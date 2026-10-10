// Optional multi-connection checks. Use only an owned, isolated local container.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.env.POSTGRES_IMAGE || 'postgres:17-alpine';
const checkId = randomUUID();
const container = `pinboard-check-${checkId}`;
const label = 'work.pinboard.check-id';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
const creator = randomUUID();
const collaborator = randomUUID();
const limitedCreator = randomUUID();
let started = false;
let interrupted = false;
let shutdown;
const commands = new Map();

function command(args, input, onOutput, holdOpen = false) {
  if (interrupted && !['inspect', 'rm'].includes(args[0]))
    return Promise.reject(new Error('PostgreSQL check was interrupted.'));
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', data => {
      stdout += data;
      onOutput?.(stdout);
    });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`Docker command timed out or was interrupted (${signal}).`));
      else resolve({ code, stdout, stderr });
    });
    child.once('error', () => clearTimeout(timeout));
  });
  // Docker commands can finish before consuming their input when startup fails.
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') child.kill('SIGKILL'); });
  if (holdOpen) child.stdin.write(input);
  else child.stdin.end(input);
  result.finish = () => child.stdin.end('commit;\n');
  commands.set(child, { result, starting: args[0] === 'run' });
  result.then(() => commands.delete(child), () => commands.delete(child));
  return result;
}

async function checked(args, input) {
  const result = await command(args, input);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

const psqlArgs = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const session = user => `begin; set local statement_timeout = '10s';
  select set_config('request.jwt.claim.sub', ${quote(user)}, true); set local role authenticated;`;
const mutation = (boardId, operation) => `select public.pinboard_mutate_board(${quote(boardId)}::uuid, ${json(operation)});`;
const create = (id, title = 'Concurrent board') => `select public.pinboard_create_board(${quote(id)}::uuid, ${quote(title)}, '');`;
const boardResult = output => JSON.parse(output.split('\n').filter(line => line.startsWith('{')).at(-1));

async function sql(script) { return checked(psqlArgs, script); }
async function createBoard(user, id = randomUUID()) {
  return boardResult(await sql(`${session(user)} ${create(id)} commit;`));
}

async function race(first, second) {
  let markReady;
  let markFailed;
  const ready = new Promise((resolve, reject) => { markReady = resolve; markFailed = reject; });
  const firstResult = command(psqlArgs, `${first} select 'PINBOARD_HOLDING_LOCK';\n`,
    output => { if (output.includes('PINBOARD_HOLDING_LOCK')) markReady(); }, true);
  firstResult.then(result => {
    if (result.code !== 0) markFailed(new Error(result.stderr));
    else markFailed(new Error('First connection completed before reporting its lock.'));
  }, markFailed);
  const waitingName = `pinboard-waiting-${randomUUID()}`;
  let secondResult;
  let failure;
  try {
    await ready;
    secondResult = command(psqlArgs, `set application_name = ${quote(waitingName)}; ${second} commit;`);
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waitType = await sql(`select wait_event_type from pg_stat_activity
        where application_name = ${quote(waitingName)} and state = 'active';`);
      if (waitType === 'Lock') { blocked = true; break; }
      await delay(50);
    }
    assert.ok(blocked, 'Second connection must be observed waiting for the first connection’s lock.');
  } catch (error) {
    failure = error;
  } finally {
    firstResult.finish?.();
  }
  if (failure) {
    await Promise.allSettled([firstResult, secondResult]);
    throw failure;
  }
  const [a, b] = await Promise.all([firstResult, secondResult]);
  assert.equal(a.code, 0, a.stderr);
  return [boardResult(a.stdout), b];
}

async function cleanup() {
  const inspected = await command(['inspect', '--format', `{{ index .Config.Labels "${label}" }}`, container]);
  if (inspected.code !== 0) {
    if (started && !/No such object|No such container/i.test(inspected.stderr))
      throw new Error(`Could not confirm removal of ${container}: ${inspected.stderr}`);
    return;
  }
  assert.equal(inspected.stdout.trim(), checkId, 'Temporary container ownership changed; it was left untouched.');
  await checked(['rm', '-f', container]);
}

function interrupt(signal) {
  if (shutdown) return;
  interrupted = true;
  const code = signal === 'SIGINT' ? 130 : 143;
  shutdown = (async () => {
    const pending = [...commands.entries()];
    // Let the bounded Docker start finish so cleanup cannot run before the
    // daemon creates its container. Cancel every other active command.
    for (const [child, state] of pending) if (!state.starting) child.kill('SIGTERM');
    await Promise.allSettled(pending.map(([, state]) => state.result));
    await cleanup();
  })();
  shutdown.then(() => process.exit(code), error => {
    console.error(error);
    process.exit(code);
  });
}

process.on('SIGINT', () => interrupt('SIGINT'));
process.on('SIGTERM', () => interrupt('SIGTERM'));

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Pinboard requires Node.js 24 or newer.');
  try {
    const running = await command(['info', '--format', '{{.ServerVersion}}']);
    if (running.code !== 0) {
      console.log('SKIP: Docker is not running. See supabase/README.md.');
      return;
    }
    const available = await command(['image', 'inspect', image]);
    if (available.code !== 0) {
      console.log(`SKIP: PostgreSQL image ${image} is not available locally. See supabase/README.md.`);
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('SKIP: Docker is not installed. See supabase/README.md.');
    return;
  }
  try {
    await checked(['run', '--detach', '--rm', '--pull=never', '--network', 'none',
      '--name', container, '--label', `${label}=${checkId}`,
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // The image starts a temporary socket-only server during initialization.
      // TCP becomes ready only when its final PostgreSQL process is running.
      const result = await command(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
      if (result.code === 0) { ready = true; break; }
      await delay(250);
    }
    assert.ok(ready, 'Temporary PostgreSQL did not become ready.');
    const version = await sql('show server_version;');
    assert.equal(Math.trunc(Number(await sql('show server_version_num;')) / 10_000), 17, 'Use a PostgreSQL 17 image.');
    await sql(`
      create role anon; create role authenticated; create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      insert into auth.users(id) values (${quote(creator)}),(${quote(collaborator)}),(${quote(limitedCreator)});
    `);
    await sql(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    // Keep the refreshed deployment path in this native check as well.
    await sql(await readFile(new URL('./upgrade-to-pinboard.sql', import.meta.url), 'utf8'));
    const board = await createBoard(creator);
    await sql(`${session(collaborator)} select public.pinboard_join_board(${quote(board.invite_code)}); commit;`);

    const [firstPatch, secondPatch] = await race(
      `${session(creator)} ${mutation(board.id, { type: 'update_board', patch: { title: 'First accepted title' } })}`,
      `${session(collaborator)} ${mutation(board.id, { type: 'update_board', patch: { description: 'Independent note' } })}`);
    assert.equal(secondPatch.code, 0, secondPatch.stderr);
    const independent = boardResult(secondPatch.stdout);
    assert.equal(independent.title, firstPatch.title);
    assert.equal(independent.description, 'Independent note');
    assert.equal(independent.revision, firstPatch.revision + 1);
    console.log('PASS: concurrent field patches retain independent edits.');

    const [firstOrder, secondOrder] = await race(
      `${session(creator)} ${mutation(board.id, { type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] })}`,
      `${session(collaborator)} ${mutation(board.id, { type: 'reorder_columns', columnIds: ['doing', 'done', 'todo'] })}`);
    assert.equal(secondOrder.code, 0, secondOrder.stderr);
    const ordered = boardResult(secondOrder.stdout);
    assert.deepEqual(ordered.columns.map(column => column.id), ['doing', 'done', 'todo']);
    assert.equal(ordered.description, independent.description);
    assert.equal(ordered.revision, firstOrder.revision + 1);
    console.log('PASS: a waiting order applies to the committed current row.');

    const column = { id: randomUUID(), title: 'Review', color: 'violet' };
    const [editedColumn, retry] = await race(
      `${session(creator)} ${mutation(board.id, { type: 'add_column', column })}
       ${mutation(board.id, { type: 'update_column', id: column.id, patch: { title: 'Reviewed together', color: 'blue' } })}`,
      `${session(collaborator)} ${mutation(board.id, { type: 'add_column', column })}`);
    assert.equal(retry.code, 0, retry.stderr);
    assert.deepEqual(boardResult(retry.stdout), editedColumn);
    console.log('PASS: concurrent column retry preserves subsequent edits without another revision.');

    const retryCard = { id: randomUUID(), title: 'Lost-response card', description: '', columnId: 'todo',
      position: 1000, priority: 'medium', assignee: '', dueDate: '', labels: [] };
    await sql(`${session(creator)} ${mutation(board.id, { type: 'create_card', card: retryCard })} commit;`);
    const [deletedCard, cardRetry] = await race(
      `${session(collaborator)} ${mutation(board.id, { type: 'delete_card', id: retryCard.id })}
       ${mutation(board.id, { type: 'update_board', patch: { description: 'Independent note after card deletion' } })}`,
      `${session(creator)} ${mutation(board.id, { type: 'create_card', card: retryCard })}`);
    assert.equal(cardRetry.code, 0, cardRetry.stderr);
    assert.deepEqual(boardResult(cardRetry.stdout), deletedCard);
    const [deletedColumn, columnRetry] = await race(
      `${session(collaborator)} ${mutation(board.id, { type: 'delete_column', id: column.id, targetColumnId: 'todo' })}`,
      `${session(creator)} ${mutation(board.id, { type: 'add_column', column })}`);
    assert.equal(columnRetry.code, 0, columnRetry.stderr);
    assert.deepEqual(boardResult(columnRetry.stdout), deletedColumn);
    console.log('PASS: waiting creation retries cannot resurrect deleted cards or columns.');

    await sql(`insert into public.pinboard_boards (id,invite_code,title,description,columns,created_by)
      select gen_random_uuid(),replace(gen_random_uuid()::text,'-',''),'Limit fixture','',columns,${quote(limitedCreator)}::uuid
      from public.pinboard_boards cross join generate_series(1,99) where id=${quote(board.id)}::uuid;`);
    const [lastBoard, excess] = await race(
      `${session(limitedCreator)} ${create(randomUUID(), '100th board')}`,
      `${session(limitedCreator)} ${create(randomUUID(), '101st board')}`);
    assert.equal(lastBoard.title, '100th board');
    assert.notEqual(excess.code, 0);
    assert.match(excess.stderr, /PINBOARD_BOARD_LIMIT/);
    assert.equal(await sql(`select count(*) from public.pinboard_boards where created_by=${quote(limitedCreator)}::uuid;`), '100');
    console.log('PASS: concurrent creates cannot exceed the per-identity board limit.');
    console.log(`PostgreSQL ${version}: all concurrent checks passed.`);
  } finally {
    if (shutdown) await shutdown;
    else await cleanup();
  }
}

main().catch(error => {
  if (!interrupted) { console.error(error); process.exitCode = 1; }
});

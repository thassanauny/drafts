import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const creator = randomUUID();
const collaborator = randomUUID();
const stranger = randomUUID();
let database;
let iouBefore;

async function identity(user, role = 'authenticated') {
  await database.exec('reset role');
  await database.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  await database.exec(`set role ${role}`);
}

async function createBoard(title = 'Project board') {
  const id = randomUUID();
  const result = await database.query(
    'select public.pinboard_create_board($1::uuid, $2, $3) as board',
    [id, title, 'Shared work'],
  );
  return result.rows[0].board;
}

async function mutate(boardId, operation) {
  const result = await database.query(
    'select public.pinboard_mutate_board($1::uuid, $2::jsonb) as board',
    [boardId, JSON.stringify(operation)],
  );
  return result.rows[0].board;
}

async function join(code) {
  const result = await database.query('select public.pinboard_join_board($1) as board', [code]);
  return result.rows[0].board;
}

function card(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Write the release note',
    description: '',
    columnId: 'todo',
    position: 1000,
    priority: 'medium',
    assignee: '',
    dueDate: '',
    labels: [],
    ...overrides,
  };
}

describe('Supabase schema in actual embedded PostgreSQL', { concurrency: false }, () => {
  before(async () => {
    database = new PGlite();
    await database.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    await database.query('insert into auth.users (id) values ($1), ($2), ($3)', [creator, collaborator, stranger]);
    // Represent an initialized sibling app without making this standalone app's
    // tests depend on another checkout. The real IOU schema is verified separately.
    await database.exec(`
      create schema private;
      create table public.iou_groups (id text primary key, payload jsonb not null);
      create table public.iou_group_access (group_id text, user_id uuid);
      alter table public.iou_groups enable row level security;
      alter table public.iou_group_access enable row level security;
      revoke all on public.iou_groups, public.iou_group_access from public, anon, authenticated;
      grant select on public.iou_groups, public.iou_group_access to authenticated;
      create function public.iou_create_group(jsonb) returns jsonb language sql as $$ select $1; $$;
      revoke all on function public.iou_create_group(jsonb) from public, anon;
      grant execute on function public.iou_create_group(jsonb) to authenticated;
      insert into public.iou_groups values ('existing-iou', '{"name":"Untouched"}');
    `);
    iouBefore = await database.query(`
      select c.relname, c.relacl::text, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('iou_groups', 'iou_group_access') order by c.relname
    `);
    await database.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  });

  after(async () => {
    await database?.close();
  });

  test('coexists with initialized IOU and exposes only checked invoker RPCs', async () => {
    await database.exec('reset role');
    const iouAfter = await database.query(`
      select c.relname, c.relacl::text, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('iou_groups', 'iou_group_access') order by c.relname
    `);
    assert.deepEqual(iouAfter.rows, iouBefore.rows);
    assert.deepEqual((await database.query("select * from public.iou_groups where id = 'existing-iou'")).rows,
      [{ id: 'existing-iou', payload: { name: 'Untouched' } }]);
    const functions = await database.query(`
      select n.nspname, p.proname, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('pinboard_create_board','pinboard_join_board','pinboard_mutate_board')
      order by n.nspname, p.proname
    `);
    assert.equal(functions.rows.length, 6);
    for (const row of functions.rows) {
      assert.equal(row.prosecdef, row.nspname === 'private');
      assert.deepEqual(row.proconfig, ['search_path=""']);
    }
    const grants = await database.query(`
      select
        has_function_privilege('anon', 'public.pinboard_create_board(uuid,text,text)', 'execute') as anonymous,
        has_function_privilege('authenticated', 'public.pinboard_create_board(uuid,text,text)', 'execute') as signed_in,
        has_function_privilege('authenticated', 'private.pinboard_valid_state(jsonb,jsonb)', 'execute') as validator,
        has_table_privilege('authenticated', 'public.pinboard_boards', 'insert,update,delete') as direct_write
    `);
    assert.deepEqual(grants.rows[0], { anonymous: false, signed_in: true, validator: false, direct_write: false });
    const permissions = await database.query(`
      select n.nspname, p.proname,
        has_function_privilege('anon', p.oid, 'execute') as anonymous,
        has_function_privilege('authenticated', p.oid, 'execute') as signed_in,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))
          where grantee = 0 and privilege_type = 'EXECUTE') as public
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname like 'pinboard_%'
      order by n.nspname, p.proname
    `);
    assert.equal(permissions.rows.length, 15);
    for (const permission of permissions.rows) {
      assert.equal(permission.anonymous, false, permission.proname);
      assert.equal(permission.public, false, permission.proname);
      assert.equal(permission.signed_in,
        ['pinboard_create_board', 'pinboard_join_board', 'pinboard_mutate_board'].includes(permission.proname),
        permission.proname);
    }
  });

  test('anonymous visitors and signed-in strangers cannot read or mutate a board', async () => {
    await identity(creator);
    const board = await createBoard();
    await identity(null, 'anon');
    await assert.rejects(database.query('select * from public.pinboard_boards'), /permission denied/);
    await assert.rejects(join(board.invite_code), /permission denied/);
    await identity(null);
    await assert.rejects(createBoard(), /PINBOARD_AUTH_REQUIRED/);
    for (const schema of ['public', 'private']) {
      await assert.rejects(database.query(`select ${schema}.pinboard_create_board($1::uuid,$2,$3)`, [randomUUID(), 'Missing session', '']), /PINBOARD_AUTH_REQUIRED/);
      await assert.rejects(database.query(`select ${schema}.pinboard_join_board($1)`, [board.invite_code]), /PINBOARD_AUTH_REQUIRED/);
      await assert.rejects(database.query(`select ${schema}.pinboard_mutate_board($1::uuid,$2::jsonb)`, [board.id, '{"type":"update_board","patch":{}}']), /PINBOARD_AUTH_REQUIRED/);
    }
    await identity(stranger);
    assert.equal((await database.query('select * from public.pinboard_boards where id = $1', [board.id])).rows.length, 0);
    assert.equal((await database.query('select * from public.pinboard_board_access where board_id = $1', [board.id])).rows.length, 0);
    await assert.rejects(mutate(board.id, { type: 'update_board', patch: { title: 'Stolen' } }), /PINBOARD_ACCESS_DENIED/);
    await assert.rejects(database.query('update public.pinboard_boards set title = $1 where id = $2', ['Stolen', board.id]), /permission denied/);
    await assert.rejects(database.query('insert into public.pinboard_board_access (board_id,user_id) values ($1,$2)', [board.id, stranger]), /permission denied/);
    await assert.rejects(database.query('delete from public.pinboard_boards where id = $1', [board.id]), /permission denied/);
  });

  test('creation retries preserve the invitation and latest data; joining needs a full code', async () => {
    await identity(creator);
    const board = await createBoard('First title');
    assert.match(board.invite_code, /^[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(board).sort(), ['id', 'invite_code', 'title', 'description', 'columns', 'cards', 'revision', 'created_at', 'updated_at'].sort());
    assert.deepEqual(board.columns.map(({ id }) => id), ['todo', 'doing', 'done']);
    const edited = await mutate(board.id, { type: 'update_board', patch: { title: 'Latest title' } });
    const retried = await database.query('select public.pinboard_create_board($1::uuid, $2, $3) as board', [board.id, 'Old title', 'Old description']);
    assert.deepEqual(retried.rows[0].board, edited);
    await identity(collaborator);
    await assert.rejects(database.query('select public.pinboard_create_board($1::uuid, $2, $3)', [board.id, 'Other creator', '']), /PINBOARD_INVALID_BOARD/);
    await assert.rejects(join(board.invite_code.slice(0, 8)), /PINBOARD_INVALID_INVITE/);
    await assert.rejects(join('0'.repeat(32)), /PINBOARD_INVALID_INVITE/);
    const joined = await join(` ${board.invite_code.slice(0, 16).toUpperCase()} \n ${board.invite_code.slice(16).toUpperCase()} `);
    assert.equal(joined.id, board.id);
    assert.equal(joined.title, 'Latest title');
    await join(board.invite_code);
    const accesses = await database.query('select * from public.pinboard_board_access where board_id = $1', [board.id]);
    assert.equal(accesses.rows.length, 1);
    assert.equal(accesses.rows[0].user_id, collaborator);
    await identity(creator);
    assert.equal((await database.query('select * from public.pinboard_boards where id = $1', [board.id])).rows.length, 1);
  });

  test('later accepted patches win only their fields and moves preserve independent edits', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card();
    await mutate(board.id, { type: 'create_card', card: original });
    await identity(collaborator);
    await join(board.invite_code);
    await mutate(board.id, { type: 'update_card', id: original.id, patch: { title: 'Collaborator title', assignee: 'Sam' } });
    await identity(creator);
    await mutate(board.id, { type: 'update_card', id: original.id, patch: { description: 'Independent description' } });
    const moved = await mutate(board.id, { type: 'move_card', id: original.id, columnId: 'doing', position: 2500.5 });
    assert.deepEqual(moved.cards[0], { ...original, title: 'Collaborator title', assignee: 'Sam', description: 'Independent description', columnId: 'doing', position: 2500.5 });
    await identity(collaborator);
    const latest = await mutate(board.id, { type: 'update_card', id: original.id, patch: { title: 'Latest accepted title' } });
    assert.equal(latest.cards[0].title, 'Latest accepted title');
    assert.equal(latest.cards[0].description, 'Independent description');
    assert.equal(latest.cards[0].columnId, 'doing');
    assert.equal(latest.revision, moved.revision + 1);
    assert.ok(Date.parse(latest.updated_at) >= Date.parse(board.created_at));
  });

  test('card retries do not overwrite edits and stale editors cannot resurrect deletions', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card();
    await mutate(board.id, { type: 'create_card', card: original });
    const edited = await mutate(board.id, { type: 'update_card', id: original.id, patch: { title: 'Edited after creation' } });
    assert.deepEqual(await mutate(board.id, { type: 'create_card', card: original }), edited);
    const deleted = await mutate(board.id, { type: 'delete_card', id: original.id });
    assert.deepEqual(await mutate(board.id, { type: 'delete_card', id: original.id }), deleted);
    await assert.rejects(mutate(board.id, { type: 'update_card', id: original.id, patch: { title: 'Stale edit' } }), /PINBOARD_CARD_NOT_FOUND/);
    await assert.rejects(mutate(board.id, { type: 'move_card', id: original.id, columnId: 'done', position: 0 }), /PINBOARD_CARD_NOT_FOUND/);
    const stored = await database.query('select cards, revision from public.pinboard_boards where id = $1', [board.id]);
    assert.deepEqual(stored.rows[0].cards, []);
    assert.equal(Number(stored.rows[0].revision), deleted.revision);
  });

  test('column-creation retries preserve later edits and order without incrementing revisions', async () => {
    await identity(creator);
    const board = await createBoard();
    const column = { id: randomUUID(), title: 'Review', color: 'violet' };
    await mutate(board.id, { type: 'add_column', column });
    await identity(collaborator);
    await join(board.invite_code);
    await mutate(board.id, { type: 'update_column', id: column.id, patch: { title: 'Peer review', color: 'blue' } });
    const current = await mutate(board.id, { type: 'reorder_columns', columnIds: [column.id, 'done', 'todo', 'doing'] });
    await identity(creator);
    assert.deepEqual(await mutate(board.id, { type: 'add_column', column }), current);
    await assert.rejects(mutate(board.id, { type: 'add_column', column: { ...column, unexpected: true } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'add_column', column: { ...column, title: '' } }), /PINBOARD_INVALID_OPERATION/);
    assert.deepEqual(await mutate(board.id, { type: 'add_column', column }), current);
  });

  test('lost create responses cannot resurrect cards or columns deleted by another member', async () => {
    await identity(creator);
    const board = await createBoard();
    const originalCard = card();
    const originalColumn = { id: randomUUID(), title: 'Temporary review', color: 'violet' };
    await mutate(board.id, { type: 'create_card', card: originalCard });
    await mutate(board.id, { type: 'add_column', column: originalColumn });
    await identity(collaborator);
    await join(board.invite_code);
    await mutate(board.id, { type: 'delete_card', id: originalCard.id });
    await mutate(board.id, { type: 'delete_column', id: originalColumn.id, targetColumnId: 'todo' });
    const independentCard = card({ title: 'New independent work' });
    await mutate(board.id, { type: 'create_card', card: independentCard });
    const latest = await mutate(board.id, { type: 'update_board', patch: { description: 'Keep this later note' } });
    await identity(creator);
    assert.deepEqual(await mutate(board.id, { type: 'create_card', card: originalCard }), latest);
    assert.deepEqual(await mutate(board.id, { type: 'create_card', card: { ...originalCard, title: 'Changed stale retry' } }), latest);
    assert.deepEqual(await mutate(board.id, { type: 'add_column', column: originalColumn }), latest);
    assert.deepEqual(await mutate(board.id, { type: 'add_column', column: { ...originalColumn, color: 'blue' } }), latest);
    assert.deepEqual(latest.cards, [independentCard]);
    assert.ok(!latest.columns.some(column => column.id === originalColumn.id));
    assert.deepEqual(Object.keys(latest).sort(), ['id','invite_code','title','description','columns','cards','revision','created_at','updated_at'].sort());
    const receipts = (await database.query('select deleted_card_ids,deleted_column_ids from public.pinboard_boards where id=$1', [board.id])).rows[0];
    assert.deepEqual(receipts, { deleted_card_ids: [originalCard.id], deleted_column_ids: [originalColumn.id] });
    assert.deepEqual(await mutate(board.id, { type: 'delete_card', id: originalCard.id }), latest);
  });

  test('column changes move contained cards atomically and always retain one column', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card();
    await mutate(board.id, { type: 'create_card', card: original });
    await mutate(board.id, { type: 'add_column', column: { id: 'review', title: 'Review', color: 'violet' } });
    await mutate(board.id, { type: 'update_column', id: 'review', patch: { title: 'Peer review', color: 'blue' } });
    const moved = await mutate(board.id, { type: 'delete_column', id: 'todo', targetColumnId: 'review' });
    assert.equal(moved.cards[0].columnId, 'review');
    assert.deepEqual(moved.columns.map(({ id }) => id), ['doing', 'done', 'review']);
    await assert.rejects(mutate(board.id, { type: 'move_card', id: original.id, columnId: 'todo', position: 0 }), /PINBOARD_INVALID_OPERATION/);
    await mutate(board.id, { type: 'delete_column', id: 'doing', targetColumnId: 'review' });
    await mutate(board.id, { type: 'delete_column', id: 'done', targetColumnId: 'review' });
    await assert.rejects(mutate(board.id, { type: 'delete_column', id: 'review', targetColumnId: 'review' }), /PINBOARD_INVALID_OPERATION/);
    const stored = await database.query('select columns,cards from public.pinboard_boards where id = $1', [board.id]);
    assert.equal(stored.rows[0].columns.length, 1);
    assert.equal(stored.rows[0].cards[0].columnId, 'review');
  });

  test('column ordering preserves current metadata, cards, and independent board changes', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card({ columnId: 'doing' });
    await mutate(board.id, { type: 'create_card', card: original });
    await identity(collaborator);
    await join(board.invite_code);
    await mutate(board.id, { type: 'update_column', id: 'doing', patch: { title: 'Active work', color: 'blue' } });
    const current = await mutate(board.id, { type: 'update_board', patch: { description: 'Independent board detail' } });
    await identity(creator);
    const ordered = await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'doing', 'todo'] });
    assert.deepEqual(ordered.columns, ['done', 'doing', 'todo'].map(id => current.columns.find(column => column.id === id)));
    assert.deepEqual(ordered.cards, current.cards);
    assert.equal(ordered.description, current.description);
    assert.equal(ordered.revision, current.revision + 1);
  });

  test('stale column orders omit deleted IDs and append current unlisted columns without losing cards', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card({ columnId: 'doing' });
    await mutate(board.id, { type: 'create_card', card: original });
    await identity(collaborator);
    await join(board.invite_code);
    await mutate(board.id, { type: 'delete_column', id: 'doing', targetColumnId: 'todo' });
    await mutate(board.id, { type: 'add_column', column: { id: 'review', title: 'Review', color: 'violet' } });
    const current = await mutate(board.id, { type: 'add_column', column: { id: 'waiting', title: 'Waiting', color: 'amber' } });
    await identity(creator);
    const ordered = await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'doing', 'todo'] });
    assert.deepEqual(ordered.columns.map(({ id }) => id), ['done', 'todo', 'review', 'waiting']);
    assert.deepEqual(ordered.cards, current.cards);
    assert.equal(ordered.cards[0].columnId, 'todo');
    assert.deepEqual(ordered.columns.slice(2), current.columns.slice(2));
    // Even an entirely obsolete snapshot preserves all current columns.
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['obsolete-column'] }), ordered);
  });

  test('later accepted column orders win while independent edits survive', async () => {
    await identity(creator);
    const board = await createBoard();
    const first = await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] });
    await identity(collaborator);
    await join(board.invite_code);
    const edited = await mutate(board.id, { type: 'update_column', id: 'todo', patch: { title: 'Backlog' } });
    const last = await mutate(board.id, { type: 'reorder_columns', columnIds: ['doing', 'done', 'todo'] });
    assert.deepEqual(last.columns.map(({ id }) => id), ['doing', 'done', 'todo']);
    assert.equal(last.columns[2].title, 'Backlog');
    assert.equal(last.revision, edited.revision + 1);
    assert.equal(last.revision, first.revision + 2);
    await identity(creator);
    assert.deepEqual((await database.query('select columns from public.pinboard_boards where id = $1', [board.id])).rows[0].columns, last.columns);
  });

  test('column ordering rejects malformed or unauthorized input without changing the board', async () => {
    await identity(creator);
    const board = await createBoard();
    const invalidOrders = [null, {}, 'todo', [], Array.from({ length: 21 }, (_, index) => `column-${index}`),
      ['todo', 'todo'], [''], ['unsafe id'], ['constructor'], ['prototype'], ['__proto__'],
      ['x'.repeat(65)], [null], [1], [{ id: 'todo' }]];
    for (const columnIds of invalidOrders) {
      await assert.rejects(mutate(board.id, { type: 'reorder_columns', columnIds }), /PINBOARD_INVALID_OPERATION/);
    }
    await assert.rejects(mutate(board.id, { type: 'reorder_columns' }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'reorder_columns', columnIds: ['todo'], columns: board.columns }), /PINBOARD_INVALID_OPERATION/);
    await identity(stranger);
    await assert.rejects(mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] }), /PINBOARD_ACCESS_DENIED/);
    await identity(creator);
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['todo', 'doing', 'done'] }), board);
  });

  test('repeating an unchanged column order is a no-op including its revision and timestamp', async () => {
    await identity(creator);
    const board = await createBoard();
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['todo', 'doing', 'done'] }), board);
    const ordered = await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'doing', 'todo'] });
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'doing', 'todo'] }), ordered);
    // A partial order appends every omitted current column in its existing order.
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['done'] }), ordered);
  });

  test('invalid payloads cannot bypass field, reference, date, size, and count limits', async () => {
    await identity(creator);
    await assert.rejects(createBoard(' '), /PINBOARD_INVALID_BOARD/);
    await assert.rejects(createBoard('😀'.repeat(81)), /PINBOARD_INVALID_BOARD/);
    const board = await createBoard();
    const invalid = [
      { title: null }, { title: 'x'.repeat(161) }, { description: 'x'.repeat(10001) },
      { columnId: 'missing' }, { position: -1 }, { position: 1000000000001 },
      { position: '0' }, { priority: 'urgent' }, { assignee: 'x'.repeat(81) },
      { dueDate: '2026-02-30' }, { dueDate: '0000-01-01' }, { dueDate: '2026-2-01' },
      { labels: Array(9).fill('tag') }, { labels: ['x'.repeat(31)] }, { labels: [''] },
      { id: 'unsafe' }, { title: '\u0001' }, { title: '\u007f' }, { unexpected: true },
    ];
    for (const overrides of invalid) {
      await assert.rejects(mutate(board.id, { type: 'create_card', card: card(overrides) }), /PINBOARD_INVALID_OPERATION/);
    }
    const valid = card({ dueDate: '2028-02-29', position: 1000000000000, title: '😀'.repeat(80), description: '\u0085\t\n\r', labels: Array(8).fill('tag') });
    await mutate(board.id, { type: 'create_card', card: valid });
    await assert.rejects(mutate(board.id, { type: 'update_card', id: valid.id, patch: { id: randomUUID() } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'update_board', patch: { invite_code: '0'.repeat(32) } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'update_board', patch: { title: 42 } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'update_board', patch: { description: null } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'add_column', column: { id: 'constructor', title: 'Unsafe', color: 'slate' } }), /PINBOARD_INVALID_OPERATION/);
    await assert.rejects(mutate(board.id, { type: 'update_column', id: 'todo', patch: { color: 'black' } }), /PINBOARD_INVALID_OPERATION/);
    for (let index = 3; index < 20; index += 1) {
      await mutate(board.id, { type: 'add_column', column: { id: `column-${index}`, title: `Column ${index}`, color: 'slate' } });
    }
    const full = await mutate(board.id, { type: 'update_board', patch: {} });
    assert.deepEqual(await mutate(board.id, { type: 'add_column', column: full.columns[0] }), full);
    await assert.rejects(mutate(board.id, { type: 'add_column', column: { id: 'too-many', title: '21st', color: 'slate' } }), /PINBOARD_INVALID_OPERATION/);
    // Seed the maximum through the administrator, then exercise the public RPC.
    await database.exec('reset role');
    await database.query('update public.pinboard_boards set cards = $1::jsonb where id = $2', [JSON.stringify(Array.from({ length: 2000 }, () => card())), board.id]);
    await identity(creator);
    await assert.rejects(mutate(board.id, { type: 'create_card', card: card() }), /PINBOARD_INVALID_OPERATION/);
    const stored = await database.query('select columns,cards from public.pinboard_boards where id = $1', [board.id]);
    assert.equal(stored.rows[0].columns.length, 20);
    assert.equal(stored.rows[0].cards.length, 2000);
  });

  test('board and membership limits reject new work while permitting creation and join retries', async () => {
    const limitedCreator = randomUUID();
    const limitedMember = randomUUID();
    await database.exec('reset role');
    await database.query('insert into auth.users(id) values ($1),($2)', [limitedCreator, limitedMember]);
    await identity(limitedCreator);
    const original = await createBoard('Creator limit retry');
    await database.exec('reset role');
    await database.query(`
      insert into public.pinboard_boards (id, invite_code, title, description, columns, created_by)
      select gen_random_uuid(), replace(gen_random_uuid()::text, '-', ''), 'Limit fixture', '', columns, $1::uuid
      from public.pinboard_boards cross join generate_series(1,99) where id = $2::uuid
    `, [limitedCreator, original.id]);
    await identity(limitedCreator);
    await assert.rejects(createBoard(), /PINBOARD_BOARD_LIMIT/);
    const retry = await database.query('select public.pinboard_create_board($1::uuid,$2,$3) as board', [original.id, 'Old title', 'Old description']);
    assert.deepEqual(retry.rows[0].board, original);

    // Bulk-seed the limit as administrator, then exercise only public RPCs.
    await database.exec('reset role');
    const seeded = await database.query(`
      insert into public.pinboard_boards (id, invite_code, title, description, columns)
      select gen_random_uuid(), replace(gen_random_uuid()::text, '-', ''), 'Membership fixture', '', columns
      from public.pinboard_boards cross join generate_series(1,1000) where id = $1::uuid
      returning id, invite_code
    `, [original.id]);
    await database.query(`
      insert into public.pinboard_board_access (board_id,user_id)
      select unnest($1::uuid[]), $2::uuid
    `, [seeded.rows.map(row => row.id), limitedMember]);
    await identity(limitedMember);
    const existing = await join(seeded.rows[0].invite_code);
    assert.equal(existing.id, seeded.rows[0].id);
    await assert.rejects(join(original.invite_code), /PINBOARD_BOARD_LIMIT/);
    await assert.rejects(createBoard(), /PINBOARD_BOARD_LIMIT/);
    assert.equal(Number((await database.query('select count(*) as count from public.pinboard_board_access')).rows[0].count), 1000);
  });

  test('revision exhaustion permits no-ops and rejects changes atomically', async () => {
    await identity(creator);
    const board = await createBoard();
    const original = card();
    const saved = await mutate(board.id, { type: 'create_card', card: original });
    await database.exec('reset role');
    await database.query('update public.pinboard_boards set revision = 9007199254740991 where id = $1', [board.id]);
    await identity(creator);
    const full = { ...saved, revision: Number.MAX_SAFE_INTEGER };
    for (const operation of [
      { type: 'update_board', patch: {} },
      { type: 'update_card', id: original.id, patch: { title: original.title } },
      { type: 'create_card', card: original },
      { type: 'add_column', column: full.columns[0] },
      { type: 'delete_card', id: randomUUID() },
      { type: 'reorder_columns', columnIds: full.columns.map(column => column.id) },
    ]) assert.deepEqual(await mutate(board.id, operation), full);
    for (const operation of [
      { type: 'update_board', patch: { title: 'Must not save' } },
      { type: 'delete_card', id: original.id },
      { type: 'reorder_columns', columnIds: ['done', 'doing', 'todo'] },
    ]) await assert.rejects(mutate(board.id, operation), /PINBOARD_BOARD_LIMIT/);
    assert.deepEqual(await mutate(board.id, { type: 'update_board', patch: {} }), full);
  });

  test('the upgrade safely refreshes an already current project without changing data, policies, ownership, or grants', async () => {
    await identity(creator);
    const board = await createBoard('Existing board before upgrade');
    const original = card();
    const saved = await mutate(board.id, { type: 'create_card', card: original });
    await database.exec('reset role');
    const functionSnapshot = async () => (await database.query(`
      select p.oid, n.nspname, p.proname, p.proowner, p.proacl::text, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname ~ '^pinboard_' order by n.nspname, p.proname
    `)).rows;
    const tableSnapshot = async () => (await database.query(`
      select c.oid, c.relname, c.relowner, c.relacl::text, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('pinboard_boards','pinboard_board_access') order by c.relname
    `)).rows;
    const policiesSnapshot = async () => (await database.query("select * from pg_policies where tablename in ('pinboard_boards','pinboard_board_access') order by tablename,policyname")).rows;
    const beforeFunctions = await functionSnapshot();
    const beforeTables = await tableSnapshot();
    const beforePolicies = await policiesSnapshot();
    const beforeAccess = (await database.query('select * from public.pinboard_board_access order by board_id,user_id')).rows;
    const upgrade = await readFile(new URL('./upgrade-to-pinboard.sql', import.meta.url), 'utf8');
    await database.exec(upgrade);
    await database.exec(upgrade);
    assert.deepEqual(await functionSnapshot(), beforeFunctions);
    assert.deepEqual(await tableSnapshot(), beforeTables);
    assert.deepEqual(await policiesSnapshot(), beforePolicies);
    assert.deepEqual((await database.query('select * from public.pinboard_board_access order by board_id,user_id')).rows, beforeAccess);
    await identity(creator);
    assert.deepEqual(await mutate(board.id, { type: 'reorder_columns', columnIds: ['todo', 'doing', 'done'] }), saved);
    const reordered = await mutate(board.id, { type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] });
    assert.equal(reordered.title, saved.title);
    assert.equal(reordered.invite_code, saved.invite_code);
    assert.deepEqual(reordered.cards, saved.cards);
    assert.deepEqual(reordered.columns.map(({ id }) => id), ['done', 'todo', 'doing']);
  });

  test('installation is initial-only and a failed rerun leaves the existing project intact', async () => {
    await database.exec('reset role');
    const beforeCount = (await database.query('select count(*) as count from public.pinboard_boards')).rows[0].count;
    await assert.rejects(database.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')), /already exists/);
    await database.exec('rollback');
    const afterCount = (await database.query('select count(*) as count from public.pinboard_boards')).rows[0].count;
    assert.equal(afterCount, beforeCount);
    const grants = await database.query("select has_function_privilege('authenticated', 'public.iou_create_group(jsonb)', 'execute') as valid");
    assert.equal(grants.rows[0].valid, true);
  });
});

test('migrates the historical Kanban installation and preserves boards, access, object identities, and security across reruns', async () => {
  const legacy = new PGlite();
  const originalId = randomUUID();
  const oldCreator = randomUUID();
  const oldCollaborator = randomUUID();
  const oldStranger = randomUUID();
  const upgrade = await readFile(new URL('./upgrade-to-pinboard.sql', import.meta.url), 'utf8');
  const setIdentity = async (user) => {
    await legacy.exec('reset role');
    await legacy.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
    await legacy.exec('set role authenticated');
  };
  const legacyMutate = async (operation) => (await legacy.query(
    'select public.kanban_mutate_board($1::uuid,$2::jsonb) as board',
    [originalId, JSON.stringify(operation)],
  )).rows[0].board;
  const currentMutate = async (operation) => (await legacy.query(
    'select public.pinboard_mutate_board($1::uuid,$2::jsonb) as board',
    [originalId, JSON.stringify(operation)],
  )).rows[0].board;
  const allRows = async (prefix) => ({
    boards: (await legacy.query(`select * from public.${prefix}_boards order by id`)).rows,
    access: (await legacy.query(`select * from public.${prefix}_board_access order by board_id,user_id`)).rows,
  });
  const objectSnapshot = async () => ({
    tables: (await legacy.query(`
      select c.oid, c.relname as name, c.relowner, c.relacl::text, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname ~ '^(kanban|pinboard)_'
      order by c.oid
    `)).rows,
    functions: (await legacy.query(`
      select p.oid, n.nspname, p.proname as name, p.proowner, p.proacl::text,
        p.prosecdef, p.proconfig, p.proargtypes::text, p.prorettype
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname ~ '^(kanban|pinboard)_'
      order by p.oid
    `)).rows,
    constraints: (await legacy.query(`
      select oid, conname as name, conrelid, confrelid, contype, convalidated
      from pg_constraint where conname ~ '^(kanban|pinboard)_' order by oid
    `)).rows,
    indexes: (await legacy.query(`
      select c.oid, c.relname as name, i.indrelid, i.indisunique, i.indisprimary, i.indisvalid
      from pg_class c join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname ~ '^(kanban|pinboard)_' order by c.oid
    `)).rows,
    policies: (await legacy.query(`
      select oid, polname as name, polrelid, polcmd, polpermissive, polroles
      from pg_policy where polname ~ '^(kanban|pinboard)_' order by oid
    `)).rows,
  });
  try {
    await legacy.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
    `);
    await legacy.query('insert into auth.users(id) values ($1),($2),($3)', [oldCreator, oldCollaborator, oldStranger]);
    // The complete archived installed schema is immutable: no transformation of
    // the current schema is involved in constructing this migration predecessor.
    await legacy.exec(await readFile(new URL('./fixtures/legacy-kanban-schema.sql', import.meta.url), 'utf8'));
    await setIdentity(oldCreator);
    const originalBoard = (await legacy.query('select public.kanban_create_board($1::uuid,$2,$3) as board',
      [originalId, 'Original project board', 'Keep the user note: kanban_ is a legacy identifier.'])).rows[0].board;
    const originalCard = card({ title: 'Original card 😀', description: 'Keep every detail', labels: ['release'], dueDate: '2028-02-29', position: 1234.5 });
    await legacyMutate({ type: 'create_card', card: originalCard });
    const saved = await legacyMutate({ type: 'update_column', id: 'doing', patch: { title: 'Active work', color: 'blue' } });
    await assert.rejects(legacyMutate({ type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] }), /KANBAN_INVALID_OPERATION/);
    await setIdentity(oldCollaborator);
    await legacy.query('select public.kanban_join_board($1)', [originalBoard.invite_code]);
    await legacy.exec('reset role');
    const beforeRows = await allRows('kanban');
    const beforeObjects = await objectSnapshot();
    const expectedObjects = Object.fromEntries(Object.entries(beforeObjects)
      .map(([category, rows]) => [category, rows.map(row => ({ ...row, name: row.name.replace(/^kanban_/, 'pinboard_') }))]));

    await legacy.exec('alter table public.kanban_board_access rename to temporarily_missing_access');
    await assert.rejects(legacy.exec(upgrade), /PINBOARD_SCHEMA_REQUIRED: an initialized board schema is required/);
    await legacy.exec('rollback');
    await legacy.exec('alter table public.temporarily_missing_access rename to kanban_board_access');
    assert.deepEqual(await allRows('kanban'), beforeRows);
    assert.deepEqual(await objectSnapshot(), beforeObjects);

    // A conflicting current table must cause an atomic rollback, never a merge
    // or overwrite of either installed project's data.
    await legacy.exec('create table public.pinboard_boards (id uuid primary key)');
    await assert.rejects(legacy.exec(upgrade), /PINBOARD_NAME_COLLISION/);
    await legacy.exec('rollback');
    assert.deepEqual(await allRows('kanban'), beforeRows);
    await legacy.exec('drop table public.pinboard_boards');

    await legacy.exec(`
      create function private.pinboard_has_keys(jsonb,text[]) returns boolean
      language sql as $$ select false; $$;
    `);
    await assert.rejects(legacy.exec(upgrade), /PINBOARD_NAME_COLLISION/);
    await legacy.exec('rollback');
    assert.deepEqual(await allRows('kanban'), beforeRows);
    await legacy.exec('drop function private.pinboard_has_keys(jsonb,text[])');
    assert.deepEqual(await objectSnapshot(), beforeObjects);

    // A missing privileged function must not be recreated with default PUBLIC
    // execution. Restore its name afterward without changing its identity/ACL.
    await legacy.exec('alter function private.kanban_mutate_board(uuid,jsonb) rename to temporarily_missing');
    await assert.rejects(legacy.exec(upgrade), /PINBOARD_SCHEMA_REQUIRED: missing function/);
    await legacy.exec('rollback');
    assert.deepEqual(await allRows('kanban'), beforeRows);
    await legacy.exec('alter function private.temporarily_missing(uuid,jsonb) rename to kanban_mutate_board');
    assert.deepEqual(await objectSnapshot(), beforeObjects);

    const upgradedRows = {
      ...beforeRows,
      boards: beforeRows.boards.map(row => ({ ...row, deleted_card_ids: [], deleted_column_ids: [] })),
    };
    await legacy.exec(upgrade);
    assert.deepEqual(await allRows('pinboard'), upgradedRows);
    const firstUpgradedObjects = await objectSnapshot();
    const addedConstraints = firstUpgradedObjects.constraints.filter(row =>
      row.name === 'pinboard_boards_deleted_card_ids_not_null' || row.name === 'pinboard_boards_deleted_column_ids_not_null');
    assert.equal(addedConstraints.length, 2);
    for (const row of addedConstraints) {
      assert.equal(row.contype, 'n');
      assert.equal(row.convalidated, true);
      assert.equal(row.conrelid, expectedObjects.tables.find(table => table.name === 'pinboard_boards').oid);
    }
    expectedObjects.constraints.push(...addedConstraints);
    assert.deepEqual(firstUpgradedObjects, expectedObjects);
    await legacy.exec(upgrade);
    assert.deepEqual(await allRows('pinboard'), upgradedRows);
    assert.deepEqual(await objectSnapshot(), expectedObjects);
    const oldObjects = await legacy.query(`
      select 'relation' as kind, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public','private') and c.relname like 'kanban%'
      union all select 'function', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public','private') and p.proname like 'kanban%'
      union all select 'constraint', conname from pg_constraint where conname like 'kanban%'
      union all select 'policy', polname from pg_policy where polname like 'kanban%'
      union all select 'type', t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
        where n.nspname in ('public','private') and (t.typname like 'kanban%' or t.typname like '_kanban%')
    `);
    assert.deepEqual(oldObjects.rows, []);
    const oldBodies = await legacy.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','private') and p.proname like 'pinboard%'
        and pg_get_functiondef(p.oid) ~* 'kanban'
    `);
    assert.deepEqual(oldBodies.rows, []);

    await setIdentity(oldCreator);
    const retried = (await legacy.query('select public.pinboard_create_board($1::uuid,$2,$3) as board',
      [originalId, 'Stale creation title', 'Stale creation description'])).rows[0].board;
    assert.deepEqual(retried, saved);
    await setIdentity(oldStranger);
    assert.equal((await legacy.query('select * from public.pinboard_boards')).rows.length, 0);
    await assert.rejects(currentMutate({ type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] }), /PINBOARD_ACCESS_DENIED/);
    await assert.rejects(legacy.query('update public.pinboard_boards set title = $1', ['Unauthorized']), /permission denied/);
    await setIdentity(oldCollaborator);
    const recovered = (await legacy.query('select public.pinboard_join_board($1) as board', [originalBoard.invite_code])).rows[0].board;
    assert.deepEqual(recovered, saved);
    const reordered = await currentMutate({ type: 'reorder_columns', columnIds: ['done', 'todo', 'doing'] });
    assert.deepEqual(reordered.cards, saved.cards);
    assert.equal(reordered.title, saved.title);
    assert.equal(reordered.description, saved.description);
    assert.equal(reordered.invite_code, saved.invite_code);
    assert.equal(reordered.created_at, saved.created_at);
    assert.equal(reordered.revision, saved.revision + 1);
    assert.deepEqual(reordered.columns.map(({ id }) => id), ['done', 'todo', 'doing']);
    assert.equal(reordered.columns[2].title, 'Active work');
    const newColumn = { id: randomUUID(), title: 'New review', color: 'violet' };
    await currentMutate({ type: 'add_column', column: newColumn });
    const editedColumn = await currentMutate({ type: 'update_column', id: newColumn.id, patch: { title: 'Reviewed together' } });
    assert.deepEqual(await currentMutate({ type: 'add_column', column: newColumn }), editedColumn);
    // New deletions after the upgrade retain receipts, including for cards
    // created by the historical installation. Independent later changes survive.
    await currentMutate({ type: 'delete_card', id: originalCard.id });
    await currentMutate({ type: 'delete_column', id: newColumn.id, targetColumnId: 'todo' });
    const later = await currentMutate({ type: 'update_board', patch: { description: 'Later work after deletion' } });
    await setIdentity(oldCreator);
    assert.deepEqual(await currentMutate({ type: 'create_card', card: originalCard }), later);
    assert.deepEqual(await currentMutate({ type: 'add_column', column: newColumn }), later);
    await legacy.exec('reset role');
    const orderedRows = await allRows('pinboard');
    await legacy.exec(upgrade);
    assert.deepEqual(await allRows('pinboard'), orderedRows);
    assert.deepEqual(await objectSnapshot(), expectedObjects);
  } finally {
    await legacy.close();
  }
});

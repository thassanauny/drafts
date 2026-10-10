import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCloudBuild } from './check-cloud-build.mjs';

for (const [name, settings] of [
  ['both Supabase settings missing', {}],
  ['Supabase URL missing', { VITE_SUPABASE_ANON_KEY: 'public-test-key' }],
  ['Supabase public key missing', { VITE_SUPABASE_URL: 'https://test.supabase.co' }],
]) {
  test('production build fails clearly with ' + name, (t) => {
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const temporary = mkdtempSync(join(tmpdir(), 'iou-unconfigured-build-'));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const output = join(temporary, 'dist');
    const result = spawnSync(process.execPath, [join(directory, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', output], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', ...settings },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /iou production builds require VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY/);
    assert.match(result.stderr, /app's \.env\.local/);
    assert.match(result.stderr, /shared \.\.\/\.\.\/publishing\/\.env\.local/);
    assert.match(result.stderr, /or build environment before publishing/);
    assert.equal(existsSync(output), false, 'Unconfigured builds must not produce output');
  });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'iou-publishing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'assets'));
  const code = 'console.log("configured app")';
  writeFileSync(join(directory, 'assets/app.js'), code);
  writeFileSync(join(directory, 'index.html'), '<script type="module" src="./assets/app.js"></script>');
  const report = { format: 1, app: 'iou', cloudConfigured: true,
    scripts: { 'assets/app.js': createHash('sha256').update(code).digest('hex') } };
  const save = () => writeFileSync(join(directory, 'cloud-build.json'), JSON.stringify(report));
  save();
  return { directory, report, save };
}

test('allows the verified configured build', (t) => {
  const { directory, report } = fixture(t);
  assert.deepEqual(checkCloudBuild(directory), report);
});

test('rejects the previous deployment without a cloud build report', (t) => {
  const { directory } = fixture(t);
  rmSync(join(directory, 'cloud-build.json'));
  assert.throws(() => checkCloudBuild(directory), /Rebuild with its public Supabase/);
});

test('rejects disabled configuration', (t) => {
  const { directory, report, save } = fixture(t);
  report.cloudConfigured = false;
  save();
  assert.throws(() => checkCloudBuild(directory), /missing its verified Supabase/);
});

test('rejects an unconfigured rebuild paired with a stale report', (t) => {
  const { directory } = fixture(t);
  writeFileSync(join(directory, 'assets/app.js'), 'console.log("unconfigured rebuild")');
  assert.throws(() => checkCloudBuild(directory), /scripts changed/);
});

test('rejects index.html pointing at an unverified app', (t) => {
  const { directory } = fixture(t);
  writeFileSync(join(directory, 'index.html'), '<script src="./assets/other.js"></script>');
  assert.throws(() => checkCloudBuild(directory), /does not load the verified app/);
});

test('rejects unsafe script paths and malformed reports', (t) => {
  const { directory, report, save } = fixture(t);
  report.scripts = { '../outside.js': 'a'.repeat(64) };
  save();
  assert.throws(() => checkCloudBuild(directory), /Invalid iou cloud build/);
  writeFileSync(join(directory, 'cloud-build.json'), 'null');
  assert.throws(() => checkCloudBuild(directory));
});

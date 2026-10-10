import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, cpSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname, relative, join, delimiter, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { writeSharedBuildReport, checkSharedBuild } from './check-shared-build.mjs';

const file = fileURLToPath(import.meta.url);
const helperName = 'scripts/prepare-shared.mjs';
const checkerName = 'scripts/check-shared-build.mjs';
const manifestName = 'publish-manifest.json';
const apps = {
  textdrop: { assets: new Set(['logo.svg']), files: ['vite.config.test.ts', 'supabase/upgrade-to-textdrop.sql'], folders: ['src', 'public', 'tests'] },
  pinboard: { assets: new Set(['favicon.svg']), files: ['vite.config.test.ts', 'supabase/upgrade-to-pinboard.sql', 'supabase/schema.test.mjs', 'supabase/postgres-check.mjs', 'supabase/fixtures/legacy-kanban-schema.sql'], folders: ['src', 'public'] },
};
const commonFiles = ['Makefile', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', 'build-config.ts', 'build-config.test.ts', '.env.example', 'supabase/schema.sql'];

function identity(name) {
  if (!Object.hasOwn(apps, name)) throw new Error('Choose textdrop or pinboard.');
  return { ...apps[name], name, site: 'site/' + name, source: 'modules/' + name };
}

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function regular(path, kind) {
  const info = stat(path);
  if (!info) return false;
  if (info.isSymbolicLink()) throw new Error('Refusing a symbolic-link shared publishing path: ' + path);
  if (!(kind === 'directory' ? info.isDirectory() : info.isFile())) throw new Error('Unexpected shared publishing path: ' + path);
  return true;
}

function collect(dir, base = dir, files = Object.create(null)) {
  if (!regular(dir, 'directory')) return files;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const info = stat(path);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not published: ' + path);
    if (info.isDirectory()) collect(path, base, files);
    else if (info.isFile()) files[relative(base, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    else throw new Error('Only regular files are published: ' + path);
  }
  return files;
}

function hashMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([name, hash]) => name && !isAbsolute(name) && !name.includes('\\')
      && name.split('/').every(part => part && part !== '.' && part !== '..') && /^[a-f0-9]{64}$/.test(hash));
}

function matches(actual, expected) {
  const names = Object.keys(actual).sort();
  return JSON.stringify(names) === JSON.stringify(Object.keys(expected).sort()) && names.every(name => actual[name] === expected[name]);
}

function ownedDirectories(dir, expected, base = dir) {
  if (!stat(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!stat(path).isDirectory()) continue;
    const prefix = relative(base, path).replaceAll('\\', '/') + '/';
    if (!Object.keys(expected).some(file => file.startsWith(prefix))) throw new Error('Unowned shared app directory: ' + path);
    ownedDirectories(path, expected, base);
  }
}

/** Read-only ownership/empty-bootstrap check, before any app build is run. */
export function validateSharedAppDestination(target, name) {
  const app = identity(name);
  if (!regular(target, 'directory')) throw new Error('Choose the existing shared Sites checkout.');
  target = realpathSync(target);
  for (const name of ['site', 'modules']) regular(join(target, name), 'directory');
  const git = stat(join(target, '.git'));
  if (!git || git.isSymbolicLink() || !(git.isDirectory() || git.isFile()) || !regular(join(target, 'site/index.html'), 'file')) {
    throw new Error('Choose the existing shared Sites checkout.');
  }
  const site = join(target, app.site);
  const source = join(target, app.source);
  const siteFiles = collect(site);
  const sourceFiles = collect(source);
  const marker = join(source, manifestName);
  if (!stat(marker)) {
    if ((stat(site) && readdirSync(site).length) || (stat(source) && readdirSync(source).length)) throw new Error('Missing ' + name + ' ownership manifest; refusing unowned contents.');
    return target;
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(marker, 'utf8')); }
  catch { throw new Error('Invalid ' + name + ' ownership manifest.'); }
  if (manifest.format !== 1 || manifest.app !== name || manifest.site !== app.site || manifest.source !== app.source
    || typeof manifest.version !== 'string' || !manifest.version || !hashMap(manifest.files) || !hashMap(manifest.sourceFiles)
    || !manifest.files['index.html'] || !manifest.files['.nojekyll'] || !manifest.files['shared-build.json']
    || !manifest.sourceFiles['Makefile'] || !manifest.sourceFiles['package.json'] || !manifest.sourceFiles[helperName]
    || !manifest.sourceFiles[checkerName] || manifest.sourceFiles[manifestName]) throw new Error('Invalid ' + name + ' ownership manifest.');
  delete sourceFiles[manifestName];
  if (!matches(siteFiles, manifest.files) || !matches(sourceFiles, manifest.sourceFiles)) {
    throw new Error('Unowned or modified ' + name + ' files; preserve those changes before preparing again.');
  }
  ownedDirectories(site, manifest.files);
  ownedDirectories(source, manifest.sourceFiles);
  return target;
}

function approved(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.every(part => !['.git', '.github', 'node_modules', 'dist', 'build', 'coverage', 'artifacts', 'output', 'recordings', 'test-results', 'playwright-report'].includes(part.toLowerCase())
    && !/^(?:readme|agents)(?:\..*)?$/i.test(part)
    && !/^(?:deployment|publishing)(?:\..*)?$/i.test(part)
    && !(/^\.env/i.test(part) && name !== '.env.example')
    && !/(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)/i.test(part)
    && !/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log|dmg|zip)$/i.test(part));
}

function approvedFiles(names, kind, app) {
  return names.filter(name => {
    if (!approved(name)) return false;
    const allowed = ['src', 'tests'].includes(kind) ? new RegExp('^' + kind + '/.+\\.(?:ts|tsx|css)$').test(name)
      : kind === 'public' ? app.assets.has(name.slice('public/'.length))
      : ['index.html', '.nojekyll'].includes(name) || app.assets.has(name) || /^assets\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(name);
    if (!allowed) throw new Error('Unapproved ' + app.name + ' ' + kind + ' file: ' + name);
    return true;
  });
}

function copyFiles(origin, destination, names) {
  for (const name of names) {
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    cpSync(join(origin, name), join(destination, name));
  }
}

function snapshot(origin, source, app) {
  mkdirSync(source);
  for (const name of [...commonFiles, ...app.files]) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) regular(join(origin, ...parts.slice(0, index)), 'directory');
    if (!regular(join(origin, name), 'file')) throw new Error('Missing approved ' + app.name + ' source file: ' + name);
    copyFiles(origin, source, [name]);
  }
  for (const name of app.folders) {
    if (!regular(join(origin, name), 'directory')) throw new Error('Missing approved ' + app.name + ' source folder: ' + name);
    copyFiles(origin, source, approvedFiles(Object.keys(collect(join(origin, name), origin)), name, app));
  }
  const makefile = join(source, 'Makefile');
  const prepareTarget = '\n.PHONY: prepare-shared\nprepare-shared: node-check\n\t"$(NODE)" scripts/prepare-shared.mjs "$(SITE_CHECKOUT)"\n';
  const makeSource = readFileSync(makefile, 'utf8');
  writeFileSync(makefile, makeSource.includes(prepareTarget) ? makeSource : makeSource + prepareTarget);
  // Examples are placeholders, even if the development copy was locally filled in.
  writeFileSync(join(source, '.env.example'), 'VITE_SUPABASE_URL=https://your-project.supabase.co\nVITE_SUPABASE_ANON_KEY=sb_publishable_your_public_key\n');
  mkdirSync(dirname(join(source, helperName)), { recursive: true });
  cpSync(file, join(source, helperName));
  cpSync(join(dirname(file), 'check-shared-build.mjs'), join(source, checkerName));
}

function fileSettings(directory) {
  const values = Object.create(null);
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    const path = join(directory, name);
    if (regular(path, 'file')) Object.assign(values, parseEnv(readFileSync(path, 'utf8')));
  }
  return values;
}

function publicSettings(origin, stagedSource, name) {
  const shared = fileSettings(resolve(origin, '../../publishing'));
  const local = fileSettings(origin);
  const settings = Object.create(null);
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    const inherited = process.env[key];
    const appValue = typeof inherited === 'string' ? inherited : local[key];
    const sharedValue = typeof inherited === 'string' ? inherited : shared[key];
    settings[key] = appValue?.trim() || sharedValue?.trim() || '';
  }
  if (!settings.VITE_SUPABASE_URL || !settings.VITE_SUPABASE_ANON_KEY) throw new Error('Set public Supabase URL and anon/publishable key before preparing ' + name + '.');
  if (Object.values(settings).some(value => /\$\{?\w/.test(value))) throw new Error('Set literal public Supabase settings in the build environment before preparing ' + name + '.');
  // Use the app's own public-config policy without printing settings or errors
  // from a subprocess that may carry its environment in diagnostic properties.
  const validator = pathToFileURL(join(stagedSource, 'build-config.ts')).href;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `import { validatePublicConfig } from ${JSON.stringify(validator)}; validatePublicConfig(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);`],
      { stdio: 'pipe', env: { ...process.env, ...settings } });
  } catch { throw new Error(name + ' requires a valid Supabase URL and public anon/publishable key; private settings are rejected.'); }
  return settings;
}

/** Stage, check, build and replace only one owned static app; no publication. */
export function prepareSharedApp(name, origin, target, run = execFileSync) {
  const app = identity(name);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Shared app preparation requires Node.js 24 or newer.');
  if (!regular(origin, 'directory')) throw new Error('Choose the ' + name + ' application source.');
  origin = realpathSync(origin);
  if (!file.endsWith('/scripts/prepare-shared.mjs')) {
    const nested = relative(realpathSync(resolve(dirname(file), '../../..')), stat(target)?.isDirectory() ? realpathSync(target) : resolve(target));
    if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a separate Sites checkout outside the development repository.');
  }
  target = validateSharedAppDestination(target, name);
  const nested = relative(origin, target);
  if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a checkout outside the application source.');
  const site = join(target, app.site);
  const source = join(target, app.source);
  const stage = mkdtempSync(join(target, '.' + name + '-prepare-'));
  let retainStage = false;
  try {
    const stagedSite = join(stage, 'site');
    const stagedSource = join(stage, 'source');
    snapshot(origin, stagedSource, app);
    const packageInfo = JSON.parse(readFileSync(join(stagedSource, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(stagedSource, 'package-lock.json'), 'utf8'));
    const version = packageInfo.version;
    if (packageInfo.name !== name || typeof version !== 'string' || !version || lock.version !== version || lock.packages?.['']?.version !== version) throw new Error('The ' + name + ' package and lockfile versions must match.');
    const settings = publicSettings(origin, stagedSource, name);
    const buildApp = join(stage, 'build-app');
    cpSync(stagedSource, buildApp, { recursive: true });
    const env = { ...process.env, ...settings, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ''), VITE_BASE_PATH: './' };
    run('make', ['-C', buildApp, 'check', 'build', 'NODE=' + process.execPath], { stdio: 'inherit', env });
    const dist = join(buildApp, 'dist');
    if (!regular(join(dist, 'index.html'), 'file')) throw new Error('The ' + name + ' build did not produce dist/index.html.');
    const builtFiles = collect(dist);
    mkdirSync(stagedSite);
    copyFiles(dist, stagedSite, approvedFiles(Object.keys(builtFiles), 'build', app));
    writeFileSync(join(stagedSite, '.nojekyll'), '');
    writeSharedBuildReport(stagedSite, { app: name, version, url: settings.VITE_SUPABASE_URL, key: settings.VITE_SUPABASE_ANON_KEY });
    checkSharedBuild(stagedSite, name);
    const manifest = { format: 1, app: name, version, site: app.site, source: app.source, files: collect(stagedSite), sourceFiles: collect(stagedSource) };
    writeFileSync(join(stagedSource, manifestName), JSON.stringify(manifest, null, 2) + '\n');
    validateSharedAppDestination(target, name);
    mkdirSync(dirname(site), { recursive: true });
    mkdirSync(dirname(source), { recursive: true });
    const oldSite = join(stage, 'previous-site');
    const oldSource = join(stage, 'previous-source');
    let siteMoved = false, sourceMoved = false, siteInstalled = false, sourceInstalled = false;
    try {
      if (stat(site)) { renameSync(site, oldSite); siteMoved = true; }
      if (stat(source)) { renameSync(source, oldSource); sourceMoved = true; }
      renameSync(stagedSite, site); siteInstalled = true;
      renameSync(stagedSource, source); sourceInstalled = true;
    } catch (error) {
      try {
        if (siteInstalled) rmSync(site, { recursive: true, force: true });
        if (sourceInstalled) rmSync(source, { recursive: true, force: true });
        if (siteMoved) renameSync(oldSite, site);
        if (sourceMoved) renameSync(oldSource, source);
      } catch {
        retainStage = true;
        throw new Error('Could not restore previous ' + name + ' files. Preserved backups in ' + stage, { cause: error });
      }
      throw error;
    }
    console.log('Prepared ' + name + ' website and source snapshot.');
    return manifest;
  } finally { if (!retainStage) rmSync(stage, { recursive: true, force: true }); }
}

export const prepareTextDrop = (app, target, run) => prepareSharedApp('textdrop', app, target, run);
export const preparePinboard = (app, target, run) => prepareSharedApp('pinboard', app, target, run);

if (process.argv[1] && stat(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(file)) {
  try {
    if (file.endsWith('/scripts/prepare-shared.mjs')) {
      const origin = resolve(dirname(file), '..');
      const name = JSON.parse(readFileSync(join(origin, 'package.json'), 'utf8')).name;
      if (!process.argv[2]) throw new Error('Pass the existing shared Sites checkout.');
      prepareSharedApp(name, origin, resolve(process.argv[2]));
    } else {
      if (!process.argv[2] || !process.argv[3]) throw new Error('Pass textdrop or pinboard and the existing shared Sites checkout.');
      const name = process.argv[2];
      prepareSharedApp(name, resolve(process.argv[4] || join(dirname(file), '../apps', name)), resolve(process.argv[3]));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

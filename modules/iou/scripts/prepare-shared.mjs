import { lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, cpSync, rmSync, renameSync } from 'node:fs';
import { resolve, dirname, relative, join, delimiter, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const file = fileURLToPath(import.meta.url);
const { checkCloudBuild } = await import(file.endsWith('/scripts/prepare-shared.mjs')
  ? './check-cloud-build.mjs' : '../apps/iou/scripts/check-cloud-build.mjs');
const appName = 'iou';
const siteName = 'site/iou';
const sourceName = 'modules/iou';
const manifestName = 'publish-manifest.json';
const helperName = 'scripts/prepare-shared.mjs';
const filesToCopy = ['Makefile', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts', '.env.example', 'supabase/schema.sql', 'scripts/check-cloud-build.mjs', 'scripts/publishing.test.mjs'];
const publicAssets = new Set(['logo.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']);

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function regular(path, kind) {
  const info = stat(path);
  if (!info) return false;
  if (info.isSymbolicLink()) throw new Error('Refusing a symbolic-link iou publishing path: ' + path);
  if (!(kind === 'directory' ? info.isDirectory() : info.isFile())) throw new Error('Unexpected iou publishing path: ' + path);
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
    if (!Object.keys(expected).some(file => file.startsWith(prefix))) throw new Error('Unowned iou directory: ' + path);
    ownedDirectories(path, expected, base);
  }
}

/** Read-only bootstrap/ownership check, suitable before preparing any other app. */
export function validateIouDestination(target) {
  if (!regular(target, 'directory')) throw new Error('Choose the existing shared Sites checkout.');
  target = realpathSync(target);
  for (const name of ['site', 'modules']) regular(join(target, name), 'directory');
  const git = stat(join(target, '.git'));
  if (!git || git.isSymbolicLink() || !(git.isDirectory() || git.isFile()) || !regular(join(target, 'site/index.html'), 'file')) {
    throw new Error('Choose the existing shared Sites checkout.');
  }
  const site = join(target, siteName);
  const source = join(target, sourceName);
  const siteFiles = collect(site);
  const sourceFiles = collect(source);
  const marker = join(source, manifestName);
  if (!stat(marker)) {
    if ((stat(site) && readdirSync(site).length) || (stat(source) && readdirSync(source).length)) throw new Error('Missing iou ownership manifest; refusing unowned contents.');
    return target;
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(marker, 'utf8')); }
  catch { throw new Error('Invalid iou ownership manifest.'); }
  if (manifest.format !== 1 || manifest.app !== appName || manifest.site !== siteName || manifest.source !== sourceName
    || typeof manifest.version !== 'string' || !manifest.version || !hashMap(manifest.files) || !hashMap(manifest.sourceFiles)
    || !manifest.files['index.html'] || !manifest.files['.nojekyll'] || !manifest.sourceFiles['Makefile']
    || !manifest.sourceFiles['package.json'] || !manifest.sourceFiles[helperName] || manifest.sourceFiles[manifestName]) {
    throw new Error('Invalid iou ownership manifest.');
  }
  delete sourceFiles[manifestName];
  if (!matches(siteFiles, manifest.files) || !matches(sourceFiles, manifest.sourceFiles)) {
    throw new Error('Unowned or modified iou files; preserve those changes before preparing again.');
  }
  ownedDirectories(site, manifest.files);
  ownedDirectories(source, manifest.sourceFiles);
  return target;
}

function approved(name) {
  const parts = name.replaceAll('\\', '/').split('/');
  return parts.every(part => !['.git', '.github', 'node_modules', 'dist', 'build', 'coverage', 'artifacts', 'output', 'recordings', 'test-results', 'playwright-report'].includes(part.toLowerCase())
    && !/^(?:readme|agents)(?:\..*)?$/i.test(part)
    && !/^deployment(?:\..*)?$/i.test(part)
    && !(/^\.env/i.test(part) && name !== '.env.example')
    && !/(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)/i.test(part)
    && !/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log|dmg|zip)$/i.test(part));
}

function approvedFiles(names, kind) {
  return names.filter(name => {
    if (!approved(name)) return false;
    const allowed = kind === 'src' ? /^src\/.+\.(?:ts|tsx|css)$/.test(name)
      : kind === 'public' ? publicAssets.has(name.slice('public/'.length))
      : ['index.html', 'manifest.webmanifest', 'sw.js', '.nojekyll', 'cloud-build.json'].includes(name) || publicAssets.has(name)
        || /^workbox-[A-Za-z0-9_-]+\.js$/.test(name) || /^assets\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(name);
    if (!allowed) throw new Error('Unapproved iou ' + kind + ' file: ' + name);
    return true;
  });
}

function copyFiles(origin, destination, names) {
  for (const name of names) {
    if (!approved(name)) continue;
    mkdirSync(dirname(join(destination, name)), { recursive: true });
    cpSync(join(origin, name), join(destination, name));
  }
}

function snapshot(app, source) {
  mkdirSync(source, { recursive: true });
  for (const name of filesToCopy) {
    const path = join(app, name);
    // Reject linked parents too, especially a linked supabase directory.
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) regular(join(app, ...parts.slice(0, index)), 'directory');
    if (!regular(path, 'file')) throw new Error('Missing approved iou source file: ' + name);
    copyFiles(app, source, [name]);
  }
  for (const name of ['src', 'public']) {
    if (!regular(join(app, name), 'directory')) throw new Error('Missing approved iou source folder: ' + name);
    copyFiles(app, source, approvedFiles(Object.keys(collect(join(app, name), app)), name));
  }
  const makefile = join(source, 'Makefile');
  writeFileSync(makefile, readFileSync(makefile, 'utf8').replace(/^PUBLISH_SCRIPT\s*\?=\s*.*publishing\/iou\.mjs\s*$/m, 'PUBLISH_SCRIPT ?= scripts/prepare-shared.mjs'));
  mkdirSync(dirname(join(source, helperName)), { recursive: true });
  cpSync(file, join(source, helperName));
}

/** Builds and prepares only iou; never pushes, deploys, or changes the catalog. */
export function prepareIou(app, target, run = execFileSync) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('iou preparation requires Node.js 24 or newer.');
  if (!regular(app, 'directory')) throw new Error('Choose the iou application source.');
  app = realpathSync(app);
  if (!file.endsWith('/scripts/prepare-shared.mjs')) {
    const nested = relative(realpathSync(resolve(dirname(file), '../../..')), stat(target)?.isDirectory() ? realpathSync(target) : resolve(target));
    if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a separate Sites checkout outside the development repository.');
  }
  target = validateIouDestination(target);
  const nested = relative(app, target);
  if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a checkout outside the application source.');
  const site = join(target, siteName);
  const source = join(target, sourceName);
  const stage = mkdtempSync(join(target, '.iou-prepare-'));
  let retainStage = false;
  try {
    const stagedSite = join(stage, 'site');
    const stagedSource = join(stage, 'source');
    snapshot(app, stagedSource);
    const version = JSON.parse(readFileSync(join(stagedSource, 'package.json'), 'utf8')).version;
    if (typeof version !== 'string' || !version) throw new Error('The iou package version is missing.');
    // A copied standalone helper builds a temporary copy, keeping its public
    // source snapshot free from generated dependencies and build artifacts.
    let buildApp = app;
    if (source === app) {
      buildApp = join(stage, 'build-app');
      cpSync(stagedSource, buildApp, { recursive: true });
    }
    const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ''), VITE_BASE_PATH: './' };
    run('make', ['-C', buildApp, 'check', 'build', 'NODE=' + process.execPath], { stdio: 'inherit', env });
    const dist = join(buildApp, 'dist');
    if (!regular(join(dist, 'index.html'), 'file')) throw new Error('The iou build did not produce dist/index.html.');
    checkCloudBuild(dist);
    const builtFiles = collect(dist);
    mkdirSync(stagedSite);
    copyFiles(dist, stagedSite, approvedFiles(Object.keys(builtFiles), 'build'));
    writeFileSync(join(stagedSite, '.nojekyll'), '');
    const manifest = { format: 1, app: appName, version, site: siteName, source: sourceName, files: collect(stagedSite), sourceFiles: collect(stagedSource) };
    writeFileSync(join(stagedSource, manifestName), JSON.stringify(manifest, null, 2) + '\n');
    // Detect edits or links introduced while Make was running before replacing.
    validateIouDestination(target);
    mkdirSync(dirname(site), { recursive: true });
    mkdirSync(dirname(source), { recursive: true });
    const oldSite = join(stage, 'previous-site');
    const oldSource = join(stage, 'previous-source');
    let siteMoved = false;
    let sourceMoved = false;
    let siteInstalled = false;
    let sourceInstalled = false;
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
        throw new Error('Could not restore the previous iou files. Preserved backups in ' + stage, { cause: error });
      }
      throw error;
    }
    console.log('Prepared iou website and source snapshot.');
    return manifest;
  } finally {
    if (!retainStage) rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && stat(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(file)) {
  if (!process.argv[2]) { console.error('Use make -C webapps/everydayapps/publishing publish from the development repository root.'); process.exitCode = 1; }
  else {
    const defaultApp = file.endsWith('/scripts/prepare-shared.mjs') ? join(dirname(file), '..') : join(dirname(file), '../apps/iou');
    try { prepareIou(resolve(process.argv[3] || defaultApp), resolve(process.argv[2])); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

import { cpSync, existsSync, mkdirSync, realpathSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const file = fileURLToPath(import.meta.url);

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

const versionPattern = /^\d+\.\d+\.\d+$/;
function validateRelease(release) {
  if (!versionPattern.test(release.version) || !versionPattern.test(release.chrome?.version)) throw new Error('Drafts release versions must be major.minor.patch.');
  let store;
  try { store = new URL(release.chrome.url); }
  catch { throw new Error('Invalid Drafts Chrome Web Store URL.'); }
  if (store.protocol !== 'https:' || store.hostname !== 'chromewebstore.google.com' || !/^\/detail\/drafts\/[a-p]{32}$/.test(store.pathname) || store.port || store.username || store.password || store.search || store.hash) throw new Error('Invalid Drafts Chrome Web Store URL.');
}

export function releaseForApp(app, target, releaseFile) {
  const manifest = JSON.parse(readFileSync(releaseFile ?? join(target, 'modules/drafts/publish-manifest.json'), 'utf8'));
  const version = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
  const extension = JSON.parse(readFileSync(join(app, 'extension/manifest.json'), 'utf8')).version;
  if (!versionPattern.test(version) || extension !== version) throw new Error('Drafts package and Chrome extension versions must match before preparing its website.');
  validateRelease(manifest);
  return { version, chrome: { version, url: manifest.chrome.url } };
}

function renderRelease(html, release) {
  validateRelease(release);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const replace = (pattern, value, label) => {
    if ([...html.matchAll(pattern)].length !== 1) throw new Error('Missing or ambiguous Drafts website release field: ' + label);
    html = html.replace(pattern, (_, before, after) => before + value + after);
  };
  replace(/(<a class="download" href=")[^"]+(">)/g, escape(release.chrome.url), 'Chrome download');
  replace(/(<a href=")[^"]+(">Drafts in the Chrome Web Store<\/a>)/g, escape(release.chrome.url), 'Chrome installation');
  replace(/(<p class="download-meta">Version )[\d.]+( <span[^>]*>·<\/span> Free)/g, release.chrome.version, 'Chrome version');
  replace(/(<span class="footer-version">Drafts · )[\d.]+(<\/span>)/g, release.version, 'footer version');
  return html;
}

function collect(dir, base, files = {}) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not published: ' + path);
    if (entry.isDirectory()) collect(path, base, files);
    else {
      if (!entry.isFile()) throw new Error('Only regular Drafts website files are published: ' + path);
      files[relative(base, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  return files;
}

/** Validate the complete website source and render release fields without writing. */
export function validateDraftsSources(input, release) {
  for (const path of [input, dirname(input)]) if (stat(path)?.isSymbolicLink()) throw new Error('Refusing a symbolic-link Drafts folder.');
  for (const [name, kind] of [['index.html', 'file'], ['styles.css', 'file'], ['assets', 'directory']]) {
    const entry = stat(join(input, name));
    if (!entry) throw new Error('Missing Drafts website input: ' + name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not published: ' + join(input, name));
    if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())) throw new Error('Invalid Drafts website input: ' + name);
  }
  collect(input, input);
  return renderRelease(readFileSync(join(input, 'index.html'), 'utf8'), release);
}

export function prepareDrafts(target, release, website) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Drafts preparation requires Node.js 24 or newer.');
  target = realpathSync(target);
  if (website) {
    const repository = resolve(dirname(file), '../../..');
    const nested = relative(realpathSync(repository), target);
    if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a separate Sites checkout outside the development repository.');
  }
  const module = join(target, 'modules/drafts');
  const input = join(module, 'site');
  const output = join(target, 'site/drafts');
  const marker = join(module, 'publish-manifest.json');
  if (!existsSync(join(target, '.git')) || !existsSync(join(target, 'site/index.html'))) throw new Error('Choose the existing shared Sites checkout.');
  const manifest = JSON.parse(readFileSync(marker, 'utf8'));
  if (manifest.app !== 'drafts' || manifest.site !== 'site/drafts') throw new Error('Invalid Drafts ownership manifest.');
  for (const path of [join(target, "site"), join(target, 'site/index.html'), join(target, "modules"), module, marker, input, join(module, "scripts"), output, ...(website ? [website, dirname(website)] : [])]) if (stat(path)?.isSymbolicLink()) throw new Error('Refusing a symbolic-link Drafts folder.');
  const origin = website ?? input;
  if (website && existsSync(input)) collect(input, input);
  const current = release ?? manifest;
  const metadata = { app: manifest.app, version: current.version, chrome: { version: current.chrome?.version, url: current.chrome?.url }, site: manifest.site };
  const html = validateDraftsSources(origin, metadata);
  if (website) {
    rmSync(input, { recursive: true, force: true });
    mkdirSync(input, { recursive: true });
    for (const name of ['index.html', 'styles.css', 'assets']) cpSync(join(origin, name), join(input, name), { recursive: true });
  }
  writeFileSync(join(input, 'index.html'), html);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const name of ['index.html', 'styles.css', 'assets']) cpSync(join(input, name), join(output, name), { recursive: true });
  writeFileSync(join(output, '.nojekyll'), '');
  writeFileSync(marker, JSON.stringify({ ...metadata, files: collect(output, output) }, null, 2) + '\n');
  if (file !== join(module, 'scripts/prepare-site.mjs')) {
    mkdirSync(join(module, 'scripts'), { recursive: true });
    cpSync(file, join(module, 'scripts/prepare-site.mjs'));
  }
  console.log(`Prepared Drafts ${metadata.version} (Chrome ${metadata.chrome.version}) in ${output}.`);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(file)) {
  const standalone = file.endsWith('/scripts/prepare-site.mjs');
  const target = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(file), standalone ? '../../..' : '../../../../sites');
  try {
    if (standalone) prepareDrafts(target, process.argv[3] ? releaseForApp(resolve(process.argv[3]), target) : undefined);
    else {
      const app = process.argv[3] ? resolve(process.argv[3]) : resolve(dirname(file), '../apps/drafts');
      prepareDrafts(target, releaseForApp(app, target, join(dirname(file), 'releases/drafts.json')), join(dirname(file), 'templates/drafts'));
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const names = new Set(['textdrop', 'pinboard']);
const digest = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;

function containsLiteral(bundle, value) {
  // Rolldown may choose single quotes or a template literal for a constant.
  // Escape template interpolation so this cannot attest executable fragments.
  const escaped = value.replace(/[\\\r\n\t\f\b\u2028\u2029]/g, character => ({
    '\\': '\\\\', '\r': '\\r', '\n': '\\n', '\t': '\\t', '\f': '\\f', '\b': '\\b',
    '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]);
  return [JSON.stringify(value), "'" + escaped.replaceAll("'", "\\'") + "'",
    '`' + escaped.replaceAll('`', '\\`').replaceAll('${', '\\${') + '`'].some(literal => bundle.includes(literal));
}

function scriptFiles(directory) {
  const files = Object.create(null);
  const assets = join(directory, 'assets');
  if (!lstatSync(assets).isDirectory() || lstatSync(assets).isSymbolicLink()) throw new Error('Invalid shared app assets directory.');
  for (const name of readdirSync(assets).sort()) {
    const path = join(assets, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Only regular shared app assets are accepted.');
    if (/^[\w.-]+\.js$/.test(name)) files['assets/' + name] = digest(readFileSync(path));
  }
  return files;
}

function entryScripts(directory, scripts) {
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1].replace(/^\.\//, ''));
  if (!entries.length || entries.some(name => !Object.hasOwn(scripts, name))) throw new Error('Shared app index.html does not load its verified scripts.');
  // All emitted local assets must work beneath the catalog's /<app>/ path.
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^(?:\/|[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) throw new Error('Shared app assets must use relative paths.');
  }
  return entries;
}

/** Attest only a fresh build containing the already validated public settings. */
export function writeSharedBuildReport(directory, { app, version, url, key }) {
  if (!names.has(app) || typeof version !== 'string' || !version) throw new Error('Invalid shared app identity.');
  let keyKind;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) keyKind = 'publishable';
    else {
      const pieces = key.split('.');
      if (pieces.length !== 3 || JSON.parse(Buffer.from(pieces[1], 'base64url').toString()).role !== 'anon') throw new Error();
      keyKind = 'anon';
    }
  } catch { throw new Error('Shared build reports require a public Supabase URL and anon/publishable key.'); }
  const scripts = scriptFiles(directory);
  entryScripts(directory, scripts);
  const bundle = Object.keys(scripts).map(name => readFileSync(join(directory, name), 'utf8')).join('\n');
  if (!url || !key || !containsLiteral(bundle, url) || !containsLiteral(bundle, key)) {
    throw new Error(app + ' build does not contain its verified public Supabase settings.');
  }
  const report = { format: 1, app, version, base: './', cloudConfigured: true,
    publicConfig: { urlSha256: digest(url), keySha256: digest(key), keyKind }, scripts };
  writeFileSync(join(directory, 'shared-build.json'), JSON.stringify(report, null, 2) + '\n');
  return checkSharedBuild(directory, app);
}

/** Fail on missing/stale configuration attestation, links, or changed scripts. */
export function checkSharedBuild(directory, app) {
  let report;
  try { report = JSON.parse(readFileSync(join(directory, 'shared-build.json'), 'utf8')); }
  catch { throw new Error('Missing or invalid shared-build.json; prepare the shared app with its public settings.'); }
  if (!names.has(app) || report.format !== 1 || report.app !== app || typeof report.version !== 'string' || !report.version
    || report.base !== './' || report.cloudConfigured !== true || !report.publicConfig
    || !digestPattern.test(report.publicConfig.urlSha256) || !digestPattern.test(report.publicConfig.keySha256)
    || !['publishable', 'anon'].includes(report.publicConfig.keyKind)
    || !report.scripts || typeof report.scripts !== 'object' || Array.isArray(report.scripts)
    || !Object.keys(report.scripts).length
    || Object.entries(report.scripts).some(([name, hash]) => !/^assets\/[\w.-]+\.js$/.test(name) || !digestPattern.test(hash))) {
    throw new Error('Invalid ' + app + ' public build report.');
  }
  const actual = scriptFiles(directory);
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(report.scripts).sort())
    || Object.keys(actual).some(name => actual[name] !== report.scripts[name])) {
    throw new Error(app + ' scripts changed after public configuration was verified; rebuild before publishing.');
  }
  entryScripts(directory, actual);
  return report;
}

const file = fileURLToPath(import.meta.url);
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === file) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw new Error('Pass the built directory and textdrop or pinboard.');
    checkSharedBuild(resolve(process.argv[2]), process.argv[3]);
    console.log(process.argv[3] + ' public configuration and script checksums verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

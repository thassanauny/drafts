import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, cpSync, rmSync } from 'node:fs';
import { resolve, dirname, relative, join, delimiter, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const file = fileURLToPath(import.meta.url);

export function prepareUtility(app, target, run = execFileSync) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Utility Desk preparation requires Node.js 24 or newer.');
  app = realpathSync(app);
  target = realpathSync(target);
  if (!file.endsWith('/scripts/prepare-shared.mjs')) {
    const nested = relative(realpathSync(resolve(dirname(file), '../../..')), target);
    if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a separate Sites checkout outside the development repository.');
  }
  const site = join(target, 'site/utility-desk');
  const source = join(target, 'modules/utility-desk');
  const marker = join(source, 'publish-manifest.json');
  const nested = relative(app, target);
  if (!nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith('..' + sep))) throw new Error('Choose a checkout outside the application source.');
  if (!existsSync(join(target, '.git')) || !existsSync(join(target, 'site/index.html'))) throw new Error('Choose the existing shared Sites checkout.');
  if (!existsSync(marker)) throw new Error('Missing Utility Desk ownership manifest.');
  const previous = JSON.parse(readFileSync(marker, 'utf8'));
  if (previous.app !== 'utility-desk' || previous.site !== 'site/utility-desk') throw new Error('Invalid Utility Desk ownership manifest.');
  for (const path of [join(target, "site"), join(target, "modules"), site, source]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing a symbolic-link Utility Desk folder.');
  const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || ''), BASE_PATH: './' };
  run('make', ['-C', app, 'check', 'build', 'NODE=' + process.execPath], { stdio: 'inherit', env });
  const collect = (dir, base, files = {}) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not published: ' + path);
      if (stat.isDirectory()) collect(path, base, files);
      else files[relative(base, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    return files;
  };
  const dist = join(app, 'dist');
  collect(dist, dist); // Reject source links before replacing generated output.
  rmSync(site, { recursive: true, force: true });
  cpSync(dist, site, { recursive: true });
  writeFileSync(join(site, '.nojekyll'), '');
  if (source !== app) {
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true });
    for (const name of ['src', 'tests', 'public', 'index.html', 'Makefile', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'eslint.config.js', 'PARITY.md']) {
      cpSync(join(app, name), join(source, name), { recursive: true });
    }
    const makefile = join(source, 'Makefile');
    writeFileSync(makefile, readFileSync(makefile, 'utf8').replace('PUBLISH_SCRIPT ?= ../../publishing/utility-desk.mjs', 'PUBLISH_SCRIPT ?= scripts/prepare-shared.mjs'));
    mkdirSync(join(source, 'scripts'), { recursive: true });
    cpSync(file, join(source, 'scripts/prepare-shared.mjs'));
  }
  const version = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
  writeFileSync(marker, JSON.stringify({ app: 'utility-desk', version, site: 'site/utility-desk', files: collect(site, site) }, null, 2) + '\n');
  console.log(`Prepared Utility Desk Lite ${version} in ${site}.`);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(file)) {
  if (!process.argv[2]) { console.error('Use make -C webapps/everydayapps/publishing publish from the development repository root.'); process.exitCode = 1; }
  else {
    const defaultApp = file.endsWith('/scripts/prepare-shared.mjs') ? join(dirname(file), '..') : join(dirname(file), '../apps/utility-desk-lite');
    try { prepareUtility(resolve(process.argv[3] || defaultApp), resolve(process.argv[2])); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

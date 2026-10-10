import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Reject missing configuration or a report left over from a different build. */
export function checkCloudBuild(directory) {
  let report;
  try { report = JSON.parse(readFileSync(join(directory, 'cloud-build.json'), 'utf8')); }
  catch { throw new Error('iou has no valid cloud-build.json. Rebuild with its public Supabase URL and key before publishing.'); }
  if (!report || report.format !== 1 || report.app !== 'iou' || report.cloudConfigured !== true
    || !report.scripts || typeof report.scripts !== 'object' || Array.isArray(report.scripts)
    || !Object.keys(report.scripts).length) {
    throw new Error('iou is missing its verified Supabase configuration.');
  }
  for (const [name, digest] of Object.entries(report.scripts)) {
    if (!/^assets\/[\w.-]+\.js$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Invalid iou cloud build report.');
    }
    let actual;
    try { actual = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'); }
    catch { throw new Error('An iou script is missing. Rebuild before publishing.'); }
    if (actual !== digest) throw new Error('iou scripts changed after their cloud configuration was verified. Rebuild before publishing.');
  }
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
    .map((match) => match[1].replace(/^\.\//, ''));
  if (!entries.length || entries.some((name) => !Object.hasOwn(report.scripts, name))) {
    throw new Error('iou index.html does not load the verified app build.');
  }
  return report;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Pass the built iou directory.');
    checkCloudBuild(resolve(process.argv[2]));
    console.log('iou Supabase configuration and app script checksums verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

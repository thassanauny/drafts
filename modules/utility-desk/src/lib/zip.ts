import { zipSync, unzipSync } from 'fflate';

export interface ZipItem { name: string; data: Uint8Array }

export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = seen.get(k) ?? 0;
    seen.set(k, c + 1);
    if (!c) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)}-${c + 1}${n.slice(dot)}` : `${n}-${c + 1}`;
  });
}

/** Entry names may contain "/" for subfolders, but never "..", absolute paths or backslashes. */
export function safeZipPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/') || 'file';
}

export function makeZip(items: ZipItem[], opts: { store?: boolean } = {}): Uint8Array {
  const names = uniqueNames(items.map((i) => safeZipPath(i.name)));
  const files: Record<string, Uint8Array> = {};
  items.forEach((it, i) => { files[names[i]] = it.data; });
  return zipSync(files, { level: opts.store ? 0 : 6 });
}

export function readZip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

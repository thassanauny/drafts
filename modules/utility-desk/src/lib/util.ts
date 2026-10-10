export function sanitizeFilename(name: string, fallback = 'file'): string {
  // eslint-disable-next-line no-control-regex
  let n = name.replace(/[\\/]+/g, '_').replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  if (n.length > 120) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** A browser picker creates a new File object when the same source is selected again. */
export function fileSourceKey(file: File | null): string {
  return file ? JSON.stringify([file.name, file.size, file.lastModified, file.type]) : '';
}

/** Suggest a filename stem when the source changes; exporters add the extension. */
export function suggestOutputName(control: HTMLInputElement, suffix: string) {
  return (source = '') => {
    const suggestion = source ? sanitizeFilename(`${baseName(source)}_${suffix}`) : '';
    control.value = suggestion;
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

/** Tracks object URLs so they can all be revoked. */
export class UrlBag {
  private urls = new Set<string>();
  make(blob: Blob): string { const u = URL.createObjectURL(blob); this.urls.add(u); return u; }
  revoke(u: string) { if (this.urls.delete(u)) URL.revokeObjectURL(u); }
  revokeAll() { this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls.clear(); }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = sanitizeFilename(filename, 'download');
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  // Retain the hidden anchor briefly for embedded browsers, then release it.
  const root = document.getElementById('main');
  const release = () => { clearTimeout(timer); URL.revokeObjectURL(url); a.remove(); root?.removeEventListener('utility-desk:leave', release); };
  const timer = setTimeout(release, 10 * 60_000);
  root?.addEventListener('utility-desk:leave', release, { once: true });
}

export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as BlobPart], { type });
}

export async function readFileBytes(file: File, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const bytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  return bytes;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

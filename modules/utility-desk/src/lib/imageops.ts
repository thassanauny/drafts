/** Pixel/geometry helpers (RGBA, Uint8ClampedArray) and cancellable canvas encoding. */
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function grayscale(d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; }
}
export function sepia(d: Uint8ClampedArray) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = clamp(0.393 * r + 0.769 * g + 0.189 * b);
    d[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b);
    d[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b);
  }
}
/** amount in [-100, 100] */
export function contrast(d: Uint8ClampedArray, amount: number) {
  const a = Math.max(-100, Math.min(100, amount));
  const f = (259 * (a * 2.55 + 255)) / (255 * (259 - a * 2.55));
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp(f * (d[i + c] - 128) + 128);
}
export function autoContrast(d: Uint8ClampedArray) {
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) for (let c = 0; c < 3; c++) { lo = Math.min(lo, d[i + c]); hi = Math.max(hi, d[i + c]); }
  if (hi <= lo) return;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp((d[i + c] - lo) * 255 / (hi - lo));
}

export type Sizing = 'maximum' | 'cover' | 'contain' | 'stretch';
export function sizeImage(w: number, h: number, width: number | undefined, height: number | undefined, mode: Sizing, enlarge: boolean) {
  for (const n of [width, height]) if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 20000)) throw new Error('Dimensions must be whole numbers from 1 to 20,000 pixels.');
  if (!width && !height) return { width: w, height: h, x: 0, y: 0, drawWidth: w, drawHeight: h };
  if (mode === 'maximum') {
    const scale = Math.min(width ? width / w : Infinity, height ? height / h : Infinity, enlarge ? Infinity : 1);
    const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
    return { width: ow, height: oh, x: 0, y: 0, drawWidth: ow, drawHeight: oh };
  }
  if (!width || !height) throw new Error('Exact sizing requires both width and height.');
  const scale = mode === 'cover' ? Math.max(width / w, height / h) : Math.min(width / w, height / h);
  const dw = mode === 'stretch' ? width : w * scale, dh = mode === 'stretch' ? height : h * scale;
  return { width, height, x: (width - dw) / 2, y: (height - dh) / 2, drawWidth: dw, drawHeight: dh };
}
/** Light unsharp via 3x3 kernel; strength 0..1 */
export function sharpen(d: Uint8ClampedArray, w: number, h: number, strength = 0.5) {
  if (strength <= 0 || w < 3 || h < 3) return;
  const src = new Uint8ClampedArray(d);
  const k = strength;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const lap = 4 * src[i + c] - src[i - 4 + c] - src[i + 4 + c] - src[i - w * 4 + c] - src[i + w * 4 + c];
      d[i + c] = clamp(src[i + c] + k * lap);
    }
  }
}

export interface Rect { x: number; y: number; width: number; height: number }
export function clampCrop(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(w - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(r.y)));
  return { x, y, width: Math.max(1, Math.min(w - x, Math.round(r.width))), height: Math.max(1, Math.min(h - y, Math.round(r.height))) };
}
export function rotatedSize(w: number, h: number, deg: number): [number, number] {
  return ((deg % 180) + 180) % 180 === 90 ? [h, w] : [w, h];
}
export const MAX_PIXELS = 100_000_000;
// Extension aliases also admit images whose OS supplies no MIME type.
export const IMAGE_ACCEPT = 'image/*,.png,.jpg,.jpeg,.jfif,.webp,.gif,.avif,.bmp,.svg,.ico';

export function detectUnsupportedImage(file: { name: string; type: string }): string | null {
  const n = file.name.toLowerCase();
  if (/\.(heic|heif)$/.test(n) || /image\/hei[cf]/.test(file.type))
    return 'HEIC/HEIF is not decodable by most browsers (Safari can). Convert it to JPEG or PNG on your device first; no server-side conversion is used here.';
  if (/\.(tiff?|raw|cr2|nef|arw|dng|psd)$/.test(n)) return 'This format is not supported by browser image APIs. Convert it to PNG or JPEG first.';
  return null;
}

/** Settle immediately on cancellation; late browser callbacks cannot revive the operation. */
export function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number, signal?: AbortSignal): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try { canvas.toBlob((result) => { cleanup(); resolve(result); }, type, quality); }
    catch (error) { cleanup(); reject(error); }
  });
}

/** Highest quality whose encoded size fits `maxBytes` (binary search). Throws when even the lowest quality is too big. */
export async function encodeWithinLimit(encode: (quality: number) => Promise<Blob | null>, startQuality: number, maxBytes: number, minQuality = 0.01): Promise<Blob> {
  const first = await encode(startQuality);
  if (!first) throw new Error('This browser cannot encode that format.');
  if (first.size <= maxBytes) return first;
  const floor = await encode(minQuality);
  if (!floor || floor.size > maxBytes) throw new Error('Cannot reach that file size by lowering quality. Reduce the dimensions or raise the limit. Nothing was saved.');
  let best = floor, lo = minQuality, hi = startQuality;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const b = await encode(mid);
    if (b && b.size <= maxBytes) { best = b; lo = mid; } else hi = mid;
  }
  return best;
}

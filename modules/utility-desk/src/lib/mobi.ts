/** Basic MOBI (MOBI 6 / PalmDOC) reader and writer. Text only: no images, KF8/AZW3, Huffman compression or DRM. */
const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
const ascii = (d: Uint8Array, o: number, n: number) => String.fromCharCode(...d.subarray(o, o + n));

export function palmDocDecompress(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c === 0 || (c >= 9 && c <= 0x7f)) out.push(c);
    else if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < data.length; k++) out.push(data[i++]); }
    else if (c >= 0xc0) out.push(0x20, c ^ 0x80);
    else {
      const pair = (c << 8) | (data[i++] ?? 0);
      const dist = (pair >> 3) & 0x7ff, len = (pair & 7) + 3;
      if (dist === 0 || dist > out.length) throw new Error('Corrupt MOBI text data');
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    }
  }
  return Uint8Array.from(out);
}

function trailingSize(rec: Uint8Array, flags: number): number {
  let num = 0;
  for (let f = flags >> 1; f; f >>= 1) {
    if (f & 1) {
      let size = 0, shift = 0;
      for (let k = 0; k < 4; k++) { const b = rec[rec.length - num - 1 - k]; size |= (b & 0x7f) << shift; shift += 7; if (b & 0x80) break; }
      num += size;
    }
  }
  if (flags & 1) num += (rec[rec.length - num - 1] & 3) + 1;
  return num;
}

export function mobiToHtml(bytes: Uint8Array): { title: string; html: string } {
  if (bytes.length < 100 || ascii(bytes, 60, 8) !== 'BOOKMOBI') throw new Error('Not a MOBI file (BOOKMOBI signature missing).');
  const n = u16(bytes, 76);
  const offsets = Array.from({ length: n }, (_, i) => u32(bytes, 78 + i * 8));
  const rec = (i: number) => bytes.subarray(offsets[i], i + 1 < n ? offsets[i + 1] : bytes.length);
  const r0 = rec(0);
  const compression = u16(r0, 0), textRecords = u16(r0, 8), encryption = u16(r0, 12);
  if (encryption !== 0) throw new Error('This MOBI is DRM-protected and cannot be converted.');
  if (compression === 17480) throw new Error('HUFF/CDIC-compressed MOBI is not supported.');
  if (compression !== 1 && compression !== 2) throw new Error('Unknown MOBI compression.');
  if (ascii(r0, 16, 4) !== 'MOBI') throw new Error('Missing MOBI header.');
  const headerLen = u32(r0, 20), encoding = u32(r0, 28), version = u32(r0, 36);
  if (version >= 8) throw new Error('AZW3/KF8 files are not supported (only classic MOBI 6).');
  const flags = headerLen >= 228 ? u16(r0, 242) : 0;
  const parts: Uint8Array[] = [];
  for (let i = 1; i <= textRecords && i < n; i++) {
    const r = rec(i);
    const body = r.subarray(0, r.length - trailingSize(r, flags));
    parts.push(compression === 2 ? palmDocDecompress(body) : body);
  }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; parts.forEach((p) => { all.set(p, o); o += p.length; });
  const text = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(all);
  const nameOff = u32(r0, 84), nameLen = u32(r0, 88);
  const title = nameLen && nameOff + nameLen <= r0.length ? new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(r0.subarray(nameOff, nameOff + nameLen)) : 'Untitled';
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script,style,img,head,link').forEach((e) => e.remove());
  doc.querySelectorAll('mbp\\:pagebreak,mbp\\:nu,mbp\\:section').forEach((e) => e.replaceWith(...e.childNodes));
  doc.querySelectorAll('a').forEach((a) => { if (!/^https?:|^mailto:/i.test(a.getAttribute('href') ?? '')) a.replaceWith(...a.childNodes); });
  const html = doc.body.innerHTML.trim();
  if (!html) throw new Error('No readable text found in this MOBI.');
  return { title: title.trim() || 'Untitled', html };
}

const w16 = (v: DataView, o: number, x: number) => v.setUint16(o, x);
const w32 = (v: DataView, o: number, x: number) => v.setUint32(o, x >>> 0);

export function buildMobi(title: string, bodyHtml: string, author = ''): Uint8Array {
  const enc = new TextEncoder();
  const text = enc.encode(`<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body>${bodyHtml}</body></html>`);
  const chunks: Uint8Array[] = [];
  for (let s = 0; s < text.length;) {
    let e = Math.min(s + 4096, text.length);
    while (e < text.length && (text[e] & 0xc0) === 0x80) e--; // never split a UTF-8 sequence
    chunks.push(text.subarray(s, e)); s = e;
  }
  if (!chunks.length) chunks.push(new Uint8Array(0));
  const name = enc.encode(title || 'Untitled');
  const exthRec = (type: number, data: Uint8Array) => { const b = new Uint8Array(8 + data.length); const v = new DataView(b.buffer); w32(v, 0, type); w32(v, 4, 8 + data.length); b.set(data, 8); return b; };
  const records = [...(author ? [exthRec(100, enc.encode(author))] : []), exthRec(501, enc.encode('EBOK')), exthRec(503, name)];
  const exthBody = records.reduce((a, r) => a + r.length, 0);
  const exthLen = 12 + exthBody, exthPad = (4 - (exthLen % 4)) % 4;
  const headerLen = 232, mobiStart = 16, exthStart = mobiStart + headerLen;
  const nameStart = exthStart + exthLen + exthPad;
  const r0 = new Uint8Array(nameStart + name.length + 2 + 1024 - ((nameStart + name.length + 2) % 1024 || 1024) + 0);
  const v = new DataView(r0.buffer);
  w16(v, 0, 1); w32(v, 4, text.length); w16(v, 8, chunks.length); w16(v, 10, 4096);
  r0.set(enc.encode('MOBI'), 16); w32(v, 20, headerLen); w32(v, 24, 2); w32(v, 28, 65001); w32(v, 32, Math.floor(Math.random() * 0xffffffff)); w32(v, 36, 6);
  for (let o = 40; o < 80; o += 4) w32(v, o, 0xffffffff);
  w32(v, 80, chunks.length + 1); w32(v, 84, nameStart); w32(v, 88, name.length); w32(v, 92, 0x409); w32(v, 104, 6); w32(v, 108, 0xffffffff);
  w32(v, 128, 0x40); w32(v, 164, 0xffffffff); w32(v, 168, 0xffffffff);
  w16(v, 192, 1); w16(v, 194, chunks.length); w32(v, 196, 1); w32(v, 200, 0xffffffff); w32(v, 208, 0xffffffff); w32(v, 244, 0xffffffff);
  r0.set(enc.encode('EXTH'), exthStart); w32(v, exthStart + 4, exthLen); w32(v, exthStart + 8, records.length);
  let p = exthStart + 12; records.forEach((r) => { r0.set(r, p); p += r.length; });
  r0.set(name, nameStart);

  const eof = Uint8Array.from([0xe9, 0x8e, 0x0d, 0x0a]);
  const recs = [r0, ...chunks, eof];
  const count = recs.length;
  const headerSize = 78 + count * 8 + 2;
  const total = headerSize + recs.reduce((a, r) => a + r.length, 0);
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  out.set(enc.encode((title || 'Untitled').replace(/[^\x20-\x7e]/g, '_').slice(0, 31)), 0);
  const now = Math.floor(Date.now() / 1000) + 2082844800;
  w32(ov, 36, now); w32(ov, 40, now);
  out.set(enc.encode('BOOKMOBI'), 60); w32(ov, 68, 2 * count - 1); w16(ov, 76, count);
  let off = headerSize;
  recs.forEach((r, i) => { w32(ov, 78 + i * 8, off); w32(ov, 78 + i * 8 + 4, 2 * i); out.set(r, off); off += r.length; });
  return out;
}

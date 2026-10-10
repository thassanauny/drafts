import { PDFDocument, PageSizes, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import { restoreStreamLengths } from './pdfStreams';
import { throwIfAborted } from './util';

export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  return doc.getPageCount();
}

export interface MergeSource { bytes: Uint8Array; /** 1-based pages; all pages when omitted */ pages?: number[] }

async function loadForCopy(bytes: Uint8Array, signal?: AbortSignal): Promise<PDFDocument> {
  throwIfAborted(signal);
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  await restoreStreamLengths(document, bytes, signal);
  throwIfAborted(signal);
  return document;
}

export async function mergePdfs(sources: MergeSource[], signal?: AbortSignal, onProgress?: (p: number) => void): Promise<Uint8Array> {
  if (!sources.length) throw new Error('Add at least one PDF');
  throwIfAborted(signal);
  const out = await PDFDocument.create();
  for (let i = 0; i < sources.length; i++) {
    const src = await loadForCopy(sources[i].bytes, signal);
    const idx = (sources[i].pages ?? src.getPageIndices().map((n) => n + 1)).map((n) => n - 1);
    const pages = await out.copyPages(src, idx);
    pages.forEach((p) => out.addPage(p));
    onProgress?.((i + 1) / sources.length);
  }
  throwIfAborted(signal);
  const bytes = await out.save();
  throwIfAborted(signal);
  return bytes;
}

export function extractPages(bytes: Uint8Array, pages: number[], signal?: AbortSignal, onProgress?: (p: number) => void): Promise<Uint8Array> {
  return mergePdfs([{ bytes, pages }], signal, onProgress);
}

export async function splitEachPage(bytes: Uint8Array, signal?: AbortSignal, onProgress?: (p: number) => void, selected?: number[]): Promise<Uint8Array[]> {
  const src = await loadForCopy(bytes, signal);
  const pages = selected ?? src.getPageIndices().map((i) => i + 1);
  const n = pages.length;
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    throwIfAborted(signal);
    const d = await PDFDocument.create();
    const [p] = await d.copyPages(src, [pages[i] - 1]);
    d.addPage(p);
    out.push(await d.save());
    onProgress?.((i + 1) / n);
  }
  throwIfAborted(signal);
  return out;
}

export type PageSizeName = 'A4' | 'Letter' | 'Fit';
export type Fit = 'contain' | 'cover' | 'stretch' | 'original';
export interface ImageToPdfOptions { pageSize: PageSizeName; orientation: 'portrait' | 'landscape' | 'auto'; fit: Fit; dpi: number; marginPt: number }
export interface PdfImage { bytes: Uint8Array; type: 'png' | 'jpg'; width: number; height: number }

export function pageDimensions(size: PageSizeName, orientation: 'portrait' | 'landscape' | 'auto', img: { width: number; height: number }, dpi: number): [number, number] {
  if (size === 'Fit') return [(img.width / dpi) * 72, (img.height / dpi) * 72];
  const base = size === 'A4' ? PageSizes.A4 : PageSizes.Letter;
  const [w, h] = base;
  const landscape = orientation === 'auto' ? img.width > img.height : orientation === 'landscape';
  return landscape ? [h, w] : [w, h];
}

/** Placement of an image on a page, in PDF points (origin bottom-left). */
export function layoutImage(img: { width: number; height: number }, page: [number, number], fit: Fit, dpi: number, margin: number) {
  const aw = Math.max(1, page[0] - margin * 2), ah = Math.max(1, page[1] - margin * 2);
  let w: number, h: number;
  if (fit === 'stretch') { w = aw; h = ah; }
  else if (fit === 'original') { w = (img.width / dpi) * 72; h = (img.height / dpi) * 72; }
  else {
    const s = fit === 'contain' ? Math.min(aw / img.width, ah / img.height) : Math.max(aw / img.width, ah / img.height);
    w = img.width * s; h = img.height * s;
  }
  return { x: (page[0] - w) / 2, y: (page[1] - h) / 2, width: w, height: h };
}

export async function imagesToPdf(images: PdfImage[], opts: ImageToPdfOptions, signal?: AbortSignal, onProgress?: (p: number) => void): Promise<Uint8Array> {
  if (!images.length) throw new Error('Add at least one image');
  const doc = await PDFDocument.create();
  for (let i = 0; i < images.length; i++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const im = images[i];
    const emb = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    const dims = pageDimensions(opts.pageSize, opts.orientation, im, opts.dpi);
    const page = doc.addPage(dims);
    const margin = opts.pageSize === 'Fit' ? 0 : opts.marginPt;
    const l = layoutImage(im, dims, opts.fit, opts.dpi, margin);
    if (opts.fit === 'cover') page.pushOperators(pushGraphicsState(), rectangle(margin, margin, dims[0] - margin * 2, dims[1] - margin * 2), clip(), endPath());
    page.drawImage(emb, l);
    if (opts.fit === 'cover') page.pushOperators(popGraphicsState());
    onProgress?.((i + 1) / images.length);
  }
  return doc.save();
}

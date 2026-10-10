import { beforeAll, describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import { parsePageRanges } from '../src/lib/ranges';
import { mergePdfs, splitEachPage, extractPages, pageCount, layoutImage, pageDimensions, imagesToPdf } from '../src/lib/pdfops';

beforeAll(() => { pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')).href; });

async function makePdf(n: number) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([100 + i, 200]);
  return d.save();
}

describe('page ranges', () => {
  it('parses lists, ranges and open ends', () => {
    expect(parsePageRanges('1-3, 5, 8-', 9)).toEqual([1, 2, 3, 5, 8, 9]);
    expect(parsePageRanges('', 3)).toEqual([1, 2, 3]);
    expect(parsePageRanges('-2', 5)).toEqual([1, 2]);
    expect(parsePageRanges('3,3,1', 5)).toEqual([1, 3]);
  });
  it('rejects invalid input', () => {
    expect(() => parsePageRanges('0', 5)).toThrow();
    expect(() => parsePageRanges('6', 5)).toThrow();
    expect(() => parsePageRanges('4-2', 5)).toThrow();
    expect(() => parsePageRanges('a', 5)).toThrow();
  });
});

describe('pdf operations', () => {
  it('merges with selected pages and preserves sources', async () => {
    const a = await makePdf(3), b = await makePdf(2);
    const copyA = a.slice();
    const merged = await mergePdfs([{ bytes: a, pages: [1, 3] }, { bytes: b }]);
    expect(await pageCount(merged)).toBe(4);
    const doc = await PDFDocument.load(merged);
    expect(doc.getPage(1).getWidth()).toBe(102);
    expect(a).toEqual(copyA);
  });
  it('splits each page and extracts ranges', async () => {
    const src = await makePdf(4);
    const parts = await splitEachPage(src);
    expect(parts).toHaveLength(4);
    expect(await pageCount(parts[2])).toBe(1);
    expect(await pageCount(await extractPages(src, [2, 4]))).toBe(2);
  });
  it('honours cancellation', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(mergePdfs([{ bytes: await makePdf(1) }], ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('honours cancellation at the final progress update', async () => {
    const bytes = await makePdf(1);
    const merge = new AbortController();
    await expect(mergePdfs([{ bytes }], merge.signal, () => merge.abort())).rejects.toMatchObject({ name: 'AbortError' });
    const split = new AbortController();
    await expect(splitEachPage(bytes, split.signal, () => split.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('lays out images', () => {
    const page = pageDimensions('A4', 'auto', { width: 2000, height: 1000 }, 150);
    expect(page[0]).toBeGreaterThan(page[1]);
    const l = layoutImage({ width: 1000, height: 1000 }, [200, 100], 'contain', 150, 0);
    expect(l).toMatchObject({ width: 100, height: 100, x: 50, y: 0 });
    expect(layoutImage({ width: 1000, height: 1000 }, [200, 100], 'cover', 150, 0).width).toBe(200);
    expect(pageDimensions('Fit', 'auto', { width: 300, height: 150 }, 150)).toEqual([144, 72]);
  });
  it('builds a PDF from images', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const pdf = await imagesToPdf([{ bytes: png, type: 'png', width: 1, height: 1 }, { bytes: png, type: 'png', width: 1, height: 1 }], { pageSize: 'A4', orientation: 'portrait', fit: 'contain', dpi: 150, marginPt: 10 });
    expect(await pageCount(pdf)).toBe(2);
  });
  it('clips fill-crop images to the rectangle inside the requested margins', async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    for (const orientation of ['portrait', 'landscape'] as const) {
      const bytes = await imagesToPdf([{ bytes: png, type: 'png', width: 200, height: 100 }], { pageSize: 'A4', orientation, fit: 'cover', dpi: 150, marginPt: 72 });
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      try {
        const page = await doc.getPage(1), ops = await page.getOperatorList();
        const clipIndex = ops.fnArray.indexOf(pdfjs.OPS.clip);
        const imageIndex = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
        expect(clipIndex).toBeGreaterThan(0);
        expect(clipIndex).toBeLessThan(imageIndex);
        const pathIndex = ops.fnArray.indexOf(pdfjs.OPS.constructPath);
        const viewport = page.getViewport({ scale: 1 });
        expect(ops.argsArray[pathIndex][0]).toContain(pdfjs.OPS.rectangle);
        expect(ops.argsArray[pathIndex][1]).toEqual([72, 72, viewport.width - 144, viewport.height - 144]);
        expect(ops.fnArray.slice(imageIndex + 1)).toContain(pdfjs.OPS.restore);
      } finally { await doc.destroy(); }
    }
  });
});

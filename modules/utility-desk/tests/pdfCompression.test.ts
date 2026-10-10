import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { zlibSync, unzlibSync } from 'fflate';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { compressPdf, compressionResult } from '../src/lib/pdfCompression';

beforeAll(() => { pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')).href; });
afterEach(() => { vi.restoreAllMocks(); });

async function fixture() {
  const doc = await PDFDocument.create();
  doc.setTitle('Compression fixture'); doc.setAuthor('Fixture author');
  const page = doc.addPage([300, 400]); page.drawText('Selectable original text', { x: 20, y: 350, size: 12 });
  page.node.addContentStream(doc.context.register(doc.context.stream('% repeated padding for lossless compression\n'.repeat(1000))));
  const field = doc.getForm().createTextField('name'); field.setText('Editable value'); field.addToPage(page, { x: 20, y: 20, width: 150, height: 30 });
  const second = doc.addPage([500, 200]);
  second.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: { S: 'URI', URI: 'https://example.com' } }))]));
  const predictorData = new Uint8Array(20000).fill(42);
  doc.context.register(doc.context.stream(zlibSync(predictorData, { level: 0 }), { Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: 10 }, Fixture: 'Predictor' }));
  doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3, 4]), { Filter: ['ASCIIHexDecode', 'FlateDecode'], Fixture: 'Opaque' }));
  return { bytes: await doc.save({ useObjectStreams: false }), predictorData };
}

describe('PDF compression', () => {
  it('reduces storage while preserving selectable text, page sizes, metadata, links and forms', async () => {
    const { bytes, predictorData } = await fixture(), original = bytes.slice();
    const result = await compressPdf(bytes, 'lossless');
    expect(result.bytes.length).toBeLessThan(bytes.length);
    expect(result.pages).toBe(2); expect(result.savedBytes).toBe(bytes.length - result.bytes.length);
    expect(result.savedPercent).toBeCloseTo(result.savedBytes / bytes.length * 100);
    expect(bytes).toEqual(original);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getTitle()).toBe('Compression fixture'); expect(doc.getAuthor()).toBe('Fixture author');
    expect(doc.getPages().map((page) => page.getSize())).toEqual([{ width: 300, height: 400 }, { width: 500, height: 200 }]);
    expect(doc.getForm().getTextField('name').getText()).toBe('Editable value');
    const annots = doc.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.lookup(0, PDFDict).lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream)) continue;
      if (object.dict.lookup(PDFName.of('Fixture')) === PDFName.of('Predictor')) {
        expect(unzlibSync(object.getContents())).toEqual(predictorData);
        expect(object.dict.lookup(PDFName.of('DecodeParms'), PDFDict).lookup(PDFName.of('Predictor'))?.toString()).toBe('12');
      }
      if (object.dict.lookup(PDFName.of('Fixture')) === PDFName.of('Opaque')) expect(object.getContents()).toEqual(new Uint8Array([1, 2, 3, 4]));
    }
    const rendered = await pdfjs.getDocument({ data: result.bytes.slice() }).promise;
    try {
      const content = await (await rendered.getPage(1)).getTextContent();
      expect(content.items.map((item) => 'str' in item ? item.str : '').join(' ')).toContain('Selectable original text');
    } finally { await rendered.destroy(); }
  });

  it('keeps the source bytes when optimization produces an equal or larger file', () => {
    const original = new Uint8Array([1, 2, 3]);
    for (const candidate of [new Uint8Array(3), new Uint8Array(4)]) {
      expect(compressionResult(original, candidate, 1)).toMatchObject({ bytes: original, savedBytes: 0, savedPercent: 0, unchanged: true });
    }
  });

  it('rejects malformed, encrypted, empty and excessive-page inputs', async () => {
    await expect(compressPdf(new Uint8Array([1, 2]), 'lossless')).rejects.toThrow();
    const empty = await PDFDocument.create();
    await expect(compressPdf(await empty.save({ addDefaultPage: false }), 'lossless')).rejects.toThrow(/1,000 pages/);
    for (let i = 0; i < 1001; i++) empty.addPage([10, 10]);
    await expect(compressPdf(await empty.save(), 'lossless')).rejects.toThrow(/1,000 pages/);
    const encrypted = await PDFDocument.create(); encrypted.addPage();
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard' }));
    await expect(compressPdf(await encrypted.save(), 'lossless')).rejects.toThrow(/protected/i);
  });

  it('honors cancellation before starting and between optimization steps', async () => {
    const { bytes } = await fixture();
    const early = new AbortController(); early.abort();
    await expect(compressPdf(bytes, 'lossless', early.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const active = new AbortController();
    await expect(compressPdf(bytes, 'lossless', active.signal, () => active.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

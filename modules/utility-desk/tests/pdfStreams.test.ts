import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { zlibSync, unzlibSync } from 'fflate';
import { restoreStreamLengths } from '../src/lib/pdfStreams';
import { compressPdf } from '../src/lib/pdfCompression';
import { extractPages, mergePdfs, splitEachPage } from '../src/lib/pdfops';

function fixture() {
  const encoder = new TextEncoder();
  let plain!: Uint8Array, compressed!: Uint8Array;
  for (let i = 0; i < 256; i++) {
    plain = encoder.encode('% ' + 'padding '.repeat(1000) + 'a'.repeat(i) + '\n');
    compressed = zlibSync(plain);
    if (compressed.at(-1) === 13) break;
  }
  expect(compressed.at(-1)).toBe(13);
  const parts: Uint8Array[] = [encoder.encode('%PDF-1.5\n')];
  const offsets = [0];
  let size = parts[0].length;
  const add = (number: number, content: Uint8Array) => {
    offsets[number] = size;
    const bytes = [encoder.encode(`${number} 0 obj\n`), content, encoder.encode('\nendobj\n')];
    parts.push(...bytes); size += bytes.reduce((total, bytes) => total + bytes.length, 0);
  };
  add(1, encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'));
  add(2, encoder.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  add(3, encoder.encode('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>'));
  const header = encoder.encode('<< /Filter /FlateDecode /Length 5 0 R >>\nstream\n');
  const tail = encoder.encode('\nendstream');
  const stream = new Uint8Array(header.length + compressed.length + tail.length);
  stream.set(header); stream.set(compressed, header.length); stream.set(tail, header.length + compressed.length);
  add(4, stream); add(5, encoder.encode(String(compressed.length)));
  const padding = 'unused padding '.repeat(1000);
  add(6, encoder.encode(`<< /Length ${padding.length} >>\nstream\n${padding}\nendstream`));
  parts.push(encoder.encode(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  const original = new Uint8Array(parts.reduce((total, bytes) => total + bytes.length, 0));
  let offset = 0;
  for (const part of parts) { original.set(part, offset); offset += part.length; }
  return { original, plain, compressed };
}

describe('forward stream lengths', () => {
  it('restores a final CR from the original bytes before lossless optimization', async () => {
    const { original, plain, compressed } = fixture();
    const before = original.slice();
    const doc = await PDFDocument.load(original);
    const stream = () => doc.context.enumerateIndirectObjects().find(([ref]) => ref.objectNumber === 4)![1] as PDFRawStream;
    expect(stream().getContents().length).toBe(compressed.length - 1);
    await restoreStreamLengths(doc, original);
    expect(stream().getContents()).toEqual(compressed);
    const result = await compressPdf(original, 'lossless');
    const output = await PDFDocument.load(result.bytes);
    expect(result.unchanged).toBe(false);
    const contents = output.getPage(0).node.Contents() as PDFRawStream;
    expect(contents.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(Array.from(unzlibSync(contents.getContents()))).toEqual(Array.from(plain));
    expect(original).toEqual(before);
  });

  it('rejects missing bytes instead of inventing data and honors cancellation', async () => {
    const { original } = fixture();
    const doc = await PDFDocument.load(original);
    await expect(restoreStreamLengths(doc, new Uint8Array())).rejects.toThrow(/complete PDF stream/);
    const controller = new AbortController(); controller.abort();
    await expect(restoreStreamLengths(doc, original, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves complete stream bytes when merging, splitting, or extracting pages', async () => {
    const { original, compressed } = fixture();
    const before = original.slice();
    const outputs = [await mergePdfs([{ bytes: original }]), ...(await splitEachPage(original)), await extractPages(original, [1])];
    for (const bytes of outputs) {
      const document = await PDFDocument.load(bytes);
      const contents = document.getPage(0).node.Contents();
      const stream = contents instanceof PDFArray ? contents.lookup(0, PDFRawStream) : contents as PDFRawStream;
      expect(stream.getContents()).toEqual(compressed);
    }
    expect(original).toEqual(before);
  });
});

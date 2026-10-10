import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist';
import { convertDocumentAsync, pdfText } from '../src/lib/documentPipeline';
import { htmlBlocks, documentToPdf } from '../src/lib/documentPdf';
import { buildEpub, epubToHtml, OUTPUTS } from '../src/lib/docconv';

const fonts = {
  regular: new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')),
  bold: new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf')),
};

beforeAll(() => {
  // PDF.js uses its bundled fake worker in Node; no browser/server is required.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')).href;
});

async function fixturePdf(blank = false) {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fonts.regular, { subset: true });
  const page = doc.addPage();
  if (!blank) {
    page.drawText('First page & readable text', { x: 50, y: 700, font });
    doc.addPage().drawText('Second page <literal> **symbols**', { x: 50, y: 700, font });
  }
  return doc.save();
}

describe('document PDF conversions', () => {
  it('offers all four requested input/output pairs', () => {
    expect(OUTPUTS.pdf).toEqual(expect.arrayContaining(['epub', 'md']));
    expect(OUTPUTS.epub).toContain('pdf'); expect(OUTPUTS.md).toContain('pdf');
  });
  it('extracts PDF pages in order into Markdown without interpreting text as markup', async () => {
    const bytes = await fixturePdf();
    const md = await convertDocumentAsync({ format: 'pdf', bytes, title: 'PDF input' }, 'md');
    expect(md).toContain('First page & readable text');
    expect(md).toContain('Second page \\<literal\\> \\*\\*symbols\\*\\*');
    expect((md as string).indexOf('First page')).toBeLessThan((md as string).indexOf('Second page'));
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF');
  });
  it('creates a readable EPUB from PDF text, with escaped content and metadata', async () => {
    const bytes = await convertDocumentAsync({ format: 'pdf', bytes: await fixturePdf(), title: 'PDF input', titleOverride: 'Converted book', author: 'Fixture author' }, 'epub');
    const epub = epubToHtml(bytes as Uint8Array);
    expect(epub.title).toBe('Converted book'); expect(epub.html).toContain('First page &amp; readable text'); expect(epub.html).toContain('&lt;literal&gt;');
  });
  it('creates paginated PDF from Markdown with headings, Unicode text and long lines', async () => {
    const text = '# Café Ελληνικά Привет\n\n' + ('A paragraph of readable document text. '.repeat(10) + '\n\n').repeat(35) + '\n\n' + 'longword'.repeat(120);
    const bytes = await convertDocumentAsync({ format: 'md', text, title: 'Markdown', author: 'Writer' }, 'pdf', { fonts }) as Uint8Array;
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1); expect(doc.getTitle()).toBe('Markdown'); expect(doc.getAuthor()).toBe('Writer');
    const extracted = await pdfText(bytes);
    expect(extracted).toContain('Café Ελληνικά Привет'); expect(extracted).toContain('readable document text');
    expect(extracted).not.toContain('# Café');
  });
  it('converts EPUB text and chapter headings into searchable PDF', async () => {
    const epub = buildEpub('EPUB title', '<h1>Chapter one</h1><p>First chapter text.</p><h2>Chapter two</h2><p>Second chapter text.</p>');
    const bytes = await convertDocumentAsync({ format: 'epub', bytes: epub, title: 'Fallback' }, 'pdf', { fonts }) as Uint8Array;
    expect((await PDFDocument.load(bytes)).getTitle()).toBe('EPUB title');
    const text = await pdfText(bytes); expect(text).toContain('Chapter one'); expect(text).toContain('Chapter two');
    expect(text.indexOf('First chapter')).toBeLessThan(text.indexOf('Second chapter'));
  });
  it('rejects scanned/empty or invalid PDFs, unsupported glyphs and cancelled work', async () => {
    await expect(pdfText(await fixturePdf(true))).rejects.toThrow(/OCR/);
    await expect(pdfText(new TextEncoder().encode('invalid'))).rejects.toThrow();
    await expect(documentToPdf([{ text: '漢字' }], 'Unsupported', '', fonts)).rejects.toThrow(/font does not support/);
    const controller = new AbortController(); controller.abort();
    await expect(convertDocumentAsync({ format: 'pdf', bytes: await fixturePdf(), title: 'Cancel' }, 'md', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(documentToPdf([{ text: 'Cancelled' }], 'Cancel', '', fonts, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('drops executable markup and images while preserving basic document blocks', () => {
    const blocks = htmlBlocks('<h1>Heading</h1><p>A<br>B</p><ul><li>Item</li></ul><script>secret()</script><iframe>hidden</iframe><img src="https://example.com/private">');
    expect(blocks).toEqual([{ text: 'Heading', heading: 1 }, { text: 'A\nB', indent: false }, { text: '• Item', indent: true }]);
  });
  it('stops an in-progress PDF conversion without returning a partial file', async () => {
    const controller = new AbortController();
    const blocks = Array.from({ length: 100 }, () => ({ text: 'Paragraph to paginate.' }));
    await expect(documentToPdf(blocks, 'Cancel', '', fonts, controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
});

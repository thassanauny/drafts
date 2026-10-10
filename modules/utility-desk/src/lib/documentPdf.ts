import { PDFDocument, PageSizes, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { throwIfAborted } from './util';

const MAX_PAGES = 1000;
export const MAX_DOCUMENT_TEXT = 2_000_000;
export interface DocumentBlock { text: string; heading?: number; code?: boolean; indent?: boolean }
export interface DocumentFonts { regular: Uint8Array; bold: Uint8Array }

/** Parse only into a detached document: embedded scripts and assets never run. */
export function htmlBlocks(html: string): DocumentBlock[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head,img,svg,link,iframe,object,embed,template').forEach(e => e.remove());
  const blocks: DocumentBlock[] = [];
  const text = (el: Node): string => el.nodeType === 3 ? el.textContent ?? '' : (el as Element).tagName === 'BR' ? '\n' : [...el.childNodes].map(text).join('');
  const add = (value: string, extra: Partial<DocumentBlock> = {}) => { if (value.trim()) blocks.push({ text: value.trim(), ...extra }); };
  const walk = (parent: Element) => {
    let inline = '';
    const flush = () => { add(inline); inline = ''; };
    for (const child of parent.childNodes) {
      if (child.nodeType !== 1) { inline += child.textContent ?? ''; continue; }
      const el = child as Element, tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) { flush(); add(text(el), { heading: Number(tag[1]) }); }
      else if (tag === 'PRE') { flush(); add(text(el), { code: true }); }
      else if (tag === 'LI') { flush(); add('• ' + text(el), { indent: true }); }
      else if (tag === 'TR') { flush(); add([...el.children].map(text).join(' | ')); }
      else if (tag === 'P' || tag === 'BLOCKQUOTE') { flush(); add(text(el), { indent: tag === 'BLOCKQUOTE' }); }
      else if (/^(DIV|SECTION|ARTICLE|MAIN|BODY|UL|OL|TABLE|TBODY|THEAD|TFOOT)$/.test(tag)) { flush(); walk(el); }
      else inline += text(el);
    }
    flush();
  };
  walk(doc.body);
  if (blocks.reduce((total, block) => total + block.text.length, 0) > MAX_DOCUMENT_TEXT) throw new Error('Document text exceeds the 2 million character limit.');
  return blocks;
}

async function wrapLine(text: string, font: PDFFont, size: number, width: number, signal?: AbortSignal): Promise<string[]> {
  const lines: string[] = []; let work = 0;
  const yieldWork = async () => { if (++work % 2000 === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); throwIfAborted(signal); } };
  for (const paragraph of text.replace(/\t/g, '    ').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      await yieldWork();
      if (font.widthOfTextAtSize(line ? line + ' ' + word : word, size) <= width) { line = line ? line + ' ' + word : word; continue; }
      if (line) { lines.push(line); line = ''; }
      // Long URLs and unspaced words must wrap rather than overflow the page.
      for (const char of word) {
        await yieldWork();
        if (line && font.widthOfTextAtSize(line + char, size) > width) { lines.push(line); line = ''; }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export async function documentToPdf(blocks: DocumentBlock[], title: string, author: string, fonts: DocumentFonts, signal?: AbortSignal, progress?: (value: number) => void): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!blocks.some(block => block.text.trim())) throw new Error('The document has no readable text to convert.');
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts.regular, { subset: true }), bold = await doc.embedFont(fonts.bold, { subset: true });
  doc.setTitle(title); if (author.trim()) doc.setAuthor(author.trim()); doc.setCreator('Utility Desk Lite');
  const available = [new Set(regular.getCharacterSet()), new Set(bold.getCharacterSet())];
  const [width, height] = PageSizes.A4, margin = 50;
  let page: PDFPage, y = height - margin;
  const newPage = () => {
    if (doc.getPageCount() >= MAX_PAGES) throw new Error('PDF output exceeds the 1,000 page limit.');
    page = doc.addPage(PageSizes.A4); y = height - margin;
  };
  newPage();
  for (const [index, block] of blocks.entries()) {
    throwIfAborted(signal);
    const font = block.heading ? bold : regular, charset = available[block.heading ? 1 : 0];
    const content = block.text.replace(/\r\n?/g, '\n');
    for (const char of content) if (!/\s/u.test(char) && !charset.has(char.codePointAt(0)!)) throw new Error(`PDF font does not support “${char}”. Choose EPUB or Markdown to preserve this text.`);
    const size = block.heading ? Math.max(12, 24 - block.heading * 2) : block.code ? 10 : 11;
    const indent = block.indent ? 14 : 0, lineHeight = size * 1.4;
    if (block.heading && y < margin + lineHeight * 3) newPage();
    let lineNumber = 0;
    for (const line of await wrapLine(content, font, size, width - margin * 2 - indent, signal)) {
      throwIfAborted(signal);
      if (y - lineHeight < margin) newPage();
      if (line) page!.drawText(line, { x: margin + indent, y: y - size, font, size, color: rgb(0.12, 0.15, 0.14) });
      y -= lineHeight;
      if (++lineNumber % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    y -= block.heading ? 10 : 8;
    progress?.((index + 1) / blocks.length);
    // Yield periodically so cancel/navigation can be handled during long documents.
    if (index % 20 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throwIfAborted(signal);
  return doc.save();
}

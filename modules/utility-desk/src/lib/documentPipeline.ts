import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import regularUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf?url';
import boldUrl from 'pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf?url';
import { convertDocument, type DocInput, type DocFormat } from './docconv';
import { documentToPdf, htmlBlocks, MAX_DOCUMENT_TEXT, type DocumentFonts } from './documentPdf';
import { throwIfAborted } from './util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export interface DocumentOptions { signal?: AbortSignal; progress?: (value: number) => void; fonts?: DocumentFonts }

export async function pdfText(bytes: Uint8Array, options: DocumentOptions = {}): Promise<string> {
  const { signal, progress } = options;
  throwIfAborted(signal);
  const assets = new URL('pdfjs/', new URL(import.meta.env.BASE_URL, location.href)).href;
  const loading = pdfjs.getDocument({ data: bytes.slice(), cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', isEvalSupported: false });
  const abort = () => { void loading.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const doc = await loading.promise;
    if (doc.numPages > 1000) throw new Error('PDF input exceeds the 1,000 page limit.');
    const pages: string[] = []; let total = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      throwIfAborted(signal);
      const page = await doc.getPage(number), content = await page.getTextContent();
      const lines: string[] = []; let line = '', previousY: number | null = null, previousEnd = 0;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (previousY !== null && Math.abs(y - previousY) > Math.max(2, item.height * 0.4) && line.trim()) { lines.push(line.trim()); line = ''; }
        const gap = item.transform[4] - previousEnd;
        line += (line && gap > Math.max(0.5, item.height * 0.12) && !/\s$/.test(line) && item.str && !/^\s/.test(item.str) ? ' ' : '') + item.str;
        previousY = y; previousEnd = item.transform[4] + item.width;
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; previousY = null; }
      }
      if (line.trim()) lines.push(line.trim());
      const text = lines.join('\n'); total += text.length;
      if (total > MAX_DOCUMENT_TEXT) throw new Error('PDF text exceeds the 2 million character limit.');
      pages.push(text); page.cleanup(); progress?.(number / doc.numPages);
    }
    const text = pages.join('\n\n');
    if (!text.trim()) throw new Error('No selectable text found. This PDF may be scanned; OCR is needed before converting it.');
    return text;
  } catch (error) {
    throwIfAborted(signal);
    if ((error as Error).name === 'PasswordException') throw new Error('Password-protected PDFs are not supported.');
    throw error;
  } finally { signal?.removeEventListener('abort', abort); await loading.destroy(); }
}

async function loadFonts(signal?: AbortSignal): Promise<DocumentFonts> {
  const read = async (url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Could not load the bundled PDF font. Reload and try again.');
    return new Uint8Array(await response.arrayBuffer());
  };
  const [regular, bold] = await Promise.all([read(regularUrl), read(boldUrl)]);
  return { regular, bold };
}

export async function convertDocumentAsync(input: DocInput, out: DocFormat, options: DocumentOptions = {}): Promise<Uint8Array | string> {
  throwIfAborted(options.signal);
  if (input.format === 'pdf') {
    const text = await pdfText(input.bytes ?? new Uint8Array(), options);
    if (out === 'md') return text.replace(/[\\`*_{}[\]<>#]/g, '\\$&') + '\n';
    return convertDocument({ ...input, format: 'txt', text }, out);
  }
  if (out === 'pdf') {
    const html = convertDocument(input, 'html') as string;
    const blocks = htmlBlocks(html);
    const title = new DOMParser().parseFromString(html, 'text/html').title || input.title;
    const fonts = options.fonts ?? await loadFonts(options.signal);
    return documentToPdf(blocks, title, input.author ?? '', fonts, options.signal, options.progress);
  }
  return convertDocument(input, out);
}

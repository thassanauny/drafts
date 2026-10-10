import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate';
import { mobiToHtml, buildMobi } from './mobi';

export type TextDocFormat = 'txt' | 'md' | 'html' | 'epub' | 'mobi';
export type DocFormat = TextDocFormat | 'pdf';
export const UNSUPPORTED_FORMATS = [
  { ext: 'azw3 / KF8, MOBI with images', why: 'Only classic text-only MOBI 6 is handled. KF8 (AZW3), Huffman-compressed MOBI and embedded images are not supported.' },
  { ext: 'docx / doc / odt', why: 'Needs a full office-document engine to preserve layout and styles.' },
  { ext: 'Scanned PDF / OCR', why: 'PDF input needs selectable text. OCR, exact page layout, images and complex table reconstruction are not supported.' },
  { ext: 'DRM-protected books', why: 'Never supported; Utility Desk Lite will not circumvent DRM.' },
];

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u: string) => (/^(https?:|mailto:|#)/i.test(u.trim()) ? u.trim() : '#');

function inline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, a, u) => `<a href="${escapeHtml(safeUrl(u.replace(/&amp;/g, '&')))}">${a}</a>`);
  return t;
}

/** Small, safe Markdown subset: headings, paragraphs, lists, code blocks, quotes, emphasis, links. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [], list: 'ul' | 'ol' | null = null, code: string[] | null = null;
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushL = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (code) { if (line.startsWith('```')) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; } else code.push(line); continue; }
    if (line.startsWith('```')) { flushP(); flushL(); code = []; continue; }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flushP(); if (list !== 'ul') { flushL(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) { flushP(); if (list !== 'ol') { flushL(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^>\s?(.*)$/.exec(line))) { flushP(); flushL(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (!line.trim()) { flushP(); flushL(); }
    else { flushL(); para.push(line.trim()); }
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushP(); flushL();
  return out.join('\n');
}

export function textToHtml(text: string): string {
  return text.replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function walk(node: Node, fn: (n: Node, enter: boolean) => void) { fn(node, true); node.childNodes.forEach((c) => walk(c, fn)); fn(node, false); }

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head').forEach((e) => e.remove());
  let out = '';
  walk(doc.body, (n, enter) => {
    if (n.nodeType === 3 && enter) out += (n.textContent ?? '').replace(/\s+/g, ' ');
    else if (n.nodeType === 1) {
      const t = (n as Element).tagName.toLowerCase();
      if (!enter && /^(p|div|h[1-6]|li|blockquote|pre|tr)$/.test(t)) out += '\n\n';
      if (enter && t === 'br') out += '\n';
    }
  });
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head').forEach((e) => e.remove());
  const conv = (n: Node): string => {
    if (n.nodeType === 3) return (n.textContent ?? '').replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    const el = n as Element, kids = () => [...el.childNodes].map(conv).join('');
    const t = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(t)) return `\n\n${'#'.repeat(Number(t[1]))} ${kids().trim()}\n\n`;
    if (t === 'p' || t === 'div') return `\n\n${kids().trim()}\n\n`;
    if (t === 'br') return '\n';
    if (t === 'strong' || t === 'b') return `**${kids()}**`;
    if (t === 'em' || t === 'i') return `*${kids()}*`;
    if (t === 'code') return `\`${kids()}\``;
    if (t === 'pre') return `\n\n\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`;
    if (t === 'a') return `[${kids()}](${safeUrl(el.getAttribute('href') ?? '#')})`;
    if (t === 'li') return `${el.parentElement?.tagName.toLowerCase() === 'ol' ? '1.' : '-'} ${kids().trim()}\n`;
    if (t === 'ul' || t === 'ol') return `\n\n${kids()}\n`;
    if (t === 'blockquote') return `\n\n> ${kids().trim()}\n\n`;
    return kids();
  };
  return conv(doc.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function markdownToText(md: string): string { return htmlToText(markdownToHtml(md)); }

export function wrapHtml(body: string, title: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body>\n${body}\n</body></html>\n`;
}

export function buildEpub(title: string, bodyHtml: string, author = ''): Uint8Array {
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeHtml(title)}</title></head><body>${bodyHtml.replace(/<br>/g, '<br/>')}</body></html>`;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${id}</dc:identifier><dc:title>${escapeHtml(title)}</dc:title><dc:language>en</dc:language>${author ? `<dc:creator>${escapeHtml(author)}</dc:creator>` : ''}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta></metadata><manifest><item id="c1" href="content.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="content.xhtml">${escapeHtml(title)}</a></li></ol></nav></body></html>`;
  const container = `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  // "mimetype" must be first and stored uncompressed.
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/content.xhtml': strToU8(xhtml),
  });
}

/** Extract concatenated XHTML body content from an unprotected EPUB, following the spine. */
export function epubToHtml(bytes: Uint8Array): { title: string; html: string } {
  const files = unzipSync(bytes);
  if (files['META-INF/encryption.xml'] && /EncryptedData/.test(strFromU8(files['META-INF/encryption.xml'])) && !/IDPF|fontobfuscation/i.test(strFromU8(files['META-INF/encryption.xml'])))
    throw new Error('This EPUB appears to be DRM-protected and cannot be converted.');
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('Not a valid EPUB (missing container.xml)');
  const parser = new DOMParser();
  const opfPath = parser.parseFromString(strFromU8(container), 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) throw new Error('EPUB package file not found');
  const opf = parser.parseFromString(strFromU8(files[opfPath]), 'application/xml');
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || 'Untitled';
  const manifest = new Map<string, string>();
  opf.querySelectorAll('manifest > item').forEach((i) => manifest.set(i.getAttribute('id') ?? '', i.getAttribute('href') ?? ''));
  const packageUrl = new URL(opfPath, 'https://epub.invalid/');
  const parts: string[] = [];
  opf.querySelectorAll('spine > itemref').forEach((r) => {
    const id = r.getAttribute('idref') ?? '';
    const href = manifest.get(id);
    if (!href) throw new Error(`EPUB chapter ${id || '(missing id)'} is not listed in the manifest.`);
    let path: string;
    try {
      const url = new URL(href, packageUrl);
      if (url.origin !== packageUrl.origin) throw new Error('External chapter');
      path = decodeURIComponent(url.pathname.slice(1));
    } catch { throw new Error(`EPUB chapter path could not be read: ${href}`); }
    const data = files[path];
    if (!data) throw new Error(`EPUB chapter file not found: ${href}`);
    const doc = parser.parseFromString(strFromU8(data), 'text/html');
    doc.querySelectorAll('script,style,img,svg,link').forEach((e) => e.remove());
    parts.push(doc.body.innerHTML);
  });
  if (!parts.length) throw new Error('No readable chapters found in this EPUB');
  return { title, html: parts.join('\n') };
}

export const OUTPUTS: Record<DocFormat, DocFormat[]> = {
  txt: ['md', 'html', 'epub', 'mobi', 'pdf'], md: ['pdf', 'txt', 'html', 'epub', 'mobi'], html: ['txt', 'md', 'epub', 'mobi', 'pdf'],
  epub: ['pdf', 'mobi', 'txt', 'md', 'html'], mobi: ['epub', 'txt', 'md', 'html', 'pdf'], pdf: ['epub', 'md', 'txt', 'html'],
};
export const MIME: Record<DocFormat, string> = { txt: 'text/plain', md: 'text/markdown', html: 'text/html', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook', pdf: 'application/pdf' };

export interface DocInput { format: DocFormat; text?: string; bytes?: Uint8Array; title: string; titleOverride?: string; author?: string }

export function convertDocument(input: DocInput, out: DocFormat): Uint8Array | string {
  if (input.format === 'pdf' || out === 'pdf') throw new Error('Use the asynchronous document converter for PDF.');
  let html: string;
  let md: string | null = null, txt: string | null = null;
  let title = input.title;
  if (input.format === 'mobi') {
    const r = mobiToHtml(input.bytes ?? new Uint8Array());
    html = r.html; title = r.title;
  } else if (input.format === 'epub') {
    const r = epubToHtml(input.bytes ?? new Uint8Array());
    html = r.html; title = r.title;
  } else if (input.format === 'html') html = input.text ?? '';
  else if (input.format === 'md') { md = input.text ?? ''; html = markdownToHtml(md); }
  else { txt = input.text ?? ''; html = textToHtml(txt); }
  title = input.titleOverride?.trim() || title;
  switch (out) {
    case 'html': return wrapHtml(input.format === 'html' ? html : html, title);
    case 'md': return md ?? htmlToMarkdown(html);
    case 'txt': return txt ?? htmlToText(html);
    case 'mobi': return buildMobi(title, stripUnsafe(html), input.author);
    case 'epub': return buildEpub(title, input.format === 'html' ? new XMLSerializer().serializeToString(new DOMParser().parseFromString(html, 'text/html').body).replace(/^<body[^>]*>|<\/body>$/g, '') : html, input.author);
  }
}

function stripUnsafe(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,img,svg,link,iframe,object').forEach((e) => e.remove());
  return doc.body.innerHTML;
}

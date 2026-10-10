import { toolPage, group } from '../page';
import { h, field, select, input, filePicker, taskControls, notice, persistForm } from '../ui';
import { OUTPUTS, MIME, UNSUPPORTED_FORMATS, type DocFormat } from '../lib/docconv';
import { convertDocumentAsync, pdfText, type DocumentOptions } from '../lib/documentPipeline';
import { downloadBlob, baseName, sanitizeFilename, readFileBytes, MAX_FILE_BYTES, formatBytes, bytesToBlob, throwIfAborted, suggestOutputName, fileSourceKey } from '../lib/util';

const fmtFromName = (n: string): DocFormat | null => { const e = n.toLowerCase().split('.').pop(); return e === 'markdown' ? 'md' : e === 'htm' ? 'html' : e === 'prc' ? 'mobi' : ['txt', 'md', 'html', 'epub', 'mobi', 'pdf'].includes(e ?? '') ? (e as DocFormat) : null; };

export function mount(root: HTMLElement) {
  let file: File | null = null, format: DocFormat | null = null;
  const info = h('div'), preview = h('pre', { class: 'report', hidden: true, 'aria-label': 'Preview' });
  const title = input('text', 'title'), author = input('text', 'author'), outputName = input('text', 'outputName', '', { placeholder: 'Use the source filename' });
  const suggestName = suggestOutputName(outputName, 'converted');
  const target = select('target', [['', 'Choose an output format']], '');
  const refreshTargets = () => { const o = format ? OUTPUTS[format] : []; target.replaceChildren(h('option', { value: '' }, 'Choose an output format'), ...o.map((f) => h('option', { value: f }, f.toUpperCase()))); target.value = ''; };
  const picker = filePicker({ label: 'Document (.txt, .md, .html, .epub, .mobi, .pdf)', accept: '.txt,.md,.markdown,.html,.htm,.epub,.mobi,.prc,.pdf,application/pdf', onFiles: ([f]) => {
    const sameSource = fileSourceKey(file) === fileSourceKey(f);
    info.replaceChildren(); preview.hidden = true; file = null; format = null; refreshTargets();
    if (!sameSource) { suggestName(); previewTask.reset(); task.reset(); }
    const fm = fmtFromName(f.name);
    if (!fm) { info.append(notice('danger', `${f.name} is not supported. See the unsupported list below.`)); return; }
    if (f.size > MAX_FILE_BYTES / 4) { info.append(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES / 4)}.`)); return; }
    file = f; if (!sameSource) suggestName(f.name); format = fm; refreshTargets(); info.append(notice('info', `${f.name}: ${fm.toUpperCase()} · ${formatBytes(f.size)}`));
  } });
  const clearPreview = () => { preview.hidden = true; preview.textContent = ''; };
  root.addEventListener('input', clearPreview); root.addEventListener('change', clearPreview);
  const selection = () => ({ file: file!, format: format!, target: target.value as DocFormat, title: title.value, author: author.value, outputName: outputName.value });
  const doConvert = async (source: ReturnType<typeof selection>, options: DocumentOptions) => {
    const out = source.format === 'epub' || source.format === 'mobi' || source.format === 'pdf' ? { format: source.format, bytes: await readFileBytes(source.file, options.signal), title: baseName(source.file.name) } : { format: source.format, text: await source.file.text(), title: baseName(source.file.name) };
    return convertDocumentAsync({ ...out, titleOverride: source.title, author: source.author }, source.target, options);
  };
  const validate = () => file && OUTPUTS[format!].includes(target.value as DocFormat) ? null : 'Choose a document and an output format first.';
  const previewTask = taskControls('document-converter', 'Preview document', async ({ signal, progress }) => {
    const source = selection();
    clearPreview();
    const result = await doConvert(source, { signal, progress });
    const text = typeof result === 'string' ? result : source.target === 'pdf' ? await pdfText(result, { signal }) : `[${source.target.toUpperCase()} file, ${formatBytes(result.length)}]`;
    throwIfAborted(signal); preview.hidden = false;
    preview.textContent = (source.target === 'pdf' ? 'PDF text preview (paginated A4 output):\n\n' : '') + text.slice(0, 5000);
    return 'Preview ready. No file was downloaded.';
  }, { validate });
  const task = taskControls('document-converter', 'Convert document', async ({ signal, progress }) => {
    const source = selection();
    const result = await doConvert(source, { signal, progress });
    const t = source.target;
    const name = `${sanitizeFilename(source.outputName.trim() || baseName(source.file.name), 'document')}.${t}`;
    throwIfAborted(signal); downloadBlob(typeof result === 'string' ? new Blob([result], { type: `${MIME[t]};charset=utf-8` }) : bytesToBlob(result, MIME[t]), name);
    return `${name} (${formatBytes(typeof result === 'string' ? new TextEncoder().encode(result).length : result.length)})`;
  }, { validate });
  toolPage(root, 'document-converter', {
    config: [notice('info', 'PDF → EPUB/Markdown extracts selectable text. EPUB/Markdown → PDF creates a paginated A4 document with basic headings and lists. Images, complex layouts and OCR are not included. Password-protected PDFs and DRM-protected books are unsupported.'), group(null, picker, info), group(null, field('Output format', target), h('div', { class: 'option-grid' }, field('Title (optional)', title), field('Author (EPUB/MOBI/PDF)', author)), field('Output filename (without extension)', outputName), preview),
      group('Conversion limits', h('p', { class: 'field-hint' }, 'Up to 50 MB per file. PDF conversions allow 1,000 pages and 2 million text characters. Text order follows the PDF’s text layer; columns and tables may need editing. EPUB/MOBI output is a basic single-chapter book. PDF fonts cover Latin, Greek and Cyrillic; unsupported characters are reported.'), h('ul', { class: 'plain-list' }, ...UNSUPPORTED_FORMATS.map((u) => h('li', {}, h('strong', {}, u.ext), `: ${u.why}`))))],
    actions: [previewTask.el, task.el] });
  persistForm('document-converter', root, ['title', 'author', 'target']);
}

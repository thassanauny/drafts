import { toolPage, group } from '../page';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, emptyState } from '../ui';
import { compressPdf, type CompressionMode } from '../lib/pdfCompression';
import { readFileBytes, downloadBlob, bytesToBlob, sanitizeFilename, MAX_FILE_BYTES, formatBytes, throwIfAborted, suggestOutputName, fileSourceKey } from '../lib/util';

export function mount(root: HTMLElement) {
  let file: File | null = null;
  let operationController: AbortController | null = null;
  const info = h('div', {}, emptyState('No PDF selected', 'Choose a PDF to compress.'));
  const mode = select('compression', [['lossless', 'Lossless · preserve quality and text'], ['balanced', 'Balanced · image-only pages, 150 DPI'], ['small', 'Smaller file · image-only pages, 96 DPI']], 'lossless');
  const name = input('text', 'outName', '', { placeholder: 'Choose a file to suggest a name' });
  const suggestName = suggestOutputName(name, 'compressed');
  const tradeoff = h('div');
  const updateMode = () => tradeoff.replaceChildren(notice(mode.value === 'lossless' ? 'info' : 'warn', mode.value === 'lossless'
    ? 'Keeps selectable text, image quality, links and forms. Already optimized PDFs may not shrink.'
    : 'Turns each visible page into a JPEG image. Text will no longer be selectable or searchable; links and forms become static. Use lossless compression to keep these features.'));
  mode.addEventListener('change', updateMode); updateMode();
  const picker = filePicker({ label: 'PDF file', accept: '.pdf,application/pdf', onFiles: ([selected]) => {
    const sameSource = fileSourceKey(file) === fileSourceKey(selected);
    file = null;
    if (!sameSource) { suggestName(); task.reset(); }
    if (selected.size > MAX_FILE_BYTES) { info.replaceChildren(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    file = selected;
    if (!sameSource) suggestName(selected.name);
    info.replaceChildren(notice('info', `${selected.name} · ${formatBytes(selected.size)}. The source stays untouched.`));
  } });
  const task = taskControls('compress-pdf', 'Compress PDF', async ({ signal, progress }) => {
    const source = file!, compression = mode.value as CompressionMode;
    const filename = sanitizeFilename(name.value, 'compressed.pdf').replace(/(?:\.pdf)?$/i, '.pdf');
    const operation = new AbortController();
    operationController = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      const result = await compressPdf(await readFileBytes(source, operation.signal), compression, operation.signal, progress);
      throwIfAborted(signal); throwIfAborted(operation.signal);
      downloadBlob(bytesToBlob(result.bytes, 'application/pdf'), filename);
      const message = result.unchanged ? 'No size reduction with these settings. An unchanged copy downloaded.' : `Saved ${formatBytes(result.savedBytes)} (${result.savedPercent.toFixed(1)}%). PDF downloaded.`;
      return `${message} Original: ${formatBytes(result.originalSize)} → Output: ${formatBytes(result.bytes.length)} · ${result.pages} pages`;
    } finally { signal.removeEventListener('abort', abort); operationController = null; }
  }, { validate: () => file ? name.value.trim() ? null : 'Enter an output filename.' : 'Choose a PDF first.' });
  toolPage(root, 'compress-pdf', { config: [group(null, picker, info), group(null, field('Compression', mode), tradeoff, field('Output filename (without extension)', name))], actions: [task.el] });
  persistForm('compress-pdf', root);
  return () => { operationController?.abort(); file = null; };
}

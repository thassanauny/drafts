import { toolPage, group } from '../page';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, emptyState } from '../ui';
import { splitEachPage, extractPages, pageCount } from '../lib/pdfops';
import { parsePageRanges } from '../lib/ranges';
import { makeZip } from '../lib/zip';
import { readFileBytes, downloadBlob, bytesToBlob, baseName, sanitizeFilename, MAX_FILE_BYTES, formatBytes, throwIfAborted } from '../lib/util';

export function mount(root: HTMLElement) {
  let file: File | null = null, pages = 0;
  let selectionRequest = 0;
  const info = h('div', {}, emptyState('No PDF selected', 'Choose a PDF to see its page count.'));
  const mode = select('mode', [['each', 'One PDF per page'], ['range', 'Extract selected pages into one PDF']], 'each');
  const range = input('text', 'range', '', { placeholder: 'e.g. 1-3, 5' });
  const picker = filePicker({ label: 'PDF file', accept: '.pdf,application/pdf', onFiles: async ([f]) => {
    const request = ++selectionRequest;
    file = null; pages = 0;
    info.replaceChildren();
    if (f.size > MAX_FILE_BYTES) { info.replaceChildren(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    try {
      const count = await pageCount(await readFileBytes(f));
      if (request !== selectionRequest) return;
      pages = count; file = f;
      info.replaceChildren(notice('info', `${f.name}: ${pages} pages (${formatBytes(f.size)}). Original is not modified.`));
    } catch {
      if (request !== selectionRequest) return;
      info.replaceChildren(notice('danger', 'Could not read this PDF (it may be encrypted or damaged).'));
    }
  } });
  const task = taskControls('split-pdf', 'Save PDF pages', async ({ signal, progress }) => {
    const source = file!, pageTotal = pages, saveMode = mode.value, selectedRange = range.value;
    let results: { name: string; data: Uint8Array }[];
    const bytes = await readFileBytes(source, signal);
    const stem = sanitizeFilename(baseName(source.name), 'document');
    if (saveMode === 'each') {
      const selected = parsePageRanges(selectedRange, pageTotal);
      const parts = await splitEachPage(bytes, signal, progress, selected);
      const pad = String(pageTotal).length;
      results = parts.map((d, i) => ({ name: `${stem}-page-${String(selected[i]).padStart(pad, '0')}.pdf`, data: d }));
    } else {
      const sel = parsePageRanges(selectedRange, pageTotal, true);
      results = [{ name: `${stem}-pages-${selectedRange.replace(/\s+/g, '') || 'all'}.pdf`.replace(/[^\w.-]+/g, '_'), data: await extractPages(bytes, sel, signal, progress) }];
    }
    throwIfAborted(signal);
    if (results.length === 1) downloadBlob(bytesToBlob(results[0].data, 'application/pdf'), results[0].name);
    else downloadBlob(bytesToBlob(makeZip(results, { store: true }), 'application/zip'), `${stem}-split.zip`);
    return `${results.length} PDF file(s) downloaded${results.length > 1 ? ' as ZIP' : ''}.`;
  }, { validate: () => (file ? null : 'Choose a PDF first.') });
  toolPage(root, 'split-pdf', { config: [group(null, picker, info), group(null, field('Save as', mode), field('Pages to include', range, 'Blank = all. Separate files use document order; extraction preserves order and repetitions.'))], actions: [task.el] });
  persistForm('split-pdf', root, ['range']);
  return () => { selectionRequest++; file = null; pages = 0; };
}

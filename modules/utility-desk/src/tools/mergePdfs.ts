import { toolPage, group } from '../page';
import { h, field, input, filePicker, fileList, taskControls, notice, persistForm } from '../ui';
import { mergePdfs, pageCount } from '../lib/pdfops';
import { parsePageRanges } from '../lib/ranges';
import { readFileBytes, downloadBlob, bytesToBlob, sanitizeFilename, MAX_FILE_BYTES, MAX_TOTAL_BYTES, formatBytes, throwIfAborted } from '../lib/util';

interface Item { name: string; size: number; file: File; pages: number; range: string }

export function mount(root: HTMLElement) {
  const items: Item[] = [];
  let pendingSelections = 0, disposed = false;
  let selectionQueue = Promise.resolve();
  const msg = h('div');

  const list = fileList(items, () => {}, (it) => h('input', { type: 'text', value: it.range, placeholder: 'All pages', 'aria-label': `Pages of ${it.name}`, class: 'range-in', size: 12, oninput: (e: Event) => { it.range = (e.target as HTMLInputElement).value; } }));
  const picker = filePicker({ label: 'Add PDFs', accept: '.pdf,application/pdf', multiple: true, onFiles: (files) => {
    pendingSelections++;
    task.reset();
    selectionQueue = selectionQueue.then(async () => {
      if (disposed) return;
      msg.replaceChildren();
      const added: Item[] = [];
      for (const f of files) {
        if (items.length + added.length >= 50 || f.size > MAX_FILE_BYTES || [...items, ...added].reduce((n, item) => n + item.size, 0) + f.size > MAX_TOTAL_BYTES) { msg.append(notice('warn', `${f.name} skipped: maximum 50 PDFs, ${formatBytes(MAX_FILE_BYTES)} per file, ${formatBytes(MAX_TOTAL_BYTES)} total.`)); continue; }
        try {
          const pages = await pageCount(await readFileBytes(f));
          if (disposed) return;
          added.push({ name: f.name, size: f.size, file: f, pages, range: '' });
        } catch (e) {
          if (disposed) return;
          msg.append(notice('danger', `${f.name}: ${/encrypt/i.test((e as Error).message) ? 'password-protected PDFs are not supported' : 'could not be read as a PDF'}.`));
        }
      }
      items.push(...added);
      list.refresh();
    }).finally(() => { pendingSelections--; });
  } });
  const name = field('Output filename (without extension)', input('text', 'outName', 'merged'));
  const task = taskControls('merge-pdfs', 'Merge PDFs', async ({ signal, progress }) => {
    const selection = items.map((item) => ({ ...item }));
    let n = sanitizeFilename((name.querySelector('input') as HTMLInputElement).value, 'merged.pdf');
    if (!/\.pdf$/i.test(n)) n += '.pdf';
    const selections = selection.map((it, index) => {
      try { return { ...it, selectedPages: parsePageRanges(it.range, it.pages, true) }; }
      catch (error) { throw new Error(`PDF ${index + 1} (${it.name}): ${(error as Error).message}`); }
    });
    const sources = [];
    for (const it of selections) sources.push({ bytes: await readFileBytes(it.file, signal), pages: it.selectedPages });
    const out = await mergePdfs(sources, signal, progress);
    throwIfAborted(signal); downloadBlob(bytesToBlob(out, 'application/pdf'), n);
    return `${n} (${formatBytes(out.length)}, ${sources.reduce((a, s) => a + s.pages.length, 0)} pages)`;
  }, { validate: () => pendingSelections ? 'Wait for the selected PDFs to finish loading.' : items.length < 2 ? 'Add at least two PDFs.' : null });
  toolPage(root, 'merge-pdfs', { config: [group('Merge order', h('p', { class: 'field-hint' }, 'Reorder with the arrow buttons. Enter pages like 1-3, 5, 8- per file (blank = all).'), picker, msg, list.el), group(null, name)], actions: [task.el] });
  persistForm('merge-pdfs', root);
  return () => { disposed = true; items.length = 0; };
}

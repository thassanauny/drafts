import { toolPage, group } from '../page';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, option } from '../ui';
import { parsePageRanges } from '../lib/ranges';
import { makeZip } from '../lib/zip';
import { encodeCanvas } from '../lib/imageops';
import { readFileBytes, downloadBlob, baseName, sanitizeFilename, MAX_FILE_BYTES, formatBytes, throwIfAborted } from '../lib/util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const MAX_PIXELS = 50_000_000;

export function mount(root: HTMLElement) {
  let file: File | null = null;
  let doc: pdfjs.PDFDocumentProxy | null = null;
  let loading: pdfjs.PDFDocumentLoadingTask | null = null;
  let selectionRequest = 0;
  let operationController: AbortController | null = null;
  const info = h('div');
  const range = input('text', 'range', '', { placeholder: 'All pages, or e.g. 1-3, 5' });
  const fmt = select('format', [['png', 'PNG'], ['jpeg', 'JPEG']], 'png');
  const dpi = input('number', 'dpi', '300', { min: 72, max: 1200 });
  const quality = input('range', 'quality', '90', { id: 'pdf-jpeg-quality', min: 1, max: 100, step: 1 });
  const qualityValue = h('output', {}, quality.value);
  qualityValue.htmlFor.add(quality.id);
  const qualityField = h('div', { class: 'field quality-slider' },
    h('div', { class: 'quality-label' }, h('label', { class: 'field-label', for: quality.id }, 'JPEG quality'), qualityValue),
    quality, h('div', { class: 'quality-scale', 'aria-hidden': 'true' }, h('span', {}, 'Low'), h('span', {}, 'High')));
  const updateQuality = () => { qualityValue.value = quality.value; };
  quality.addEventListener('input', updateQuality); quality.addEventListener('change', updateQuality);
  const cropBox = input('checkbox', 'cropBox', '', { checked: true });
  const hideAnnotations = input('checkbox', 'hideAnnotations');

  function releaseSource() {
    const previousLoad = loading, previousDocument = doc;
    loading = null; doc = null; file = null;
    if (previousLoad) void previousLoad.destroy();
    else if (previousDocument) void previousDocument.destroy();
  }

  async function renderPage(num: number, scale: number, canvas: HTMLCanvasElement, source: pdfjs.PDFDocumentProxy, hide: boolean, signal: AbortSignal) {
    let page: pdfjs.PDFPageProxy | undefined, rendering: pdfjs.RenderTask | undefined;
    const abort = () => rendering?.cancel();
    signal.addEventListener('abort', abort, { once: true });
    try {
      throwIfAborted(signal);
      page = await source.getPage(num);
      throwIfAborted(signal);
      // PDF.js exposes the visible crop box, but not the media box via its public API.
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
      if (!Number.isFinite(width * height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error(`Page ${num} exceeds the 50 MP rendering limit. Lower the DPI.`);
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot render PDF pages.');
      rendering = page.render({ canvasContext: context, viewport, annotationMode: hide ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE });
      await rendering.promise;
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      page?.cleanup();
    }
  }

  const picker = filePicker({ label: 'PDF file', accept: '.pdf,application/pdf', onFiles: async ([f]) => {
    const request = ++selectionRequest;
    info.replaceChildren();
    releaseSource();
    if (f.size > MAX_FILE_BYTES) { info.append(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    try {
      const assetRoot = new URL('pdfjs/', new URL(import.meta.env.BASE_URL, location.href)).href;
      const data = await readFileBytes(f);
      if (request !== selectionRequest) return;
      loading = pdfjs.getDocument({ data, cMapUrl: assetRoot + 'cmaps/', cMapPacked: true, standardFontDataUrl: assetRoot + 'standard_fonts/', isEvalSupported: false });
      const loaded = await loading.promise;
      if (request !== selectionRequest) { void loaded.destroy(); return; }
      loading = null; doc = loaded; file = f;
      info.append(notice('info', `${f.name}: ${doc.numPages} pages.`));
    } catch (e) {
      if (request !== selectionRequest) return;
      releaseSource();
      info.append(notice('danger', /password/i.test((e as Error).message) ? 'Password-protected PDFs are not supported.' : `Could not open PDF: ${(e as Error).message}`));
    }
  } });

  const task = taskControls('pdf-to-images', 'Export page images', async ({ signal: taskSignal, progress }) => {
    throwIfAborted(taskSignal);
    const source = doc!, sourceFile = file!, hide = hideAnnotations.checked;
    const resolution = Number(dpi.value), jpegQuality = Math.min(1, Math.max(0.01, Number(quality.value) / 100));
    const outputs: { name: string; blob: Blob }[] = [];
    const pages = parsePageRanges(range.value, source.numPages);
    const type = fmt.value === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = fmt.value === 'jpeg' ? 'jpg' : 'png';
    const stem = sanitizeFilename(baseName(sourceFile.name), 'page');
    const pad = String(source.numPages).length;
    if (!Number.isInteger(resolution) || resolution < 72 || resolution > 1200) throw new Error('Resolution must be a whole number from 72 to 1,200 DPI.');
    const operation = new AbortController(), signal = operation.signal;
    operationController = operation;
    const abort = () => operation.abort();
    taskSignal.addEventListener('abort', abort, { once: true });
    try {
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(signal);
        const c = document.createElement('canvas');
        try {
          await renderPage(pages[i], resolution / 72, c, source, hide, signal);
          const blob = await encodeCanvas(c, type, jpegQuality, signal);
          throwIfAborted(signal);
          if (!blob || blob.type !== type) throw new Error('Canvas export failed');
          const name = `${stem}-p${String(pages[i]).padStart(pad, '0')}.${ext}`;
          outputs.push({ name, blob });
        } finally { c.width = c.height = 0; }

        progress((i + 1) / pages.length, `Page ${i + 1} of ${pages.length}`);
      }
      throwIfAborted(signal);
      if (outputs.length === 1) downloadBlob(outputs[0].blob, outputs[0].name);
      else {
        const items = await Promise.all(outputs.map(async (o) => ({ name: o.name, data: new Uint8Array(await o.blob.arrayBuffer()) })));
        throwIfAborted(signal);
        downloadBlob(new Blob([makeZip(items, { store: true }) as BlobPart], { type: 'application/zip' }), `${stem}-images.zip`);
      }
      return `${outputs.length} image(s) downloaded${outputs.length > 1 ? ' as ZIP' : ''}.`;
    } finally { outputs.length = 0; taskSignal.removeEventListener('abort', abort); operationController = null; }
  }, { validate: () => (doc ? null : 'Choose a PDF first.') });

  cropBox.disabled = true;
  toolPage(root, 'pdf-to-images', { config: [group(null, picker, info), group(null, field('Pages to export', range, 'Leave blank for all, or enter 1, 3, 5-8.'), h('div', { class: 'option-grid' }, field('Image format', fmt), field('Resolution (DPI)', dpi)), qualityField, option('Use the PDF crop box', 'PDF.js always renders the visible crop box. Full media-box rendering and TIFF export are unavailable in this edition.', cropBox), option('Hide annotations', 'Omit annotation appearances from the exported pages.', hideAnnotations))], actions: [task.el] });
  persistForm('pdf-to-images', root, ['range']);
  return () => { selectionRequest++; operationController?.abort(); releaseSource(); };
}

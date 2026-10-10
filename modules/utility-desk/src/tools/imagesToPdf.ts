import { toolPage, group } from '../page';
import { h, field, input, select, filePicker, fileList, taskControls, notice, persistForm } from '../ui';
import { imagesToPdf, type PageSizeName, type Fit, type PdfImage } from '../lib/pdfops';
import { detectUnsupportedImage, encodeCanvas, MAX_PIXELS, IMAGE_ACCEPT } from '../lib/imageops';
import { downloadBlob, bytesToBlob, sanitizeFilename, formatBytes, MAX_FILE_BYTES, MAX_TOTAL_BYTES, throwIfAborted, suggestOutputName } from '../lib/util';

/** Decode any browser-supported image; re-encode to PNG/JPEG for pdf-lib when needed. */
export async function toPdfImage(file: File, signal?: AbortSignal): Promise<PdfImage> {
  throwIfAborted(signal);
  let bmp: ImageBitmap | null = await createImageBitmap(file);
  const { width, height } = bmp;
  let canvas: HTMLCanvasElement | undefined;
  try {
    throwIfAborted(signal);
    if (width * height > MAX_PIXELS) throw new Error('Image is too large for browser memory.');
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot render images.');
    context.fillStyle = 'white'; context.fillRect(0, 0, width, height); context.drawImage(bmp, 0, 0);
    bmp.close(); bmp = null;
    const blob = await encodeCanvas(canvas, 'image/png', 1, signal);
    if (!blob || blob.type !== 'image/png') throw new Error(`Could not convert ${file.name}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);
    return { bytes, type: 'png', width, height };
  } finally { bmp?.close(); if (canvas) canvas.width = canvas.height = 0; }
}

export function mount(root: HTMLElement) {
  const items: { name: string; size: number; file: File }[] = [];
  let operationController: AbortController | null = null;
  const msg = h('div');
  const list = fileList(items, syncName);
  const picker = filePicker({ label: 'Add images', accept: IMAGE_ACCEPT, multiple: true, onFiles: (files) => {
    msg.replaceChildren();
    for (const f of files) { const bad = detectUnsupportedImage(f); if (bad) { msg.append(notice('warn', `${f.name}: ${bad}`)); continue; } if (items.length >= 50 || f.size > MAX_FILE_BYTES || items.reduce((n, i) => n + i.size, 0) + f.size > MAX_TOTAL_BYTES) { msg.append(notice('warn', `${f.name} skipped: maximum 50 images, 200 MB each, 500 MB total.`)); continue; } items.push({ name: f.name, size: f.size, file: f }); }
    list.refresh(); syncName();
  } });
  const size = select('pageSize', [['A4', 'A4'], ['Letter', 'Letter'], ['Fit', 'Match each image']], 'A4');
  const orient = select('orientation', [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], 'auto');
  const updateOrientation = () => { orient.disabled = size.value === 'Fit'; };
  size.addEventListener('change', updateOrientation);
  const fit = select('fit', [['contain', 'Fit inside'], ['cover', 'Fill (crop)'], ['stretch', 'Stretch'], ['original', 'Original size at DPI']], 'contain');
  const dpi = input('number', 'dpi', '150', { min: 72, max: 600 });
  const margin = input('number', 'margin', '0', { min: 0, max: 144 });
  const name = input('text', 'outName', '', { placeholder: 'Choose a file to suggest a name' });
  const suggestName = suggestOutputName(name, 'images');
  let firstSource: File | undefined;
  function syncName() {
    const source = items[0]?.file;
    if (source === firstSource) return;
    firstSource = source;
    suggestName(source?.name);
  }
  const task = taskControls('images-to-pdf', 'Create PDF', async ({ signal, progress }) => {
    const operation = new AbortController();
    operationController = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const sources = items.map((item) => item.file);
    const options = { pageSize: size.value as PageSizeName, orientation: orient.value as 'portrait' | 'landscape' | 'auto', fit: fit.value as Fit, dpi: Number(dpi.value), marginPt: Number(margin.value) || 0 };
    let n = sanitizeFilename(name.value, 'images.pdf'); if (!/\.pdf$/i.test(n)) n += '.pdf';
    const imgs: PdfImage[] = [];
    try {
      throwIfAborted(signal);
      for (let i = 0; i < sources.length; i++) { throwIfAborted(operation.signal); imgs.push(await toPdfImage(sources[i], operation.signal)); progress((i / sources.length) * 0.5); }
      const out = await imagesToPdf(imgs, options, operation.signal, (p) => progress(0.5 + p / 2));
      throwIfAborted(signal); throwIfAborted(operation.signal); downloadBlob(bytesToBlob(out, 'application/pdf'), n);
      return `${n} (${formatBytes(out.length)}, ${sources.length} pages)`;
    } finally { imgs.length = 0; signal.removeEventListener('abort', abort); operationController = null; }
  }, { validate: () => (!items.length ? 'Add at least one image.' : !Number.isInteger(Number(dpi.value)) || Number(dpi.value) < 72 || Number(dpi.value) > 600 ? 'DPI must be a whole number from 72 to 600.' : Number(margin.value) < 0 || Number(margin.value) > 144 ? 'Margin must be from 0 to 144 points.' : null) });
  toolPage(root, 'images-to-pdf', { config: [group('Image order', h('p', { class: 'field-hint' }, 'Reorder with the arrow buttons. HEIC/TIFF are unavailable. Camera orientation is applied, transparency flattened onto white, and metadata removed.'), picker, msg, list.el), group('Page settings', h('div', { class: 'option-grid' }, field('Page size', size), field('Orientation', orient)), h('p', { class: 'field-hint' }, 'Auto follows each image’s proportions. Orientation applies to A4 and Letter; Match each image keeps the image’s dimensions.'), h('div', { class: 'option-grid' }, field('Image fitting', fit), field('DPI', dpi)), field('Margin (pt)', margin)), group(null, field('Output filename (without extension)', name))], actions: [task.el] });
  persistForm('images-to-pdf', root);
  updateOrientation();
  return () => { operationController?.abort(); items.length = 0; };
}

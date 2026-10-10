import { toolPage, group, outputPanel } from '../page';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, button, option } from '../ui';
import { encodeCanvas, grayscale, sepia, contrast, autoContrast, sharpen, rotatedSize, detectUnsupportedImage, MAX_PIXELS, IMAGE_ACCEPT } from '../lib/imageops';
import { downloadBlob, baseName, sanitizeFilename, formatBytes, MAX_FILE_BYTES, throwIfAborted } from '../lib/util';

export function mount(root: HTMLElement) {
  let file: File | null = null;
  let bmp: ImageBitmap | null = null;
  let imageRequest = 0, disposed = false;
  let operationController: AbortController | null = null;
  const info = h('div'), canvas = h('canvas', { class: 'preview-img', 'aria-label': 'Edited image preview', role: 'img' });
  const auto = input('checkbox', 'autoContrast');
  const rot = select('rotate', [['0', 'No rotation'], ['90', '90°'], ['180', '180°'], ['270', '270°']], '0');
  const flip = select('flip', [['none', 'No flip'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['both', 'Both']], 'none');
  const colorStyle = select('colorStyle', [['original', 'Original colors'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia']], 'original');
  const con = input('range', 'contrast', '0', { min: -100, max: 100 });
  const sharp = input('checkbox', 'sharpen');
  const fmt = select('format', [['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']], 'image/png');
  function process(): HTMLCanvasElement {
    if (!bmp) throw new Error('Choose an image first.');
    const deg = Number(rot.value);
    const [ow, oh] = rotatedSize(bmp.width, bmp.height, deg);
    if (ow * oh > MAX_PIXELS) throw new Error('Output would be too large for browser memory. Reduce the size.');
    const output = document.createElement('canvas'); output.width = ow; output.height = oh;
    try {
      const og = output.getContext('2d', { willReadFrequently: true });
      if (!og) throw new Error('This browser cannot process images.');
      og.imageSmoothingQuality = 'high';
      og.translate(ow / 2, oh / 2);
      og.scale(flip.value === 'horizontal' || flip.value === 'both' ? -1 : 1, flip.value === 'vertical' || flip.value === 'both' ? -1 : 1);
      og.rotate((deg * Math.PI) / 180);
      og.drawImage(bmp, 0, 0, bmp.width, bmp.height, -bmp.width / 2, -bmp.height / 2, bmp.width, bmp.height);
      og.setTransform(1, 0, 0, 1, 0, 0);
      if (colorStyle.value === 'grayscale' || colorStyle.value === 'sepia' || Number(con.value) || sharp.checked || auto.checked) {
        const img = og.getImageData(0, 0, output.width, output.height);
        if (sharp.checked) sharpen(img.data, output.width, output.height, 0.5);
        if (auto.checked) autoContrast(img.data);
        if (Number(con.value)) contrast(img.data, Number(con.value));
        if (colorStyle.value === 'grayscale') grayscale(img.data);
        else if (colorStyle.value === 'sepia') sepia(img.data);
        og.putImageData(img, 0, 0);
      }
      if (fmt.value === 'image/jpeg') {
        og.globalCompositeOperation = 'destination-over';
        og.fillStyle = 'white'; og.fillRect(0, 0, output.width, output.height);
        og.globalCompositeOperation = 'source-over';
      }
      return output;
    } catch (error) { output.width = output.height = 0; throw error; }
  }
  const refresh = () => {
    if (!bmp) return;
    info.querySelector('.err')?.remove();
    let out: HTMLCanvasElement | undefined;
    try {
      out = process();
      const g = canvas.getContext('2d');
      if (!g) throw new Error('This browser cannot preview images.');
      const s = Math.min(1, 640 / out.width);
      canvas.width = Math.max(1, Math.round(out.width * s)); canvas.height = Math.max(1, Math.round(out.height * s));
      g.drawImage(out, 0, 0, canvas.width, canvas.height);
    } catch (e) { canvas.width = canvas.height = 0; info.append(h('div', { class: 'err' }, notice('danger', (e as Error).message))); }
    finally { if (out) out.width = out.height = 0; }
  };
  let t: ReturnType<typeof setTimeout>;
  const edits = h('div', { oninput: () => { clearTimeout(t); t = setTimeout(refresh, 120); }, onchange: () => { clearTimeout(t); refresh(); } },
    group('Orientation', h('p', { class: 'field-hint' }, 'Camera orientation is corrected automatically.'), h('div', { class: 'option-grid' }, field('Rotate clockwise', rot), field('Flip', flip))),
    group('Color & detail', field('Color style', colorStyle), field('Contrast', con, '-100 to 100. Zero leaves it unchanged.'), option('Automatic contrast', 'Expand the image’s color range.', auto), option('Sharpen details', 'Apply light sharpening.', sharp)));
  const task = taskControls('image-workshop', 'Export image', async ({ signal }) => {
    const request = imageRequest;
    const stem = sanitizeFilename(baseName(file!.name), 'image');
    const type = fmt.value;
    const operation = new AbortController();
    operationController = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const checkCurrent = () => {
      throwIfAborted(signal); throwIfAborted(operation.signal);
      if (disposed || request !== imageRequest) throw new DOMException('Cancelled', 'AbortError');
    };
    let c: HTMLCanvasElement | undefined;
    clearTimeout(t);
    try {
      checkCurrent(); c = process();
      const blob = await encodeCanvas(c, type, 0.9, operation.signal);
      checkCurrent();
      if (!blob || blob.type !== type) throw new Error(`This browser cannot encode ${type}. Pick another format.`);
      const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
      const name = sanitizeFilename(`${stem}-edited.${ext}`);
      downloadBlob(blob, name);
      return `${name} (${formatBytes(blob.size)})`;
    } finally { signal.removeEventListener('abort', abort); operationController = null; if (c) c.width = c.height = 0; }
  }, { validate: () => (bmp ? null : 'Choose an image first.') });
  const picker = filePicker({ label: 'Image', accept: IMAGE_ACCEPT, onFiles: async ([fl]) => {
    if (disposed) return;
    const request = ++imageRequest;
    clearTimeout(t); task.reset(); info.replaceChildren(); bmp?.close(); bmp = null; file = null;
    canvas.width = canvas.height = 0;
    const bad = detectUnsupportedImage(fl);
    if (bad) { info.append(notice('warn', bad)); return; }
    if (fl.size > MAX_FILE_BYTES) { info.append(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    try {
      const decoded = await createImageBitmap(fl, { imageOrientation: 'from-image' });
      if (disposed || request !== imageRequest) { decoded.close(); return; }
      if (decoded.width * decoded.height > MAX_PIXELS) { decoded.close(); throw new Error('Image is too large to process in the browser.'); }
      bmp = decoded; file = fl;
      info.append(notice('info', `${fl.name}: ${bmp.width}×${bmp.height}. The original file is never changed.`));
      refresh();
    } catch (e) { if (!disposed && request === imageRequest) { info.append(notice('danger', `Cannot decode this image (${(e as Error).message}). The format may be unsupported by this browser.`)); } }
  } });
  const resetBtn = button('Reset edits', () => { clearTimeout(t); root.querySelectorAll<HTMLInputElement>('[name]').forEach((e) => { if (e.type === 'checkbox') e.checked = false; else if (e.name === 'contrast') e.value = '0'; else if (e.tagName === 'SELECT' && e.name === 'rotate') e.value = '0'; else if (e.name === 'flip') e.value = 'none'; else if (e.name === 'colorStyle') e.value = 'original'; }); root.dispatchEvent(new Event('change', { bubbles: true })); refresh(); }, { variant: 'secondary' });
  fmt.addEventListener('change', refresh);
  toolPage(root, 'image-workshop', { config: [group(null, picker, info), edits, group('Output', field('Output format', fmt), h('p', { class: 'field-hint' }, 'JPEG/WebP export uses high quality. Use ', h('a', { href: '#/compress-image' }, 'Compress Image'), ' to resize, choose compression quality or set a maximum file size.'), notice('info', 'Camera orientation is applied by the browser. Canvas export removes source metadata; retaining EXIF and profiles is unavailable. TIFF, GIF, BMP and AVIF encoding are unavailable in this edition.'))], actions: [task.el, resetBtn], output: [outputPanel('Preview', 'LIVE', canvas)] });
  persistForm('image-workshop', root);
  return () => { disposed = true; imageRequest++; clearTimeout(t); operationController?.abort(); bmp?.close(); bmp = null; file = null; canvas.width = canvas.height = 0; };
}

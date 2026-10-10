import { toolPage, group } from '../page';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, button } from '../ui';
import { clampCrop, detectUnsupportedImage, encodeCanvas, MAX_PIXELS, IMAGE_ACCEPT } from '../lib/imageops';
import { downloadBlob, sanitizeFilename, formatBytes, MAX_FILE_BYTES, throwIfAborted, suggestOutputName, fileSourceKey } from '../lib/util';

export function mount(root: HTMLElement) {
  let bmp: ImageBitmap | null = null;
  let imageRequest = 0, disposed = false;
  let sourceKey = '';
  let operationController: AbortController | null = null;
  const info = h('div');
  const f = (name: string, value: string, extra: Record<string, any> = {}) => input('number', name, value, extra);
  const cx = f('cropX', '0', { min: 0, max: 100000 }), cy = f('cropY', '0', { min: 0, max: 100000 }), cw = f('cropW', '', { min: 1, max: 20000, placeholder: 'full' }), ch = f('cropH', '', { min: 1, max: 20000, placeholder: 'full' });
  const cropCanvas = h('canvas', { role: 'img', 'aria-label': 'Original image with the kept crop outlined' });
  const cropOutline = h('div', { class: 'crop-outline', 'aria-hidden': true });
  const cropFrame = h('div', { class: 'crop-frame', hidden: true }, cropCanvas, cropOutline);
  const cropEmpty = h('p', { class: 'crop-empty' }, 'Choose an image to see its dimensions and the area you will keep.');
  const cropStats = h('div', { class: 'crop-stats', 'aria-live': 'polite' });
  const cropLegend = h('p', { class: 'field-hint', hidden: true }, 'The outlined area is kept. Shaded areas are removed.');
  const cropPreview = h('div', { class: 'crop-preview' }, h('strong', {}, 'Crop preview'), cropEmpty, cropFrame, cropLegend, cropStats);
  const fmt = select('format', [['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']], 'image/png');
  const quality = input('range', 'quality', '90', { id: 'crop-quality', min: 1, max: 100, step: 1 });
  const qualityValue = h('output', {}, quality.value);
  qualityValue.htmlFor.add(quality.id);
  const qualityField = h('div', { class: 'field quality-slider' },
    h('div', { class: 'quality-label' }, h('label', { class: 'field-label', for: quality.id }, 'Encoding quality'), qualityValue),
    quality, h('div', { class: 'quality-scale', 'aria-hidden': 'true' }, h('span', {}, 'Low'), h('span', {}, 'High')));
  const updateQuality = () => { qualityValue.value = quality.value; };
  quality.addEventListener('input', updateQuality); quality.addEventListener('change', updateQuality);
  const name = input('text', 'outName', '', { placeholder: 'Choose a file to suggest a name' });
  const suggestName = suggestOutputName(name, 'cropped');
  function selectedCrop() {
    if (!bmp) throw new Error('Choose an image first.');
    for (const [control, min, max, blank] of [[cx, 0, 100000, false], [cy, 0, 100000, false], [cw, 1, 20000, true], [ch, 1, 20000, true]] as const) {
      if (blank && control.value === '') continue;
      if (!/^\d+$/.test(control.value) || Number(control.value) < min || Number(control.value) > max) throw new Error('Use whole pixel values: sizes from 1 to 20,000, and offsets from 0 to 100,000.');
    }
    return clampCrop({ x: Number(cx.value) || 0, y: Number(cy.value) || 0, width: Number(cw.value) || bmp.width, height: Number(ch.value) || bmp.height }, bmp.width, bmp.height);
  }
  function updateCropPreview() {
    cropEmpty.hidden = !!bmp; cropFrame.hidden = cropLegend.hidden = !bmp;
    cropStats.replaceChildren();
    if (!bmp) { cropCanvas.width = cropCanvas.height = 0; cw.placeholder = ch.placeholder = 'full'; return null; }
    let crop;
    try { crop = selectedCrop(); }
    catch (error) { cropOutline.hidden = true; cropStats.append(notice('warn', (error as Error).message)); return null; }
    cropOutline.hidden = false;
    Object.assign(cropOutline.style, { left: `${crop.x / bmp.width * 100}%`, top: `${crop.y / bmp.height * 100}%`, width: `${crop.width / bmp.width * 100}%`, height: `${crop.height / bmp.height * 100}%` });
    cw.placeholder = String(bmp.width - crop.x); ch.placeholder = String(bmp.height - crop.y);
    const removed = 100 * (1 - crop.width * crop.height / (bmp.width * bmp.height));
    cropStats.append(h('div', { class: 'crop-dimensions' },
      h('div', {}, h('span', {}, 'Original'), h('strong', {}, `${bmp.width} × ${bmp.height} px`)),
      h('div', {}, h('span', {}, 'Keep'), h('strong', {}, `${crop.width} × ${crop.height} px`))),
      h('p', { class: 'crop-removal' }, removed === 0 ? 'No cropping · the whole image is kept.' : `${removed.toFixed(1)}% of the image area removed.`),
      h('p', { class: 'crop-edges' }, `Removed from edges: left ${crop.x} px · top ${crop.y} px · right ${bmp.width - crop.x - crop.width} px · bottom ${bmp.height - crop.y - crop.height} px.`));
    cropCanvas.setAttribute('aria-label', `Original ${bmp.width} by ${bmp.height} pixels. Keep ${crop.width} by ${crop.height} pixels, starting ${crop.x} pixels from the left and ${crop.y} pixels from the top.`);
    return crop;
  }

  function process() {
    if (!bmp) throw new Error('Choose an image first.');
    const crop = selectedCrop(), out = document.createElement('canvas');
    out.width = crop.width; out.height = crop.height;
    const context = out.getContext('2d')!;
    if (fmt.value === 'image/jpeg') { context.fillStyle = 'white'; context.fillRect(0, 0, out.width, out.height); }
    context.drawImage(bmp, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return out;
  }
  const cropSection = group('Crop', h('p', { class: 'crop-intro' }, 'Choose the width and height to keep, then set where the crop starts from the left and top edges. Measurements use the original image with camera orientation applied.'),
    h('div', { class: 'crop-workspace' }, h('div', { class: 'crop-controls' },
      h('div', { class: 'option-grid' }, field('Width to keep (px)', cw), field('Height to keep (px)', ch)),
      h('div', { class: 'option-grid' }, field('Start from left (px)', cx), field('Start from top (px)', cy)),
      h('p', { class: 'field-hint' }, '0 starts at the edge. Blank width extends to the right edge; blank height extends to the bottom. Crops stay within the image.'),
      button('Keep whole image', () => { cx.value = cy.value = '0'; cw.value = ch.value = ''; updateCropPreview(); cx.dispatchEvent(new Event('input', { bubbles: true })); }, { variant: 'secondary' })), cropPreview));
  cropSection.classList.add('crop-section');
  cropSection.addEventListener('input', updateCropPreview); cropSection.addEventListener('change', updateCropPreview);
  const task = taskControls('crop-image', 'Export cropped image', async ({ signal }) => {
    const operation = new AbortController(), request = imageRequest;
    operationController = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    let out: HTMLCanvasElement | undefined;
    try {
      throwIfAborted(signal);
      out = process();
      const type = fmt.value;
      const blob = await encodeCanvas(out, type, Number(quality.value) / 100, operation.signal);
      throwIfAborted(signal); throwIfAborted(operation.signal);
      if (disposed || request !== imageRequest) throw new DOMException('Cancelled', 'AbortError');
      if (!blob || blob.type !== type) throw new Error('This browser cannot encode the selected format. Pick another format.');
      const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
      const filename = sanitizeFilename(name.value.replace(/\.(png|jpe?g|webp)$/i, ''), 'cropped') + '.' + extension;
      downloadBlob(blob, filename);
      return filename + ' (' + formatBytes(blob.size) + ')';
    } finally { signal.removeEventListener('abort', abort); operationController = null; if (out) out.width = out.height = 0; }
  }, { validate: () => {
    try { selectedCrop(); } catch (error) { return (error as Error).message; }
    return name.value.trim() ? null : 'Enter an output filename.';
  } });
  const picker = filePicker({ label: 'Image', accept: IMAGE_ACCEPT, onFiles: async ([fl]) => {
    if (disposed) return;
    const request = ++imageRequest;
    const key = fileSourceKey(fl), sameSource = sourceKey === key;
    info.replaceChildren(); bmp?.close(); bmp = null;
    if (!sameSource) { suggestName(); task.reset(); }
    updateCropPreview();
    const bad = detectUnsupportedImage(fl);
    if (bad) { sourceKey = ''; suggestName(); task.reset(); info.append(notice('warn', bad)); return; }
    if (fl.size > MAX_FILE_BYTES) { sourceKey = ''; suggestName(); task.reset(); info.append(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    sourceKey = key;
    if (!sameSource) suggestName(fl.name);
    try {
      const decoded = await createImageBitmap(fl);
      if (request !== imageRequest) { decoded.close(); return; }
      if (decoded.width * decoded.height > MAX_PIXELS) { decoded.close(); throw new Error('Image is too large to process in the browser.'); }
      bmp = decoded;
      info.append(notice('info', `${fl.name}: ${bmp.width}×${bmp.height}. The original file is never changed.`));
      const scale = Math.min(1, 640 / bmp.width, 280 / bmp.height);
      cropCanvas.width = Math.max(1, Math.round(bmp.width * scale)); cropCanvas.height = Math.max(1, Math.round(bmp.height * scale));
      cropFrame.style.maxWidth = `${cropCanvas.width}px`;
      cropCanvas.getContext('2d')!.drawImage(bmp, 0, 0, cropCanvas.width, cropCanvas.height);
      updateCropPreview();
    } catch (e) { if (request === imageRequest) { sourceKey = ''; suggestName(); task.reset(); bmp?.close(); bmp = null; updateCropPreview(); info.append(notice('danger', `Cannot decode this image (${(e as Error).message}). The format may be unsupported by this browser.`)); } }
  } });
  toolPage(root, 'crop-image', { config: [group(null, picker, info), cropSection, group('Output', h('div', { class: 'option-grid' }, field('Output format', fmt), qualityField), field('Output filename (without extension)', name), h('p', { class: 'field-hint' }, 'Photos are rotated upright automatically. PNG/WebP keep transparency; JPEG turns it white. Camera details, location and comments are removed. Your original stays unchanged.'))], actions: [task.el] });
  persistForm('crop-image', root, ['cropX', 'cropY', 'cropW', 'cropH']);
  return () => { disposed = true; imageRequest++; operationController?.abort(); bmp?.close(); bmp = null; cropCanvas.width = cropCanvas.height = 0; };
}

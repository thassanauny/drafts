import { toolPage, group } from '../page';
import { h, field, input, select, filePicker, taskControls, notice, persistForm, emptyState, option } from '../ui';
import { encodeCanvas, encodeWithinLimit, sizeImage, type Sizing, detectUnsupportedImage, MAX_PIXELS, IMAGE_ACCEPT } from '../lib/imageops';
import { downloadBlob, sanitizeFilename, formatBytes, MAX_FILE_BYTES, throwIfAborted, suggestOutputName, fileSourceKey } from '../lib/util';

export function mount(root: HTMLElement) {
  let file: File | null = null, bitmap: ImageBitmap | null = null;
  let imageRequest = 0, disposed = false;
  let sourceKey = '';
  let operationController: AbortController | null = null;
  const info = h('div', {}, emptyState('No image selected', 'Choose an image to compress.'));
  const resize = input('checkbox', 'resize');
  const sizing = select('sizing', [['maximum', 'Maximum size · keep proportions'], ['cover', 'Exact size · crop to fit'], ['contain', 'Exact size · add padding'], ['stretch', 'Exact size · stretch']], 'maximum');
  const width = input('number', 'width', '', { min: 1, max: 20000, step: 1, placeholder: 'auto' });
  const height = input('number', 'height', '', { min: 1, max: 20000, step: 1, placeholder: 'auto' });
  const enlarge = input('checkbox', 'enlarge');
  const enlargeField = option('Allow enlargement', 'Let maximum sizing make a smaller image larger.', enlarge);
  const padding = select('padding', [['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent']], 'white');
  const paddingField = field('Padding color', padding);
  const resizeHint = h('p', { class: 'field-hint' });
  const dimensions = h('p', { class: 'field-hint image-dimensions', 'aria-live': 'polite' });
  const resizeBox = h('div', {}, field('Sizing method', sizing), h('div', { class: 'option-grid' }, field('Width (pixels)', width), field('Height (pixels)', height)), enlargeField, paddingField, resizeHint);
  const format = select('format', [['image/png', 'PNG'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']], 'image/jpeg');
  const quality = input('range', 'quality', '75', { id: 'compress-image-quality', min: 1, max: 100, step: 1 });
  const qualityValue = h('output', {}, quality.value);
  qualityValue.htmlFor.add(quality.id);
  const qualityField = h('div', { class: 'field quality-slider' },
    h('div', { class: 'quality-label' }, h('label', { class: 'field-label', for: quality.id }, 'Encoding quality'), qualityValue),
    quality, h('div', { class: 'quality-scale', 'aria-hidden': 'true' }, h('span', {}, 'Low'), h('span', {}, 'High')));
  const limit = input('checkbox', 'limitSize');
  const maxSize = input('number', 'maxSize', '500', { min: 1, step: 'any' });
  const sizeUnit = select('sizeUnit', [['kb', 'KB'], ['mb', 'MB']], 'kb');
  const sizeBox = h('div', {}, h('div', { class: 'option-grid' }, field('Maximum file size', maxSize), field('Size unit', sizeUnit)),
    h('p', { class: 'field-hint' }, '1 KB = 1,000 bytes. JPEG/WebP quality is lowered within your chosen output dimensions. PNG must meet the limit with lossless encoding. If the limit cannot be met, no file is saved.'));
  const tradeoff = h('div');
  const name = input('text', 'outName', '', { placeholder: 'Choose a file to suggest a name' });
  const suggestName = suggestOutputName(name, 'compressed');
  const updateSettings = () => {
    qualityValue.value = quality.value;
    quality.disabled = format.value === 'image/png';
    resizeBox.hidden = !resize.checked;
    enlargeField.hidden = sizing.value !== 'maximum';
    paddingField.hidden = sizing.value !== 'contain';
    resizeHint.textContent = sizing.value === 'maximum'
      ? 'Enter a width, height, or both as maximum bounds. Proportions stay the same. Use whole pixels from 1 to 20,000.'
      : sizing.value === 'cover' ? 'Enter both dimensions. The image fills the exact size with its proportions kept; edges are cropped to fit. Use whole pixels from 1 to 20,000.'
        : sizing.value === 'contain' ? 'Enter both dimensions. The whole image fits inside the exact size with its proportions kept; padding fills the remaining space. JPEG makes transparent areas white. Use whole pixels from 1 to 20,000.'
          : 'Enter both dimensions. The image stretches to the exact size; its proportions may change. Use whole pixels from 1 to 20,000.';
    sizeBox.hidden = !limit.checked;
    const message = format.value === 'image/png'
      ? 'PNG is lossless: quality settings do not reduce its size, and the file may grow. PNG keeps transparency. Choose JPEG or WebP for stronger compression.'
      : `${format.value === 'image/jpeg' ? 'JPEG makes transparent areas white.' : 'WebP keeps transparency.'} Lower quality can reduce fine detail. Dimensions stay unchanged unless Resize image is enabled; already compressed images may not shrink.`;
    tradeoff.replaceChildren(notice(format.value === 'image/png' ? 'warn' : 'info', message));
    updateDimensions();
  };
  for (const control of [format, quality, limit, resize, sizing, width, height, enlarge, padding]) control.addEventListener('change', updateSettings);
  quality.addEventListener('input', updateSettings);
  width.addEventListener('input', updateSettings); height.addEventListener('input', updateSettings);
  updateSettings();

  function selectedLayout(source = bitmap) {
    if (!source) throw new Error('Choose an image first.');
    const mode = resize.checked ? sizing.value as Sizing : 'maximum';
    const targetWidth = resize.checked && width.value ? Number(width.value) : undefined;
    const targetHeight = resize.checked && height.value ? Number(height.value) : undefined;
    if (resize.checked && mode === 'maximum' && targetWidth === undefined && targetHeight === undefined) throw new Error('Enter a width, height, or both.');
    if (resize.checked && mode !== 'maximum' && (targetWidth === undefined || targetHeight === undefined)) throw new Error('Exact sizing requires both width and height.');
    const layout = sizeImage(source.width, source.height, targetWidth, targetHeight, mode, resize.checked && enlarge.checked);
    if (layout.width * layout.height > MAX_PIXELS) throw new Error('Output would be too large for browser memory. Reduce the dimensions.');
    return layout;
  }
  function updateDimensions() {
    if (!resize.checked) { dimensions.textContent = bitmap ? `Keep original dimensions · ${bitmap.width} × ${bitmap.height} pixels.` : 'Keep original dimensions.'; return; }
    if (!bitmap) { dimensions.textContent = 'Choose an image to see its output dimensions.'; return; }
    try { const layout = selectedLayout(); dimensions.textContent = `Output dimensions: ${layout.width} × ${layout.height} pixels · Original: ${bitmap.width} × ${bitmap.height} pixels.`; }
    catch (error) { dimensions.textContent = (error as Error).message; }
  }

  function selectedQuality() {
    if (format.value === 'image/png') return 0.9;
    const value = Number(quality.value);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Choose an encoding quality from 1 to 100.');
    return value / 100;
  }
  function maximumBytes() {
    if (!limit.checked) return undefined;
    const bytes = Math.floor(Number(maxSize.value) * (sizeUnit.value === 'mb' ? 1_000_000 : 1000));
    if (!(bytes >= 1000 && bytes <= 1_000_000_000)) throw new Error('Enter a size from 1 KB to 1,000 MB.');
    return bytes;
  }
  const task = taskControls('compress-image', 'Compress Image', async ({ signal, progress }) => {
    const source = file!, decoded = bitmap!, request = imageRequest;
    const type = format.value, startQuality = selectedQuality(), maxBytes = maximumBytes();
    const layout = selectedLayout(decoded);
    const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
    const filename = sanitizeFilename(name.value.replace(/\.(png|jpe?g|webp)$/i, ''), 'compressed') + '.' + extension;
    const operation = new AbortController();
    operationController = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    const checkCurrent = () => {
      throwIfAborted(signal);
      throwIfAborted(operation.signal);
      if (disposed || request !== imageRequest) throw new DOMException('Cancelled', 'AbortError');
    };
    const canvas = document.createElement('canvas');
    try {
      checkCurrent();
      progress(0.1, 'Preparing image…');
      canvas.width = layout.width; canvas.height = layout.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot process images.');
      context.imageSmoothingQuality = 'high';
      if (type === 'image/jpeg') { context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); }
      if (resize.checked && sizing.value === 'contain' && padding.value !== 'transparent') {
        // Paint only the padding bands, so source transparency remains white in JPEG and transparent in PNG/WebP.
        context.fillStyle = padding.value;
        context.fillRect(0, 0, layout.width, layout.y);
        context.fillRect(0, layout.y + layout.drawHeight, layout.width, layout.height - layout.y - layout.drawHeight);
        context.fillRect(0, layout.y, layout.x, layout.drawHeight);
        context.fillRect(layout.x + layout.drawWidth, layout.y, layout.width - layout.x - layout.drawWidth, layout.drawHeight);
      }
      context.drawImage(decoded, layout.x, layout.y, layout.drawWidth, layout.drawHeight);
      let encodes = 0;
      const encode = async (value: number) => {
        checkCurrent();
        progress(Math.min(0.9, 0.2 + encodes++ * 0.075), maxBytes ? 'Compressing to the size limit…' : 'Compressing image…');
        const blob = await encodeCanvas(canvas, type, value, operation.signal);
        checkCurrent();
        if (!blob || blob.type !== type) throw new Error('This browser cannot encode the selected format. Pick another format.');
        return blob;
      };
      const blob = maxBytes === undefined || type === 'image/png' ? await encode(startQuality) : await encodeWithinLimit(encode, startQuality, maxBytes);
      if (maxBytes !== undefined && blob.size > maxBytes) throw new Error('PNG is lossless and exceeds the file size limit. Choose JPEG or WebP, or raise the limit. Nothing was saved.');
      checkCurrent();
      progress(1, 'Downloading image…');
      downloadBlob(blob, filename);
      const saved = source.size - blob.size;
      const message = saved > 0
        ? `Saved ${formatBytes(saved)} (${(saved / source.size * 100).toFixed(1)}%). Image downloaded.`
        : saved === 0 ? 'No size reduction with these settings. Image downloaded.' : `Output is ${formatBytes(-saved)} larger with these settings. Image downloaded.`;
      return `${message} Original: ${formatBytes(source.size)} → Output: ${formatBytes(blob.size)} · Dimensions: ${decoded.width} × ${decoded.height} → ${layout.width} × ${layout.height} pixels`;
    } finally { signal.removeEventListener('abort', abort); operationController = null; canvas.width = canvas.height = 0; }
  }, { validate: () => {
    if (!file || !bitmap) return 'Choose an image first.';
    if (!name.value.trim()) return 'Enter an output filename.';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(format.value)) return 'Choose an output format.';
    try { selectedLayout(); selectedQuality(); maximumBytes(); } catch (error) { return (error as Error).message; }
    return null;
  } });
  const picker = filePicker({ label: 'Image file', accept: IMAGE_ACCEPT, onFiles: async ([selected]) => {
    const request = ++imageRequest;
    const key = fileSourceKey(selected);
    const sameSource = sourceKey === key;
    bitmap?.close(); bitmap = null; file = null;
    updateDimensions();
    if (!sameSource) { suggestName(); task.reset(); }
    info.replaceChildren();
    const bad = detectUnsupportedImage(selected);
    if (bad) { sourceKey = ''; suggestName(); task.reset(); info.append(notice('warn', bad)); return; }
    if (selected.size > MAX_FILE_BYTES) { sourceKey = ''; suggestName(); task.reset(); info.append(notice('warn', `File exceeds ${formatBytes(MAX_FILE_BYTES)}.`)); return; }
    sourceKey = key;
    if (!sameSource) suggestName(selected.name);
    try {
      info.append(notice('info', 'Reading image…'));
      const decoded = await createImageBitmap(selected, { imageOrientation: 'from-image' });
      if (disposed || request !== imageRequest) { decoded.close(); return; }
      if (decoded.width * decoded.height > MAX_PIXELS) { decoded.close(); throw new Error('Image is too large to process in the browser.'); }
      bitmap = decoded; file = selected;
      info.replaceChildren(notice('info', `${selected.name} · ${formatBytes(selected.size)} · ${decoded.width} × ${decoded.height} pixels. The source stays untouched.`));
      updateDimensions();
    } catch (error) {
      if (!disposed && request === imageRequest) { sourceKey = ''; suggestName(); task.reset(); info.replaceChildren(notice('danger', `Cannot decode this image (${(error as Error).message}). The format may be unsupported by this browser.`)); }
    }
  } });
  toolPage(root, 'compress-image', { config: [group(null, picker, info), group(null, option('Resize image', 'Choose smaller bounds or an exact output size.', resize), resizeBox, dimensions), group(null, field('Output format', format), qualityField, tradeoff,
    option('Limit file size', 'Set a maximum size for the compressed file.', limit), sizeBox, field('Output filename (without extension)', name),
    h('p', { class: 'field-hint' }, 'Saved camera rotation is applied automatically. The saved copy removes camera details, location and comments; your original stays unchanged.'))], actions: [task.el] });
  persistForm('compress-image', root);
  return () => { disposed = true; imageRequest++; operationController?.abort(); bitmap?.close(); bitmap = null; file = null; };
}

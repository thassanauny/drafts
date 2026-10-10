import { afterEach, expect, it, vi } from 'vitest';
import { mount } from '../src/tools/imageWorkshop';
import { store } from '../src/lib/storage';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it('exports the full image after cropping moves to a separate utility, including when a previous draft contains crop fields', async () => {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!;
  store.setDraft('image-workshop', { cropX: '100', cropY: '50', cropW: '800', cropH: '600', quality: '10', limitSize: '1', maxSize: '1', sizeUnit: 'kb', width: '100', height: '100', sizing: 'stretch', enlarge: '1', padding: 'black', flipH: '1', flipV: '1' });
  const source = { width: 1200, height: 800, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
  const context = { drawImage() {}, translate() {}, rotate() {}, scale: vi.fn(), setTransform() {} };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
  const encodedSizes: number[][] = [];
  const encodedQualities: (number | undefined)[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
    encodedSizes.push([this.width, this.height]); encodedQualities.push(quality); callback(new Blob(['fixture'], { type: type ?? 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  const cleanup = mount(root);
  try {
    expect(root.querySelector('[name="cropW"]')).toBeNull();
    expect(root.querySelector('.crop-section')).toBeNull();
    for (const name of ['quality', 'limitSize', 'maxSize', 'sizeUnit', 'width', 'height', 'sizing', 'enlarge', 'padding']) expect(root.querySelector(`[name="${name}"]`)).toBeNull();
    const rotate = root.querySelector<HTMLSelectElement>('[name=rotate]')!;
    const flip = root.querySelector<HTMLSelectElement>('[name=flip]')!;
    expect([...rotate.options].map(option => [option.value, option.text])).toEqual([['0', 'No rotation'], ['90', '90°'], ['180', '180°'], ['270', '270°']]);
    expect([...flip.options].map(option => [option.value, option.text])).toEqual([['none', 'No flip'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['both', 'Both']]);
    expect(rotate.value).toBe('0'); expect(flip.value).toBe('none');
    expect(root.querySelector(`label[for="${rotate.id}"]`)!.textContent).toBe('Rotate clockwise');
    expect(root.querySelector(`label[for="${flip.id}"]`)!.textContent).toBe('Flip');
    expect(rotate.closest('.option-grid')).toBe(flip.closest('.option-grid'));
    expect(rotate.closest('.option-grid')).not.toBeNull();
    expect(root.querySelector('[name=flipH]')).toBeNull(); expect(root.querySelector('[name=flipV]')).toBeNull();
    expect(root.textContent).toContain('Camera orientation is corrected automatically.');
    expect(root.textContent).toContain('Use Compress Image');
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['fixture'], 'sample.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('1200×800'));
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Export image →')!.click();
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done.'));
    expect(encodedSizes).toEqual([[1200, 800]]);
    expect(encodedQualities).toEqual([0.9]);
    expect(context.scale).toHaveBeenCalledWith(1, 1);
    root.dispatchEvent(new Event('utility-desk:leave'));
    expect(store.getDraft('image-workshop').flipH).toBeUndefined(); expect(store.getDraft('image-workshop').flipV).toBeUndefined();
  } finally { root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); }
});

const orientationCases = [[90, 800, 1200], [180, 1200, 800], [270, 800, 1200]].flatMap(([rotation, width, height]) =>
  [['none', 1, 1], ['horizontal', -1, 1], ['vertical', 1, -1], ['both', -1, -1]].map(([flip, x, y]) => [rotation, flip, width, height, x, y] as const));

it.each(orientationCases)('rotates %s° with %s flip at the original dimensions despite obsolete saved resize preferences', async (rotation, flip, width, height, x, y) => {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!;
  store.setDraft('image-workshop', { width: '100', height: '100', sizing: 'contain', enlarge: '1', padding: 'black', rotate: String(rotation), flip: String(flip), flipH: '1', flipV: '1' });
  const source = { width: 1200, height: 800, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
  const context = { drawImage: vi.fn(), translate: vi.fn(), rotate: vi.fn(), scale: vi.fn(), setTransform: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
  const encodedSizes: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    encodedSizes.push([this.width, this.height]); callback(new Blob(['fixture'], { type: type ?? 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  const cleanup = mount(root);
  try {
    const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['fixture'], 'photo.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('1200×800'));
    [...root.querySelectorAll('button')].find(button => button.textContent === 'Export image →')!.click();
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done.'));
    expect(encodedSizes).toEqual([[width, height]]);
    expect(context.translate).toHaveBeenCalledWith(width / 2, height / 2);
    expect(context.rotate).toHaveBeenCalledWith(rotation * Math.PI / 180);
    expect(context.scale).toHaveBeenCalledWith(x, y);
    expect(context.translate.mock.invocationCallOrder[0]).toBeLessThan(context.scale.mock.invocationCallOrder[0]);
    expect(context.scale.mock.invocationCallOrder[0]).toBeLessThan(context.rotate.mock.invocationCallOrder[0]);
    expect(context.rotate.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
    expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0, 1200, 800, -600, -400, 1200, 800);
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  } finally { root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); }
});

const pixelCases = [
  [90, 'none', [[5, 3, 1], [6, 4, 2]]],
  [90, 'horizontal', [[1, 3, 5], [2, 4, 6]]],
  [90, 'vertical', [[6, 4, 2], [5, 3, 1]]],
  [90, 'both', [[2, 4, 6], [1, 3, 5]]],
  [180, 'none', [[6, 5], [4, 3], [2, 1]]],
  [180, 'horizontal', [[5, 6], [3, 4], [1, 2]]],
  [180, 'vertical', [[2, 1], [4, 3], [6, 5]]],
  [180, 'both', [[1, 2], [3, 4], [5, 6]]],
  [270, 'none', [[2, 4, 6], [1, 3, 5]]],
  [270, 'horizontal', [[6, 4, 2], [5, 3, 1]]],
  [270, 'vertical', [[1, 3, 5], [2, 4, 6]]],
  [270, 'both', [[5, 3, 1], [6, 4, 2]]],
] as const;

it.each(pixelCases)('mirrors the displayed axes after %s° rotation with %s flip in preview and export', async (rotation, flip, expected) => {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!;
  store.setDraft('image-workshop', { rotate: String(rotation), flip });
  const source = { width: 2, height: 3, close: vi.fn() };
  const sourcePixels = [[1, 2], [3, 4], [5, 6]];
  const raster = new WeakMap<HTMLCanvasElement, number[][]>();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
    // Apply Canvas's affine transforms to pixel centers, independently of the expected grids.
    const context = {
      translate(x: number, y: number) { e += a * x + c * y; f += b * x + d * y; },
      scale(x: number, y: number) { a *= x; b *= x; c *= y; d *= y; },
      rotate(angle: number) {
        const cos = Math.round(Math.cos(angle)), sin = Math.round(Math.sin(angle));
        [a, b, c, d] = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin];
      },
      setTransform() { a = d = 1; b = c = e = f = 0; },
      drawImage: (image: unknown, ...coords: number[]) => {
        const pixels = image === source ? sourcePixels : raster.get(image as HTMLCanvasElement)!;
        const [x, y, width, height] = coords.length === 8 ? coords.slice(4) : coords;
        const result = Array.from({ length: this.height }, () => Array<number>(this.width).fill(0));
        for (let row = 0; row < pixels.length; row++) for (let col = 0; col < pixels[row].length; col++) {
          const px = x + (col + 0.5) * width / pixels[row].length;
          const py = y + (row + 0.5) * height / pixels.length;
          result[Math.floor(b * px + d * py + f)][Math.floor(a * px + c * py + e)] = pixels[row][col];
        }
        raster.set(this, result);
      },
    };
    return context as unknown as CanvasRenderingContext2D;
  });
  let encoded: number[][] | undefined;
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    encoded = raster.get(this); callback(new Blob(['fixture'], { type: type ?? 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  const cleanup = mount(root);
  try {
    const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['fixture'], 'grid.png', { type: 'image/png' })] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(root.textContent).toContain('grid.png: 2×3'));
    const preview = root.querySelector<HTMLCanvasElement>('.preview-img')!;
    expect(raster.get(preview)).toEqual(expected);
    expect([preview.width, preview.height]).toEqual([expected[0].length, expected.length]);
    [...root.querySelectorAll('button')].find(button => button.textContent === 'Export image →')!.click();
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done.'));
    expect(encoded).toEqual(expected);
  } finally { root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); }
});

function colorFixture(draft: Record<string, string> = {}) {
  document.body.innerHTML = '<main></main>';
  const root = document.querySelector('main')!;
  store.setDraft('image-workshop', draft);
  const source = { width: 3, height: 3, close: vi.fn() };
  const original = new Uint8ClampedArray(Array.from({ length: 9 }, () => [100, 160, 220, 200]).flat());
  let pixels = original.slice();
  const encoded: number[][] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
  const context = {
    drawImage(image: unknown) { if (image === source) pixels = original.slice(); },
    translate() {}, rotate() {}, scale() {}, setTransform() {}, fillRect() {},
    getImageData: vi.fn(() => ({ data: pixels.slice(), width: 3, height: 3 })),
    putImageData(image: ImageData) { pixels = image.data.slice(); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => {
    encoded.push(Array.from(pixels.slice(0, 4))); callback(new Blob(['fixture'], { type: type ?? 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  const cleanup = mount(root);
  const choose = (name = 'colors.png') => {
    const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(picker, 'files', { value: [new File(['fixture'], name, { type: 'image/png' })], configurable: true });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const edit = (name: string, value: string) => {
    const control = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    if (control.type === 'checkbox') control.checked = value === '1'; else control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const action = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!.click();
  const exportImage = async () => {
    action('Export image →');
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done.'));
    return encoded.at(-1);
  };
  return { root, source, context, choose, edit, action, exportImage, preview: () => Array.from(pixels.slice(0, 4)), cleanup, dispose: () => { root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); } };
}

it.each([
  ['original', [100, 160, 220, 200]],
  ['grayscale', [149, 149, 149, 200]],
  ['sepia', [204, 182, 141, 200]],
] as const)('uses one %s color effect for preview and export while ignoring obsolete combined flags', async (style, expected) => {
  const fixture = colorFixture({ gray: '1', sepia: '1' });
  try {
    const select = fixture.root.querySelector<HTMLSelectElement>('[name=colorStyle]')!;
    expect(select.value).toBe('original');
    expect([...select.options].map(option => [option.value, option.text])).toEqual([['original', 'Original colors'], ['grayscale', 'Grayscale'], ['sepia', 'Sepia']]);
    expect(fixture.root.querySelector(`label[for="${select.id}"]`)!.textContent).toBe('Color style');
    expect(fixture.root.querySelector('[name=gray]')).toBeNull();
    expect(fixture.root.querySelector('[name=sepia]')).toBeNull();
    fixture.choose();
    await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    fixture.edit('colorStyle', style);
    expect(fixture.preview()).toEqual(expected);
    expect(await fixture.exportImage()).toEqual(expected);
    if (style === 'original') expect(fixture.context.getImageData).not.toHaveBeenCalled();
    fixture.root.dispatchEvent(new Event('utility-desk:leave'));
    expect(store.getDraft('image-workshop').gray).toBeUndefined();
    expect(store.getDraft('image-workshop').sepia).toBeUndefined();
    expect(store.getDraft('image-workshop').colorStyle).toBe(style);
  } finally { fixture.dispose(); }
});

it.each(['Cancel', 'leave', 'dispose'])('settles a pending workshop encoder immediately on %s and ignores its late output', async (stop) => {
  const fixture = colorFixture();
  let pending!: { canvas: HTMLCanvasElement; complete: BlobCallback };
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) { pending = { canvas: this, complete: callback }; });
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('colors.png: 3×3'));
    fixture.action('Export image →'); await vi.waitFor(() => expect(pending).toBeDefined());
    if (stop === 'Cancel') fixture.action('Cancel');
    else if (stop === 'leave') fixture.root.dispatchEvent(new Event('utility-desk:leave'));
    else fixture.cleanup();
    await vi.waitFor(() => expect(fixture.root.querySelector('.status')!.textContent).toBe('Cancelled.'));
    expect(pending.canvas.width).toBe(0); expect(pending.canvas.height).toBe(0);
    expect(fixture.root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    expect([...fixture.root.querySelectorAll('button')].find(button => button.textContent === 'Export image →')!.disabled).toBe(false);
    pending.complete(new Blob(['obsolete'], { type: 'image/png' }));
    await Promise.resolve(); expect(click).not.toHaveBeenCalled();
    expect(fixture.root.querySelector('.status')!.textContent).toBe('Cancelled.');
  } finally { fixture.dispose(); }
});

it('can retry after cancellation while the abandoned encoder callback is still pending', async () => {
  const fixture = colorFixture();
  const callbacks: BlobCallback[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => { callbacks.push(callback); });
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    fixture.action('Export image →'); await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    fixture.action('Cancel'); await vi.waitFor(() => expect(fixture.root.querySelector('.status')!.textContent).toBe('Cancelled.'));
    fixture.edit('format', 'image/webp'); fixture.action('Retry');
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[0](new Blob(['old'], { type: 'image/png' })); await Promise.resolve();
    expect(click).not.toHaveBeenCalled(); expect(fixture.root.querySelector('.status')!.textContent).toBe('Working…');
    callbacks[1](new Blob(['new'], { type: 'image/webp' }));
    await vi.waitFor(() => expect(fixture.root.querySelector('.status')!.textContent).toContain('Done. colors-edited.webp'));
    expect(click).toHaveBeenCalledOnce();
  } finally { fixture.dispose(); }
});

it('fails a synchronous workshop encoder error without downloading and releases its canvas', async () => {
  const fixture = colorFixture();
  const attempted: HTMLCanvasElement[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement) {
    attempted.push(this); throw new Error('Encoder failed synchronously');
  });
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    fixture.action('Export image →');
    await vi.waitFor(() => expect(fixture.root.querySelector('.status')!.textContent).toBe('Failed: Encoder failed synchronously'));
    expect(click).not.toHaveBeenCalled(); expect(attempted).toHaveLength(1);
    expect(attempted[0].width).toBe(0); expect(attempted[0].height).toBe(0);
    expect(fixture.root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
  } finally { fixture.dispose(); }
});

it('clears old workshop results on source selection and keeps edit preferences with the new source', async () => {
  const fixture = colorFixture();
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    fixture.edit('format', 'image/webp'); fixture.edit('rotate', '90'); fixture.edit('flip', 'horizontal'); fixture.edit('colorStyle', 'sepia');
    await fixture.exportImage();
    expect(fixture.root.querySelector<HTMLElement>('.progress')!.hidden).toBe(false);
    fixture.choose('new.png');
    expect(fixture.root.querySelector('.status')!.textContent).toBe('Ready.');
    expect(fixture.root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    expect(fixture.source.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(fixture.root.textContent).toContain('new.png: 3×3'));
    for (const [name, value] of [['format', 'image/webp'], ['rotate', '90'], ['flip', 'horizontal'], ['colorStyle', 'sepia']]) expect(fixture.root.querySelector<HTMLSelectElement>(`[name=${name}]`)!.value).toBe(value);
    await fixture.exportImage(); expect(fixture.root.querySelector('.status')!.textContent).toContain('new-edited.webp');
  } finally { fixture.dispose(); }
});

it('discards stale workshop decodes and closes images returned after disposal', async () => {
  const fixture = colorFixture();
  const pending: ((image: { width: number; height: number; close: ReturnType<typeof vi.fn> }) => void)[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => pending.push(resolve))));
  try {
    fixture.choose('old.png'); fixture.choose('current.png');
    const current = { width: 300, height: 200, close: vi.fn() }, old = { width: 100, height: 100, close: vi.fn() };
    pending[1](current); await vi.waitFor(() => expect(fixture.root.textContent).toContain('current.png: 300×200'));
    pending[0](old); await vi.waitFor(() => expect(old.close).toHaveBeenCalledOnce());
    expect(fixture.root.textContent).not.toContain('old.png:');
    fixture.choose('late.png'); fixture.cleanup();
    const late = { width: 10, height: 10, close: vi.fn() }; pending[2](late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(current.close).toHaveBeenCalledOnce();
    expect(fixture.root.querySelector<HTMLCanvasElement>('.preview-img')!.width).toBe(0);
    expect(fixture.root.textContent).not.toContain('late.png:');
  } finally { fixture.dispose(); }
});

it('closes an oversized workshop decode and prevents exporting the former source', async () => {
  const fixture = colorFixture();
  const oversized = { width: 10001, height: 10000, close: vi.fn() };
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => oversized));
    fixture.choose('huge.png'); await vi.waitFor(() => expect(fixture.root.textContent).toContain('Image is too large'));
    expect(oversized.close).toHaveBeenCalledOnce(); expect(fixture.source.close).toHaveBeenCalledOnce();
    fixture.action('Export image →'); expect(fixture.root.querySelector('.status')!.textContent).toBe('Choose an image first.');
    expect(encode).not.toHaveBeenCalled(); expect(fixture.root.querySelector<HTMLCanvasElement>('.preview-img')!.width).toBe(0);
  } finally { fixture.dispose(); }
});

it('flattens JPEG transparency to white after sepia while PNG preserves alpha', async () => {
  const fixture = colorFixture();
  fixture.source.height = 1;
  const original = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 128, 0, 0, 255, 255]);
  let pixels = original.slice();
  const context = {
    globalCompositeOperation: 'source-over', fillStyle: '',
    drawImage(image: unknown) { if (image === fixture.source) pixels = original.slice(); },
    translate() {}, rotate() {}, scale() {}, setTransform() {},
    getImageData: () => ({ data: pixels.slice(), width: 3, height: 1 }),
    putImageData(image: ImageData) { pixels = image.data.slice(); },
    fillRect() {
      expect(this.globalCompositeOperation).toBe('destination-over'); expect(this.fillStyle).toBe('white');
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        for (let channel = 0; channel < 3; channel++) pixels[i + channel] = pixels[i + channel] * alpha + 255 * (1 - alpha);
        pixels[i + 3] = 255;
      }
    },
  };
  const outputs: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => { outputs.push(Array.from(pixels)); callback(new Blob(['fixture'], { type })); });
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×1'));
    fixture.edit('colorStyle', 'sepia'); await fixture.exportImage();
    expect(outputs[0]).toEqual([100, 89, 69, 0, 100, 89, 69, 128, 48, 43, 33, 255]);
    fixture.edit('format', 'image/jpeg'); await fixture.exportImage();
    expect(outputs[1]).toEqual([255, 255, 255, 255, 177, 172, 162, 255, 48, 43, 33, 255]);
    expect(context.globalCompositeOperation).toBe('source-over');
  } finally { fixture.dispose(); }
});

it('reports the sanitized workshop download filename for a long source name', async () => {
  const fixture = colorFixture();
  try {
    fixture.choose('a'.repeat(180) + '.png'); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    await fixture.exportImage();
    const download = document.querySelector<HTMLAnchorElement>('a[download]')!.download;
    expect(download).toHaveLength(120); expect(download).toMatch(/\.png$/);
    expect(fixture.root.querySelector('.status')!.textContent).toContain(`Done. ${download} (`);
  } finally { fixture.dispose(); }
});

it('keeps contrast and detail controls separate and resets color style while preserving the source and output format', async () => {
  const fixture = colorFixture();
  try {
    fixture.choose(); await vi.waitFor(() => expect(fixture.root.textContent).toContain('3×3'));
    fixture.edit('format', 'image/webp'); fixture.edit('rotate', '90'); fixture.edit('flip', 'both'); fixture.edit('contrast', '20');
    expect(fixture.preview()).toEqual([86, 176, 255, 200]);
    fixture.edit('autoContrast', '1'); fixture.edit('sharpen', '1');
    expect(fixture.preview()).toEqual([0, 128, 255, 200]);
    fixture.edit('colorStyle', 'sepia');
    expect(fixture.preview()).toEqual([147, 131, 102, 200]);
    expect(await fixture.exportImage()).toEqual([147, 131, 102, 200]);
    await vi.waitFor(() => expect(store.getDraft('image-workshop').flip).toBe('both'));
    fixture.action('Reset edits');
    expect(fixture.root.querySelector<HTMLSelectElement>('[name=colorStyle]')!.value).toBe('original');
    expect(fixture.root.querySelector<HTMLInputElement>('[name=contrast]')!.value).toBe('0');
    expect(fixture.root.querySelector<HTMLInputElement>('[name=autoContrast]')!.checked).toBe(false);
    expect(fixture.root.querySelector<HTMLInputElement>('[name=sharpen]')!.checked).toBe(false);
    expect(fixture.root.querySelector<HTMLSelectElement>('[name=rotate]')!.value).toBe('0');
    expect(fixture.root.querySelector<HTMLSelectElement>('[name=flip]')!.value).toBe('none');
    expect(fixture.root.querySelector<HTMLSelectElement>('[name=format]')!.value).toBe('image/webp');
    expect(fixture.root.textContent).toContain('colors.png: 3×3');
    expect(fixture.preview()).toEqual([100, 160, 220, 200]);
    await vi.waitFor(() => expect(store.getDraft('image-workshop').flip).toBe('none'));
    expect(store.getDraft('image-workshop').colorStyle).toBe('original');
    expect(await fixture.exportImage()).toEqual([100, 160, 220, 200]);
  } finally { fixture.dispose(); }
});

it('restores the selected color preference on reload with orientation and output format, without restoring a source', () => {
  const fixture = colorFixture({ colorStyle: 'grayscale', rotate: '90', flip: 'vertical', format: 'image/webp', autoContrast: '1', sharpen: '1', contrast: '20', gray: '1', sepia: '1', flipH: '1', flipV: '1' });
  try {
    expect(fixture.root.querySelector<HTMLSelectElement>('[name=colorStyle]')!.value).toBe('grayscale');
    fixture.edit('colorStyle', 'sepia'); fixture.dispose();
    fixture.root.replaceChildren();
    const cleanup = mount(fixture.root);
    try {
      expect(fixture.root.querySelector<HTMLSelectElement>('[name=colorStyle]')!.value).toBe('sepia');
      expect(fixture.root.querySelector<HTMLSelectElement>('[name=rotate]')!.value).toBe('90');
      expect(fixture.root.querySelector<HTMLSelectElement>('[name=flip]')!.value).toBe('vertical');
      expect(fixture.root.querySelector<HTMLSelectElement>('[name=format]')!.value).toBe('image/webp');
      expect(fixture.root.querySelector<HTMLInputElement>('[name=contrast]')!.value).toBe('20');
      expect(fixture.root.querySelector<HTMLInputElement>('[name=autoContrast]')!.checked).toBe(true);
      expect(fixture.root.querySelector<HTMLInputElement>('[name=sharpen]')!.checked).toBe(true);
      expect(fixture.root.querySelector<HTMLInputElement>('input[type=file]')!.files).toHaveLength(0);
      expect(fixture.root.querySelector('[name=gray]')).toBeNull(); expect(fixture.root.querySelector('[name=sepia]')).toBeNull();
      expect(fixture.root.querySelector('[name=flipH]')).toBeNull(); expect(fixture.root.querySelector('[name=flipV]')).toBeNull();
    } finally { fixture.root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); }
  } finally { fixture.dispose(); }
});

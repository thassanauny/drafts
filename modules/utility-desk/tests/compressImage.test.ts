import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/tools/compressImage';
import { store } from '../src/lib/storage';
import { parseHash } from '../src/lib/router';

let root: HTMLElement, cleanup: (() => void) | undefined;
const drawImage = vi.fn(), fillRect = vi.fn();
let click: ReturnType<typeof vi.spyOn>;
let encoded: { canvas: HTMLCanvasElement; width: number; height: number; quality: number | undefined; type: string | undefined }[];
const bitmap = (width = 1200, height = 800) => ({ width, height, close: vi.fn() });
function pick(name = 'photo.PNG', size = 2000, type = '') {
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'.repeat(size)], name, { type, lastModified: 123456 })] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function edit(name: string, value: string) {
  const control = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  if (control.type === 'checkbox') control.checked = value === '1'; else control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
}
function action(label = 'Compress Image') { [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith(label))!.click(); }
const status = () => root.querySelector('.status')!.textContent;
const ready = () => vi.waitFor(() => expect(root.textContent).toContain('1200 × 800 pixels'));

beforeEach(() => {
  localStorage.clear(); document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!; encoded = []; drawImage.mockClear(); fillRect.mockClear();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap()));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
    encoded.push({ canvas: this, width: this.width, height: this.height, quality, type });
    callback(new Blob(['x'.repeat(500)], { type }));
  });
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('standalone image compression', () => {
  it('matches the PDF configuration shell, defaults to JPEG with a quality slider at 75 and downloads with actual savings', async () => {
    cleanup = mount(root);
    expect(parseHash('#/compress-image')).toBe('compress-image');
    expect(root.querySelector('h1')!.textContent).toBe('Compress Image');
    expect(root.querySelector('.panel-heading h2')!.textContent).toBe('A lighter image');
    expect(root.querySelectorAll('.side-panels .panel')).toHaveLength(2);
    expect(root.querySelector('.run-panel')).toBeNull();
    expect(root.querySelector<HTMLSelectElement>('[name=format]')!.value).toBe('image/jpeg');
    expect(root.querySelector('[name=compression]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('[name=quality]')!.value).toBe('75');
    expect(root.querySelector('output')!.value).toBe('75');
    expect(root.querySelector<HTMLElement>('.quality-slider')!.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[name=resize]')!.checked).toBe(false);
    expect(root.querySelector('[name=sizing]')!.parentElement!.parentElement!.hidden).toBe(true);
    expect(root.querySelector('.image-dimensions')!.textContent).toBe('Keep original dimensions.');
    pick(); await ready();
    expect(vi.mocked(createImageBitmap)).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' });
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('photo_compressed');
    action(); await vi.waitFor(() => expect(status()).toContain('Done.'));
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.download).toBe('photo_compressed.jpg');
    expect(encoded).toEqual([expect.objectContaining({ width: 1200, height: 800, quality: 0.75, type: 'image/jpeg' })]);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1200, 800);
    expect(status()).toContain('75.0%'); expect(status()).toContain('Original: 2.0 KB → Output: 500 B');
    expect(root.querySelector<HTMLProgressElement>('progress')!.value).toBe(100);
    expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(false);
    expect(encoded[0].canvas.width).toBe(0); expect(encoded[0].canvas.height).toBe(0);
    expect(status()).toContain('Dimensions: 1200 × 800 → 1200 × 800 pixels');
  });

  it('honors slider quality and a sanitized filename without a repeated image extension', async () => {
    cleanup = mount(root); pick(); await ready();
    edit('format', 'image/webp'); edit('quality', '42'); edit('outName', 'finished/name.JPEG');
    expect(root.querySelector<HTMLElement>('.quality-slider')!.hidden).toBe(false);
    expect(root.querySelector('output')!.value).toBe('42');
    action(); await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(encoded[0].quality).toBe(0.42);
    expect(fillRect).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.download).toBe('finished_name.webp');
  });

  it('lowers quality to meet a decimal KB limit without changing dimensions', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type });
      callback(new Blob(['x'.repeat(Math.round(4000 * quality!))], { type }));
    });
    cleanup = mount(root); pick(); await ready(); edit('limitSize', '1'); edit('maxSize', '1.5');
    action(); await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(encoded).toHaveLength(9);
    expect(encoded.every(({ width, height }) => width === 1200 && height === 800)).toBe(true);
    expect(status()).toContain('Done.');
    expect(encoded.at(-1)!.canvas.width).toBe(0);
  });

  it('does not save an image when even minimum quality exceeds the limit', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality: undefined, type });
      callback(new Blob(['x'.repeat(2000)], { type }));
    });
    cleanup = mount(root); pick(); await ready(); edit('limitSize', '1'); edit('maxSize', '1');
    action(); await vi.waitFor(() => expect(status()).toContain('Nothing was saved.'));
    expect(click).not.toHaveBeenCalled(); expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    expect(encoded[0].canvas.width).toBe(0);
  });

  it('retries a failed size limit using the corrected dimensions and filename', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type }); callback(new Blob(['x'.repeat(2000)], { type }));
    });
    cleanup = mount(root); pick(); await ready(); edit('limitSize', '1'); edit('maxSize', '1'); action();
    await vi.waitFor(() => expect(status()).toContain('Nothing was saved'));
    expect(click).not.toHaveBeenCalled(); expect(encoded).toHaveLength(2);
    edit('maxSize', '3'); edit('resize', '1'); edit('width', '600'); edit('outName', 'retry-result'); action('Retry');
    await vi.waitFor(() => expect(status()).toContain('Image downloaded'));
    expect(encoded).toHaveLength(3);
    expect(encoded[2]).toEqual(expect.objectContaining({ width: 600, height: 400, quality: 0.75, type: 'image/jpeg' }));
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.download).toBe('retry-result.jpg');
    expect(status()).toContain('Dimensions: 1200 × 800 → 600 × 400 pixels');
    expect(click).toHaveBeenCalledOnce();
  });

  it.each(['null', 'fallback PNG'])('rejects an unsupported browser encoder result (%s) without saving it', async (result) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type });
      callback(result === 'null' ? null : new Blob(['fixture'], { type: 'image/png' }));
    });
    cleanup = mount(root); pick(); await ready(); action();
    await vi.waitFor(() => expect(status()).toContain('cannot encode the selected format'));
    expect(click).not.toHaveBeenCalled(); expect(encoded).toHaveLength(1);
    expect(encoded[0].canvas.width).toBe(0); expect(encoded[0].canvas.height).toBe(0);
    expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
  });

  it.each([500, 2000])('checks lossless PNG against its size limit (%s bytes) without lowering quality', async (outputSize) => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type });
      callback(new Blob(['x'.repeat(outputSize)], { type }));
    });
    cleanup = mount(root); pick(); await ready(); edit('quality', '22'); edit('format', 'image/png'); edit('limitSize', '1'); edit('maxSize', '1');
    expect(root.querySelector<HTMLInputElement>('[name=quality]')!.disabled).toBe(true);
    expect(root.querySelector<HTMLElement>('.quality-slider')!.hidden).toBe(false);
    expect(root.textContent).toContain('PNG is lossless');
    action(); await vi.waitFor(() => expect(status()).not.toBe('Working…'));
    expect(encoded).toHaveLength(1); expect(fillRect).not.toHaveBeenCalled();
    expect(encoded[0].quality).toBe(0.9);
    if (outputSize === 500) {
      expect(click).toHaveBeenCalledOnce();
      expect(document.querySelector<HTMLAnchorElement>('a[download]')!.download).toBe('photo_compressed.png');
    } else { expect(status()).toContain('PNG is lossless and exceeds'); expect(click).not.toHaveBeenCalled(); }
    expect(root.querySelector<HTMLInputElement>('[name=quality]')!.disabled).toBe(true);
    edit('format', 'image/jpeg');
    expect(root.querySelector<HTMLInputElement>('[name=quality]')!.disabled).toBe(false);
    expect(root.querySelector<HTMLElement>('.quality-slider')!.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>('[name=quality]')!.value).toBe('22');
  });

  it('reports a larger result honestly and keeps output names out of saved preferences', async () => {
    store.setDraft('compress-image', { outName: 'old', quality: '90' });
    cleanup = mount(root); expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('');
    pick('small.jpeg', 100); await ready(); action();
    await vi.waitFor(() => expect(status()).toContain('Output is 400 B larger'));
    expect(encoded[0].quality).toBe(0.9);
    root.dispatchEvent(new Event('utility-desk:leave'));
    expect(store.getDraft('compress-image').outName).toBeUndefined();
    expect(store.getDraft('compress-image').quality).toBe('90');
  });

  it('rejects unsupported files and validates the filename before encoding', async () => {
    cleanup = mount(root); pick('wrong.txt');
    expect(createImageBitmap).not.toHaveBeenCalled(); expect(root.textContent).toContain('Unsupported files were skipped');
    pick('photo.JFIF'); await ready(); edit('outName', ''); action();
    expect(status()).toBe('Enter an output filename.'); expect(encoded).toHaveLength(0);
    edit('outName', 'photo'); edit('limitSize', '1'); edit('maxSize', '0.1'); action();
    expect(status()).toContain('Enter a size from 1 KB'); expect(encoded).toHaveLength(0);
  });

  it.each(['My chosen name', ''])('preserves %j when reselecting the same source and refreshes it for a new source', async (chosen) => {
    cleanup = mount(root); pick(); await ready(); edit('outName', chosen);
    pick(); await ready();
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe(chosen);
    pick('new.png'); await ready();
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('new_compressed');
  });

  it('clears the previous source result and completed progress when another image is selected', async () => {
    cleanup = mount(root); pick(); await ready(); action();
    await vi.waitFor(() => expect(status()).toContain('75.0%'));
    expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(false);
    pick('next.png');
    expect(status()).toBe('Ready.');
    expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    await ready(); expect(status()).not.toContain('Original:');
  });

  it.each(['Cancel', 'leave', 'dispose'])('releases a pending encoder and suppresses its later download on %s', async (stop) => {
    let complete!: BlobCallback;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type }); complete = callback;
    });
    cleanup = mount(root); pick(); await ready(); action();
    await vi.waitFor(() => expect(encoded).toHaveLength(1));
    if (stop === 'Cancel') action('Cancel'); else if (stop === 'leave') root.dispatchEvent(new Event('utility-desk:leave')); else cleanup();
    await vi.waitFor(() => expect(status()).toBe('Cancelled.'));
    expect(encoded[0].canvas.width).toBe(0); expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    complete(new Blob(['late'], { type: 'image/jpeg' }));
    await Promise.resolve(); expect(click).not.toHaveBeenCalled();
  });

  it('ignores obsolete decoded images and closes images returned after disposal', async () => {
    const pending: ((image: ReturnType<typeof bitmap>) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => pending.push(resolve))));
    cleanup = mount(root); pick('old.png'); pick('new.png');
    const newer = bitmap(300, 200), older = bitmap(); pending[1](newer);
    await vi.waitFor(() => expect(root.textContent).toContain('300 × 200 pixels'));
    pending[0](older); await vi.waitFor(() => expect(older.close).toHaveBeenCalledOnce());
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('new_compressed');
    pick('late.png'); cleanup(); cleanup = undefined;
    const late = bitmap(); pending[2](late); await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect(newer.close).toHaveBeenCalledOnce();
  });

  it.each(['Typed while loading', ''])('keeps the output name %j entered during decoding, including after an obsolete image finishes', async (chosenName) => {
    const pending: ((image: ReturnType<typeof bitmap>) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => pending.push(resolve))));
    cleanup = mount(root); pick('older.png'); pick('current.png');
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('current_compressed');
    edit('outName', chosenName);
    pending[1](bitmap()); await ready();
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe(chosenName);
    const obsolete = bitmap(100, 100); pending[0](obsolete);
    await vi.waitFor(() => expect(obsolete.close).toHaveBeenCalledOnce());
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe(chosenName);
    expect(root.textContent).not.toContain('100 × 100 pixels');
  });

  it('ties naming to the current selection through decoded A, pending B, repeated B and reselected A', async () => {
    const pending: ((image: ReturnType<typeof bitmap>) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => pending.push(resolve))));
    cleanup = mount(root); pick('a.png'); pending[0](bitmap()); await ready();
    edit('outName', 'Custom A'); pick('b.png');
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('b_compressed');
    edit('outName', 'Custom B'); pick('b.png');
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('Custom B');
    pick('a.png');
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('a_compressed');
    pending[3](bitmap()); await ready();
    const firstB = bitmap(100, 100), repeatedB = bitmap(200, 200);
    pending[1](firstB); pending[2](repeatedB);
    await vi.waitFor(() => { expect(firstB.close).toHaveBeenCalledOnce(); expect(repeatedB.close).toHaveBeenCalledOnce(); });
    expect(root.querySelector<HTMLInputElement>('[name=outName]')!.value).toBe('a_compressed');
    expect(root.textContent).not.toContain('100 × 100 pixels');
    expect(root.textContent).not.toContain('200 × 200 pixels');
  });
});

describe('optional image resizing', () => {
  it('ignores saved sizing values while resizing is off', async () => {
    store.setDraft('compress-image', { resize: '0', sizing: 'contain', width: '20000', height: '20000', enlarge: '1', padding: 'black' });
    cleanup = mount(root); pick(); await ready(); action();
    await vi.waitFor(() => expect(status()).toContain('Done.'));
    expect(encoded[0]).toMatchObject({ width: 1200, height: 800 });
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 1200, 800);
    expect(fillRect).toHaveBeenCalledOnce();
    expect(root.querySelector('.image-dimensions')!.textContent).toBe('Keep original dimensions · 1200 × 800 pixels.');
  });

  it.each([
    ['600', '', false, 600, 400], ['', '200', false, 300, 200], ['600', '100', false, 150, 100],
    ['2400', '', false, 1200, 800], ['2400', '', true, 2400, 1600],
  ])('keeps proportions with width %s and height %s, enlargement %s', async (width, height, enlargement, expectedWidth, expectedHeight) => {
    cleanup = mount(root); pick(); await ready(); edit('resize', '1'); edit('width', width); edit('height', height); edit('enlarge', enlargement ? '1' : '0');
    expect(root.querySelector('.image-dimensions')!.textContent).toContain(`Output dimensions: ${expectedWidth} × ${expectedHeight} pixels`);
    action(); await vi.waitFor(() => expect(status()).toContain('Done.'));
    expect(encoded[0]).toMatchObject({ width: expectedWidth, height: expectedHeight });
    expect(status()).toContain(`Dimensions: 1200 × 800 → ${expectedWidth} × ${expectedHeight} pixels`);
  });

  it.each([
    ['cover', -75, 0, 450, 300, 'edges are cropped'],
    ['contain', 0, 50, 300, 200, 'padding fills'],
    ['stretch', 0, 0, 300, 300, 'proportions may change'],
  ])('exports exact %s geometry and explains its tradeoff', async (mode, x, y, drawWidth, drawHeight, hint) => {
    cleanup = mount(root); pick(); await ready(); edit('resize', '1'); edit('sizing', mode); edit('width', '300'); edit('height', '300');
    expect(root.textContent).toContain(hint);
    expect(root.querySelector<HTMLInputElement>('[name=enlarge]')!.closest<HTMLElement>('.option')!.hidden).toBe(true);
    expect(root.querySelector('[name=padding]')!.parentElement!.hidden).toBe(mode !== 'contain');
    action(); await vi.waitFor(() => expect(status()).toContain('Done.'));
    expect(encoded[0]).toMatchObject({ width: 300, height: 300 });
    expect(drawImage).toHaveBeenCalledWith(expect.any(Object), x, y, drawWidth, drawHeight);
  });

  it.each([
    ['maximum', '', '', 'Enter a width, height, or both.'],
    ['cover', '', '', 'Exact sizing requires both width and height.'],
    ['contain', '300', '', 'Exact sizing requires both width and height.'],
    ['stretch', '', '300', 'Exact sizing requires both width and height.'],
    ['maximum', '1.5', '', 'Dimensions must be whole numbers'],
    ['cover', '20000', '20000', 'Output would be too large'],
    ['maximum', '20001', '', 'Dimensions must be whole numbers'],
  ])('blocks invalid %s dimensions %s × %s before encoding', async (mode, width, height, error) => {
    cleanup = mount(root); pick(); await ready(); edit('resize', '1'); edit('sizing', mode); edit('width', width); edit('height', height);
    expect(root.querySelector('.image-dimensions')!.textContent).toContain(error);
    action(); expect(status()).toContain(error); expect(encoded).toHaveLength(0); expect(click).not.toHaveBeenCalled();
  });

  it('uses the requested dimensions for every size-limit quality attempt', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type, quality) {
      encoded.push({ canvas: this, width: this.width, height: this.height, quality, type });
      callback(new Blob(['x'.repeat(Math.round(4000 * quality!))], { type }));
    });
    cleanup = mount(root); pick(); await ready(); edit('resize', '1'); edit('width', '600'); edit('limitSize', '1'); edit('maxSize', '1.5'); action();
    await vi.waitFor(() => expect(status()).toContain('Done.'));
    expect(encoded).toHaveLength(9);
    expect(encoded.every(({ width, height }) => width === 600 && height === 400)).toBe(true);
    expect(status()).toContain('Dimensions: 1200 × 800 → 600 × 400 pixels');
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])('keeps source transparency inside colored padding for %s', async (format) => {
    const source = bitmap(2, 1);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
    let pixels: (string | undefined)[] = [];
    const context = {
      fillStyle: 'black', imageSmoothingQuality: '',
      fillRect(x: number, y: number, width: number, height: number) {
        for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) pixels[row * 4 + col] = this.fillStyle;
      },
      drawImage(_source: unknown, x: number, y: number, width: number, height: number) {
        // Source left half is transparent, right half opaque red. Only opaque source pixels replace their destination.
        for (let row = y; row < y + height; row++) for (let col = x + width / 2; col < x + width; col++) pixels[row * 4 + col] = 'red';
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => { pixels = new Array(16); return context as unknown as CanvasRenderingContext2D; });
    cleanup = mount(root); pick(); await vi.waitFor(() => expect(root.textContent).toContain('2 × 1 pixels'));
    edit('resize', '1'); edit('sizing', 'contain'); edit('width', '4'); edit('height', '4'); edit('format', format);
    for (const color of ['black', 'white', 'transparent']) {
      edit('padding', color); action(); await vi.waitFor(() => expect(status()).toContain('Done.'));
      const margin = color === 'transparent' ? format === 'image/jpeg' ? 'white' : undefined : color;
      const sourceTransparent = format === 'image/jpeg' ? 'white' : undefined;
      expect(pixels).toEqual([
        margin, margin, margin, margin,
        sourceTransparent, sourceTransparent, 'red', 'red',
        sourceTransparent, sourceTransparent, 'red', 'red',
        margin, margin, margin, margin,
      ]);
      expect(context.imageSmoothingQuality).toBe('high');
    }
  });
});

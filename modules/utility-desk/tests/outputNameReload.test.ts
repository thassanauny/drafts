import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '../src/lib/storage';
import { mount as document } from '../src/tools/documentConverter';
import { mount as media } from '../src/tools/mediaConverter';
import { mount as compress } from '../src/tools/compressPdf';
import { mount as unlock } from '../src/tools/unlockPdf';
import { mount as images } from '../src/tools/imagesToPdf';
import { mount as merge } from '../src/tools/mergePdfs';
import { mount as crop } from '../src/tools/cropImage';
import { mount as compressImage } from '../src/tools/compressImage';
vi.mock('../src/lib/caps', () => ({ detectCapabilities: () => [
  { id: 'ffmpeg', label: 'FFmpeg', state: 'Supported', detail: 'Test environment' },
] }));
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  window.document.body.innerHTML = '<main id="main"></main>';
  root = window.document.getElementById('main')!;
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([
  ['document-converter', document], ['media-converter', media], ['compress-pdf', compress],
  ['unlock-pdf', unlock], ['images-to-pdf', images], ['merge-pdfs', merge], ['crop-image', crop], ['compress-image', compressImage],
] as const)('%s resets its output name instead of restoring a saved name', (id, mount) => {
  store.setDraft(id, {outName: 'old_output', outputName: 'old_output'});
  const cleanup = mount(root);
  const control = root.querySelector<HTMLInputElement>('[name=outName], [name=outputName]')!;
  expect(control.value).toBe(id === 'merge-pdfs' ? 'merged' : '');
  control.value = 'edited'; control.dispatchEvent(new Event('input', {bubbles: true}));
  root.dispatchEvent(new Event('utility-desk:leave'));
  if (id !== 'unlock-pdf') {
    expect(store.getDraft(id).outName).toBeUndefined();
    expect(store.getDraft(id).outputName).toBeUndefined();
  }
  if (typeof cleanup === 'function') cleanup();
});

function addImages(files: File[]) {
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: files });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
function listAction(label: string) {
  root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
}

it.each(['custom_book', ''])('keeps output name %j while later images change', (chosenName) => {
  images(root);
  addImages([new File(['first'], 'first.png'), new File(['second'], 'second.png')]);
  const name = root.querySelector<HTMLInputElement>('[name=outName]')!;
  expect(name.value).toBe('first_images');
  name.value = chosenName;
  addImages([new File(['third'], 'third.png')]);
  expect(name.value).toBe(chosenName);
  listAction('Move third.png up');
  expect(name.value).toBe(chosenName);
  listAction('Remove second.png');
  expect(name.value).toBe(chosenName);
  addImages([new File(['unsupported'], 'picture.heic', { type: 'image/heic' })]);
  expect(name.value).toBe(chosenName);
  listAction('Move first.png down');
  expect(name.value).toBe('third_images');
  name.value = chosenName;
  listAction('Remove third.png');
  expect(name.value).toBe('first_images');
  listAction('Remove first.png');
  expect(name.value).toBe('');
});

it('refreshes the suggestion when a different first image has the same filename', () => {
  images(root);
  addImages([new File(['first'], 'same.png'), new File(['second'], 'same.png')]);
  const name = root.querySelector<HTMLInputElement>('[name=outName]')!;
  name.value = 'custom';
  listAction('Move same.png down');
  expect(name.value).toBe('same_images');
});

const singleSourceTools = [
  { id: 'compress-pdf', mount: compress, extension: 'pdf', suffix: 'compressed' },
  { id: 'unlock-pdf', mount: unlock, extension: 'pdf', suffix: 'unlocked' },
  { id: 'document-converter', mount: document, extension: 'md', suffix: 'converted' },
  { id: 'media-converter', mount: media, extension: 'mp4', suffix: 'converted' },
  { id: 'crop-image', mount: crop, extension: 'png', suffix: 'cropped' },
] as const;
for (const tool of singleSourceTools) {
  it.each(['Keep my name', ''])(`preserves output name %j when ${tool.id} reselects the same source, then resets for changed or invalid sources`, async chosenName => {
    vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
    const cleanup = tool.mount(root);
    const file = (name = `source.${tool.extension}`, lastModified = 123) => new File(['fixture'], name, { lastModified });
    const control = root.querySelector<HTMLInputElement>('[name=outName], [name=outputName]')!;
    try {
      addImages([file()]);
      await vi.waitFor(() => expect(control.value).toBe(`source_${tool.suffix}`));
      if (tool.id === 'crop-image') await vi.waitFor(() => expect(root.textContent).toContain('source.png: 100×100'));
      control.value = chosenName;
      addImages([file()]);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(control.value).toBe(chosenName);
      addImages([file(undefined, 124)]);
      await vi.waitFor(() => expect(control.value).toBe(`source_${tool.suffix}`));
      addImages([file(`different.${tool.extension}`)]);
      await vi.waitFor(() => expect(control.value).toBe(`different_${tool.suffix}`));
      const tooLarge = file(`large.${tool.extension}`);
      Object.defineProperty(tooLarge, 'size', { value: 300 * 1024 * 1024 });
      addImages([tooLarge]);
      expect(control.value).toBe('');
      expect(root.textContent).toMatch(/exceeds|browser limit/);
    } finally { if (typeof cleanup === 'function') cleanup(); }
  });
}

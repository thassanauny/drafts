import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import { mount as crop } from '../src/tools/cropImage';
import { mount as images } from '../src/tools/imagesToPdf';
import { mount as pages } from '../src/tools/pdfToImages';
import { mount as compress } from '../src/tools/compressPdf';
import { taskControls } from '../src/ui';

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, AnnotationMode: { ENABLE: 1, DISABLE: 0 }, getDocument: vi.fn() }));
let root: HTMLElement;
let cleanup: (() => void) | undefined;
let pending: { canvas: HTMLCanvasElement; complete: BlobCallback; type: string }[];
let bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[];
const pageCleanup = vi.fn(), destroy = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!; pending = []; bitmaps = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    const bitmap = { width: 100, height: 150, close: vi.fn() }; bitmaps.push(bitmap); return bitmap;
  }));
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:fixture'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {}, fillRect() {} } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, complete, type) { pending.push({ canvas: this, complete, type: type ?? 'image/png' }); });
  const pdfDocument = { numPages: 1, destroy, getPage: async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 150 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), cleanup: pageCleanup,
  }) };
  vi.mocked(pdfjs.getDocument).mockReturnValue({ promise: Promise.resolve(pdfDocument), destroy } as unknown as pdfjs.PDFDocumentLoadingTask);
});
afterEach(async () => {
  root.dispatchEvent(new Event('utility-desk:leave')); cleanup?.(); cleanup = undefined;
  pending.forEach(item => item.complete(new Blob(['obsolete'], { type: item.type })));
  await Promise.resolve(); await Promise.resolve();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const tools = [
  { id: 'crop-image', mount: crop, label: 'Export cropped image →', image: true },
  { id: 'images-to-pdf', mount: images, label: 'Create PDF →', image: true },
  { id: 'pdf-to-images', mount: pages, label: 'Export page images →', image: false },
  { id: 'compress-pdf', mount: compress, label: 'Compress PDF →', image: false },
] as const;
function click(label: string) { [...root.querySelectorAll('button')].find(button => button.textContent === label)!.click(); }
async function select(image: boolean) {
  const document = await PDFDocument.create(); document.addPage([100, 150]);
  const bytes = await document.save();
  const file = new File(['fixture'], image ? 'image.png' : 'source.pdf', { type: image ? 'image/png' : 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}

for (const tool of tools) {
  it.each(['Cancel', 'leave', 'dispose'])(`settles the pending encoder for ${tool.id} on %s, allowing another task before a late callback`, async stop => {
    cleanup = tool.mount(root);
    await select(tool.image);
    if (tool.id === 'crop-image') await vi.waitFor(() => expect(root.textContent).toContain('100×150'));
    if (tool.id === 'pdf-to-images') await vi.waitFor(() => expect(root.textContent).toContain('1 pages.'));
    if (tool.id === 'compress-pdf') root.querySelector<HTMLSelectElement>('[name=compression]')!.value = 'balanced';
    click(tool.label);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    if (stop === 'Cancel') click('Cancel');
    else if (stop === 'leave') root.dispatchEvent(new Event('utility-desk:leave'));
    else { cleanup(); cleanup = undefined; }
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toBe('Cancelled.'));
    expect([pending[0].canvas.width, pending[0].canvas.height]).toEqual([0, 0]);
    expect(root.querySelector<HTMLElement>('.progress')!.hidden).toBe(true);
    if (tool.id === 'images-to-pdf') expect(bitmaps[0].close).toHaveBeenCalledOnce();
    if (!tool.image) expect(pageCleanup).toHaveBeenCalledOnce();
    if (tool.id === 'compress-pdf') expect(destroy).toHaveBeenCalled();
    const nextRoot = document.createElement('main'); document.body.append(nextRoot);
    const next = taskControls('fixture', 'Next tool', async () => 'Available.'); nextRoot.append(next.el);
    await next.run(); expect(next.el.textContent).toContain('Done. Available.');
    pending[0].complete(new Blob(['obsolete'], { type: pending[0].type }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(root.querySelector('.status')!.textContent).toBe('Cancelled.');
  });
}

it.each(tools)('releases $id encoding resources when the browser encoder throws', async tool => {
  cleanup = tool.mount(root); await select(tool.image);
  if (tool.id === 'crop-image') await vi.waitFor(() => expect(root.textContent).toContain('100×150'));
  if (tool.id === 'pdf-to-images') await vi.waitFor(() => expect(root.textContent).toContain('1 pages.'));
  if (tool.id === 'compress-pdf') root.querySelector<HTMLSelectElement>('[name=compression]')!.value = 'balanced';
  const attempted: HTMLCanvasElement[] = [];
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(function (this: HTMLCanvasElement) { attempted.push(this); throw new Error('Fixture encoder failure'); });
  click(tool.label);
  await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toBe('Failed: Fixture encoder failure'));
  expect(attempted).toHaveLength(1);
  expect([attempted[0].width, attempted[0].height]).toEqual([0, 0]);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  if (tool.id === 'images-to-pdf') expect(bitmaps[0].close).toHaveBeenCalledOnce();
  if (!tool.image) expect(pageCleanup).toHaveBeenCalledOnce();
});

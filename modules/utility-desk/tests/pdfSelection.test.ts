import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist';
import { pageCount } from '../src/lib/pdfops';
import { mount as mountImages } from '../src/tools/pdfToImages';
import { mount as mountSplit } from '../src/tools/splitPdf';

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0, ENABLE: 1 }, getDocument: vi.fn() }));
vi.mock('../src/lib/pdfops', () => ({ pageCount: vi.fn(), splitEachPage: vi.fn(), extractPages: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}
function choose(root: HTMLElement, name: string, marker: number): void {
  const file = new File(['fixture'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([marker]).buffer });
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
function document(pages: number) {
  return { numPages: pages, destroy: vi.fn().mockResolvedValue(undefined) };
}
let root: HTMLElement;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  window.document.body.innerHTML = '<main id="main"></main>';
  root = window.document.getElementById('main')!;
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); });

describe('PDF source selection', () => {
  it('keeps the latest image-export source and releases superseded loads', async () => {
    const older = deferred<ReturnType<typeof document>>(), newer = deferred<ReturnType<typeof document>>();
    const olderLoad = { promise: older.promise, destroy: vi.fn().mockResolvedValue(undefined) };
    const newerLoad = { promise: newer.promise, destroy: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(pdfjs.getDocument).mockReturnValueOnce(olderLoad as unknown as pdfjs.PDFDocumentLoadingTask).mockReturnValueOnce(newerLoad as unknown as pdfjs.PDFDocumentLoadingTask);
    cleanup = mountImages(root);
    choose(root, 'older.pdf', 1);
    await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledOnce());
    choose(root, 'newer.pdf', 2);
    await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledTimes(2));
    const newDocument = document(3), oldDocument = document(2);
    newer.resolve(newDocument);
    await vi.waitFor(() => expect(root.textContent).toContain('newer.pdf: 3 pages.'));
    older.resolve(oldDocument);
    await vi.waitFor(() => expect(oldDocument.destroy).toHaveBeenCalledOnce());
    expect(root.textContent).toContain('newer.pdf: 3 pages.');
    expect(root.textContent).not.toContain('older.pdf: 2 pages.');
    expect(olderLoad.destroy).toHaveBeenCalledOnce();
  });

  it('releases an image-export document that loads after navigation', async () => {
    const pending = deferred<ReturnType<typeof document>>();
    const load = { promise: pending.promise, destroy: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(pdfjs.getDocument).mockReturnValue(load as unknown as pdfjs.PDFDocumentLoadingTask);
    cleanup = mountImages(root);
    choose(root, 'pending.pdf', 1);
    await vi.waitFor(() => expect(pdfjs.getDocument).toHaveBeenCalledOnce());
    cleanup(); cleanup = undefined;
    const loaded = document(2); pending.resolve(loaded);
    await vi.waitFor(() => expect(loaded.destroy).toHaveBeenCalledOnce());
    expect(load.destroy).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain('pending.pdf: 2 pages.');
  });

  it('keeps the newest split-PDF source when earlier page counting finishes late', async () => {
    const older = deferred<number>();
    vi.mocked(pageCount).mockImplementation(async (bytes) => bytes[0] === 1 ? older.promise : 3);
    const dispose = mountSplit(root);
    cleanup = typeof dispose === 'function' ? dispose : undefined;
    choose(root, 'older.pdf', 1);
    await vi.waitFor(() => expect(pageCount).toHaveBeenCalledOnce());
    choose(root, 'newer.pdf', 2);
    await vi.waitFor(() => expect(root.textContent).toContain('newer.pdf: 3 pages'));
    older.resolve(2);
    await older.promise; await Promise.resolve(); await Promise.resolve();
    expect(root.textContent).toContain('newer.pdf: 3 pages');
    expect(root.textContent).not.toContain('older.pdf: 2 pages');
  });

  it('cancels an active page render and releases its page and canvas', async () => {
    const pending = deferred<void>();
    const rendering = { promise: pending.promise, cancel: vi.fn(() => pending.reject(new DOMException('Cancelled', 'AbortError'))) };
    const page = { getViewport: () => ({ width: 100, height: 150 }), render: vi.fn(() => rendering), cleanup: vi.fn() };
    const source = { ...document(1), getPage: vi.fn().mockResolvedValue(page) };
    vi.mocked(pdfjs.getDocument).mockReturnValue({ promise: Promise.resolve(source), destroy: vi.fn() } as unknown as pdfjs.PDFDocumentLoadingTask);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) { return { canvas: this } as unknown as CanvasRenderingContext2D; });
    cleanup = mountImages(root);
    choose(root, 'render.pdf', 1);
    await vi.waitFor(() => expect(root.textContent).toContain('render.pdf: 1 pages.'));
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Export page images →')!.click();
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledOnce());
    const canvas = (page.render.mock.calls[0] as unknown as [{ canvasContext: CanvasRenderingContext2D }])[0].canvasContext.canvas;
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
    try {
      await vi.waitFor(() => expect(rendering.cancel).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(root.querySelector('.status')?.textContent).toBe('Cancelled.'));
      expect(page.cleanup).toHaveBeenCalledOnce();
      expect([canvas.width, canvas.height]).toEqual([0, 0]);
      expect(root.querySelector('input')?.disabled).toBe(false);
      expect(root.querySelector('a[download]')).toBeNull();
    } finally {
      pending.reject(new DOMException('Cancelled', 'AbortError'));
      await vi.waitFor(() => expect(root.querySelector('.status')?.textContent).toBe('Cancelled.'));
    }
  });
});

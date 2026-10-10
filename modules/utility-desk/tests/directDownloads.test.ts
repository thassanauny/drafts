import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mount as mountCompress } from '../src/tools/compressPdf';
import { mount as mountImages } from '../src/tools/pdfToImages';
import { mount as mountSplit } from '../src/tools/splitPdf';
import { mount as mountMerge } from '../src/tools/mergePdfs';
import { compressPdf } from '../src/lib/pdfCompression';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0, ENABLE: 1 },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 2, destroy: vi.fn(), getPage: async () => ({ getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }), cleanup: vi.fn() }) }) }),
}));
vi.mock('../src/lib/pdfCompression', () => ({ compressPdf: vi.fn() }));
let click: ReturnType<typeof vi.spyOn>;
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!;
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL = vi.fn(); });
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  root.dispatchEvent(new Event('utility-desk:leave'));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function choose(bytes: Uint8Array, filename = 'source.pdf') {
  const file = new File(['fixture'], filename, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
function action(label: string) {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith(label))!;
  button.click();
}

describe('direct file downloads', () => {
  it('identifies the PDF and current list position for an invalid merge range', async () => {
    const doc = await PDFDocument.create();
    for (let page = 0; page < 4; page++) doc.addPage();
    const bytes = await doc.save();
    mountMerge(root);
    choose(bytes, 'first.pdf');
    await vi.waitFor(() => expect(root.querySelectorAll('.file-row')).toHaveLength(1));
    choose(bytes, 'second.pdf');
    await vi.waitFor(() => expect(root.querySelectorAll('.file-row')).toHaveLength(2));
    const ranges = root.querySelectorAll<HTMLInputElement>('.range-in');
    ranges[1].value = '5'; ranges[1].dispatchEvent(new Event('input', { bubbles: true }));
    action('Merge PDFs');
    await vi.waitFor(() => expect(root.textContent).toContain('Failed: PDF 2 (second.pdf): Range "5" is outside 1-4'));
    expect(document.querySelector('.toast-danger')).toBeNull();
    expect(click).not.toHaveBeenCalled();
  });

  it('compresses and downloads from the main action without output or download panels', async () => {
    vi.mocked(compressPdf).mockResolvedValue({ bytes: new Uint8Array([1]), originalSize: 2, savedBytes: 1, savedPercent: 50, pages: 1, unchanged: false });
    mountCompress(root);
    expect(root.querySelector<HTMLInputElement>('[name=outName]')?.value).toBe('');
    choose(new Uint8Array([1, 2]));
    expect(root.querySelector<HTMLInputElement>('[name=outName]')?.value).toBe('source_compressed');
    expect(root.textContent).toContain('Output filename (without extension)');
    action('Compress PDF');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(document.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('source_compressed.pdf');
    expect(root.textContent).not.toContain('Compressed PDF');
    expect(root.textContent).not.toContain('Downloads ready');
    expect(root.textContent).toContain('PDF downloaded');
  });

  it('does not download when compression fails', async () => {
    vi.mocked(compressPdf).mockRejectedValue(new Error('Invalid fixture'));
    mountCompress(root); choose(new Uint8Array([1])); action('Compress PDF');
    await vi.waitFor(() => expect(root.textContent).toContain('Failed: Invalid fixture'));
    expect(click).not.toHaveBeenCalled();
  });

  it('downloads split pages as ZIP and a selected range as one PDF', async () => {
    const doc = await PDFDocument.create(); doc.addPage(); doc.addPage();
    mountSplit(root); choose(await doc.save());
    await vi.waitFor(() => expect(root.textContent).toContain('2 pages'));
    action('Save PDF pages');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(document.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('source-split.zip');
    const mode = root.querySelector<HTMLSelectElement>('[name=mode]')!;
    mode.value = 'range'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    action('Save PDF pages');
    await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    expect([...document.querySelectorAll<HTMLAnchorElement>('a[download]')].at(-1)?.download).toBe('source-pages-all.pdf');
    expect(root.textContent).not.toContain('Downloads ready');
    expect(root.querySelector('.download-links')).toBeNull();
  });

  it('exports multiple PDF page images directly as a ZIP without an output panel', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      const blob = new Blob(['image'], { type: 'image/png' });
      Object.defineProperty(blob, 'arrayBuffer', { value: async () => new Uint8Array([1, 2]).buffer });
      callback(blob);
    });
    const cleanup = mountImages(root); choose(new Uint8Array([1]));
    await vi.waitFor(() => expect(root.textContent).toContain('source.pdf: 2 pages.'));
    expect(root.querySelectorAll('figure')).toHaveLength(0);
    action('Export page images');
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(document.querySelector<HTMLAnchorElement>('a[download]')?.download).toBe('source-images.zip');
    expect(root.textContent).not.toContain('Downloads ready');
    expect(root.querySelectorAll('figure')).toHaveLength(0);
    cleanup();
  });

});

it('keeps completed progress with the result and hides it after failure', async () => {
  vi.mocked(compressPdf).mockResolvedValue({ bytes: new Uint8Array([1]), originalSize: 2, savedBytes: 1, savedPercent: 50, pages: 1, unchanged: false });
  mountCompress(root); choose(new Uint8Array([1, 2])); action('Compress PDF');
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  const bar = root.querySelector<HTMLProgressElement>('progress')!;
  expect(bar.value).toBe(100);
  expect(bar.parentElement?.hidden).toBe(false);
  vi.mocked(compressPdf).mockRejectedValue(new Error('Invalid fixture'));
  action('Compress PDF');
  await vi.waitFor(() => expect(root.textContent).toContain('Failed: Invalid fixture'));
  expect(bar.parentElement?.hidden).toBe(true);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { compressPdf } from '../src/lib/pdfCompression';

const pdf = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, AnnotationMode: { ENABLE: 1 }, getDocument: pdf.load }));
afterEach(() => { vi.restoreAllMocks(); pdf.load.mockReset(); });

async function fixture(huge = false, blobSize = 160) {
  const source = await PDFDocument.create();
  const dimensions = [[300, 400], [500, 200]];
  dimensions.forEach((size) => {
    const page = source.addPage(size as [number, number]);
    page.drawText('Original selectable text');
    page.node.addContentStream(source.context.register(source.context.stream('% padding for compression\n'.repeat(1000))));
  });
  const bytes = await source.save({ useObjectStreams: false });
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const cleanup = vi.fn(), destroy = vi.fn(async () => {});
  pdf.load.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 2, getPage: async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: (huge ? 10000 : dimensions[number - 1][0]) * scale, height: (huge ? 10000 : dimensions[number - 1][1]) * scale }), render, cleanup,
  }) }) });
  const jpeg = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='), (c) => c.charCodeAt(0));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  const exportImage = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback({ type: 'image/jpeg', size: blobSize, arrayBuffer: async () => jpeg.slice().buffer } as Blob));
  return { bytes, render, cleanup, destroy, exportImage };
}

describe('image-based PDF compression', () => {
  for (const [mode, dpi, quality] of [['balanced', 150, 0.75], ['small', 96, 0.55]] as const) {
    it(`rebuilds all pages at ${dpi} DPI with their displayed dimensions`, async () => {
      const { bytes, render, cleanup, destroy, exportImage } = await fixture();
      const copy = bytes.slice();
      const result = await compressPdf(bytes, mode);
      expect(result.unchanged).toBe(false); expect(result.pages).toBe(2);
      const output = await PDFDocument.load(result.bytes);
      expect(output.getPages().map((page) => page.getSize())).toEqual([{ width: 300, height: 400 }, { width: 500, height: 200 }]);
      expect(render.mock.calls[0]).toMatchObject([{ viewport: { width: expect.closeTo(300 * dpi / 72, 6), height: expect.closeTo(400 * dpi / 72, 6) }, background: '#ffffff' }]);
      expect(exportImage).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', quality);
      expect(cleanup).toHaveBeenCalledTimes(2); expect(destroy).toHaveBeenCalled(); expect(bytes).toEqual(copy);
    });
  }

  it('stops between rendered pages and never returns a partial result', async () => {
    const { bytes, render, destroy } = await fixture();
    const controller = new AbortController();
    await expect(compressPdf(bytes, 'balanced', controller.signal, () => controller.abort())).rejects.toMatchObject({ name: 'AbortError' });
    expect(render).toHaveBeenCalledTimes(1); expect(destroy).toHaveBeenCalled();
  });

  it('rejects pages above the pixel limit before rendering and frees the worker', async () => {
    const { bytes, render, destroy } = await fixture(true);
    await expect(compressPdf(bytes, 'small')).rejects.toThrow(/50 MP/);
    expect(render).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalled();
  });

  it('stops when encoded page data exceeds the output memory limit', async () => {
    const { bytes, destroy } = await fixture(false, 501 * 1024 * 1024);
    await expect(compressPdf(bytes, 'balanced')).rejects.toThrow(/500 MB/);
    expect(destroy).toHaveBeenCalled();
  });
});

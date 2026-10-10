import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/tools/cropImage';

const drawImage = vi.fn();
const encodedSizes: number[][] = [];
let cleanup: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear(); document.body.innerHTML = '<main id="main"></main>';
  drawImage.mockClear(); encodedSizes.length = 0;
  const context = { drawImage, clearRect() {}, fillRect() {} };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    encodedSizes.push([this.width, this.height]); callback(new Blob(['fixture'], { type: type ?? 'image/png' }));
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
});
afterEach(() => { document.getElementById('main')?.dispatchEvent(new Event('utility-desk:leave')); cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function page() { const root = document.getElementById('main')!; cleanup = mount(root); return root; }
function bitmap(width: number, height: number) { return { width, height, close: vi.fn() }; }
function pick(root: HTMLElement, name = 'fixture.png') {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], name, { type: 'image/png' })] });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function edit(root: HTMLElement, name: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
}
function click(root: HTMLElement, label: string) { [...root.querySelectorAll('button')].find((button) => button.textContent === label)!.click(); }

describe('image crop guidance', () => {
  it('reports the kept area and removed edges using the same rectangle as export', async () => {
    const source = bitmap(1200, 800); vi.stubGlobal('createImageBitmap', vi.fn(async () => source));
    const root = page(); pick(root);
    expect(root.querySelector('.run-panel')).toBeNull();
    await vi.waitFor(() => expect(root.querySelector('.crop-stats')!.textContent).toContain('1200 × 800 px'));
    edit(root, 'cropW', '800'); edit(root, 'cropH', '600'); edit(root, 'cropX', '100'); edit(root, 'cropY', '50');
    const text = root.querySelector('.crop-stats')!.textContent!;
    expect(text).toContain('Keep800 × 600 px'); expect(text).toContain('50.0%');
    expect(text).toContain('left 100 px · top 50 px · right 300 px · bottom 150 px');
    click(root, 'Export cropped image →');
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done.'));
    expect(encodedSizes).toEqual([[800, 600]]);
    expect(drawImage.mock.calls.some((args) => args[0] === source && args.length === 9 && args.slice(1, 5).join() === '100,50,800,600')).toBe(true);
  });
  it('shows the actual crop when requests extend past an edge and resets only cropping', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap(1200, 800)));
    const root = page(); pick(root);
    await vi.waitFor(() => expect(root.querySelector('.crop-stats')!.textContent).toContain('1200 × 800 px'));
    edit(root, 'cropX', '1100'); edit(root, 'cropY', '50'); edit(root, 'cropW', '400'); edit(root, 'quality', '75');
    expect(root.querySelector('.crop-stats')!.textContent).toContain('Keep100 × 750 px');
    expect(root.querySelector('.crop-edges')!.textContent).toContain('right 0 px · bottom 0 px');
    click(root, 'Keep whole image');
    expect(root.querySelector('.crop-removal')!.textContent).toContain('No cropping');
    expect(root.querySelector<HTMLInputElement>('[name="quality"]')!.value).toBe('75');
    pick(root, 'unsupported.heic');
    expect(root.querySelector<HTMLElement>('.crop-frame')!.hidden).toBe(true);
    expect(root.querySelector('.crop-stats')!.textContent).toBe('');
    expect(root.querySelector<HTMLCanvasElement>('.crop-frame canvas')!.width).toBe(0);
  });
  it('ignores obsolete image loads and closes a bitmap that finishes after leaving the page', async () => {
    const pending: ((image: ReturnType<typeof bitmap>) => void)[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((resolve) => pending.push(resolve))));
    const root = page(); pick(root, 'older.png'); pick(root, 'newer.png');
    const newer = bitmap(300, 200), older = bitmap(1200, 800);
    pending[1](newer);
    await vi.waitFor(() => expect(root.querySelector('.crop-stats')!.textContent).toContain('300 × 200 px'));
    pending[0](older);
    await vi.waitFor(() => expect(older.close).toHaveBeenCalledOnce());
    expect(root.querySelector('.crop-stats')!.textContent).not.toContain('1200');
    pick(root, 'last.png'); cleanup!(); cleanup = undefined;
    const last = bitmap(500, 500); pending[2](last);
    await vi.waitFor(() => expect(last.close).toHaveBeenCalledOnce());
    expect(newer.close).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '../src/lib/storage';
import { mount as split } from '../src/tools/splitPdf';
import { mount as pages } from '../src/tools/pdfToImages';
import { mount as media } from '../src/tools/mediaConverter';
import { mount as crop } from '../src/tools/cropImage';
import { mount as documentConverter } from '../src/tools/documentConverter';

vi.mock('../src/lib/caps', () => ({ detectCapabilities: () => [
  { id: 'ffmpeg', label: 'FFmpeg', state: 'Supported', detail: 'Test environment' },
] }));
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!;
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); });

const cases: { id: string; mount: (root: HTMLElement) => void | (() => void); source: Record<string, string>; defaults: Record<string, string>; prefs: Record<string, string> }[] = [
  { id: 'split-pdf', mount: split, source: { range: '1,3' }, defaults: { range: '' }, prefs: { mode: 'range' } },
  { id: 'pdf-to-images', mount: pages, source: { range: '2-5' }, defaults: { range: '' }, prefs: { dpi: '150', format: 'jpeg' } },
  { id: 'media-converter', mount: media, source: { start: '10', end: '20' }, defaults: { start: '', end: '' }, prefs: { quality: 'small' } },
  { id: 'crop-image', mount: crop, source: { cropX: '10', cropY: '20', cropW: '100', cropH: '200' }, defaults: { cropX: '0', cropY: '0', cropW: '', cropH: '' }, prefs: { quality: '75' } },
  { id: 'document-converter', mount: documentConverter, source: { title: 'Old book', author: 'Old author', target: 'pdf' }, defaults: { title: '', author: '', target: '' }, prefs: {} },
];
it.each(cases)('$id ignores source-specific drafts and clears them on reload while keeping preferences', ({ id, mount, source, defaults, prefs }) => {
  store.setDraft(id, { ...source, ...prefs });
  const control = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  const assertReset = () => {
    for (const [name, value] of Object.entries(defaults)) expect(control(name).value).toBe(value);
    for (const [name, value] of Object.entries(prefs)) expect(control(name).value).toBe(value);
    expect(root.querySelector<HTMLInputElement>('input[type=file]')!.files?.length).toBe(0);
  };
  let cleanup = mount(root);
  assertReset();
  for (const [name, value] of Object.entries(source)) {
    control(name).value = value;
    control(name).dispatchEvent(new Event('input', { bubbles: true }));
  }
  root.dispatchEvent(new Event('utility-desk:leave'));
  for (const name of Object.keys(source)) expect(store.getDraft(id)[name]).toBeUndefined();
  if (typeof cleanup === 'function') cleanup();
  root.replaceChildren();
  cleanup = mount(root);
  assertReset();
  if (typeof cleanup === 'function') cleanup();
});

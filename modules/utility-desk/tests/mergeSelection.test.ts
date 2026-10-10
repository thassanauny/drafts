import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mount } from '../src/tools/mergePdfs';

let root: HTMLElement;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() });
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function pdf(width: number) {
  const document = await PDFDocument.create(); document.addPage([width, 200]);
  const bytes = await document.save();
  const file = new File([bytes as BlobPart], `${width}.pdf`, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer, configurable: true });
  return { file, bytes };
}
function choose(files: File[]) {
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: files, configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
function merge() { [...root.querySelectorAll('button')].find(button => button.textContent === 'Merge PDFs →')!.click(); }

it('blocks merging while a delayed batch is checked and preserves the order of overlapping additions', async () => {
  cleanup = mount(root);
  const inputs = await Promise.all([101, 102, 103, 104, 105].map(pdf));
  choose(inputs.slice(0, 2).map(input => input.file));
  await vi.waitFor(() => expect(root.querySelectorAll('.file-row')).toHaveLength(2));
  let finish!: (bytes: ArrayBuffer) => void;
  const delayed = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
  Object.defineProperty(inputs[2].file, 'arrayBuffer', { value: () => delayed });
  choose(inputs.slice(2, 4).map(input => input.file));
  choose([inputs[4].file]);
  merge();
  expect(root.querySelector('.status')!.textContent).toContain('Wait for the selected PDFs');
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(root.querySelectorAll('.file-row')).toHaveLength(2);
  finish(inputs[2].bytes.slice().buffer as ArrayBuffer);
  await vi.waitFor(() => expect(root.querySelectorAll('.file-row')).toHaveLength(5));
  const selected = [...root.querySelectorAll('.file-name')].map(element => element.textContent);
  expect(selected.map(name => name!.match(/\d+\. (\d+)\.pdf/)![1])).toEqual(['101', '102', '103', '104', '105']);
  merge();
  await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('5 pages'));
  const output = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(output);
  });
  expect((await PDFDocument.load(bytes)).getPages().map(page => page.getWidth())).toEqual([101, 102, 103, 104, 105]);
});

it('does not publish a selection batch that finishes after the page is disposed', async () => {
  cleanup = mount(root);
  const source = await pdf(101);
  let finish!: (bytes: ArrayBuffer) => void;
  Object.defineProperty(source.file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
  choose([source.file]);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  root.dispatchEvent(new Event('utility-desk:leave')); cleanup(); cleanup = undefined;
  finish(source.bytes.slice().buffer as ArrayBuffer);
  await vi.waitFor(() => expect(root.querySelectorAll('.file-row')).toHaveLength(0));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(root.querySelectorAll('.file-row')).toHaveLength(0);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

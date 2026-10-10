import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '../src/tools/documentConverter';
import { convertDocumentAsync } from '../src/lib/documentPipeline';
import { store } from '../src/lib/storage';

vi.mock('../src/lib/documentPipeline', () => ({ convertDocumentAsync: vi.fn().mockResolvedValue('converted fixture'), pdfText: vi.fn() }));
let root: HTMLElement;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  document.body.innerHTML = '<main id="main"></main>';
  root = document.getElementById('main')!;
});
afterEach(() => { root.dispatchEvent(new Event('utility-desk:leave')); });
function choose(name: string) {
  const file = new File(['fixture'], name);
  Object.defineProperty(file, 'text', { value: async () => 'fixture' });
  const picker = root.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(picker, 'files', { value: [file], configurable: true });
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}
function action(label: string) {
  [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith(label))!.click();
}
it('does not restore or persist filenames when the source file is absent after reload', () => {
  store.setDraft('document-converter', {outputName: 'previous_converted', title: 'Saved title'});
  mount(root);
  const filename = root.querySelector<HTMLInputElement>('[name=outputName]')!;
  expect(filename.value).toBe('');
  expect(root.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('');
  choose('new.md');
  expect(filename.value).toBe('new_converted');
  filename.value = 'custom'; filename.dispatchEvent(new Event('input', {bubbles: true}));
  root.dispatchEvent(new Event('utility-desk:leave'));
  expect(store.getDraft('document-converter').outputName).toBeUndefined();
  root.replaceChildren(); mount(root);
  expect(root.querySelector<HTMLInputElement>('[name=outputName]')!.value).toBe('');
});
it('requires a format choice for each source before previewing or converting', async () => {
  mount(root);
  const target = root.querySelector<HTMLSelectElement>('[name=target]')!;
  expect(target.value).toBe('');
  expect(target.selectedOptions[0].textContent).toBe('Choose an output format');
  choose('first.md');
  expect(target.value).toBe('');
  action('Preview document'); action('Convert document');
  expect(convertDocumentAsync).not.toHaveBeenCalled();
  expect(root.textContent).toContain('Choose a document and an output format first.');
  target.value = 'html'; target.dispatchEvent(new Event('change', { bubbles: true }));
  action('Preview document');
  await vi.waitFor(() => expect(root.textContent).toContain('Preview ready.'));
  expect(convertDocumentAsync).toHaveBeenCalledOnce();
  choose('second.pdf');
  expect(target.value).toBe('');
  expect([...target.options].map(option => option.value)).toContain('epub');
  action('Convert document');
  expect(convertDocumentAsync).toHaveBeenCalledOnce();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { filePicker } from '../src/ui';
import { mount as mountMedia } from '../src/tools/mediaConverter';
import { mount as mountImages } from '../src/tools/imagesToPdf';

function choose(picker: HTMLElement, files: File[]) {
  const input = picker.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function drop(picker: HTMLElement, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  picker.dispatchEvent(event);
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('supported file selection', () => {
  it.each([choose, drop])('validates selected and dropped files consistently', (selectFiles) => {
    const onFiles = vi.fn();
    const picker = filePicker({ label: 'PDFs', accept: ' .pdf, application/pdf ', multiple: true, onFiles });
    document.body.append(picker);
    const pdf = new File(['pdf'], 'UPPER.PDF'), typedPdf = new File(['pdf'], 'document', { type: 'application/pdf' });
    selectFiles(picker, [new File(['text'], 'wrong.txt'), pdf, typedPdf]);
    expect(onFiles).toHaveBeenCalledWith([pdf, typedPdf]);
    expect(picker.textContent).toContain('Unsupported files were skipped');
    selectFiles(picker, [new File(['text'], 'wrong.txt')]);
    expect(onFiles).toHaveBeenCalledOnce();
  });

  it('accepts common FFmpeg inputs with no MIME type, including animated GIF', () => {
    vi.stubGlobal('Worker', class {});
    const root = document.body.appendChild(document.createElement('main'));
    const cleanup = mountMedia(root);
    for (const name of ['clip.mkv', 'clip.mov', 'clip.avi', 'sound.flac', 'sound.opus', 'animation.gif']) {
      choose(root, [new File(['fixture'], name)]);
      expect(root.textContent).toContain(`${name} ·`);
      drop(root.querySelector<HTMLElement>('.dropzone')!, [new File(['fixture'], name)]);
      expect(root.textContent).toContain(`${name} ·`);
    }
    cleanup?.();
  });

  it('accepts common browser image inputs without an OS-provided MIME type', () => {
    const root = document.body.appendChild(document.createElement('main'));
    mountImages(root);
    for (const name of ['photo.PNG', 'photo.jpeg', 'picture.webp', 'animation.gif', 'picture.avif', 'picture.bmp', 'drawing.svg']) {
      drop(root.querySelector<HTMLElement>('.dropzone')!, [new File(['fixture'], name)]);
      expect(root.querySelector('.file-list')?.textContent).toContain(name);
    }
  });
});

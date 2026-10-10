import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { persistForm, input, filePicker, taskControls } from '../src/ui';
import { store } from '../src/lib/storage';
import { epubToHtml } from '../src/lib/docconv';
import { mount as mountMedia } from '../src/tools/mediaConverter';
import { mount as mountImages } from '../src/tools/imagesToPdf';
import { mount as mountMerge } from '../src/tools/mergePdfs';
import { mount as mountSync } from '../src/tools/folderSync';
import { mount as mountScp } from '../src/tools/secureCopy';
import { mount as mountDownloader } from '../src/tools/mediaDownloader';

const ffmpeg = vi.hoisted(() => ({
  load: vi.fn(async () => {}), writeFile: vi.fn<(path: string, data: Uint8Array) => Promise<void>>(async () => {}), exec: vi.fn<(command: string[]) => Promise<number>>(async () => 0),
  readFile: vi.fn(async () => new Uint8Array([1])), terminate: vi.fn(),
}));
vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: class {
  on() {}
  load = ffmpeg.load;
  writeFile = ffmpeg.writeFile;
  exec = ffmpeg.exec;
  readFile = ffmpeg.readFile;
  terminate = ffmpeg.terminate;
} }));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function main() { document.body.innerHTML = '<main id="main"></main>'; return document.querySelector('main')!; }
function drop(zone: HTMLElement, files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  zone.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe('reviewed file and draft lifecycle', () => {
  it('hides the previous completed progress when new inputs fail validation', async () => {
    const root = main();
    let validation: string | null = null;
    const task = taskControls('crop-image', 'Export fixture', async () => 'Downloaded.', { validate: () => validation });
    root.append(task.el);
    await task.run();
    const bar = root.querySelector<HTMLProgressElement>('progress')!;
    expect(bar.parentElement?.hidden).toBe(false);
    validation = 'Choose a valid image.';
    await task.run();
    expect(root.querySelector('.status')?.textContent).toBe(validation);
    expect(bar.parentElement?.hidden).toBe(true);
  });
  for (const [id, mount] of [['images-to-pdf', mountImages], ['merge-pdfs', mountMerge]] as const) {
    it(`does not save planner fields in the previous ${id} draft`, () => {
      vi.useFakeTimers();
      const root = main();
      mount(root);
      const filename = root.querySelector<HTMLInputElement>('[name="outName"]')!;
      filename.value = 'chosen.pdf'; filename.dispatchEvent(new Event('input', { bubbles: true }));
      root.dispatchEvent(new Event('utility-desk:leave'));
      const expected = store.getDraft(id);
      expect(expected.outName).toBeUndefined();
      for (const planner of [mountSync, mountScp, mountDownloader]) {
        root.replaceChildren(); planner(root);
        root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="checkbox"]), textarea').forEach((control) => {
          control.value = 'private fixture';
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
        });
        vi.advanceTimersByTime(500);
        root.dispatchEvent(new Event('utility-desk:leave'));
        expect(store.getDraft(id)).toEqual(expected);
        expect(JSON.stringify(localStorage)).not.toContain('private fixture');
      }
    });
  }
  it('keeps consecutive tool drafts independent and flushes pending edits once', () => {
    vi.useFakeTimers();
    const root = main(), first = input('text', 'choice', 'first'); root.append(first);
    persistForm('first', root); first.value = 'edited'; first.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new Event('utility-desk:leave'));
    const second = input('text', 'choice', 'second'); root.replaceChildren(second); persistForm('second', root);
    second.value = 'later'; second.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(500);
    expect(store.getDraft('first')).toEqual({ choice: 'edited' });
    expect(store.getDraft('second')).toEqual({ choice: 'later' });
    root.dispatchEvent(new Event('utility-desk:leave'));
  });
  it('rejects dropped replacements during work and allows them after completion', async () => {
    const root = main(), onFiles = vi.fn();
    const picker = filePicker({ label: 'Source', accept: '.txt', onFiles }); root.append(picker);
    let finish!: () => void;
    const task = taskControls('fixture', 'Work', () => new Promise<void>((resolve) => { finish = resolve; })); root.append(task.el);
    const file = new File(['fixture'], 'fixture.txt');
    drop(picker, [file]); expect(onFiles).toHaveBeenCalledTimes(1);
    const completion = task.run();
    expect(picker.querySelector('input')!.disabled).toBe(true);
    drop(picker, [file]); expect(onFiles).toHaveBeenCalledTimes(1);
    finish(); await completion;
    drop(picker, [file]); expect(onFiles).toHaveBeenCalledTimes(2);
  });
});

function epub(chapters: Record<string, string>, hrefs: string[], ids = hrefs.map((_href, i) => `c${i}`)) {
  return zipSync(Object.fromEntries(Object.entries({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/Packages/book.opf"/></rootfiles></container>',
    'OPS/Packages/book.opf': `<package><metadata><title>Fixture</title></metadata><manifest>${hrefs.map((href, i) => `<item id="c${i}" href="${href}"/>`).join('')}</manifest><spine>${ids.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`,
    ...chapters,
  }).map(([path, text]) => [path, strToU8(text)])));
}

describe('EPUB chapter completeness', () => {
  it('resolves parent-relative, dot, encoded and fragment paths in spine order', () => {
    const bytes = epub({
      'OPS/Packages/first.xhtml': '<p>First chapter</p>',
      'OPS/Text/second chapter.xhtml': '<p>Second chapter</p>',
      'OPS/Text/third.xhtml': '<p>Third chapter</p>',
    }, ['./first.xhtml', '../Text/second%20chapter.xhtml#section', '../Text/./third.xhtml']);
    const result = epubToHtml(bytes);
    expect(result.html).toBe('<p>First chapter</p>\n<p>Second chapter</p>\n<p>Third chapter</p>');
  });
  it('reports a missing chapter instead of returning a partial book', () => {
    const bytes = epub({ 'OPS/Packages/first.xhtml': '<p>First chapter</p>' }, ['first.xhtml', '../Text/missing.xhtml']);
    expect(() => epubToHtml(bytes)).toThrow('EPUB chapter file not found: ../Text/missing.xhtml');
  });
  it('reports unlisted, invalid and external spine references', () => {
    expect(() => epubToHtml(epub({}, ['first.xhtml'], ['unknown']))).toThrow(/not listed in the manifest/);
    for (const href of ['../Text/%zz.xhtml', 'https://example.org/chapter.xhtml']) expect(() => epubToHtml(epub({}, [href]))).toThrow(/chapter path could not be read/);
  });
});

function mediaFixture() {
  const NativeURL = URL;
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL() { return 'blob:fixture'; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal('Worker', class {});
  const root = main(), cleanup = mountMedia(root)!;
  const picker = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const preview = root.querySelector('video')!;
  const end = root.querySelector<HTMLInputElement>('[name="end"]')!;
  const choose = (name: string, seconds: number) => {
    const file = new File([name], name, { type: 'video/mp4' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([seconds]).buffer });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    Object.defineProperty(preview, 'duration', { value: seconds, configurable: true });
    preview.dispatchEvent(new Event('loadedmetadata'));
  };
  return { root, picker, end, choose, cleanup };
}

describe('media duration and frozen operation inputs', () => {
  it('keeps full-length conversion unbounded when a longer file replaces the source', () => {
    const { root, end, choose, cleanup } = mediaFixture();
    choose('short.mp4', 10); expect(end.value).toBe(''); expect(end.placeholder).toContain('10 s');
    choose('long.mp4', 20); expect(end.value).toBe(''); expect(end.placeholder).toContain('20 s');
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Preview conversion')!.click();
    expect(root.querySelector('pre')!.textContent).toContain('Source: long.mp4');
    expect(root.querySelector('pre')!.textContent).not.toContain('-t ');
    end.value = '5'; end.dispatchEvent(new Event('input', { bubbles: true }));
    choose('another.mp4', 30); expect(end.value).toBe('5');
    root.dispatchEvent(new Event('utility-desk:leave')); cleanup();
  });
  it('preserves the selected file, settings and output name through asynchronous conversion', async () => {
    const { root, picker, choose, cleanup } = mediaFixture();
    choose('original.mp4', 10);
    let finishLoad!: () => void;
    ffmpeg.load.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    ffmpeg.exec.mockClear(); ffmpeg.writeFile.mockClear();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    [...root.querySelectorAll('button')].find((button) => button.textContent === 'Convert media →')!.click();
    expect(picker.disabled).toBe(true);
    drop(picker.closest('.dropzone')!, [new File(['replacement'], 'replacement.mp4', { type: 'video/mp4' })]);
    root.querySelector<HTMLInputElement>('[name="outputName"]')!.value = 'changed';
    root.querySelector<HTMLSelectElement>('[name="format"]')!.value = 'wav';
    root.querySelector<HTMLInputElement>('[name="end"]')!.value = '5';
    finishLoad();
    await vi.waitFor(() => expect(root.querySelector('.status')!.textContent).toContain('Done. original_converted.mp4'));
    expect(ffmpeg.writeFile).toHaveBeenCalledWith('input.mp4', new Uint8Array([10]));
    expect(ffmpeg.exec.mock.calls[0][0]).toContain('output.mp4');
    expect(ffmpeg.exec.mock.calls[0][0]).not.toContain('-t');
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.download).toBe('original_converted.mp4');
    root.dispatchEvent(new Event('utility-desk:leave')); cleanup();
  });
});

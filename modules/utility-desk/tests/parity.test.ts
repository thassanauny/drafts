import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { parsePageRanges } from '../src/lib/ranges';
import { extractPages, splitEachPage } from '../src/lib/pdfops';
import { dateToTimestamp } from '../src/lib/dates';
import { sizeImage } from '../src/lib/imageops';
import { mediaArgs, mediaSeconds } from '../src/tools/mediaConverter';
import { scpCommand } from '../src/tools/secureCopy';
import { persistForm, input, taskControls } from '../src/ui';
import { store } from '../src/lib/storage';
import { convertDocument, epubToHtml } from '../src/lib/docconv';
import { readZip } from '../src/lib/zip';
import { strFromU8 } from 'fflate';
import { downloadBlob } from '../src/lib/util';

describe('original functionality parity', () => {
  it('preserves ordered/repeated extraction and separate page selection', async () => {
    const d = await PDFDocument.create();
    for (const width of [101, 102, 103]) d.addPage([width, 200]);
    const bytes = await d.save();
    const selected = parsePageRanges('3,1,3', 3, true);
    const extracted = await PDFDocument.load(await extractPages(bytes, selected));
    expect(extracted.getPages().map((p) => p.getWidth())).toEqual([103, 101, 103]);
    const parts = await splitEachPage(bytes, undefined, undefined, parsePageRanges('3,1,3', 3));
    expect(await Promise.all(parts.map(async (p) => (await PDFDocument.load(p)).getPage(0).getWidth()))).toEqual([101, 103]);
    expect(() => parsePageRanges('1,', 3)).toThrow();
    expect(() => parsePageRanges('1-1001', 1001)).toThrow(/1,000/);
  });
  it('rejects missing times and lets users select repeated times', () => {
    expect(() => dateToTimestamp('2024-03-10T02:30', 'America/New_York')).toThrow(/does not exist/);
    const early = dateToTimestamp('2024-11-03T01:30', 'America/New_York', 'earlier');
    const late = dateToTimestamp('2024-11-03T01:30', 'America/New_York', 'later');
    expect(late.seconds - early.seconds).toBe(3600);
  });
  it('keeps maximum sizing proportional and exact sizing exact', () => {
    expect(sizeImage(400, 200, 100, 100, 'maximum', false)).toMatchObject({ width: 100, height: 50 });
    expect(sizeImage(40, 20, 100, 100, 'maximum', false)).toMatchObject({ width: 40, height: 20 });
    expect(sizeImage(400, 200, 100, 100, 'cover', true)).toMatchObject({ width: 100, height: 100, drawWidth: 200, x: -50 });
    expect(sizeImage(400, 200, 100, 100, 'contain', true)).toMatchObject({ width: 100, height: 100, drawHeight: 50, y: 25 });
    expect(() => sizeImage(100, 100, 1.5, 100, 'stretch', true)).toThrow();
  });
  it('plans media formats, quality, sizing, bitrate and end times', () => {
    expect(mediaSeconds('1:02.5')).toBe(62.5);
    expect(() => mediaSeconds('1:99')).toThrow();
    expect(mediaArgs('mkv', 'high', '720', '192', '5', '15')).toEqual(expect.arrayContaining(['-t', '10', '-crf', '18', '-b:a', '192k', 'output.mkv']));
    expect(mediaArgs('webm', 'balanced', '', '128', '', '')).toContain('libvpx-vp9');
    expect(mediaArgs('wav', 'balanced', '', '128', '', '')).not.toContain('-b:a');
    expect(() => mediaArgs('mp4', 'balanced', '', '128', '10', '5')).toThrow();
  });
  it('quotes local paths and refuses unsupported remote syntax', () => {
    const o = { direction: 'upload', folder: true, preserve: true, host: 'example.org', user: 'user', port: '22', local: "/tmp/a'b $(echo hello)", remote: '/data' };
    expect(scpCommand(o)).toContain("'/tmp/a'\\''b $(echo hello)'");
    expect(scpCommand(o)).toContain('StrictHostKeyChecking=yes');
    expect(() => scpCommand({ ...o, host: '-oProxyCommand=bad' })).toThrow();
    expect(() => scpCommand({ ...o, remote: '/bad path' })).toThrow();
  });
  it('overrides EPUB title and author with escaped metadata', () => {
    const out = convertDocument({ format: 'txt', text: 'Hello', title: 'Original', titleOverride: 'New & book', author: 'A < B' }, 'epub') as Uint8Array;
    expect(epubToHtml(out).title).toBe('New & book');
    expect(strFromU8(readZip(out)['OEBPS/content.opf'])).toContain('<dc:creator>A &lt; B</dc:creator>');
  });
});

describe('navigation during work', () => {
  it('downloads directly without a visible result section', () => {
    document.body.innerHTML = '<main id="main"></main>';
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:fixture', revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadBlob(new Blob(['output']), 'unlocked.pdf');
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector('.download-links')).toBeNull();
    const link = document.querySelector<HTMLAnchorElement>('a')!;
    expect(link.hidden).toBe(true);
    expect(link.download).toBe('unlocked.pdf');
    document.getElementById('main')!.dispatchEvent(new Event('utility-desk:leave'));
    expect(revoke).toHaveBeenCalledWith('blob:fixture');
    expect(document.querySelector('a')).toBeNull();
    click.mockRestore(); vi.unstubAllGlobals();
  });
  it('flushes form choices immediately on navigation', () => {
    document.body.innerHTML = '<main></main>';
    const root = document.querySelector('main')!;
    const control = input('text', 'parity', ''); root.append(control);
    persistForm('parity-test', root);
    control.value = 'edited'; control.dispatchEvent(new Event('input', { bubbles: true }));
    root.dispatchEvent(new Event('utility-desk:leave'));
    expect(store.getDraft('parity-test').parity).toBe('edited');
  });
  it('aborts the current operation when leaving its page', async () => {
    document.body.innerHTML = '<main></main>';
    const root = document.querySelector('main')!;
    let signal: AbortSignal | undefined;
    const run = vi.fn(async (ctx) => { signal = ctx.signal; await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true })); });
    const task = taskControls('parity-test', 'Work', run); root.append(task.el);
    const completion = task.run();
    root.dispatchEvent(new Event('utility-desk:leave'));
    await completion;
    expect(signal?.aborted).toBe(true);
    expect(root.querySelector('.status')?.textContent).toBe('Cancelled.');
  });
});

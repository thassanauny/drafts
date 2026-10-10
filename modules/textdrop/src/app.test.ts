// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/textdrop/#/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTextDrop } from './app';
import type { Cloud, TextDropPage } from './lib/cloud';
import { DEVICE_SNIPPETS_KEY, DeviceSnippets } from './lib/deviceSnippets';

const first: TextDropPage = { id: '00000000-0000-4000-8000-000000000001', code: 'a'.repeat(32), text: 'Shared text', version: 1, updatedAt: '2026-10-10T01:00:00.000Z' };
const second: TextDropPage = { ...first, id: '00000000-0000-4000-8000-000000000002', code: 'b'.repeat(32), text: 'Another snippet' };
const key = (code: string) => `${DEVICE_SNIPPETS_KEY}:${code}`;

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

let root: HTMLDivElement;
let cloud: Cloud;
let dispose: (() => void) | undefined;
let writeText: ReturnType<typeof vi.fn>;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return root.querySelector<T>(`#${id}`)!;
}
const rows = () => [...root.querySelectorAll<HTMLAnchorElement>('.device-row .snippet-open')].map(row => row.dataset.code);
const flush = () => vi.advanceTimersByTimeAsync(1);

async function start(hash = '#/', configured = true): Promise<void> {
  history.replaceState(null, '', `/textdrop/${hash}`);
  dispose = mountTextDrop(root, cloud, { configured, version: 'test' });
  await flush();
}

async function join(code: string): Promise<void> {
  if (!element<HTMLDialogElement>('snippet-dialog').open || element('join-form').hidden) element('join').click();
  element<HTMLInputElement>('join-code').value = code;
  element('join-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

async function create(): Promise<void> {
  element('create').click();
  element('create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
}

function edit(text: string): void {
  element<HTMLTextAreaElement>('editor').value = text;
  element('editor').dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(first.updatedAt));
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  root = document.querySelector<HTMLDivElement>('#app')!;
  cloud = {
    createPage: vi.fn().mockResolvedValue(first),
    joinPage: vi.fn(async code => code === second.code ? second : first),
    loadPage: vi.fn().mockResolvedValue(first),
    savePage: vi.fn(async (_id, text) => ({ ...first, text, version: 2 })),
  };
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TextDrop page controls', () => {
  it('opens Create and Join dialogs without sending a request and restores trigger focus when cancelled', async () => {
    await start();
    const dialog = element<HTMLDialogElement>('snippet-dialog');
    element('create').focus();
    element('create').click();
    expect(dialog.open).toBe(true);
    expect(element('create-form').hidden).toBe(false);
    expect(element('join-form').hidden).toBe(true);
    expect(document.activeElement).toBe(element('create-confirm'));
    expect(cloud.createPage).not.toHaveBeenCalled();
    element('create-cancel').click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(element('create'));

    element('join').focus();
    element('join').click();
    expect(dialog.open).toBe(true);
    expect(element('create-form').hidden).toBe(true);
    expect(element('join-form').hidden).toBe(false);
    expect(document.activeElement).toBe(element('join-code'));
    expect(cloud.joinPage).not.toHaveBeenCalled();
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(element('join'));
  });

  it('creates only after confirmation and closes the dialog before focusing the opened editor', async () => {
    await start();
    element('create').click();
    expect(cloud.createPage).not.toHaveBeenCalled();
    element('create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(cloud.createPage).toHaveBeenCalledTimes(1);
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(false);
    expect(element('workspace').hidden).toBe(false);
    expect(location.hash).toBe(`#/p/${first.code}`);
    expect(document.activeElement).toBe(element('editor'));
  });

  it('retains a failed Create confirmation for retry without creating a second page', async () => {
    vi.mocked(cloud.createPage).mockRejectedValueOnce(new Error('Create response lost'));
    await start();
    await create();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').textContent).toBe('Create response lost');
    expect(element('workspace').hidden).toBe(true);
    expect(rows()).toEqual([]);
    expect(element<HTMLButtonElement>('create-confirm').disabled).toBe(false);
    element('create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    const calls = vi.mocked(cloud.createPage).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toBe(calls[1]![0]);
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(false);
    expect(rows()).toEqual([first.code]);
  });

  it('keeps invalid codes and opening failures inside Join with the entered value available to retry', async () => {
    await start();
    await join('wrong');
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').hidden).toBe(false);
    expect(element<HTMLInputElement>('join-code').value).toBe('wrong');
    expect(document.activeElement).toBe(element('join-code'));
    vi.mocked(cloud.joinPage).mockRejectedValueOnce(new Error('Snippet could not be opened'));
    await join(first.code);
    expect(element('dialog-error').textContent).toBe('Snippet could not be opened');
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    expect(element('workspace').hidden).toBe(true);
    expect(rows()).toEqual([]);
    await join(first.code);
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(false);
    expect(element('workspace').hidden).toBe(false);
    expect(element('notice').hidden).toBe(true);
    expect(document.activeElement).toBe(element('editor'));
  });

  it('opens a prefilled Join dialog for an invitation without requesting the shared text until submitted', async () => {
    await start(`#/join/${first.code}`);
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('join-form').hidden).toBe(false);
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    expect(document.activeElement).toBe(element('join-code'));
    expect(cloud.joinPage).not.toHaveBeenCalled();
    element('join-cancel').click();
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    await join(`http://localhost/textdrop/#/join/${first.code}`);
    expect(cloud.joinPage).toHaveBeenCalledExactlyOnceWith(first.code);
    expect(location.hash).toBe(`#/p/${first.code}`);
  });

  it('explains unavailable sharing inside an unconfigured invitation dialog without allowing a request', async () => {
    await start(`#/join/${first.code}`, false);
    const dialog = element<HTMLDialogElement>('snippet-dialog');
    expect(dialog.open).toBe(true);
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    expect(element('dialog-error').hidden).toBe(false);
    expect(element('dialog-error').textContent).toBe('Sharing is unavailable. Please try again later.');
    expect(element<HTMLButtonElement>('join-confirm').disabled).toBe(true);
    expect(element<HTMLButtonElement>('join-cancel').disabled).toBe(false);
    element('join-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(cloud.createPage).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    element('join-cancel').click();
    expect(dialog.open).toBe(false);
    expect(element('home').hidden).toBe(false);
    expect(location.hash).toBe('#/');
  });

  it('keeps Join input available across an offline interruption and blocks requests until reconnected', async () => {
    await start();
    element('join').click();
    element<HTMLInputElement>('join-code').value = first.code;
    window.dispatchEvent(new Event('offline'));
    expect(element<HTMLButtonElement>('join-confirm').disabled).toBe(true);
    element('join-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    window.dispatchEvent(new Event('online'));
    expect(element<HTMLButtonElement>('join-confirm').disabled).toBe(false);
    await join(first.code);
    expect(cloud.joinPage).toHaveBeenCalledExactlyOnceWith(first.code);
    expect(element('workspace').hidden).toBe(false);
  });

  it('blocks duplicate submissions and dismissal while Create or Join is pending', async () => {
    for (const kind of ['create', 'join'] as const) {
      const opening = pending<TextDropPage>();
      if (kind === 'create') vi.mocked(cloud.createPage).mockReturnValueOnce(opening.promise);
      else vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
      await start();
      element(kind).focus();
      element(kind).click();
      if (kind === 'join') element<HTMLInputElement>('join-code').value = first.code;
      const form = element(`${kind}-form`);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      const request = kind === 'create' ? cloud.createPage : cloud.joinPage;
      expect(request).toHaveBeenCalledTimes(1);
      expect(element<HTMLButtonElement>(`${kind}-confirm`).disabled).toBe(true);
      expect(element<HTMLButtonElement>(`${kind}-cancel`).disabled).toBe(true);
      expect(element<HTMLButtonElement>('dialog-close').disabled).toBe(true);
      if (kind === 'join') expect(element<HTMLInputElement>('join-code').disabled).toBe(true);
      const dialog = element<HTMLDialogElement>('snippet-dialog');
      element(`${kind}-cancel`).click();
      element('dialog-close').click();
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, right: 500, bottom: 400 } as DOMRect);
      dialog.dispatchEvent(new MouseEvent('click', { clientX: 90, clientY: 110, bubbles: true }));
      expect(cancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      opening.resolve(first);
      await flush();
      expect(dialog.open).toBe(false);
      expect(document.activeElement).toBe(element('editor'));
      dispose!();
      vi.mocked(cloud.createPage).mockClear();
      vi.mocked(cloud.joinPage).mockClear();
      localStorage.clear();
    }
  });

  it('ignores a pending Create after navigation to a newer invitation', async () => {
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.createPage).mockReturnValueOnce(opening.promise);
    await start();
    element('create').click();
    element('create-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    history.replaceState(null, '', `/textdrop/#/join/${second.code}`);
    window.dispatchEvent(new Event('hashchange'));
    expect(element('join-form').hidden).toBe(false);
    expect(element<HTMLInputElement>('join-code').value).toBe(second.code);
    opening.resolve(first);
    await flush();
    expect(element('workspace').hidden).toBe(true);
    expect(rows()).toEqual([]);
    expect(location.hash).toBe(`#/join/${second.code}`);
    expect(element<HTMLInputElement>('join-code').value).toBe(second.code);
    await join(second.code);
    expect(element('page-code').textContent).toBe(second.code);
    expect(rows()).toEqual([second.code]);
  });

  it('reports storage recovery when a removed snippet cannot be recorded after rejoining', async () => {
    const history = new DeviceSnippets();
    history.remember(first.code);
    history.remove(first.code);
    const removed = history.snapshot(first.code);
    await start();
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    await join(first.code);
    expect(cloud.joinPage).toHaveBeenCalledWith(first.code);
    expect(history.snapshot(first.code)).toBe(removed);
    expect(history.isRemoved(first.code)).toBe(true);
    expect(element('home').hidden).toBe(false);
    expect(element('notice-message').textContent).toContain('Could not save the snippet on this device');
    expect(element('notice-message').textContent).toContain('available space');
    expect(element('notice-message').textContent).not.toContain('removed from this device while opening');
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    writes.mockRestore();
    await join(first.code);
    expect(element('workspace').hidden).toBe(false);
    expect(element('notice').hidden).toBe(true);
    expect(history.isRemoved(first.code)).toBe(false);
  });

  it('restores dialog focus when another tab replaces the list buttons', async () => {
    new DeviceSnippets().remember(first.code);
    await start();
    const trigger = root.querySelector<HTMLButtonElement>('.snippet-remove')!;
    trigger.focus();
    trigger.click();
    new DeviceSnippets().remember(second.code);
    window.dispatchEvent(new StorageEvent('storage', { key: key(second.code) }));
    expect(trigger.isConnected).toBe(false);
    element('remove-cancel').click();
    expect(document.activeElement).toBe(root.querySelector('.snippet-remove[data-code="' + first.code + '"]'));
  });

  it('keeps a successful newer copy visible when an older copy fails later', async () => {
    await start(`#/p/${first.code}`);
    const older = pending<void>();
    const newer = pending<void>();
    writeText.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    element('share').click();
    element('invite-copy-code').click();
    element('invite-copy-link').click();
    newer.resolve();
    await flush();
    expect(element('toast').textContent).toBe('Invite link copied');
    older.reject(new Error('Late failure'));
    await flush();
    expect(element('dialog-error').hidden).toBe(true);
    expect(element('notice').hidden).toBe(true);
    expect(element('toast').textContent).toBe('Invite link copied');
  });

  it('ignores a late invite copy failure after opening a different dialog', async () => {
    await start(`#/p/${first.code}`);
    const copying = pending<void>();
    writeText.mockReturnValueOnce(copying.promise);
    element('share').click();
    element('invite-copy-code').click();
    element('dialog-close').click();
    element('settings').click();
    copying.reject(new Error('Late failure'));
    await flush();
    expect(element('dialog-title').textContent).toBe('Snippet settings');
    expect(element('dialog-error').hidden).toBe(true);
    expect(element('notice').hidden).toBe(true);
  });

  it('offers a selectable invitation code and link with clipboard failure recovery', async () => {
    await start(`#/p/${first.code}`);
    element('share').focus();
    element('share').click();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-title').textContent).toBe('Invite to snippet');
    expect(element<HTMLInputElement>('invite-code').value).toBe(first.code);
    expect(element<HTMLInputElement>('invite-code').selectionEnd).toBe(32);
    expect(element('invite-panel').textContent).toContain('Share it with people you trust');
    writeText.mockRejectedValueOnce(new Error('Denied'));
    element('invite-copy-code').click();
    await flush();
    expect(element('dialog-error').hidden).toBe(false);
    expect(element<HTMLInputElement>('invite-code').value).toBe(first.code);
    element('invite-copy-code').click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(first.code);
    expect(element('dialog-error').hidden).toBe(true);
    element('invite-copy-link').click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(`http://localhost/textdrop/#/join/${first.code}`);
    element('dialog-close').click();
    expect(document.activeElement).toBe(element('share'));
  });

  it('keeps a dialog open on its padding, closes from the backdrop or Escape, and restores keyboard focus', async () => {
    await start(`#/p/${first.code}`);
    const dialog = element<HTMLDialogElement>('snippet-dialog');
    const trigger = element('settings');
    const draft = 'Keep this dialog draft';
    edit(draft);
    trigger.focus();
    trigger.click();
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, right: 500, bottom: 400 } as DOMRect);
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 110, clientY: 110, bubbles: true }));
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { clientX: 90, clientY: 110, bubbles: true }));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(element<HTMLTextAreaElement>('editor').value).toBe(draft);

    trigger.click();
    element('settings-remove').click();
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(rows()).toEqual([first.code]);
    expect(element<HTMLTextAreaElement>('editor').value).toBe(draft);
    expect(cloud.savePage).not.toHaveBeenCalled();
  });

  it('removes through settings with a confirmation and keeps ordinary links hidden across reloads', async () => {
    await start(`#/p/${first.code}`);
    element('settings').click();
    expect(element('dialog-title').textContent).toBe('Snippet settings');
    element('settings-remove').click();
    expect(element('dialog-title').textContent).toBe('Remove from this device?');
    expect(rows()).toEqual([first.code]);
    expect(element<HTMLInputElement>('remove-code').value).toBe(first.code);
    element('remove-cancel').click();
    expect(rows()).toEqual([first.code]);
    element('settings').click();
    element('settings-remove').click();
    window.dispatchEvent(new Event('offline'));
    element('remove-confirm').click();
    expect(rows()).toEqual([]);
    expect(element('home').hidden).toBe(false);
    expect(location.hash).toBe('#/');
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(cloud.createPage).not.toHaveBeenCalled();
    vi.mocked(cloud.joinPage).mockClear();
    dispose!();
    await start(`#/p/${first.code}`);
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(element('home').hidden).toBe(false);
    expect(element<HTMLInputElement>('join-code').value).toBe(first.code);
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(3100);
    expect(rows()).toEqual([]);
    dispose!();
    await start(`#/join/${first.code}`);
    expect(cloud.joinPage).not.toHaveBeenCalled();
    element('join-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(cloud.joinPage).toHaveBeenLastCalledWith(first.code);
    expect(rows()).toEqual([first.code]);
    expect(location.hash).toBe(`#/p/${first.code}`);
  });

  it('requires an explicit choice to discard unsaved text and preserves it when local removal fails', async () => {
    await start(`#/p/${first.code}`);
    edit('Only in this open page');
    element('settings').click();
    element('settings-remove').click();
    expect(element('remove-unsaved').hidden).toBe(false);
    expect(element<HTMLButtonElement>('remove-confirm').disabled).toBe(true);
    element('remove-confirm').click();
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Only in this open page');
    element('remove-copy-text').click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('Only in this open page');
    element<HTMLInputElement>('remove-discard').click();
    expect(element<HTMLButtonElement>('remove-confirm').disabled).toBe(false);
    const saving = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
    element('remove-confirm').click();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').textContent).toContain('Could not remove');
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Only in this open page');
    expect(rows()).toEqual([first.code]);
    saving.mockRestore();
    element('remove-confirm').click();
    expect(element('home').hidden).toBe(false);
    expect(rows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cloud.savePage).not.toHaveBeenCalled();
  });

  it('waits for an in-flight save before allowing removal', async () => {
    const saving = pending<TextDropPage>();
    vi.mocked(cloud.savePage).mockReturnValueOnce(saving.promise);
    await start(`#/p/${first.code}`);
    edit('Saving this text');
    await vi.advanceTimersByTimeAsync(650);
    element('settings').click();
    element('settings-remove').click();
    element<HTMLInputElement>('remove-discard').click();
    expect(element('remove-saving').hidden).toBe(false);
    expect(element<HTMLButtonElement>('remove-confirm').disabled).toBe(true);
    saving.resolve({ ...first, text: 'Saving this text', version: 2 });
    await flush();
    expect(element('remove-unsaved').hidden).toBe(true);
    expect(element<HTMLButtonElement>('remove-confirm').disabled).toBe(false);
    element('remove-confirm').click();
    expect(rows()).toEqual([]);
    expect(cloud.savePage).toHaveBeenCalledTimes(1);
  });

  it('does not let an earlier opening restore a snippet removed in another tab', async () => {
    new DeviceSnippets().remember(first.code);
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
    await start(`#/p/${first.code}`);
    new DeviceSnippets().remove(first.code);
    window.dispatchEvent(new StorageEvent('storage', { key: key(first.code) }));
    opening.resolve(first);
    await flush();
    expect(rows()).toEqual([]);
    expect(new DeviceSnippets().isRemoved(first.code)).toBe(true);
    expect(element('home').hidden).toBe(false);
    expect(element('notice-message').textContent).toContain('removed from this device while opening');
    expect(document.activeElement).toBe(element('join'));
  });

  it('ignores an old opening after navigation to a different invitation and keeps the new code prefilled', async () => {
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
    await start(`#/p/${first.code}`);
    history.replaceState(null, '', `/textdrop/#/join/${second.code}`);
    window.dispatchEvent(new Event('hashchange'));
    expect(element('home').hidden).toBe(false);
    expect(element<HTMLInputElement>('join-code').value).toBe(second.code);
    opening.resolve(first);
    await flush();
    expect(location.hash).toBe(`#/join/${second.code}`);
    expect(element('workspace').hidden).toBe(true);
    expect(element<HTMLInputElement>('join-code').value).toBe(second.code);
    expect(rows()).toEqual([]);
    await join(second.code);
    expect(element('page-code').textContent).toBe(second.code);
    expect(rows()).toEqual([second.code]);
  });

  it('preserves a dirty editor and confirmation when browser storage cannot be read during removal', async () => {
    await start(`#/p/${first.code}`);
    edit('Recover this unsaved text');
    window.dispatchEvent(new Event('offline'));
    element('settings').click();
    element('settings-remove').click();
    element<HTMLInputElement>('remove-discard').click();
    const reads = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    element('remove-confirm').click();
    expect(writes).not.toHaveBeenCalled();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').textContent).toContain('Could not read snippets saved on this device');
    expect(element('workspace').hidden).toBe(false);
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Recover this unsaved text');
    expect(rows()).toEqual([first.code]);
    reads.mockRestore();
    expect(new DeviceSnippets().isRemoved(first.code)).toBe(false);
    expect(cloud.savePage).not.toHaveBeenCalled();
  });

  it('honors cross-tab removal without discarding an unsaved editor', async () => {
    await start(`#/p/${first.code}`);
    edit('Keep this unsaved draft');
    window.dispatchEvent(new Event('offline'));
    new DeviceSnippets().remove(first.code);
    window.dispatchEvent(new StorageEvent('storage', { key: key(first.code) }));
    expect(rows()).toEqual([]);
    expect(element('workspace').hidden).toBe(false);
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Keep this unsaved draft');
    expect(element('notice-message').textContent).toContain('unsaved text stays');
    expect(cloud.savePage).not.toHaveBeenCalled();
    dispose!();
    await start('#/');
    await join(first.code);
    new DeviceSnippets().remove(first.code);
    window.dispatchEvent(new StorageEvent('storage', { key: key(first.code) }));
    expect(element('home').hidden).toBe(false);
    expect(rows()).toEqual([]);
    expect(location.hash).toBe('#/');
  });

  it('remembers created, joined, and direct-link snippets and restores the list after remounting', async () => {
    await start();
    await create();
    expect(location.hash).toBe(`#/p/${first.code}`);
    expect(rows()).toEqual([first.code]);
    root.querySelector<HTMLAnchorElement>('.back-link')!.click();
    await flush();
    vi.setSystemTime(new Date('2026-10-10T02:00:00.000Z'));
    await join(second.code);
    expect(rows()).toEqual([second.code, first.code]);
    expect(JSON.parse(localStorage.getItem(key(second.code))!)).toEqual({ code: second.code, openedAt: '2026-10-10T02:00:00.000Z' });
    dispose!();
    await start();
    expect(rows()).toEqual([second.code, first.code]);
    expect(element('home').hidden).toBe(false);
    dispose!();
    await start(`#/p/${first.code}`);
    expect(cloud.joinPage).toHaveBeenLastCalledWith(first.code);
    expect(element<HTMLTextAreaElement>('editor').value).toBe(first.text);
    expect(rows().filter(code => code === first.code)).toHaveLength(1);
  });

  it('retries a failed recent-snippet opening even when the hash already matches', async () => {
    new DeviceSnippets().remember(first.code);
    vi.mocked(cloud.joinPage).mockRejectedValueOnce(new Error('Connection failed'));
    await start();
    root.querySelector<HTMLAnchorElement>('.snippet-open')!.click();
    await flush();
    expect(location.hash).toBe(`#/p/${first.code}`);
    expect(element('home').hidden).toBe(false);
    expect(element('notice-message').textContent).toBe('Connection failed');
    root.querySelector<HTMLAnchorElement>('.snippet-open')!.click();
    await flush();
    expect(cloud.joinPage).toHaveBeenCalledTimes(2);
    expect(element('workspace').hidden).toBe(false);
    expect(element('notice').hidden).toBe(true);
  });

  it('adds only successful openings and disables removal while an opening is pending', async () => {
    new DeviceSnippets().remember(first.code);
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
    await start();
    const joining = join(first.code);
    await flush();
    const remove = root.querySelector<HTMLButtonElement>('.snippet-remove')!;
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(localStorage.getItem(key(first.code))).not.toBeNull();
    opening.resolve(first);
    await joining;
    await flush();
    expect(element('workspace').hidden).toBe(false);
    dispose!();
    vi.mocked(cloud.joinPage).mockRejectedValueOnce(new Error('Invalid snippet'));
    await start(`#/p/${second.code}`);
    expect(rows()).toEqual([first.code]);
    expect(localStorage.getItem(key(second.code))).toBeNull();
  });

  it('keeps failed removals visible and removes only local metadata after a retry', async () => {
    new DeviceSnippets().remember(first.code);
    new DeviceSnippets().remember(second.code);
    await start();
    const removal = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
    root.querySelector<HTMLButtonElement>('.snippet-remove')!.click();
    element('remove-confirm').click();
    expect(rows()).toEqual([first.code, second.code]);
    expect(element('toast').hidden).toBe(true);
    expect(element('notice-message').textContent).toContain('Could not remove');
    removal.mockRestore();
    element('remove-confirm').click();
    expect(rows()).toEqual([second.code]);
    expect(new DeviceSnippets().isRemoved(first.code)).toBe(true);
    expect(element('toast').textContent).toBe('Snippet removed from this device');
    expect(document.activeElement).toBe(root.querySelector('.snippet-remove'));
    expect(cloud.createPage).not.toHaveBeenCalled();
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(cloud.loadPage).not.toHaveBeenCalled();
    expect(cloud.savePage).not.toHaveBeenCalled();
    await join(first.code);
    expect(element<HTMLTextAreaElement>('editor').value).toBe(first.text);
    expect(rows()).toContain(first.code);
  });

  it('keeps a failed history-write warning through successful reads without blocking the shared page', async () => {
    await start();
    const saving = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
    await create();
    expect(element('workspace').hidden).toBe(false);
    expect(element('notice-message').textContent).toContain('Keep the snippet code');
    root.querySelector<HTMLAnchorElement>('.back-link')!.click();
    await flush();
    window.dispatchEvent(new Event('focus'));
    expect(rows()).toEqual([]);
    expect(element('notice-message').textContent).toContain('Could not save');
    saving.mockRestore();
    await join(first.code);
    expect(rows()).toEqual([first.code]);
    expect(element('notice').hidden).toBe(true);
  });

  it('updates another tab history without losing keyboard focus or restoring removed codes', async () => {
    new DeviceSnippets().remember(first.code);
    await start();
    root.querySelector<HTMLAnchorElement>('.snippet-open')!.focus();
    new DeviceSnippets().remember(second.code);
    window.dispatchEvent(new StorageEvent('storage', { key: key(second.code) }));
    expect(rows()).toEqual([second.code, first.code]);
    expect((document.activeElement as HTMLElement).dataset.code).toBe(first.code);
    localStorage.removeItem(key(first.code));
    window.dispatchEvent(new StorageEvent('storage', { key: key(first.code) }));
    expect(rows()).toEqual([second.code]);
    expect((document.activeElement as HTMLElement).dataset.code).toBe(second.code);
    window.dispatchEvent(new Event('focus'));
    expect(rows()).toEqual([second.code]);
  });

  it('names snippets on this device, keeps the code underneath, and restores the name after remounting', async () => {
    new DeviceSnippets().remember(first.code);
    await start();
    const rename = root.querySelector<HTMLButtonElement>('.snippet-rename')!;
    rename.focus();
    rename.click();
    expect(element('dialog-title').textContent).toBe('Name this snippet');
    expect(document.activeElement).toBe(element('snippet-name-input'));
    element<HTMLInputElement>('snippet-name-input').value = 'Travel notes <draft>';
    element('rename-confirm').click();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(false);
    expect(root.querySelector('.snippet-name')!.textContent).toBe('Travel notes <draft>');
    expect(root.querySelector('.snippet-name draft')).toBeNull();
    expect(root.querySelector('.snippet-metadata code')!.textContent).toBe('aaaaaa…aaaaaa');
    expect(document.activeElement).toBe(root.querySelector('.snippet-rename'));
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(cloud.savePage).not.toHaveBeenCalled();
    dispose!();
    await start();
    expect(root.querySelector('.snippet-name')!.textContent).toBe('Travel notes <draft>');
    root.querySelector<HTMLButtonElement>('.snippet-rename')!.click();
    expect(element<HTMLInputElement>('snippet-name-input').value).toBe('Travel notes <draft>');
    element<HTMLInputElement>('snippet-name-input').value = '';
    element('rename-confirm').click();
    expect(root.querySelector('.snippet-name')!.textContent).toBe('Untitled snippet');
  });

  it('keeps a failed name edit available for retry and allows naming offline without changing shared text', async () => {
    await start(`#/p/${first.code}`);
    edit('Keep this unsaved text');
    window.dispatchEvent(new Event('offline'));
    element('settings').focus();
    element('settings').click();
    element('settings-rename').click();
    element<HTMLInputElement>('snippet-name-input').value = 'My notes';
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
    element('rename-confirm').click();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').textContent).toContain('Could not save');
    expect(element<HTMLInputElement>('snippet-name-input').value).toBe('My notes');
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Keep this unsaved text');
    expect(element('page-name').textContent).toBe('Shared snippet');
    writes.mockRestore();
    element('rename-confirm').click();
    expect(element('page-name').textContent).toBe('My notes');
    expect(document.title).toBe('My notes — TextDrop');
    expect(document.activeElement).toBe(element('settings'));
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Keep this unsaved text');
  });

  it('cancels names without writing and handles cross-tab names and removal while the dialog is open', async () => {
    new DeviceSnippets().remember(first.code);
    await start();
    root.querySelector<HTMLButtonElement>('.snippet-rename')!.focus();
    root.querySelector<HTMLButtonElement>('.snippet-rename')!.click();
    element<HTMLInputElement>('snippet-name-input').value = 'Cancelled name';
    element('rename-cancel').click();
    expect(new DeviceSnippets().list()[0]!.name).toBeUndefined();
    expect(document.activeElement).toBe(root.querySelector('.snippet-rename'));
    new DeviceSnippets().rename(first.code, 'From another tab');
    window.dispatchEvent(new StorageEvent('storage', { key: `${DEVICE_SNIPPETS_KEY}:name:${first.code}` }));
    expect(root.querySelector('.snippet-name')!.textContent).toBe('From another tab');
    expect(document.activeElement).toBe(root.querySelector('.snippet-rename'));
    root.querySelector<HTMLButtonElement>('.snippet-rename')!.click();
    element<HTMLInputElement>('snippet-name-input').value = 'Keep my input';
    new DeviceSnippets().remove(first.code);
    window.dispatchEvent(new StorageEvent('storage', { key: `${DEVICE_SNIPPETS_KEY}:removed:${first.code}` }));
    expect(element<HTMLInputElement>('snippet-name-input').value).toBe('Keep my input');
    element('rename-confirm').click();
    expect(element<HTMLDialogElement>('snippet-dialog').open).toBe(true);
    expect(element('dialog-error').hidden).toBe(false);
    expect(rows()).toEqual([]);
    expect(new DeviceSnippets().isRemoved(first.code)).toBe(true);
    element('rename-cancel').click();
    expect(document.activeElement).toBe(element('device-heading'));
  });

  it('accepts an opening response after another tab names the snippet without discarding the name', async () => {
    new DeviceSnippets().remember(first.code);
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
    await start(`#/p/${first.code}`);
    new DeviceSnippets().rename(first.code, 'Travel notes');
    window.dispatchEvent(new StorageEvent('storage', { key: `${DEVICE_SNIPPETS_KEY}:name:${first.code}` }));
    opening.resolve(first);
    await flush();
    expect(element('workspace').hidden).toBe(false);
    expect(element('page-name').textContent).toBe('Travel notes');
    expect(element<HTMLTextAreaElement>('editor').value).toBe(first.text);
    expect(new DeviceSnippets().list()[0]!.name).toBe('Travel notes');
  });

  it('preserves the draft when leaving is cancelled, and cancels pending autosave after confirmed navigation', async () => {
    await start(`#/p/${first.code}`);
    edit('Keep this draft');
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    root.querySelector<HTMLAnchorElement>('.back-link')!.click();
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe(`#/p/${first.code}`);
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Keep this draft');
    vi.mocked(window.confirm).mockReturnValue(true);
    root.querySelector<HTMLAnchorElement>('.back-link')!.click();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(element('home').hidden).toBe(false);
    expect(cloud.savePage).not.toHaveBeenCalled();
    const cleanLeaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanLeaving);
    expect(cleanLeaving.defaultPrevented).toBe(false);
  });

  it('keeps a failed-save draft through reconnect and publishes it only after Retry save', async () => {
    vi.mocked(cloud.savePage).mockRejectedValueOnce(new Error('Save failed'));
    await start(`#/p/${first.code}`);
    edit('Retry this text');
    await vi.advanceTimersByTimeAsync(650);
    expect(element('save-status').textContent).toBe('Not saved');
    window.dispatchEvent(new Event('offline'));
    expect(element<HTMLTextAreaElement>('editor').disabled).toBe(true);
    expect(element('retry').hidden).toBe(true);
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(element<HTMLTextAreaElement>('editor').value).toBe('Retry this text');
    expect(element('retry').hidden).toBe(false);
    expect(cloud.savePage).toHaveBeenCalledTimes(1);
    element('retry').click();
    await flush();
    expect(cloud.savePage).toHaveBeenLastCalledWith(first.id, 'Retry this text');
    expect(element('save-status').textContent).toBe('All changes saved');
    expect(element('notice').hidden).toBe(true);
  });

  it('renders shared text literally and copies the original text and static-path invitation', async () => {
    const text = '<script>window.injected = true</script>\r\nsecond line';
    vi.mocked(cloud.joinPage).mockResolvedValue({ ...first, text });
    await start(`#/p/${first.code}`);
    expect(root.querySelector('script')).toBeNull();
    expect(element<HTMLTextAreaElement>('editor').value).toBe(text.replace(/\r\n/g, '\n'));
    element('copy-text').click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(text);
    element('share').click();
    element('invite-copy-link').click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(`http://localhost/textdrop/#/join/${first.code}`);
  });

  it('clears an old copy error when the next copy succeeds', async () => {
    await start(`#/p/${first.code}`);
    writeText.mockRejectedValueOnce(new Error('Denied'));
    element('copy-text').click();
    await flush();
    expect(element('notice').hidden).toBe(false);
    element('copy-text').click();
    await flush();
    expect(element('toast').textContent).toBe('Text copied');
    expect(element('notice').hidden).toBe(true);
  });

  it('downloads the visible draft as literal UTF-8 text and releases the temporary URL', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:textdrop-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await start(`#/p/${first.code}`);
    const text = '<config>\nবাংলা 😀\n</config>';
    edit(text);
    element('download').click();
    const blob: Blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('text/plain;charset=utf-8');
    const anchor = download.mock.instances[0]! as HTMLAnchorElement;
    expect(anchor.download).toBe('textdrop-aaaaaaaa.txt');
    expect(anchor.href).toBe('blob:textdrop-export');
    expect(cloud.savePage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:textdrop-export');
    vi.useRealTimers();
    const contents = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => { resolve(String(reader.result)); });
      reader.addEventListener('error', () => { reject(reader.error); });
      reader.readAsText(blob);
    });
    expect(contents).toBe(text);
  });

  it('does not issue actions without configuration or when Home is offline', async () => {
    await start('#/', false);
    expect(element<HTMLButtonElement>('create').disabled).toBe(true);
    expect(element<HTMLButtonElement>('join').disabled).toBe(true);
    expect(element('notice-message').textContent).toContain('Supabase settings');
    element('create').click();
    expect(cloud.createPage).not.toHaveBeenCalled();
    dispose!();
    new DeviceSnippets().remember(first.code);
    await start();
    window.dispatchEvent(new Event('offline'));
    root.querySelector<HTMLAnchorElement>('.snippet-open')!.click();
    await flush();
    expect(cloud.joinPage).not.toHaveBeenCalled();
    expect(element<HTMLButtonElement>('create').disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.snippet-remove')!.disabled).toBe(false);
  });

  it('tears down listeners and polling and ignores late opens or copy results', async () => {
    const opening = pending<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(opening.promise);
    await start(`#/p/${first.code}`);
    dispose!();
    await start();
    opening.resolve(first);
    await flush();
    expect(element('home').hidden).toBe(false);
    expect(rows()).toEqual([]);
    await join(first.code);
    const copying = pending<void>();
    writeText.mockReturnValueOnce(copying.promise);
    element('copy-text').click();
    const oldCreate = element('create');
    dispose!();
    const loadCalls = vi.mocked(cloud.loadPage).mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('hashchange'));
    oldCreate.click();
    await vi.advanceTimersByTimeAsync(6000);
    expect(cloud.loadPage).toHaveBeenCalledTimes(loadCalls);
    expect(cloud.createPage).not.toHaveBeenCalled();
    await start();
    copying.resolve();
    await flush();
    expect(element('toast').hidden).toBe(true);
  });
});

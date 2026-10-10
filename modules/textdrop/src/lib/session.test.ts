import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cloud, TextDropPage } from './cloud';
import { PageSession } from './session';

const id = '11111111-1111-4111-8111-111111111111';
const code = '0123456789abcdef0123456789abcdef';
function page(text = '', version = 1): TextDropPage {
  return { id, code, text, version, updatedAt: '2026-10-10T10:00:00Z' };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const cloud: Cloud = {
    createPage: vi.fn(async () => page()),
    joinPage: vi.fn(async () => page()),
    loadPage: vi.fn(async () => page()),
    savePage: vi.fn(async (_id: string, text: string) => page(text, 2)),
  };
  const session = new PageSession(cloud, 50);
  return { cloud, session };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('online page session', () => {
  it('debounces edits and confirms text only after a successful save', async () => {
    vi.useFakeTimers();
    const { cloud, session } = setup();
    await session.join(code);
    session.edit('first');
    await vi.advanceTimersByTimeAsync(30);
    session.edit('latest');
    await vi.advanceTimersByTimeAsync(49);
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(session.state.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.savePage).toHaveBeenCalledExactlyOnceWith(id, 'latest');
    expect(session.state.draft).toBe('latest');
    expect(session.state.dirty).toBe(false);
    session.dispose();
  });

  it('serializes saves and preserves new edits made during an upload', async () => {
    vi.useFakeTimers();
    const { cloud, session } = setup();
    const first = deferred<TextDropPage>();
    vi.mocked(cloud.savePage).mockReturnValueOnce(first.promise).mockResolvedValueOnce(page('second', 3));
    await session.join(code);
    session.edit('first');
    const saving = session.save();
    session.edit('second');
    await vi.advanceTimersByTimeAsync(100);
    expect(cloud.savePage).toHaveBeenCalledTimes(1);
    first.resolve(page('first', 2));
    await saving;
    expect(session.state.draft).toBe('second');
    expect(session.state.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(cloud.savePage).toHaveBeenNthCalledWith(2, id, 'second');
    expect(session.state.dirty).toBe(false);
    expect(session.state.page?.text).toBe('second');
    session.dispose();
  });

  it('keeps a newer poll when an older save response arrives afterward', async () => {
    const { cloud, session } = setup();
    const saving = deferred<TextDropPage>();
    vi.mocked(cloud.savePage).mockReturnValueOnce(saving.promise);
    vi.mocked(cloud.loadPage).mockResolvedValueOnce(page('later browser save', 3));
    await session.join(code);
    session.edit('my text');
    const saved = session.save();
    await session.refresh();
    expect(session.state.draft).toBe('my text');
    saving.resolve(page('my text', 2));
    await saved;
    expect(session.state.page?.version).toBe(3);
    expect(session.state.draft).toBe('later browser save');
    expect(session.state.dirty).toBe(false);
    session.dispose();
  });

  it('rejects an older poll response after a newer save', async () => {
    const { cloud, session } = setup();
    const refresh = deferred<TextDropPage>();
    vi.mocked(cloud.loadPage).mockReturnValueOnce(refresh.promise);
    await session.join(code);
    const refreshing = session.refresh();
    session.edit('latest');
    await session.save();
    refresh.resolve(page('outdated'));
    await refreshing;
    expect(session.state.draft).toBe('latest');
    expect(session.state.page?.version).toBe(2);
    session.dispose();
  });

  it('coalesces slow polls and allows another refresh after a failed request', async () => {
    const { cloud, session } = setup();
    const pending = deferred<TextDropPage>();
    vi.mocked(cloud.loadPage).mockReturnValueOnce(pending.promise);
    await session.join(code);
    const polls = [session.refresh(), session.refresh(), session.refresh()];
    await Promise.resolve();
    expect(cloud.loadPage).toHaveBeenCalledTimes(1);
    pending.reject(new Error('Connection lost'));
    await Promise.all(polls);
    expect(session.state.error).toBe('Connection lost');
    vi.mocked(cloud.loadPage).mockResolvedValueOnce(page('Latest shared text', 2));
    await session.refresh();
    expect(cloud.loadPage).toHaveBeenCalledTimes(2);
    expect(session.state.draft).toBe('Latest shared text');
    expect(session.state.error).toBe('');
    session.dispose();
  });

  it('ignores a failed older poll after a newer save confirms sync', async () => {
    const { cloud, session } = setup();
    const pending = deferred<TextDropPage>();
    vi.mocked(cloud.loadPage).mockReturnValueOnce(pending.promise);
    await session.join(code);
    const polling = session.refresh();
    await Promise.resolve();
    session.edit('Saved after the poll started');
    await session.save();
    pending.reject(new Error('Old failed poll'));
    await polling;
    expect(session.state.page?.version).toBe(2);
    expect(session.state.draft).toBe('Saved after the poll started');
    expect(session.state.dirty).toBe(false);
    expect(session.state.error).toBe('');
    session.dispose();
  });

  it('starts a new navigation poll without an obsolete request clearing its in-flight guard', async () => {
    const { cloud, session } = setup();
    const obsolete = deferred<TextDropPage>();
    const current = deferred<TextDropPage>();
    vi.mocked(cloud.loadPage).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    await session.join(code);
    const oldPolling = session.refresh();
    await Promise.resolve();
    session.home();
    await session.join(code);
    const newPolling = session.refresh();
    await Promise.resolve();
    expect(cloud.loadPage).toHaveBeenCalledTimes(2);
    obsolete.reject(new Error('Old page failure'));
    await oldPolling;
    const duplicate = session.refresh();
    await Promise.resolve();
    expect(cloud.loadPage).toHaveBeenCalledTimes(2);
    expect(session.state.error).toBe('');
    current.resolve(page('Current page', 2));
    await Promise.all([newPolling, duplicate]);
    expect(session.state.draft).toBe('Current page');
    session.dispose();
  });

  it('retains a failed draft without automatically retrying or replacing it', async () => {
    vi.useFakeTimers();
    const { cloud, session } = setup();
    vi.mocked(cloud.savePage).mockRejectedValueOnce(new Error('Connection lost'));
    vi.mocked(cloud.loadPage).mockResolvedValueOnce(page('other browser', 3));
    await session.join(code);
    session.edit('keep this');
    await session.save();
    await session.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cloud.savePage).toHaveBeenCalledTimes(1);
    expect(session.state.draft).toBe('keep this');
    expect(session.state.error).toBe('Connection lost');
    expect(session.state.dirty).toBe(true);
    vi.mocked(cloud.savePage).mockResolvedValueOnce(page('keep this', 4));
    await session.save();
    expect(session.state.page?.text).toBe('keep this');
    expect(session.state.dirty).toBe(false);
    session.dispose();
  });

  it('pauses saves offline and requires retry on reconnection', async () => {
    vi.useFakeTimers();
    const { cloud, session } = setup();
    await session.join(code);
    session.edit('pending');
    session.setOnline(false);
    session.edit('offline change');
    await vi.advanceTimersByTimeAsync(100);
    await session.save();
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(session.state.draft).toBe('pending');
    session.setOnline(true);
    expect(session.state.error).toMatch(/choose Retry save/);
    await vi.advanceTimersByTimeAsync(100);
    expect(cloud.savePage).not.toHaveBeenCalled();
    await session.save();
    expect(cloud.savePage).toHaveBeenCalledExactlyOnceWith(id, 'pending');
    session.dispose();
  });

  it('ignores obsolete navigation, load and save responses', async () => {
    const { cloud, session } = setup();
    const joining = deferred<TextDropPage>();
    vi.mocked(cloud.joinPage).mockReturnValueOnce(joining.promise);
    const opening = session.join(code);
    session.home();
    joining.resolve(page());
    expect(await opening).toBe(false);
    expect(session.state.phase).toBe('home');
    await session.join(code);
    const pending = deferred<TextDropPage>();
    vi.mocked(cloud.savePage).mockReturnValueOnce(pending.promise);
    session.edit('old page');
    const saving = session.save();
    await Promise.resolve();
    expect(cloud.savePage).toHaveBeenCalledExactlyOnceWith(id, 'old page');
    session.home();
    pending.resolve(page('old page', 2));
    await saving;
    expect(session.state.page).toBeNull();
    expect(session.state.draft).toBe('');
    session.dispose();
  });

  it('does not launch queued writes after returning home or disposing the session', async () => {
    for (const stop of ['home', 'dispose'] as const) {
      const { cloud, session } = setup();
      await session.join(code);
      session.edit('Discard this text');
      const saving = session.save();
      session[stop]();
      await saving;
      expect(cloud.savePage).not.toHaveBeenCalled();
      session.dispose();
    }
  });

  it('does not launch a queued write after going offline and keeps it available to retry', async () => {
    const { cloud, session } = setup();
    await session.join(code);
    session.edit('Retry after reconnecting');
    const saving = session.save();
    session.setOnline(false);
    await saving;
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(session.state.phase).toBe('ready');
    expect(session.state.dirty).toBe(true);
    expect(session.state.draft).toBe('Retry after reconnecting');
    session.setOnline(true);
    await session.save();
    expect(cloud.savePage).toHaveBeenCalledExactlyOnceWith(id, 'Retry after reconnecting');
    expect(session.state.dirty).toBe(false);
    session.dispose();
  });

  it('reuses the creation ID after a lost response', async () => {
    const { cloud, session } = setup();
    vi.mocked(cloud.createPage).mockRejectedValueOnce(new Error('Response lost'));
    expect(await session.create()).toBe(false);
    expect(await session.create()).toBe(true);
    const calls = vi.mocked(cloud.createPage).mock.calls;
    expect(calls[0]![0]).toBe(calls[1]![0]);
    session.dispose();
  });

  it('uses secure random bytes when randomUUID is unavailable and retains that ID for retry', async () => {
    const randomBytes = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    });
    vi.stubGlobal('crypto', { getRandomValues: randomBytes });
    const { cloud, session } = setup();
    vi.mocked(cloud.createPage).mockRejectedValueOnce(new Error('Response lost'));
    expect(await session.create()).toBe(false);
    expect(await session.create()).toBe(true);
    const expected = '00010203-0405-4607-8809-0a0b0c0d0e0f';
    expect(vi.mocked(cloud.createPage).mock.calls.map(([createdId]) => createdId)).toEqual([expected, expected]);
    expect(randomBytes).toHaveBeenCalledTimes(1);
    expect(session.state.error).toBe('');
    session.dispose();
  });

  it('reports a thrown UUID generator without sending a create request and permits a later retry', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => { throw new Error('Random generator failed'); } });
    const { cloud, session } = setup();
    expect(await session.create()).toBe(false);
    expect(cloud.createPage).not.toHaveBeenCalled();
    expect(session.state.error).toMatch(/Could not create a snippet/);
    vi.stubGlobal('crypto', { randomUUID: () => id });
    expect(await session.create()).toBe(true);
    expect(cloud.createPage).toHaveBeenCalledExactlyOnceWith(id);
    expect(session.state.error).toBe('');
    session.dispose();
  });

  it('reports missing or denied secure random bytes without contacting Supabase', async () => {
    for (const randomness of [undefined, {}, { getRandomValues: () => { throw new Error('Random bytes unavailable'); } }]) {
      vi.stubGlobal('crypto', randomness);
      const { cloud, session } = setup();
      expect(await session.create()).toBe(false);
      expect(cloud.createPage).not.toHaveBeenCalled();
      expect(session.state.error).toMatch(/HTTPS/);
      expect(session.state.phase).toBe('home');
      session.dispose();
    }
  });

  it('shows invalid-text errors without making a save request', async () => {
    const { cloud, session } = setup();
    await session.join(code);
    session.edit('bad\u0000text');
    await session.save();
    expect(cloud.savePage).not.toHaveBeenCalled();
    expect(session.state.error).toMatch(/cannot be saved/);
    expect(session.state.draft).toBe('bad\u0000text');
    session.dispose();
  });

  it('allows retry after a synchronous service failure', async () => {
    const { cloud, session } = setup();
    vi.mocked(cloud.savePage).mockImplementationOnce(() => { throw new Error('Failed immediately'); });
    await session.join(code);
    session.edit('retry me');
    await session.save();
    expect(session.state.error).toBe('Failed immediately');
    await session.save();
    expect(cloud.savePage).toHaveBeenCalledTimes(2);
    expect(session.state.dirty).toBe(false);
    session.dispose();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacyAuthStorage, TEXTDROP_AUTH_KEY } from './authStorage';

const legacyKey = 'paste-auth';
const credentials = '{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_at":1}';
function fixture(entries: [string, string][] = []) {
  const values = new Map(entries);
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { values, storage };
}
/** Independent owners share a named queue, like browser tabs. */
function browserLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = async (name: string, callback: () => unknown) => {
    const previous = tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    tails.set(name, previous.then(() => held));
    await previous;
    try { return await callback(); } finally { release(); }
  };
  return { request: request as LockManager['request'] };
}
afterEach(() => vi.unstubAllGlobals());

describe('TextDrop authentication storage rename', () => {
  it('copies credentials exactly and retains the original and metadata for recovery', async () => {
    const { storage, values } = fixture([[legacyKey, credentials], ['textdrop-snippets:fixture', 'metadata']]);
    const locks = browserLocks();
    await migrateLegacyAuthStorage(storage, locks);
    await migrateLegacyAuthStorage(storage, locks);
    expect(values.get(TEXTDROP_AUTH_KEY)).toBe(credentials);
    expect(values.get(legacyKey)).toBe(credentials);
    expect(values.get('textdrop-snippets:fixture')).toBe('metadata');
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it('waits for an ordinary auth writer and preserves its newer identity', async () => {
    const { storage, values } = fixture([[legacyKey, credentials]]);
    const locks = browserLocks();
    let finishWriter!: () => void;
    const held = new Promise<void>(resolve => { finishWriter = resolve; });
    const newer = credentials.replace('fixture-access', 'newer-access');
    const writer = locks.request(`lock:${TEXTDROP_AUTH_KEY}`, async () => {
      await held; storage.setItem(TEXTDROP_AUTH_KEY, newer);
    });
    const migration = migrateLegacyAuthStorage(storage, locks);
    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();
    finishWriter(); await Promise.all([writer, migration]);
    expect(values.get(TEXTDROP_AUTH_KEY)).toBe(newer);
    expect(values.get(legacyKey)).toBe(credentials);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it('waits for a legacy token refresh before copying', async () => {
    const { storage, values } = fixture([[legacyKey, credentials]]);
    const locks = browserLocks();
    const refreshed = credentials.replace('fixture-refresh', 'rotated-refresh');
    const writer = locks.request(`lock:${legacyKey}`, async () => storage.setItem(legacyKey, refreshed));
    await Promise.all([writer, migrateLegacyAuthStorage(storage, locks)]);
    expect(values.get(TEXTDROP_AUTH_KEY)).toBe(refreshed);
    expect(values.get(legacyKey)).toBe(refreshed);
  });
  it('preserves distinct current credentials without requiring migration', async () => {
    const current = credentials.replace('fixture-access', 'other-access');
    const { storage, values } = fixture([[legacyKey, credentials], [TEXTDROP_AUTH_KEY, current]]);
    await migrateLegacyAuthStorage(storage);
    expect(values.get(TEXTDROP_AUTH_KEY)).toBe(current);
    expect(values.get(legacyKey)).toBe(credentials);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('fails closed if legacy migration needs unavailable browser locks', async () => {
    const { storage, values } = fixture([[legacyKey, credentials]]);
    await expect(migrateLegacyAuthStorage(storage, null)).rejects.toThrow('Could not preserve');
    expect(values.get(legacyKey)).toBe(credentials);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it('blocks incomplete or malformed credentials without discarding them', async () => {
    for (const invalid of ['', '{malformed', 'null', '{}', '{"access_token":"a","refresh_token":"r"}', '{"access_token":"","refresh_token":"r","expires_at":1}']) {
      for (const entries of [[[legacyKey, credentials], [TEXTDROP_AUTH_KEY, invalid]], [[legacyKey, invalid]]] as [string, string][][]) {
        const { storage, values } = fixture(entries);
        await expect(migrateLegacyAuthStorage(storage, browserLocks())).rejects.toThrow('Could not preserve');
        expect([...values]).toEqual(entries);
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.removeItem).not.toHaveBeenCalled();
      }
    }
  });
  it('leaves a fresh browser unchanged and does nothing outside a browser', async () => {
    const { storage } = fixture();
    await migrateLegacyAuthStorage(storage);
    expect(storage.setItem).not.toHaveBeenCalled();
    await expect(migrateLegacyAuthStorage()).resolves.toBeUndefined();
  });
  it('keeps original credentials when storage fails or a write is lost', async () => {
    for (const failure of ['read', 'write', 'lost']) {
      const { storage, values } = fixture([[legacyKey, credentials]]);
      if (failure === 'read') storage.getItem.mockImplementationOnce(() => { throw new Error('Denied'); });
      if (failure === 'write') storage.setItem.mockImplementationOnce(() => { throw new Error('Full'); });
      if (failure === 'lost') storage.setItem.mockImplementationOnce(() => {});
      await expect(migrateLegacyAuthStorage(storage, browserLocks())).rejects.toThrow('Could not preserve');
      expect(values.get(legacyKey)).toBe(credentials);
      expect(storage.removeItem).not.toHaveBeenCalled();
    }
  });
  it('redacts unavailable browser storage errors', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error(credentials); } });
    await expect(migrateLegacyAuthStorage()).rejects.toThrow('Check browser storage permissions');
    await expect(migrateLegacyAuthStorage()).rejects.not.toThrow('fixture-access');
  });
});

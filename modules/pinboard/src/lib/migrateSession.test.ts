import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migratePinboardSession } from './migrateSession';

const locks = { request: vi.fn(async (_name: string, callback: (lock: Lock) => unknown) => callback({} as Lock)) } as unknown as Pick<LockManager, 'request'>;
const currentKey = 'pinboard-auth';
// This fixture exercises the one-time migration from the app's former name.
const legacyKey = 'kanban-auth';
const legacySession = JSON.stringify({ access_token: 'legacy-token', refresh_token: 'legacy-refresh', expires_at: 4_000_000_000 });

function storageFixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { values, storage };
}

beforeEach(() => vi.clearAllMocks());

describe('Pinboard session migration', () => {
  it.each([
    'not JSON', 'null', '[]', '{}',
    JSON.stringify({ access_token: 'token', refresh_token: 'refresh' }),
    JSON.stringify({ access_token: '', refresh_token: 'refresh', expires_at: 4_000_000_000 }),
    JSON.stringify({ access_token: 'token', refresh_token: 'refresh', expires_at: 'later' }),
  ])('retains rejected original credentials without exposing them to the auth client: %s', async (raw) => {
    const { values, storage } = storageFixture({ [legacyKey]: raw });
    await expect(migratePinboardSession(storage, locks)).rejects.toThrow(/original credentials are preserved/i);
    expect(values.get(legacyKey)).toBe(raw);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('retains credentials without copying when browser auth locks are unavailable', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    await expect(migratePinboardSession(storage, null)).rejects.toThrow(/original credentials are preserved/i);
    expect(values.has(currentKey)).toBe(false);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('reads current credentials after waiting for a concurrent auth writer', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    const current = JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh', expires_at: 4_000_000_000 });
    vi.mocked(locks.request).mockImplementationOnce(async (_name, callback) => {
      values.set(currentKey, current);
      return (callback as (lock: Lock) => unknown)({} as Lock);
    });
    await migratePinboardSession(storage, locks);
    expect(values.get(currentKey)).toBe(current);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves a refreshed original written by an uncoordinated tab during copy', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    const refreshed = JSON.stringify({ access_token: 'refreshed-token', refresh_token: 'refreshed-refresh', expires_at: 4_000_000_000 });
    storage.setItem.mockImplementation((key, value) => { values.set(key, value); values.set(legacyKey, refreshed); });
    await migratePinboardSession(storage, locks);
    expect(values.get(legacyKey)).toBe(refreshed);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('copies valid credentials under both auth locks and retains the recovery original', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    await migratePinboardSession(storage, locks);
    expect(values.get(currentKey)).toBe(legacySession);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(vi.mocked(locks.request).mock.calls.map(([name]) => name)).toEqual(['lock:pinboard-auth', 'lock:kanban-auth']);
    expect(storage.setItem).toHaveBeenCalledWith(currentKey, legacySession);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('keeps an existing Pinboard identity without replacing or deleting either session', async () => {
    const currentSession = JSON.stringify({ access_token: 'current-token', refresh_token: 'current-refresh', expires_at: 4_000_000_000 });
    const { values, storage } = storageFixture({ [currentKey]: currentSession, [legacyKey]: legacySession });
    await migratePinboardSession(storage, locks);
    expect(values.get(currentKey)).toBe(currentSession);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(storage.getItem).toHaveBeenCalledOnce();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('leaves storage untouched when there is no former session', async () => {
    const { values, storage } = storageFixture();
    await migratePinboardSession(storage, locks);
    expect(values.size).toBe(0);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves the original session when saving the new key fails', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    storage.setItem.mockImplementation(() => { throw new Error('Quota exceeded'); });
    await expect(migratePinboardSession(storage, locks)).rejects.toThrow(/session/i);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(values.has(currentKey)).toBe(false);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves the original session when the new copy cannot be verified', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    storage.getItem.mockImplementation((key) => key === legacyKey ? legacySession : null);
    await expect(migratePinboardSession(storage, locks)).rejects.toThrow(/session/i);
    expect(storage.setItem).toHaveBeenCalledWith(currentKey, legacySession);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves the original session when storage cannot be read', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    storage.getItem.mockImplementation(() => { throw new Error('Storage disabled'); });
    await expect(migratePinboardSession(storage, locks)).rejects.toThrow(/session/i);
    expect(values.get(legacyKey)).toBe(legacySession);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('never requires deleting the recovery original after a verified copy', async () => {
    const { values, storage } = storageFixture({ [legacyKey]: legacySession });
    storage.removeItem.mockImplementation(() => { throw new Error('Storage unavailable'); });
    await expect(migratePinboardSession(storage, locks)).resolves.toBeUndefined();
    expect(values.get(currentKey)).toBe(legacySession);
    expect(values.get(legacyKey)).toBe(legacySession);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { DEVICE_SNIPPETS_KEY, DeviceSnippets, MAX_SNIPPET_NAME_LENGTH } from './deviceSnippets';

const firstCode = 'a'.repeat(32);
const secondCode = 'b'.repeat(32);
const thirdCode = 'c'.repeat(32);
const fourthCode = 'd'.repeat(32);
const firstTime = '2026-10-10T01:00:00.000Z';
const secondTime = '2026-10-10T02:00:00.000Z';
const thirdTime = '2026-10-10T03:00:00.000Z';
const storageKey = (code: string) => `${DEVICE_SNIPPETS_KEY}:${code}`;
const removalKey = (code: string) => `${DEVICE_SNIPPETS_KEY}:removed:${code}`;
const reopeningKey = (code: string, token: string) => `${DEVICE_SNIPPETS_KEY}:opened:${code}:${token}`;
const nameKey = (code: string) => `${DEVICE_SNIPPETS_KEY}:name:${code}`;

function fixture(initial: [string, string][] = []) {
  const values = new Map(initial);
  const storage = {
    get length() { return values.size; },
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, saved: string) => { values.set(key, saved); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { storage, values };
}

describe('device snippet history', () => {
  it('persists codes and opening times for a fresh instance after reload', () => {
    const { storage } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    expect(history.list()).toEqual([]);
    expect(history.remember(firstCode)).toEqual([{ code: firstCode, openedAt: firstTime }]);
    expect(new DeviceSnippets(() => storage).list()).toEqual([{ code: firstCode, openedAt: firstTime }]);
    expect(storage.getItem).toHaveBeenCalledWith(storageKey(firstCode));
  });

  it('normalizes duplicate openings and moves the reopened snippet to the front', () => {
    const { storage, values } = fixture();
    let time = firstTime;
    const history = new DeviceSnippets(() => storage, () => new Date(time));
    history.remember(firstCode);
    time = secondTime;
    history.remember(secondCode);
    time = thirdTime;
    expect(history.remember(` ${'A'.repeat(16)}-${'A'.repeat(16)}\n`)).toEqual([
      { code: firstCode, openedAt: thirdTime }, { code: secondCode, openedAt: secondTime },
    ]);
    expect(values.size).toBe(2);
  });

  it('persists a normalized device name without changing opening times, order, or opening guards', () => {
    const { storage, values } = fixture();
    let time = firstTime;
    const history = new DeviceSnippets(() => storage, () => new Date(time));
    history.remember(firstCode);
    time = secondTime;
    history.remember(secondCode);
    const opening = values.get(storageKey(firstCode));
    const guard = history.snapshot(firstCode);
    storage.setItem.mockClear();
    expect(history.rename(firstCode, '  Travel\n  notes\t ')).toEqual([
      { code: secondCode, openedAt: secondTime }, { code: firstCode, openedAt: firstTime, name: 'Travel notes' },
    ]);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([nameKey(firstCode)]);
    expect(JSON.parse(values.get(nameKey(firstCode))!)).toEqual({ code: firstCode, name: 'Travel notes' });
    expect(values.get(storageKey(firstCode))).toBe(opening);
    expect(history.snapshot(firstCode)).toBe(guard);
    expect(new DeviceSnippets(() => storage).list()[1]!.name).toBe('Travel notes');
    expect(history.rename(firstCode, '\n \t')[1]).toEqual({ code: firstCode, openedAt: firstTime });
  });

  it('keeps a name through subsequent openings, removal, and an explicit successful rejoin', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    firstTab.rename(firstCode, 'Shared checklist');
    expect(secondTab.remember(firstCode)).toEqual([{ code: firstCode, openedAt: secondTime, name: 'Shared checklist' }]);
    expect(secondTab.remove(firstCode)).toEqual([]);
    storage.setItem.mockClear();
    expect(() => firstTab.rename(firstCode, 'Hidden entry')).toThrow('no longer saved');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.get(nameKey(firstCode))).toContain('Shared checklist');
    expect(firstTab.remember(firstCode)).toEqual([]);
    expect(firstTab.remember(firstCode, firstTab.snapshot(firstCode))).toEqual([
      { code: firstCode, openedAt: firstTime, name: 'Shared checklist' },
    ]);
  });

  it('ignores malformed names without losing valid snippets and never creates history from a name alone', () => {
    const { storage } = fixture([
      [storageKey(firstCode), JSON.stringify({ code: firstCode, openedAt: firstTime, name: 'Injected row name' })],
      [nameKey(firstCode), JSON.stringify({ code: secondCode, name: 'Wrong snippet' })],
      [storageKey(secondCode), JSON.stringify({ code: secondCode, openedAt: firstTime })],
      [nameKey(secondCode), JSON.stringify({ code: secondCode, name: 'x'.repeat(MAX_SNIPPET_NAME_LENGTH + 1) })],
      [storageKey(thirdCode), JSON.stringify({ code: thirdCode, openedAt: firstTime })],
      [nameKey(thirdCode), '{broken'],
      [nameKey(fourthCode), JSON.stringify({ code: fourthCode, name: 'Orphan name' })],
    ]);
    const history = new DeviceSnippets(() => storage);
    expect(history.list()).toEqual([
      { code: firstCode, openedAt: firstTime }, { code: secondCode, openedAt: firstTime }, { code: thirdCode, openedAt: firstTime },
    ]);
    expect(() => history.rename(fourthCode, 'Still orphaned')).toThrow('no longer saved');
    for (const name of [123, null, [], {}, ' \n ']) {
      storage.setItem(nameKey(firstCode), JSON.stringify({ code: firstCode, name }));
      expect(history.list()[0]).toEqual({ code: firstCode, openedAt: firstTime });
    }
    storage.setItem(nameKey(firstCode), JSON.stringify({ code: firstCode, name: 'Valid', text: 'private text', id: 'private-id' }));
    expect(history.list()[0]).toEqual({ code: firstCode, openedAt: firstTime, name: 'Valid' });
  });

  it('validates names and codes before touching storage and preserves a durable name when writes fail', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    expect(() => history.rename('bad-code', 'Name')).toThrow('32-character');
    expect(() => history.rename(firstCode, 'x'.repeat(MAX_SNIPPET_NAME_LENGTH + 1))).toThrow('80 characters');
    expect(storage.key).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    history.remember(firstCode);
    history.rename(firstCode, 'Original');
    const name = values.get(nameKey(firstCode));
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => history.rename(firstCode, 'Changed')).toThrow('Could not save the snippet name');
    expect(() => history.rename(firstCode, '')).toThrow('Could not save the snippet name');
    expect(values.get(nameKey(firstCode))).toBe(name);
    expect(history.list()).toEqual([{ code: firstCode, openedAt: firstTime, name: 'Original' }]);
  });

  it('keeps names and opening times independent during interleaved same-code writes', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      secondTab.rename(firstCode, 'Named while opening');
      values.set(key, saved);
    });
    expect(firstTab.remember(firstCode)).toEqual([{ code: firstCode, openedAt: firstTime, name: 'Named while opening' }]);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      secondTab.remember(firstCode);
      values.set(key, saved);
    });
    expect(firstTab.rename(firstCode, 'Named after opening')).toEqual([{ code: firstCode, openedAt: secondTime, name: 'Named after opening' }]);
  });

  it('never restores a concurrently removed snippet while writing its separate name', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      new DeviceSnippets(() => storage).remove(firstCode);
      values.set(key, saved);
    });
    expect(history.rename(firstCode, 'Name retained for rejoin')).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(new DeviceSnippets(() => storage).list()).toEqual([]);
    expect(history.remember(firstCode, history.snapshot(firstCode))).toEqual([
      { code: firstCode, openedAt: firstTime, name: 'Name retained for rejoin' },
    ]);
  });

  it('blocks name writes after denied reads and omits the renamed row when post-write visibility cannot be checked', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    history.rename(firstCode, 'Original');
    storage.setItem.mockClear();
    storage.getItem.mockImplementationOnce(() => { throw new Error('Denied'); });
    expect(() => history.rename(firstCode, 'Not committed')).toThrow('Could not read');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.get(nameKey(firstCode))).toContain('Original');
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      new DeviceSnippets(() => storage).remove(firstCode);
      values.set(key, saved);
      storage.getItem.mockImplementationOnce(() => { throw new Error('Denied after write'); });
    });
    expect(history.rename(firstCode, 'Committed')).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(values.get(nameKey(firstCode))).toContain('Committed');
  });

  it('removes one local code, preserves other snippets, and restores it only when reopened', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    history.remember(secondCode);
    expect(history.remove(firstCode)).toEqual([{ code: secondCode, openedAt: firstTime }]);
    expect(JSON.parse(values.get(removalKey(firstCode))!).removed).toBe(true);
    expect(JSON.parse(values.get(storageKey(firstCode))!)).toEqual({ code: firstCode, openedAt: firstTime });
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(new DeviceSnippets(() => storage).list()).toEqual([{ code: secondCode, openedAt: firstTime }]);
    expect(history.remove(firstCode)).toEqual([{ code: secondCode, openedAt: firstTime }]);
    expect(history.remember(firstCode).map(row => row.code)).toEqual([secondCode]);
    expect(history.remember(firstCode, history.snapshot(firstCode)).map(row => row.code)).toEqual([firstCode, secondCode]);
  });

  it('rereads durable data without rewriting another tab additions or removals', () => {
    const { storage } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    expect(secondTab.list()).toEqual([{ code: firstCode, openedAt: firstTime }]);
    firstTab.remember(secondCode);
    expect(secondTab.remember(thirdCode).map(row => row.code)).toEqual([thirdCode, firstCode, secondCode]);
    expect(firstTab.remove(firstCode).map(row => row.code)).toEqual([thirdCode, secondCode]);
    expect(secondTab.remember(thirdCode).map(row => row.code)).toEqual([thirdCode, secondCode]);
    expect(secondTab.remove(thirdCode).map(row => row.code)).toEqual([secondCode]);
    expect(firstTab.list().map(row => row.code)).toEqual([secondCode]);
  });

  it('touches only the requested code and preserves unrelated browser storage', () => {
    const { storage, values } = fixture([['textdrop-auth', 'session-token']]);
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    const original = values.get(storageKey(firstCode));
    storage.setItem.mockClear();
    history.remember(secondCode);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([storageKey(secondCode)]);
    expect(values.get(storageKey(firstCode))).toBe(original);
    history.remove(secondCode);
    expect(JSON.parse(values.get(removalKey(secondCode))!).removed).toBe(true);
    expect(values.get(storageKey(firstCode))).toBe(original);
    expect(values.get('textdrop-auth')).toBe('session-token');
    expect(values.has(DEVICE_SNIPPETS_KEY)).toBe(false);
  });

  it('keeps removals and new rows under interleaved operations from two tabs', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    firstTab.remember(secondCode);
    const set = (key: string, saved: string) => { values.set(key, saved); };
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation(set);
      secondTab.remove(secondCode);
      values.set(key, saved);
    });
    expect(firstTab.remember(thirdCode).map(row => row.code)).toEqual([firstCode, thirdCode]);
    expect(JSON.parse(values.get(removalKey(secondCode))!).removed).toBe(true);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation(set);
      secondTab.remember(fourthCode);
      values.set(key, saved);
    });
    expect(firstTab.remove(firstCode).map(row => row.code)).toEqual([fourthCode, thirdCode]);
    expect(secondTab.list().map(row => row.code)).toEqual([fourthCode, thirdCode]);
  });

  it('does not retain a mutable in-memory snapshot that could later be written back', () => {
    const { storage } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const returned = history.remember(firstCode);
    returned[0]!.code = secondCode;
    returned.push({ code: thirdCode, openedAt: thirdTime });
    expect(history.list()).toEqual([{ code: firstCode, openedAt: firstTime }]);
    expect(history.remember(secondCode).map(row => row.code)).toEqual([firstCode, secondCode]);
  });

  it('ignores corrupted rows, mismatched codes, invalid times, and the old preview array', () => {
    const { storage, values } = fixture([
      [DEVICE_SNIPPETS_KEY, JSON.stringify([{ code: fourthCode, openedAt: firstTime }])],
      [storageKey(firstCode), '{broken'],
      [storageKey(secondCode), JSON.stringify({ code: firstCode, openedAt: firstTime })],
      [storageKey(thirdCode), JSON.stringify({ code: thirdCode, openedAt: '2026-02-30T01:00:00.000Z' })],
      [`${DEVICE_SNIPPETS_KEY}:invalid`, JSON.stringify({ code: fourthCode, openedAt: firstTime })],
      [storageKey(fourthCode), JSON.stringify({ code: fourthCode, openedAt: firstTime, text: 'Injected text', id: 'private-id' })],
    ]);
    const history = new DeviceSnippets(() => storage, () => new Date(secondTime));
    expect(history.list()).toEqual([{ code: fourthCode, openedAt: firstTime }]);
    history.remember(firstCode);
    expect(history.list()).toEqual([
      { code: firstCode, openedAt: secondTime }, { code: fourthCode, openedAt: firstTime },
    ]);
    expect(JSON.parse(values.get(storageKey(firstCode))!)).toEqual({ code: firstCode, openedAt: secondTime });
  });

  it('reports denied storage access and denied list reads', () => {
    const denied = new DeviceSnippets(() => { throw new Error('SecurityError'); });
    expect(() => denied.list()).toThrow('Could not read snippets');
    expect(() => denied.remember(firstCode)).toThrow('Could not read snippets');
    expect(() => denied.remove(firstCode)).toThrow('Could not read snippets');
    const { storage } = fixture([[storageKey(firstCode), JSON.stringify({ code: firstCode, openedAt: firstTime })]]);
    storage.getItem.mockImplementation(() => { throw new Error('SecurityError'); });
    const history = new DeviceSnippets(() => storage);
    expect(() => history.list()).toThrow('Could not read snippets');
    storage.key.mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => history.list()).toThrow('Could not read snippets');
  });

  it('reports failed writes and removals while preserving the previous durable entries', () => {
    const { storage } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => history.remember(secondCode)).toThrow('Could not save the snippet');
    expect(() => history.remove(firstCode)).toThrow('Could not remove the snippet');
    expect(history.list()).toEqual([{ code: firstCode, openedAt: firstTime }]);
  });

  it('rejects malformed codes before touching storage and never stores page text or IDs', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    expect(() => history.remember('bad-code')).toThrow('32-character');
    expect(() => history.remove('bad-code')).toThrow('32-character');
    expect(storage.key).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    history.remember(firstCode);
    expect(JSON.parse(values.get(storageKey(firstCode))!)).toEqual({ code: firstCode, openedAt: firstTime });
  });

  it('does not let an older opening response overwrite a later removal, but allows an explicit fresh join', () => {
    const { storage } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    const beforeOpening = history.snapshot(firstCode);
    new DeviceSnippets(() => storage).remove(firstCode);
    expect(history.remember(firstCode, beforeOpening)).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    const beforeJoin = history.snapshot(firstCode);
    expect(history.remember(firstCode, beforeJoin)).toEqual([{ code: firstCode, openedAt: firstTime }]);
    expect(history.isRemoved(firstCode)).toBe(false);
  });

  it('keeps a same-code removal written between the opening guard check and row write', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    const beforeOpening = firstTab.snapshot(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      secondTab.remove(firstCode);
      values.set(key, saved);
    });
    expect(firstTab.remember(firstCode, beforeOpening)).toEqual([]);
    const marker = values.get(removalKey(firstCode));
    expect(marker).toBeDefined();
    expect(firstTab.isRemoved(firstCode)).toBe(true);
    expect(secondTab.list()).toEqual([]);

    storage.setItem.mockClear();
    expect(firstTab.remember(firstCode, firstTab.snapshot(firstCode))).toEqual([{ code: firstCode, openedAt: firstTime }]);
    const token: string = JSON.parse(marker!).token;
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([reopeningKey(firstCode, token)]);
    expect(values.get(removalKey(firstCode))).toBe(marker);
    expect(JSON.parse(values.get(reopeningKey(firstCode, token))!).removalToken).toBe(token);
    expect(new DeviceSnippets(() => storage).isRemoved(firstCode)).toBe(false);
  });

  it('requires a new acknowledgement for each later removal of a restored code', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    secondTab.remove(firstCode);
    firstTab.remember(firstCode, firstTab.snapshot(firstCode));
    const acknowledgedMarker = values.get(removalKey(firstCode));
    const beforeOpening = firstTab.snapshot(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      secondTab.remove(firstCode);
      values.set(key, saved);
    });
    expect(firstTab.remember(firstCode, beforeOpening)).toEqual([]);
    expect(values.get(removalKey(firstCode))).not.toBe(acknowledgedMarker);
    expect(firstTab.isRemoved(firstCode)).toBe(true);
    expect(firstTab.remember(firstCode)).toEqual([]);
    expect(firstTab.remember(firstCode, firstTab.snapshot(firstCode))).toEqual([{ code: firstCode, openedAt: firstTime }]);
  });

  it.each(['initial opening', 'earlier rejoin'])('keeps a successful fresh rejoin when a stale %s writes afterward', kind => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    if (kind === 'earlier rejoin') {
      firstTab.remove(firstCode);
      firstTab.remember(firstCode, firstTab.snapshot(firstCode));
    }
    const beforeOpening = firstTab.snapshot(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      secondTab.remove(firstCode);
      expect(secondTab.remember(firstCode, secondTab.snapshot(firstCode))).toEqual([{ code: firstCode, openedAt: secondTime }]);
      values.set(key, saved);
    });
    expect(firstTab.remember(firstCode, beforeOpening)).toEqual([{ code: firstCode, openedAt: secondTime }]);
    expect(firstTab.isRemoved(firstCode)).toBe(false);
    expect(secondTab.list()).toEqual([{ code: firstCode, openedAt: secondTime }]);
    const token: string = JSON.parse(values.get(removalKey(firstCode))!).token;
    expect(JSON.parse(values.get(reopeningKey(firstCode, token))!)).toEqual({ code: firstCode, openedAt: secondTime, removalToken: token });
  });

  it('rereads the selected opening if another tab changes its removal marker during a snapshot', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    firstTab.remember(firstCode);
    storage.getItem.mockImplementation(key => {
      const saved = values.get(key) ?? null;
      if (key === storageKey(firstCode)) {
        storage.getItem.mockImplementation(nextKey => values.get(nextKey) ?? null);
        secondTab.remove(firstCode);
        secondTab.remember(firstCode, secondTab.snapshot(firstCode));
      }
      return saved;
    });
    expect(firstTab.snapshot(firstCode)).toBe(secondTab.snapshot(firstCode));
    expect(firstTab.list()).toEqual([{ code: firstCode, openedAt: secondTime }]);
    expect(firstTab.isRemoved(firstCode)).toBe(false);
  });

  it('guards both opening rows and independent markers without rewriting stale data', () => {
    const { storage, values } = fixture();
    const firstTab = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const secondTab = new DeviceSnippets(() => storage, () => new Date(secondTime));
    expect(firstTab.snapshot(firstCode)).toBeNull();
    firstTab.remember(firstCode);
    const beforeReopening = firstTab.snapshot(firstCode);
    secondTab.remember(firstCode);
    expect(firstTab.snapshot(firstCode)).not.toBe(beforeReopening);
    const laterRow = values.get(storageKey(firstCode));
    storage.setItem.mockClear();
    expect(firstTab.remember(firstCode, beforeReopening)).toEqual([{ code: firstCode, openedAt: secondTime }]);
    expect(storage.setItem).not.toHaveBeenCalled();
    const beforeRemoval = firstTab.snapshot(firstCode);
    secondTab.remove(firstCode);
    expect(values.get(storageKey(firstCode))).toBe(laterRow);
    expect(firstTab.snapshot(firstCode)).not.toBe(beforeRemoval);
    storage.setItem.mockClear();
    expect(firstTab.remember(firstCode, beforeRemoval)).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('honors old inline removal markers until an explicit fresh join succeeds', () => {
    const inlineMarker = JSON.stringify({ code: firstCode, removed: true, token: 'older-removal', openedAt: firstTime });
    const { storage, values } = fixture([[storageKey(firstCode), inlineMarker]]);
    const history = new DeviceSnippets(() => storage, () => new Date(secondTime));
    expect(history.list()).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(history.remember(firstCode)).toEqual([]);
    expect(values.get(storageKey(firstCode))).toBe(inlineMarker);
    expect(history.remember(firstCode, history.snapshot(firstCode))).toEqual([{ code: firstCode, openedAt: secondTime }]);
    expect(history.isRemoved(firstCode)).toBe(false);
    expect(JSON.parse(values.get(storageKey(firstCode))!)).toEqual({ code: firstCode, openedAt: secondTime });
    expect(values.has(removalKey(firstCode))).toBe(false);
  });

  it('keeps a new independent removal when an old inline marker is being explicitly restored', () => {
    const { storage, values } = fixture([[storageKey(firstCode), JSON.stringify({ code: firstCode, removed: true })]]);
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    const beforeJoin = history.snapshot(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      new DeviceSnippets(() => storage).remove(firstCode);
      values.set(key, saved);
    });
    expect(history.remember(firstCode, beforeJoin)).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(history.remember(firstCode, history.snapshot(firstCode))).toEqual([{ code: firstCode, openedAt: firstTime }]);
    expect(history.isRemoved(firstCode)).toBe(false);
  });

  it('sanitizes malformed removal metadata without exposing it in returned rows', () => {
    const { storage } = fixture([
      [reopeningKey(firstCode, 'observed-removal'), JSON.stringify({ code: firstCode, openedAt: firstTime, removalToken: 'observed-removal', text: 'private' })],
      [removalKey(firstCode), JSON.stringify({ code: firstCode, removed: true, token: 'observed-removal' })],
      [storageKey(secondCode), JSON.stringify({ code: secondCode, openedAt: secondTime })],
      [removalKey(secondCode), JSON.stringify({ code: thirdCode, removed: true, token: 'wrong-code' })],
      [storageKey(thirdCode), JSON.stringify({ code: thirdCode, openedAt: thirdTime, removalToken: 123 })],
      [removalKey(thirdCode), '{broken'],
      [storageKey(fourthCode), JSON.stringify({ code: fourthCode, openedAt: firstTime })],
      [removalKey(fourthCode), JSON.stringify({ code: fourthCode, removed: true, token: '' })],
    ]);
    const history = new DeviceSnippets(() => storage);
    expect(history.list()).toEqual([
      { code: secondCode, openedAt: secondTime }, { code: firstCode, openedAt: firstTime }, { code: fourthCode, openedAt: firstTime },
    ]);
    expect(history.isRemoved(firstCode)).toBe(false);
    expect(history.isRemoved(secondCode)).toBe(false);
  });

  it('blocks writes if an opening cannot read its removal marker', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    const beforeOpening = history.snapshot(firstCode);
    const original = values.get(storageKey(firstCode));
    storage.getItem.mockImplementation(key => {
      if (key === removalKey(firstCode)) throw new Error('Denied');
      return values.get(key) ?? null;
    });
    storage.setItem.mockClear();
    expect(() => history.snapshot(firstCode)).toThrow('Could not read');
    expect(() => history.isRemoved(firstCode)).toThrow('Could not read');
    expect(() => history.remember(firstCode, beforeOpening)).toThrow('Could not read');
    expect(() => history.remove(firstCode)).toThrow('Could not read');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.get(storageKey(firstCode))).toBe(original);
    expect(values.has(removalKey(firstCode))).toBe(false);
  });

  it('does not falsely display a concurrently removed row when its committed opening cannot be read back', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    const beforeOpening = history.snapshot(firstCode);
    storage.setItem.mockImplementationOnce((key, saved) => {
      storage.setItem.mockImplementation((nextKey, nextSaved) => { values.set(nextKey, nextSaved); });
      new DeviceSnippets(() => storage).remove(firstCode);
      values.set(key, saved);
      storage.getItem.mockImplementationOnce(() => { throw new Error('Denied after write'); });
    });
    expect(history.remember(firstCode, beforeOpening)).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
    expect(history.list()).toEqual([]);
  });

  it('does not mutate entries when the initial read fails and treats a committed write as success if a later read fails', () => {
    const { storage, values } = fixture();
    const history = new DeviceSnippets(() => storage, () => new Date(firstTime));
    history.remember(firstCode);
    const original = values.get(storageKey(firstCode));
    storage.getItem.mockImplementationOnce(() => { throw new Error('Denied'); });
    expect(() => history.remove(firstCode)).toThrow('Could not read');
    expect(values.get(storageKey(firstCode))).toBe(original);
    storage.setItem.mockImplementationOnce((key, saved) => {
      values.set(key, saved);
      storage.getItem.mockImplementationOnce(() => { throw new Error('Denied after write'); });
    });
    expect(history.remove(firstCode)).toEqual([]);
    expect(history.isRemoved(firstCode)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../types';
import { MAX_MEMBERS, MAX_TRANSACTIONS } from './ledger';
import { STORE_KEY, downloadGroup, emptyStore, loadStore, mergeCloudStore, removeGroupFromDevice, restoreInvitation, saveStore, updateTravelMode } from './storage';

const now = '2026-10-08T09:00:00.000Z';

function makeGroup(id: string, currency = 'THB'): Group {
  return {
    id,
    name: `Trip ${id}`,
    description: 'Shared meals',
    currency,
    icon: 'trip',
    color: '#10b981',
    inviteCode: 'a'.repeat(32),
    createdAt: now,
    updatedAt: now,
    members: [{ id: `${id}-amy`, name: 'Amy' }, { id: `${id}-ben`, name: 'Ben' }],
    transactions: [{
      id: `${id}-dinner`, type: 'expense', description: 'Dinner', amount: 1_001,
      paidBy: `${id}-amy`, shares: { [`${id}-amy`]: 501, [`${id}-ben`]: 500 },
      category: 'food', date: '2026-10-08', createdAt: now,
    }],
  };
}

let entries: Map<string, string>;
let memoryStorage: Storage;

beforeEach(() => {
  entries = new Map();
  memoryStorage = {
    get length() { return entries.size; },
    clear: vi.fn(() => entries.clear()),
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    key: vi.fn((index: number) => [...entries.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => { entries.delete(key); }),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
  };
  vi.stubGlobal('localStorage', memoryStorage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('saved browser data', () => {
  it('returns a fresh empty store when no browser data exists', () => {
    expect(loadStore()).toEqual({ store: emptyStore() });
    const first = emptyStore();
    first.removedGroupIds.push('removed');
    expect(emptyStore().removedGroupIds).toEqual([]);
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('round-trips supported currencies, balances, pins, identity, and shared revisions', () => {
    const value = {
      ...emptyStore(),
      groups: [makeGroup('thailand', 'THB'), makeGroup('bangladesh', 'BDT'), makeGroup('america', 'USD'), makeGroup('canada', 'CAD'), makeGroup('europe', 'EUR'), makeGroup('britain', 'GBP')],
      pinnedIds: ['thailand', 'america'],
      memberByGroup: { thailand: 'thailand-amy', bangladesh: 'bangladesh-ben', america: 'america-amy' },
      cloudRevisions: { thailand: 7, bangladesh: 2, america: 1, canada: 1, europe: 1, britain: 1 },
    };
    saveStore(value);
    expect(loadStore()).toEqual({ store: value });
    expect(JSON.parse(entries.get(STORE_KEY)!)).toEqual(value);
  });

  it('returns the exact written fingerprint for saving or recovery without reading browser storage', () => {
    vi.mocked(memoryStorage.getItem).mockImplementation(() => { throw new DOMException('Read denied', 'SecurityError'); });
    const value = { ...emptyStore(), groups: [makeGroup('trip')], cloudRevisions: { trip: 1 } };
    const saved = saveStore(value);
    expect(saved).toBe(JSON.stringify(value));
    expect(entries.get(STORE_KEY)).toBe(saved);
    expect(memoryStorage.setItem).toHaveBeenLastCalledWith(STORE_KEY, saved);
    const reset = saveStore(emptyStore());
    expect(reset).toBe(JSON.stringify(emptyStore()));
    expect(entries.get(STORE_KEY)).toBe(reset);
    expect(memoryStorage.getItem).not.toHaveBeenCalled();
  });

  it('preserves malformed original data and requests recovery instead of replacing it', () => {
    const invalidValues = [
      '{unparseable',
      JSON.stringify({ ...emptyStore(), version: 999 }),
      JSON.stringify({ ...emptyStore(), groups: [makeGroup('trip'), makeGroup('trip')] }),
      JSON.stringify({ ...emptyStore(), groups: [{ ...makeGroup('trip'), currency: 'usd' }] }),
    ];
    for (const raw of invalidValues) {
      entries.set(STORE_KEY, raw);
      const loaded = loadStore();
      expect(loaded.store).toEqual(emptyStore());
      expect(loaded.error).toMatch(/kept in browser storage/);
      expect(entries.get(STORE_KEY)).toBe(raw);
    }
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('removes missing identities and dangling preferences while retaining valid shared groups', () => {
    const trip = makeGroup('trip');
    const other = makeGroup('other');
    saveStore({
      ...emptyStore(), groups: [trip, other],
      pinnedIds: ['trip', 'absent'],
      memberByGroup: { trip: 'missing-member', other: 'other-ben', absent: 'absent-person' },
      cloudRevisions: { trip: 4, other: 4, absent: 9 },
    });
    const loaded = loadStore();
    expect(loaded.error).toBeUndefined();
    expect(loaded.store.groups).toEqual([trip, other]);
    expect(loaded.store.pinnedIds).toEqual(['trip']);
    expect(loaded.store.memberByGroup).toEqual({ other: 'other-ben' });
    expect(loaded.store.cloudRevisions).toEqual({ trip: 4, other: 4 });
  });

  it('reads only the current cache namespace without importing earlier data', () => {
    const oldRaw = JSON.stringify({ version: 1, groups: [makeGroup('local')] });
    entries.set('iou:store:v1', oldRaw);
    expect(loadStore()).toEqual({ store: emptyStore() });
    expect(memoryStorage.getItem).toHaveBeenCalledWith(STORE_KEY);
    expect(memoryStorage.getItem).not.toHaveBeenCalledWith('iou:store:v1');
    expect(entries.get('iou:store:v1')).toBe(oldRaw);
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('requires current fields and a confirmed revision for every cached group', () => {
    const valid = { ...emptyStore(), groups: [makeGroup('trip')], cloudRevisions: { trip: 4 } };
    const { removedGroupIds: _removedGroupIds, ...incomplete } = valid;
    const invalid = [incomplete, { ...valid, pendingCloudIds: [] }, { ...valid, version: 1 },
      ...[undefined, 0, -1, '4', Number.MAX_SAFE_INTEGER + 1].map(revision => ({ ...valid, cloudRevisions: { trip: revision } }))];
    for (const value of invalid) {
      const raw = JSON.stringify(value);
      entries.set(STORE_KEY, raw);
      expect(loadStore().error).toMatch(/kept in browser storage/);
      expect(entries.get(STORE_KEY)).toBe(raw);
    }
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('surfaces write failures and leaves the previous saved data intact', () => {
    const previous = { ...emptyStore(), groups: [makeGroup('previous')], cloudRevisions: { previous: 1 } };
    saveStore(previous);
    const original = entries.get(STORE_KEY);
    vi.mocked(memoryStorage.setItem).mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => saveStore({ ...previous, pinnedIds: ['previous'] })).toThrow(/Could not save on this device/);
    expect(entries.get(STORE_KEY)).toBe(original);
    expect(loadStore()).toEqual({ store: previous });
  });

  it('rejects unexpected root fields without rewriting the cache', () => {
    const previous = { ...emptyStore(), groups: [makeGroup('trip')], pinnedIds: ['trip'], memberByGroup: { trip: 'trip-amy' }, cloudRevisions: { trip: 4 } };
    const raw = JSON.stringify({ ...previous, name: 'Extra field' });
    entries.set(STORE_KEY, raw);
    expect(loadStore().error).toMatch(/kept in browser storage/);
    expect(entries.get(STORE_KEY)).toBe(raw);
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('turns unavailable storage into a recovery result without attempting writes', () => {
    vi.mocked(memoryStorage.getItem).mockImplementationOnce(() => { throw new DOMException('Denied', 'SecurityError'); });
    const loaded = loadStore();
    expect(loaded.store).toEqual(emptyStore());
    expect(loaded.error).toBeDefined();
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });
});

describe('saved Travel mode preferences', () => {
  const sharedStore = () => ({ ...emptyStore(), groups: [makeGroup('trip'), makeGroup('other')], pinnedIds: ['trip'], memberByGroup: { trip: 'trip-amy' }, cloudRevisions: { trip: 4, other: 2 } });

  it('adds disabled Travel mode to the previous current cache without losing data or rewriting it', () => {
    const { travelMode: _travelMode, ...previous } = sharedStore();
    const raw = JSON.stringify(previous);
    entries.set(STORE_KEY, raw);
    expect(loadStore()).toEqual({ store: sharedStore() });
    expect(entries.get(STORE_KEY)).toBe(raw);
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });

  it('persists the default group and retains that choice when switched off', () => {
    const active = updateTravelMode(sharedStore(), { enabled: true, defaultGroupId: 'trip' });
    saveStore(active);
    expect(loadStore()).toEqual({ store: active });
    const disabled = updateTravelMode(active, { ...active.travelMode, enabled: false });
    saveStore(disabled);
    expect(loadStore().store.travelMode).toEqual({ enabled: false, defaultGroupId: 'trip' });
  });

  it('requires a default group on this device before enabling', () => {
    const original = sharedStore();
    expect(() => updateTravelMode(original, { enabled: true, defaultGroupId: null })).toThrow(/Choose a default group/);
    expect(() => updateTravelMode(original, { enabled: true, defaultGroupId: 'missing' })).toThrow(/no longer on this device/);
    expect(original).toEqual(sharedStore());
  });

  it('turns Travel mode off only when its default group is removed, and does not enable it on rejoin', () => {
    const active = updateTravelMode(sharedStore(), { enabled: true, defaultGroupId: 'trip' });
    expect(removeGroupFromDevice(active, 'other').travelMode).toEqual(active.travelMode);
    const removed = removeGroupFromDevice(active, 'trip');
    expect(removed.travelMode).toEqual(emptyStore().travelMode);
    saveStore(removed);
    expect(loadStore().store.travelMode).toEqual(emptyStore().travelMode);
    expect(mergeCloudStore(removed, [{ group: active.groups[0], revision: 5 }], 'trip').travelMode).toEqual(emptyStore().travelMode);
  });

  it('clears a stale default during loading and honors another tab changing the setting during refresh', () => {
    saveStore({ ...sharedStore(), travelMode: { enabled: true, defaultGroupId: 'missing' } });
    expect(loadStore().store.travelMode).toEqual(emptyStore().travelMode);
    const base = updateTravelMode(sharedStore(), { enabled: true, defaultGroupId: 'trip' });
    const next = mergeCloudStore(base, [{ group: { ...base.groups[0], name: 'Updated trip' }, revision: 5 }]);
    const external = updateTravelMode(base, { enabled: true, defaultGroupId: 'other' });
    const merged = mergeCloudStore(external, [{ group: next.groups[0], revision: 5 }]);
    expect(merged.travelMode).toEqual(external.travelMode);
    expect(merged.groups[0].name).toBe('Updated trip');
    expect(mergeCloudStore(removeGroupFromDevice(external, 'other'), [{ group: next.groups[0], revision: 5 }]).travelMode).toEqual(emptyStore().travelMode);
  });

  it('preserves the previous preference when saving fails', () => {
    const original = sharedStore();
    saveStore(original);
    vi.mocked(memoryStorage.setItem).mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => saveStore(updateTravelMode(original, { enabled: true, defaultGroupId: 'trip' }))).toThrow(/Could not save/);
    expect(loadStore()).toEqual({ store: original });
  });

  it('preserves the original cache when Travel mode settings are malformed', () => {
    for (const travelMode of [null, [], { enabled: 'true', defaultGroupId: 'trip' }, { enabled: true, defaultGroupId: 3 }, { enabled: false }, { enabled: false, defaultGroupId: null, extra: true }]) {
      const raw = JSON.stringify({ ...sharedStore(), travelMode });
      entries.set(STORE_KEY, raw);
      expect(loadStore().error).toMatch(/kept in browser storage/);
      expect(entries.get(STORE_KEY)).toBe(raw);
    }
  });
});

describe('removing groups from this device', () => {
  function sharedStore() {
    return {
      ...emptyStore(), groups: [makeGroup('trip'), makeGroup('other')],
      pinnedIds: ['trip', 'other'], memberByGroup: { trip: 'trip-amy', other: 'other-ben' },
      cloudRevisions: { trip: 4, other: 2 },
    };
  }

  it('removes only the chosen cache and personal settings, preserving the original shared group', () => {
    const original = sharedStore();
    const snapshot = structuredClone(original);
    const removed = removeGroupFromDevice(original, 'trip');
    expect(removed.groups).toEqual([original.groups[1]]);
    expect(removed.pinnedIds).toEqual(['other']);
    expect(removed.memberByGroup).toEqual({ other: 'other-ben' });
    expect(removed.cloudRevisions).toEqual({ other: 2 });
    expect(removed.removedGroupIds).toEqual(['trip']);
    expect(original).toEqual(snapshot);
    saveStore(removed);
    expect(loadStore()).toEqual({ store: removed });
  });

  it('keeps removed groups out after automatic refresh, reload, and newer remote revisions', () => {
    const original = sharedStore();
    const removed = removeGroupFromDevice(original, 'trip');
    const records = [{ group: { ...original.groups[0]!, name: 'Updated trip' }, revision: 5 }];
    const refreshed = mergeCloudStore(removed, records);
    expect(refreshed).toEqual(removed);
    saveStore(refreshed);
    expect(mergeCloudStore(loadStore().store, records)).toEqual(removed);
  });

  it('restores only the explicitly rejoined group with its latest data', () => {
    const original = sharedStore();
    const removed = removeGroupFromDevice(removeGroupFromDevice(original, 'trip'), 'other');
    const records = original.groups.map(group => ({ group, revision: 5 }));
    const restored = mergeCloudStore(removed, records, 'trip');
    expect(restored.groups).toEqual([original.groups[0]]);
    expect(restored.removedGroupIds).toEqual(['other']);
    expect(restored.cloudRevisions).toEqual({ trip: 5 });
    expect(restored.memberByGroup).toEqual({});
    expect(restored.pinnedIds).toEqual([]);
    saveStore(restored);
    expect(loadStore().store).toEqual(restored);
    expect(mergeCloudStore(removed, [], 'trip')).toEqual(removed);
  });

  it('honors another tab removing a group while an online refresh or save was in flight', () => {
    const base = sharedStore();
    const external = removeGroupFromDevice(base, 'trip');
    const next = mergeCloudStore(base, [{ group: { ...base.groups[0]!, name: 'New remote name' }, revision: 6 }]);
    expect(mergeCloudStore(external, [{ group: next.groups[0], revision: next.cloudRevisions.trip }])).toEqual(external);
    expect(mergeCloudStore(external, [{ group: base.groups[0]!, revision: 7 }])).toEqual(external);
  });

  it('retains newer cached revisions and clears invalid identities only after accepting a newer record', () => {
    const original = sharedStore();
    const outdated = { ...original.groups[0]!, members: [{ id: 'new-person', name: 'New person' }], transactions: [] };
    expect(mergeCloudStore(original, [{ group: outdated, revision: 3 }])).toEqual(original);
    const updated = mergeCloudStore(original, [{ group: outdated, revision: 5 }]);
    expect(updated.groups[0]).toEqual(outdated);
    expect(updated.cloudRevisions).toEqual({ trip: 5, other: 2 });
    expect(updated.memberByGroup).toEqual({ other: 'other-ben' });
  });

  it('keeps another tab’s newer groups, identity, and pins during ordinary online reconciliation', () => {
    const base = sharedStore();
    const next = mergeCloudStore(base, [{ group: { ...base.groups[0]!, name: 'Revision five' }, revision: 5 }]);
    const external = { ...sharedStore(), groups: [{ ...base.groups[0]!, name: 'Revision six' }, base.groups[1]!, makeGroup('additional')], pinnedIds: ['other'], memberByGroup: { trip: 'trip-ben', other: 'other-ben' }, cloudRevisions: { trip: 6, other: 2, additional: 1 } };
    expect(mergeCloudStore(external, [{ group: next.groups[0], revision: next.cloudRevisions.trip }])).toEqual(external);
  });

  it('merges an explicit rejoin without undoing another tab’s unrelated removal or pin changes', () => {
    const original = sharedStore();
    const base = removeGroupFromDevice(original, 'trip');
    const external = removeGroupFromDevice(base, 'other');
    const merged = mergeCloudStore(external, [{ group: original.groups[0]!, revision: 6 }], 'trip');
    merged.memberByGroup.trip = 'trip-amy';
    expect(merged.groups).toEqual([original.groups[0]]);
    expect(merged.removedGroupIds).toEqual(['other']);
    expect(merged.memberByGroup).toEqual({ trip: 'trip-amy' });
    expect(merged.pinnedIds).toEqual([]);
    expect(merged.cloudRevisions).toEqual({ trip: 6 });
  });

  it('rejects a missing group without changing cached data', () => {
    const original = sharedStore();
    const snapshot = structuredClone(original);
    expect(() => removeGroupFromDevice(original, 'missing')).toThrow(/could not be found/);
    expect(original).toEqual(snapshot);
  });

  it('keeps the previous cache when a removal cannot be saved', () => {
    const original = sharedStore();
    saveStore(original);
    const fingerprint = entries.get(STORE_KEY);
    vi.mocked(memoryStorage.setItem).mockImplementationOnce(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => saveStore(removeGroupFromDevice(original, 'trip'))).toThrow(/Could not save/);
    expect(entries.get(STORE_KEY)).toBe(fingerprint);
    expect(loadStore().store).toEqual(original);
  });

  it('honors saved removal markers even if a stale cache still contains the group', () => {
    const stale = { ...sharedStore(), removedGroupIds: ['trip', 'trip'] };
    entries.set(STORE_KEY, JSON.stringify(stale));
    expect(loadStore().store).toEqual({ ...removeGroupFromDevice(sharedStore(), 'trip'), removalEpochs: {} });
  });

  it('preserves invalid removal records for recovery instead of silently rediscovering groups', () => {
    for (const removedGroupIds of [null, 'trip', [5], ['__proto__'], ['bad id']]) {
      const raw = JSON.stringify({ ...sharedStore(), removedGroupIds });
      entries.set(STORE_KEY, raw);
      expect(loadStore().error).toMatch(/kept in browser storage/);
      expect(entries.get(STORE_KEY)).toBe(raw);
    }
    expect(memoryStorage.setItem).not.toHaveBeenCalled();
  });
});

describe('group CSV download', () => {
  it('downloads a complete CSV above 5 MB with the full supported member and transaction counts', async () => {
    vi.useFakeTimers();
    const members = Array.from({ length: MAX_MEMBERS }, (_, index) => ({ id: `member-${String(index).padStart(3, '0')}`, name: `Member ${index}` }));
    const shares = Object.fromEntries(members.map(({ id }) => [id, 10_000]));
    const original: Group = {
      ...makeGroup('full-backup'), members,
      transactions: Array.from({ length: MAX_TRANSACTIONS }, (_, index) => ({
        id: `expense-${index}`, type: 'expense', description: '🍜'.repeat(80), amount: 1_000_000,
        paidBy: members[index % members.length]!.id, shares, category: 'food', date: '2026-10-08', createdAt: now,
      })),
    };
    let downloaded: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { downloaded = blob as Blob; return 'blob:group-backup'; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchor = { href: '', download: '', click: vi.fn() };
    const createElement = vi.fn(() => anchor);
    vi.stubGlobal('document', { createElement });
    downloadGroup(original);
    expect(createElement).toHaveBeenCalledWith('a');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.download).toBe('trip-full-backup.csv');
    expect(anchor.href).toBe('blob:group-backup');
    expect(downloaded!.type).toBe('text/csv;charset=utf-8');
    const file = new File([downloaded!], anchor.download, { type: 'text/csv' });
    expect(file.size).toBeGreaterThan(5_000_000);
    expect(await file.text()).toMatch(/^record,version,id,name,description,currency/);
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith('blob:group-backup');
  });

});


describe('invitation removal ordering', () => {
  it('rejects a response begun before removal, including remove/rejoin/remove cycles', () => {
    const original = { ...emptyStore(), groups: [makeGroup('trip')], cloudRevisions: { trip: 1 } };
    const record = { group: makeGroup('trip'), revision: 1 };
    const removed = removeGroupFromDevice(original, 'trip');
    expect(() => restoreInvitation(removed, record, original)).toThrow('removed while opening');
    const rejoined = restoreInvitation(removed, record, removed);
    expect(rejoined.groups).toHaveLength(1);
    const removedAgain = removeGroupFromDevice(rejoined, 'trip');
    expect(() => restoreInvitation(removedAgain, record, removed)).toThrow('removed while opening');
    saveStore(removedAgain);
    expect(loadStore().store.removalEpochs).toEqual(removedAgain.removalEpochs);
  });
  it('loads previous stores without removal history and preserves corrupt history for recovery', () => {
    const previous = emptyStore(); delete previous.removalEpochs;
    entries.set(STORE_KEY, JSON.stringify(previous));
    expect(loadStore().store.removalEpochs).toEqual({});
    for (const history of [null, [], { trip: 'invalid' }]) {
      const raw = JSON.stringify({ ...previous, removalEpochs: history });
      entries.set(STORE_KEY, raw);
      expect(loadStore().error).toContain('kept');
      expect(entries.get(STORE_KEY)).toBe(raw);
    }
  });
});

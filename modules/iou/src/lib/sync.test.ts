import { describe, expect, it, vi } from 'vitest'
import { CloudConflictError, type CloudRecord } from './cloud'
import { queueGroup, queueJoin } from './offline'
import { emptyStore, removeGroupFromDevice, type AppStore } from './storage'
import { syncOffline, type SyncDevice, type SyncTransport } from './sync'
import type { Expense, Group } from '../types'

const time = (n: number) => `2026-10-08T09:${String(n).padStart(2, '0')}:00.000Z`
const group = (): Group => ({ id: 'trip', name: 'Trip', description: '', currency: 'THB', icon: 'trip', color: '#10b981', inviteCode: 'a'.repeat(32), createdAt: time(0), updatedAt: time(0), members: [{ id: 'amy', name: 'Amy' }, { id: 'ben', name: 'Ben' }], transactions: [] })
const expense = (id: string): Expense => ({ id, type: 'expense', description: id, amount: 1000, paidBy: 'amy', shares: { amy: 500, ben: 500 }, category: 'food', date: '2026-10-08', createdAt: time(1) })
function fixture(initial: AppStore, record?: CloudRecord) {
  let store = initial
  let server = record
  let online = true
  const device: SyncDevice = { read: () => store, update: change => { store = change(store) }, online: () => online }
  const cloud: SyncTransport = {
    load: vi.fn(async () => server ? [structuredClone(server)] : []),
    create: vi.fn(async payload => {
      server ??= { group: { ...structuredClone(payload), inviteCode: 'b'.repeat(32) }, revision: 1 }
      return structuredClone(server)
    }),
    save: vi.fn(async (payload, revision) => {
      if (revision !== server?.revision) throw new CloudConflictError()
      server = { group: structuredClone(payload), revision: revision + 1 }
      return structuredClone(server)
    }),
    join: vi.fn(async () => { if (!server) throw new Error('Missing invitation'); return structuredClone(server) }),
  }
  return { device, cloud, store: () => store, server: () => server, setServer: (record: CloudRecord) => { server = record }, setOnline: (value: boolean) => { online = value } }
}

describe('automatic offline sync', () => {
  it('makes no network calls offline, then creates a group and uploads its entire ledger once', async () => {
    const draft = { ...group(), updatedAt: time(1), transactions: [expense('dinner'), { id: 'payment', type: 'payment' as const, fromId: 'ben', toId: 'amy', amount: 500, note: '', date: '2026-10-08', createdAt: time(1) }] }
    const f = fixture(queueGroup(emptyStore(), draft, 'amy'))
    f.setOnline(false)
    await syncOffline(f.device, f.cloud)
    expect(f.cloud.load).not.toHaveBeenCalled()
    expect(f.store().outbox).toHaveLength(1)
    f.setOnline(true)
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.transactions).toEqual(draft.transactions)
    expect(f.store().groups[0].inviteCode).toBe('b'.repeat(32))
    expect(f.store().outbox).toEqual([])
    await syncOffline(f.device, f.cloud)
    expect(f.cloud.create).toHaveBeenCalledTimes(1)
  })

  it('retries a lost upload response without duplicate transactions', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, transactions: [expense('dinner')], updatedAt: time(1) }), { group: base, revision: 1 })
    const save = f.cloud.save
    f.cloud.save = vi.fn(async (payload, revision) => { await save(payload, revision); throw new Error('Response lost') })
    await expect(syncOffline(f.device, f.cloud)).rejects.toThrow('Response lost')
    expect(f.store().outbox).toHaveLength(1)
    f.cloud.save = save
    await syncOffline(f.device, f.cloud)
    expect(f.store().outbox).toEqual([])
    expect(f.server()?.group.transactions.map(t => t.id)).toEqual(['dinner'])
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost creation response while preserving a subsequent offline rename', async () => {
    const f = fixture(queueGroup(emptyStore(), group(), 'amy'))
    const create = f.cloud.create
    f.cloud.create = vi.fn(async payload => { await create(payload); throw new Error('Response lost') })
    await expect(syncOffline(f.device, f.cloud)).rejects.toThrow('Response lost')
    f.device.update(store => queueGroup(store, { ...store.groups[0], name: 'Later name', updatedAt: time(2) }))
    f.cloud.create = create
    await syncOffline(f.device, f.cloud)
    expect(create).toHaveBeenCalledTimes(1)
    expect(f.server()?.group.name).toBe('Later name')
    expect(f.store().outbox).toEqual([])
  })

  it('refreshes a revision conflict, keeps independent additions, and uses the latest conflicting edit', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, name: 'Offline name', updatedAt: time(2), transactions: [expense('ours')] }), { group: base, revision: 1 })
    const save = f.cloud.save
    f.cloud.save = vi.fn(async (payload, revision) => {
      if (revision === 1) f.setServer({ group: { ...base, name: 'Latest name', transactions: [expense('theirs')], updatedAt: time(3) }, revision: 2 })
      return save(payload, revision)
    })
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.name).toBe('Latest name')
    expect(f.server()?.group.transactions.map(t => t.id)).toEqual(['theirs', 'ours'])
    expect(f.store().outbox).toEqual([])
  })

  it('saves edits from another tab during an upload, keeping its pin and Travel mode preference', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, updatedAt: time(1), transactions: [expense('first')] }), { group: base, revision: 1 })
    const save = f.cloud.save
    f.cloud.save = vi.fn(async (payload, revision) => {
      if (revision === 1) f.device.update(store => ({ ...queueGroup(store, { ...store.groups[0], updatedAt: time(2), transactions: [...store.groups[0].transactions, expense('second')] }), pinnedIds: ['trip'], travelMode: { enabled: true, defaultGroupId: 'trip' } }))
      return save(payload, revision)
    })
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.transactions).toHaveLength(2)
    expect(f.store().pinnedIds).toEqual(['trip'])
    expect(f.store().travelMode.enabled).toBe(true)
    expect(f.store().outbox).toEqual([])
  })

  it('keeps changes queued on a storage failure after a successful server write', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, updatedAt: time(1), transactions: [expense('dinner')] }), { group: base, revision: 1 })
    const update = f.device.update
    f.device.update = change => { if (f.server()?.revision === 2) throw new Error('Storage full'); update(change) }
    await expect(syncOffline(f.device, f.cloud)).rejects.toThrow('Storage full')
    expect(f.store().outbox).toHaveLength(1)
    f.device.update = update
    await syncOffline(f.device, f.cloud)
    expect(f.store().outbox).toEqual([])
    expect(f.server()?.group.transactions).toHaveLength(1)
  })

  it('finishes a saved invitation using an existing name, avoiding duplicate members on retry', async () => {
    const request = { code: 'a'.repeat(32), name: 'Amy', memberId: 'new-id', createdAt: time(2) }
    const f = fixture(queueJoin(emptyStore(), request), { group: group(), revision: 1 })
    await syncOffline(f.device, f.cloud)
    expect(f.store().memberByGroup.trip).toBe('amy')
    expect(f.store().pendingJoins).toEqual([])
    expect(f.store().groups[0].members).toHaveLength(2)
  })

  it('adds a new offline member and keeps removed groups hidden after their pending edits sync', async () => {
    const f = fixture(queueJoin(emptyStore(), { code: 'a'.repeat(32), name: 'Cal', memberId: 'cal', createdAt: time(2) }), { group: group(), revision: 1 })
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.members).toContainEqual({ id: 'cal', name: 'Cal' })
    f.device.update(store => removeGroupFromDevice(queueGroup(store, { ...store.groups[0], name: 'Final name', updatedAt: time(3) }), 'trip'))
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.name).toBe('Final name')
    expect(f.store().groups).toEqual([])
    expect(f.store().outbox).toEqual([])
  })

  it('retains pending edits when disconnected mid-sync, then resumes', async () => {
    const f = fixture(queueGroup(emptyStore(), group()))
    f.cloud.load = vi.fn(async () => { f.setOnline(false); return [] })
    await syncOffline(f.device, f.cloud)
    expect(f.cloud.create).not.toHaveBeenCalled()
    expect(f.store().outbox).toHaveLength(1)
    f.setOnline(true)
    f.cloud.load = vi.fn(async () => [])
    await syncOffline(f.device, f.cloud)
    expect(f.store().outbox).toEqual([])
  })

  it('does not resurrect a group removed by another tab during its upload', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, name: 'Offline rename', updatedAt: time(1) }), { group: base, revision: 1 })
    const save = f.cloud.save
    f.cloud.save = async (payload, revision) => {
      f.device.update(store => removeGroupFromDevice(store, 'trip'))
      return save(payload, revision)
    }
    await syncOffline(f.device, f.cloud)
    expect(f.server()?.group.name).toBe('Offline rename')
    expect(f.store().groups).toEqual([])
    expect(f.store().removedGroupIds).toEqual(['trip'])
    expect(f.store().outbox).toEqual([])
  })

  it('bounds repeated revision conflicts and retains the queue for the next automatic attempt', async () => {
    const base = group()
    const f = fixture(queueGroup({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { ...base, name: 'Offline rename', updatedAt: time(1) }), { group: base, revision: 1 })
    f.cloud.save = vi.fn(async () => { throw new CloudConflictError() })
    await expect(syncOffline(f.device, f.cloud)).rejects.toThrow(/retry automatically/)
    expect(f.cloud.save).toHaveBeenCalledTimes(3)
    expect(f.store().outbox[0].group.name).toBe('Offline rename')
  })

  it('does not let a failed invitation block other pending group changes', async () => {
    const store = queueJoin(queueGroup(emptyStore(), group()), { code: 'd'.repeat(32), name: 'Cal', memberId: 'cal', createdAt: time(1) })
    const f = fixture(store)
    await expect(syncOffline(f.device, f.cloud)).rejects.toThrow('Missing invitation')
    expect(f.server()?.group.name).toBe('Trip')
    expect(f.store().outbox).toEqual([])
    expect(f.store().pendingJoins).toEqual(store.pendingJoins)
  })
})


describe('late invitation responses', () => {
  it('does not restore a group removed while its queued join was in flight', async () => {
    const base = group();
    const initial = queueJoin({ ...emptyStore(), groups: [base], cloudRevisions: { trip: 1 } }, { code: base.inviteCode, name: 'Amy', memberId: 'amy', createdAt: time(1) });
    const f = fixture(initial, { group: base, revision: 1 });
    f.cloud.join = vi.fn(async () => {
      f.device.update(store => removeGroupFromDevice(store, 'trip'));
      return { group: base, revision: 1 };
    });
    await syncOffline(f.device, f.cloud);
    expect(f.store().groups).toEqual([]);
    expect(f.store().removedGroupIds).toEqual(['trip']);
    expect(f.store().pendingJoins).toEqual([]);
    f.device.update(store => queueJoin(store, { code: base.inviteCode, name: 'Amy', memberId: 'amy', createdAt: time(2) }));
    f.cloud.join = vi.fn(async () => ({ group: base, revision: 1 }));
    await syncOffline(f.device, f.cloud);
    expect(f.store().groups.map(item => item.id)).toEqual(['trip']);
    expect(f.store().removedGroupIds).toEqual([]);
  });
  it('does not accept a replaced request with identical name and membership', async () => {
    const base = group();
    const f = fixture(queueJoin(emptyStore(), { code: base.inviteCode, name: 'Amy', memberId: 'amy', createdAt: time(1) }), { group: base, revision: 1 });
    f.cloud.load = vi.fn(async () => []);
    f.cloud.join = vi.fn(async () => {
      f.device.update(store => queueJoin(store, { code: base.inviteCode, name: 'Amy', memberId: 'amy', createdAt: time(2) }));
      return { group: base, revision: 1 };
    });
    await syncOffline(f.device, f.cloud);
    expect(f.store().groups).toEqual([]);
    expect(f.store().pendingJoins[0].createdAt).toBe(time(2));
  });
});

import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Group, Expense } from '../types'
import { acknowledgeGroup, mergeLatestGroup, queueGroup, queueJoin } from './offline'
import { emptyStore, loadStore, mergeCloudStore, removeGroupFromDevice, saveStore, STORE_KEY } from './storage'

const time = (minute: number) => `2026-10-08T09:${String(minute).padStart(2, '0')}:00.000Z`
const group = (): Group => ({ id: 'trip', name: 'Trip', description: '', currency: 'THB', icon: 'trip', color: '#10b981', inviteCode: 'a'.repeat(32), createdAt: time(0), updatedAt: time(0), members: [{ id: 'amy', name: 'Amy' }, { id: 'ben', name: 'Ben' }], transactions: [] })
const expense = (id: string): Expense => ({ id, type: 'expense', description: 'Dinner', amount: 1000, paidBy: 'amy', shares: { amy: 500, ben: 500 }, category: 'food', date: '2026-10-08', createdAt: time(1) })
const cached = () => ({ ...emptyStore(), groups: [group()], cloudRevisions: { trip: 1 } })
afterEach(() => vi.unstubAllGlobals())

describe('durable offline changes', () => {
  it('reopens a new offline group with expenses and payments, preserving the first sync base', () => {
    let raw: string | null = null
    vi.stubGlobal('localStorage', { getItem: () => raw, setItem: (_: string, value: string) => { raw = value } })
    let store = queueGroup(emptyStore(), group(), 'amy')
    store = queueGroup(store, { ...group(), updatedAt: time(2), transactions: [expense('dinner'), { id: 'payment', type: 'payment', fromId: 'ben', toId: 'amy', amount: 500, note: '', date: '2026-10-08', createdAt: time(2) }] })
    saveStore(store)
    expect(loadStore()).toEqual({ store })
    expect(store.cloudRevisions.trip).toBe(0)
    expect(store.outbox[0].base).toBeNull()
    expect(store.memberByGroup.trip).toBe('amy')
  })

  it('preserves the existing current cache when adding offline fields', () => {
    const { outbox: _outbox, pendingJoins: _joins, ...previous } = cached()
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(previous) })
    expect(loadStore().store).toEqual(cached())
  })

  it('keeps independent transactions and applies the newest conflicting edit automatically', () => {
    const base = { ...group(), transactions: [expense('same')] }
    const local = { ...base, name: 'Our trip', updatedAt: time(2), transactions: [{ ...expense('same'), amount: 2000, shares: { amy: 1000, ben: 1000 } }, expense('ours')] }
    const remote = { ...base, description: 'Their description', updatedAt: time(3), transactions: [{ ...expense('same'), description: 'Latest dinner' }, expense('theirs')] }
    const merged = mergeLatestGroup(base, local, remote)
    expect(merged.name).toBe('Our trip')
    expect(merged.description).toBe('Their description')
    expect(merged.transactions.find(t => t.id === 'same')).toEqual(remote.transactions[0])
    expect(merged.transactions.map(t => t.id)).toEqual(['same', 'theirs', 'ours'])
    expect(mergeLatestGroup(base, { ...local, updatedAt: time(4) }, remote).transactions[0]).toEqual(local.transactions[0])
  })

  it('merges deletion and later edits by time without restoring deleted transactions', () => {
    const base = { ...group(), transactions: [expense('dinner')] }
    const deleted = { ...base, updatedAt: time(3), transactions: [] }
    const edited = { ...base, updatedAt: time(2), transactions: [{ ...expense('dinner'), description: 'Edited' }] }
    expect(mergeLatestGroup(base, deleted, edited).transactions).toEqual([])
    expect(mergeLatestGroup(base, { ...deleted, updatedAt: time(1) }, edited).transactions).toEqual(edited.transactions)
  })

  it('keeps members referenced by an independently added transaction', () => {
    const base = group()
    const local = { ...base, members: [base.members[0]], updatedAt: time(3) }
    const remote = { ...base, transactions: [expense('dinner')], updatedAt: time(2) }
    expect(mergeLatestGroup(base, local, remote).members).toContainEqual(base.members[1])
  })

  it('protects pending edits from a cloud refresh and remembers the refreshed revision', () => {
    const queued = queueGroup(cached(), { ...group(), name: 'Offline name', updatedAt: time(2) })
    const refreshed = mergeCloudStore(queued, [{ group: { ...group(), description: 'Online detail', updatedAt: time(3) }, revision: 2 }])
    expect(refreshed.groups[0]).toMatchObject({ name: 'Offline name', description: 'Online detail' })
    expect(refreshed.outbox[0].revision).toBe(2)
    expect(refreshed.outbox[0].base?.description).toBe('Online detail')
  })

  it('does not drop a second edit made during the first upload', () => {
    const queued = queueGroup(cached(), { ...group(), transactions: [expense('first')], updatedAt: time(1) })
    const sent = queued.outbox[0]
    const later = queueGroup(queued, { ...sent.group, transactions: [...sent.group.transactions, expense('second')], updatedAt: time(2) })
    const confirmed = acknowledgeGroup(later, sent, { group: sent.group, revision: 2 })
    expect(confirmed.groups[0].transactions).toHaveLength(2)
    expect(confirmed.outbox[0].revision).toBe(2)
    expect(confirmed.outbox[0].base?.transactions).toHaveLength(1)
    expect(acknowledgeGroup(confirmed, confirmed.outbox[0], { group: confirmed.groups[0], revision: 3 }).outbox).toEqual([])
  })

  it('updates a new group’s server invitation without losing later offline edits', () => {
    const created = queueGroup(emptyStore(), group())
    const later = queueGroup(created, { ...group(), name: 'Renamed', updatedAt: time(2) })
    const ack = acknowledgeGroup(later, created.outbox[0], { group: { ...group(), inviteCode: 'b'.repeat(32) }, revision: 1 })
    expect(ack.groups[0]).toMatchObject({ name: 'Renamed', inviteCode: 'b'.repeat(32) })
    expect(ack.outbox[0].base?.inviteCode).toBe('b'.repeat(32))
  })

  it('uploads pending edits for a removed group without returning it to device lists', () => {
    const queued = queueGroup(cached(), { ...group(), name: 'Changed offline', updatedAt: time(1) })
    const hidden = removeGroupFromDevice(queued, 'trip')
    saveToMemory(hidden)
    expect(loadStore().store.outbox).toEqual(queued.outbox)
    const ack = acknowledgeGroup(hidden, queued.outbox[0], { group: queued.groups[0], revision: 2 })
    expect(ack.groups).toEqual([])
    expect(ack.outbox).toEqual([])
    expect(mergeCloudStore(ack, [{ group: queued.groups[0], revision: 2 }]).groups).toEqual([])
  })

  it('preserves the previous durable queue when the next device write fails', () => {
    const previous = queueGroup(cached(), { ...group(), name: 'Saved', updatedAt: time(1) })
    const original = saveToMemory(previous)
    vi.stubGlobal('localStorage', { getItem: () => original, setItem: () => { throw new Error('Full') } })
    expect(() => saveStore(queueGroup(previous, { ...group(), name: 'Unsaved', updatedAt: time(2) }))).toThrow(/Could not save/)
    expect(loadStore().store).toEqual(previous)
  })

  it('persists a join request once and rejects malformed queues without rewriting them', () => {
    const queued = queueJoin(emptyStore(), { code: 'c'.repeat(32), name: 'Amy', memberId: 'amy', createdAt: time(0) })
    saveToMemory(queued)
    expect(loadStore().store).toEqual(queued)
    expect(queueJoin(queued, queued.pendingJoins[0]).pendingJoins).toHaveLength(1)
    for (const invalid of [{ ...queued, pendingJoins: null }, { ...queued, outbox: [{ group: group(), base: null, revision: 2 }] }, { ...cached(), cloudRevisions: { trip: 0 } }]) {
      const raw = JSON.stringify(invalid)
      vi.stubGlobal('localStorage', { getItem: () => raw, setItem: vi.fn() })
      expect(loadStore().error).toMatch(/kept in browser storage/)
      expect(localStorage.setItem).not.toHaveBeenCalled()
    }
  })
})

function saveToMemory(store: ReturnType<typeof emptyStore>): string {
  let raw = ''
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === STORE_KEY ? raw : null, setItem: (_: string, value: string) => { raw = value } })
  saveStore(store)
  return raw
}

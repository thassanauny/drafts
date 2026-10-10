import type { Group, Member, Transaction } from '../types'
import type { AppStore } from './storage'
import { validateGroup } from './ledger'

export interface PendingGroup {
  base: Group | null
  group: Group
  revision: number
}

export interface PendingJoin {
  code: string
  name: string
  memberId: string
  createdAt: string
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Keep independent edits. When the same value changes, the latest edit wins. */
export function mergeLatestGroup(base: Group, local: Group, remote: Group): Group {
  const localWins = Date.parse(local.updatedAt) > Date.parse(remote.updatedAt)
  function choose<T>(original: T, ours: T, theirs: T): T {
    if (same(ours, original)) return theirs
    if (same(theirs, original) || same(ours, theirs)) return ours
    return localWins ? ours : theirs
  }
  function entries<T extends { id: string }>(original: T[], ours: T[], theirs: T[]): T[] {
    const before = new Map(original.map(item => [item.id, item]))
    const left = new Map(ours.map(item => [item.id, item]))
    const right = new Map(theirs.map(item => [item.id, item]))
    return [...new Set([...right.keys(), ...left.keys()])].flatMap(id => {
      const item = choose(before.get(id), left.get(id), right.get(id))
      return item ? [item] : []
    })
  }
  const members = entries<Member>(base.members, local.members, remote.members)
  const transactions = entries<Transaction>(base.transactions, local.transactions, remote.transactions)
  // A simultaneous member removal must not orphan another person's new transaction.
  const referenced = new Set(transactions.flatMap(t => t.type === 'expense' ? [t.paidBy, ...Object.keys(t.shares)] : [t.fromId, t.toId]))
  for (const id of referenced) {
    if (!members.some(member => member.id === id)) {
      const member = (localWins ? [...local.members, ...remote.members] : [...remote.members, ...local.members]).find(member => member.id === id)
      if (member) members.push(member)
    }
  }
  return validateGroup({
    ...remote,
    name: choose(base.name, local.name, remote.name),
    description: choose(base.description, local.description, remote.description),
    icon: choose(base.icon, local.icon, remote.icon),
    color: choose(base.color, local.color, remote.color),
    members, transactions,
    updatedAt: localWins ? local.updatedAt : remote.updatedAt,
  })
}

export function queueGroup(store: AppStore, input: Group, identity?: string): AppStore {
  const group = validateGroup(input)
  const previous = store.groups.find(g => g.id === group.id)
  if (previous && (group.currency !== previous.currency || group.inviteCode !== previous.inviteCode || group.createdAt !== previous.createdAt)) throw new Error('The group’s currency and invitation are fixed.')
  const pending = store.outbox.find(item => item.group.id === group.id)
  const entry: PendingGroup = { base: pending ? pending.base : previous ?? null, revision: pending?.revision ?? store.cloudRevisions[group.id] ?? 0, group }
  return {
    ...store,
    groups: previous ? store.groups.map(g => g.id === group.id ? group : g) : [...store.groups, group],
    cloudRevisions: { ...store.cloudRevisions, [group.id]: entry.revision },
    outbox: [...store.outbox.filter(item => item.group.id !== group.id), entry],
    memberByGroup: identity ? { ...store.memberByGroup, [group.id]: identity } : store.memberByGroup,
  }
}

export function rebasePending(pending: PendingGroup, remote: Group, revision: number): PendingGroup | null {
  // A retried creation can return a group already published by this device.
  const base = pending.base ?? { ...pending.group, name: '', description: '', icon: '', color: '', members: [], transactions: [] }
  const group = mergeLatestGroup(base, pending.group, remote)
  return same(group, remote) ? null : { base: remote, group, revision }
}

/** Acknowledging one upload must preserve edits made while it was in flight. */
export function acknowledgeGroup(store: AppStore, sent: PendingGroup, record: { group: Group; revision: number }): AppStore {
  const pending = store.outbox.find(item => item.group.id === sent.group.id)
  if (!pending || pending.revision > record.revision) return store
  const group = mergeLatestGroup(sent.group, pending.group, record.group)
  const remaining = same(group, record.group) ? null : { base: record.group, group, revision: record.revision }
  const hidden = store.removedGroupIds.includes(group.id)
  return {
    ...store,
    groups: hidden ? store.groups : store.groups.map(g => g.id === group.id ? group : g),
    cloudRevisions: hidden ? store.cloudRevisions : { ...store.cloudRevisions, [group.id]: record.revision },
    outbox: [...store.outbox.filter(item => item.group.id !== group.id), ...(remaining ? [remaining] : [])],
  }
}

export function queueJoin(store: AppStore, join: PendingJoin): AppStore {
  if (!/^[a-f0-9]{32}$/.test(join.code)) throw new Error('Enter the complete 32-character invite code.')
  if (!join.name.trim() || join.name.trim().length > 80 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(join.name)) throw new Error('Enter your name (up to 80 characters).')
  return { ...store, pendingJoins: [...store.pendingJoins.filter(item => item.code !== join.code), { ...join, name: join.name.trim() }] }
}

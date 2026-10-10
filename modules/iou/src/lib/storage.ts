import type { Group } from '../types'
import { validateGroup } from './ledger'
import { exportGroupCsv } from './groupCsv'
import { emptyTravelMode, normalizeTravelMode, type TravelModeSettings } from './travelMode'
import { rebasePending, type PendingGroup, type PendingJoin } from './offline'

export interface AppStore {
  version: 2
  groups: Group[]
  pinnedIds: string[]
  memberByGroup: Record<string, string>
  cloudRevisions: Record<string, number>
  removedGroupIds: string[]
  removalEpochs?: Record<string, string>
  travelMode: TravelModeSettings
  outbox: PendingGroup[]
  pendingJoins: PendingJoin[]
}

export const STORE_KEY = 'iou:store:v2'

export const emptyStore = (): AppStore => ({ version: 2, groups: [], pinnedIds: [], memberByGroup: {}, cloudRevisions: {}, removedGroupIds: [], removalEpochs: {}, travelMode: emptyTravelMode(), outbox: [], pendingJoins: [] })

function withoutRemovedGroups(store: AppStore): AppStore {
  const removed = new Set(store.removedGroupIds)
  const groups = store.groups.filter(group => !removed.has(group.id))
  return {
    ...store,
    groups,
    pinnedIds: store.pinnedIds.filter(id => !removed.has(id)),
    memberByGroup: Object.fromEntries(Object.entries(store.memberByGroup).filter(([id]) => !removed.has(id))),
    cloudRevisions: Object.fromEntries(Object.entries(store.cloudRevisions).filter(([id]) => !removed.has(id))),
    travelMode: normalizeTravelMode(store.travelMode, groups),
  }
}

export function updateTravelMode(store: AppStore, settings: TravelModeSettings): AppStore {
  if (settings.enabled && !settings.defaultGroupId) throw new Error('Choose a default group to turn on Travel mode.')
  if (settings.defaultGroupId && !store.groups.some(group => group.id === settings.defaultGroupId)) throw new Error('That group is no longer on this device. Choose another group.')
  return { ...store, travelMode: { ...settings } }
}

/** Forget a shared group's cache and personal settings without changing shared data. */
export function removeGroupFromDevice(store: AppStore, groupId: string): AppStore {
  const group = store.groups.find(group => group.id === groupId)
  if (!group) throw new Error('This group could not be found.')
  return withoutRemovedGroups({
    ...store,
    removedGroupIds: [...new Set([...store.removedGroupIds, groupId])],
    removalEpochs: { ...store.removalEpochs, [groupId]: crypto.randomUUID() },
    pendingJoins: store.pendingJoins.filter(request => request.code !== group.inviteCode),
  })
}

/** Only an invitation begun after the latest removal may restore a group. */
export function restoreInvitation(store: AppStore, record: { group: Group; revision: number }, started: AppStore): AppStore {
  const id = record.group.id
  if (store.removalEpochs?.[id] !== started.removalEpochs?.[id]) {
    throw new Error('This group was removed while opening the invitation. Open its invitation again to rejoin.')
  }
  return mergeCloudStore(store, [record], id)
}

/** Automatic refresh respects device removals; an explicit invitation lookup can restore one group. */
export function mergeCloudStore(store: AppStore, records: readonly { group: Group; revision: number }[], restoreGroupId?: string): AppStore {
  const removedGroupIds = store.removedGroupIds.filter(id => id !== restoreGroupId || !records.some(record => record.group.id === id))
  const removed = new Set(removedGroupIds)
  const groups = [...store.groups]
  const cloudRevisions = { ...store.cloudRevisions }
  const memberByGroup = { ...store.memberByGroup }
  let outbox = [...store.outbox]
  for (const record of records) {
    const pending = outbox.find(item => item.group.id === record.group.id)
    if (Math.max(cloudRevisions[record.group.id] || 0, pending?.revision || 0) > record.revision) continue
    const rebased = pending ? rebasePending(pending, record.group, record.revision) : null
    if (pending) outbox = [...outbox.filter(item => item.group.id !== record.group.id), ...(rebased ? [rebased] : [])]
    if (removed.has(record.group.id)) continue
    const group = rebased?.group ?? record.group
    const index = groups.findIndex(group => group.id === record.group.id)
    if (index < 0) groups.push(group); else groups[index] = group
    cloudRevisions[record.group.id] = record.revision
    if (!group.members.some(member => member.id === memberByGroup[record.group.id])) delete memberByGroup[record.group.id]
  }
  return withoutRemovedGroups({ ...store, groups, cloudRevisions, memberByGroup, removedGroupIds, outbox })
}

export function readSavedRaw(): string | null {
  try { return localStorage.getItem(STORE_KEY) } catch { return null }
}

export function loadStore(): { store: AppStore; error?: string; unavailable?: boolean } {
  let raw: string | null
  try { raw = localStorage.getItem(STORE_KEY) }
  catch { return { store: emptyStore(), error: 'Browser storage is unavailable. Allow browser storage to save changes on this device.', unavailable: true } }
  try {
    if (!raw) return { store: emptyStore() }
    const value = JSON.parse(raw) as AppStore
    const fields = ['version', 'groups', 'pinnedIds', 'memberByGroup', 'cloudRevisions', 'removedGroupIds']
    if (!value || value.version !== 2 || Object.keys(value).some(field => !fields.includes(field) && !['travelMode', 'outbox', 'pendingJoins', 'removalEpochs'].includes(field)) || fields.some(field => !Object.hasOwn(value, field)) || !Array.isArray(value.groups) || !Array.isArray(value.pinnedIds) || !value.memberByGroup || typeof value.memberByGroup !== 'object' || Array.isArray(value.memberByGroup) || !value.cloudRevisions || typeof value.cloudRevisions !== 'object' || Array.isArray(value.cloudRevisions)) throw new Error('Invalid saved data')
    const travelMode = value.travelMode ?? (Object.hasOwn(value, 'travelMode') ? null : emptyTravelMode())
    if (!travelMode || typeof travelMode !== 'object' || Object.keys(travelMode).length !== 2 || typeof travelMode.enabled !== 'boolean' || (travelMode.defaultGroupId !== null && typeof travelMode.defaultGroupId !== 'string')) throw new Error('Invalid Travel mode settings')
    if (!Array.isArray(value.removedGroupIds) || value.removedGroupIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id))) throw new Error('Invalid device removals')
    const removedGroupIds = [...new Set(value.removedGroupIds)]
    const removalEpochs = Object.hasOwn(value, 'removalEpochs') ? value.removalEpochs : {}
    if (!removalEpochs || typeof removalEpochs !== 'object' || Array.isArray(removalEpochs) || Object.entries(removalEpochs).some(([id, epoch]) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || ['__proto__', 'prototype', 'constructor'].includes(id) || typeof epoch !== 'string' || !/^[a-f0-9-]{36}$/.test(epoch))) throw new Error('Invalid device removal history')
    const pending = Object.hasOwn(value, 'outbox') ? value.outbox : []
    if (!Array.isArray(pending)) throw new Error('Invalid pending changes')
    const outbox = pending.map(item => {
      if (!item || Object.keys(item).length !== 3 || !Number.isSafeInteger(item.revision) || item.revision < 0) throw new Error('Invalid pending change')
      const group = validateGroup(item.group)
      const base = item.base === null ? null : validateGroup(item.base)
      if ((base === null) !== (item.revision === 0) || (base && (base.id !== group.id || base.currency !== group.currency || base.inviteCode !== group.inviteCode || base.createdAt !== group.createdAt))) throw new Error('Invalid pending base')
      return { group, base, revision: item.revision }
    })
    if (new Set(outbox.map(item => item.group.id)).size !== outbox.length) throw new Error('Duplicate pending changes')
    const pendingJoins = Object.hasOwn(value, 'pendingJoins') ? value.pendingJoins : []
    if (!Array.isArray(pendingJoins) || pendingJoins.some(item => !item || Object.keys(item).length !== 4 || typeof item.code !== 'string' || !/^[a-f0-9]{32}$/.test(item.code) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || typeof item.memberId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(item.memberId) || ['__proto__', 'prototype', 'constructor'].includes(item.memberId) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) || new Set(pendingJoins.map(item => item.code)).size !== pendingJoins.length) throw new Error('Invalid pending invitations')
    const groups = value.groups.map(validateGroup)
    if (new Set(groups.map(g => g.id)).size !== groups.length) throw new Error('Duplicate saved groups')
    const ids = new Set(groups.map(g => g.id))
    const memberByGroup: Record<string, string> = {}
    const cloudRevisions: Record<string, number> = {}
    for (const group of groups) {
      const memberId = value.memberByGroup[group.id]
      if (group.members.some(m => m.id === memberId)) memberByGroup[group.id] = memberId
      const revision = value.cloudRevisions[group.id]
      const pending = outbox.find(item => item.group.id === group.id)
      if (!Number.isSafeInteger(revision) || revision < 0 || (revision === 0 && pending?.base !== null) || (pending && (pending.revision !== revision || JSON.stringify(pending.group) !== JSON.stringify(group)))) throw new Error('Invalid shared group revision')
      cloudRevisions[group.id] = revision
    }
    if (outbox.some(item => !ids.has(item.group.id) && !removedGroupIds.includes(item.group.id))) throw new Error('Missing pending group')
    return { store: withoutRemovedGroups({ version: 2, groups, pinnedIds: value.pinnedIds.filter(id => typeof id === 'string' && ids.has(id)), memberByGroup, cloudRevisions, removedGroupIds, removalEpochs, travelMode, outbox, pendingJoins }) }
  } catch {
    return { store: emptyStore(), error: 'Your saved data could not be opened. It has been kept in browser storage. Export or recover it before saving new data.' }
  }
}

export function saveStore(store: AppStore): string {
  try {
    const serialized = JSON.stringify(store)
    localStorage.setItem(STORE_KEY, serialized)
    return serialized
  }
  catch { throw new Error('Could not save on this device. Browser storage may be full or unavailable. Free some space and try again.') }
}

export function downloadGroup(group: Group): void {
  const blob = new Blob([exportGroupCsv(group)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'iou-group'}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

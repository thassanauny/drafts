import type { AppStore } from './storage'
import { mergeCloudStore, restoreInvitation } from './storage'
import { acknowledgeGroup, queueGroup } from './offline'
import { CloudConflictError, type CloudRecord } from './cloud'
import type { Group } from '../types'

export interface SyncTransport {
  load: () => Promise<CloudRecord[]>
  create: (group: Group) => Promise<CloudRecord>
  save: (group: Group, revision: number) => Promise<CloudRecord>
  join: (code: string) => Promise<CloudRecord>
}

export interface SyncDevice {
  read: () => AppStore
  update: (change: (latest: AppStore) => AppStore) => void
  online: () => boolean
}

/** All network results are applied to the latest durable store, never a stale snapshot. */
export async function syncOffline(device: SyncDevice, cloud: SyncTransport): Promise<string[]> {
  if (!device.online()) return []
  const records = await cloud.load()
  const accessible = new Set(records.map(record => record.group.id))
  device.update(store => mergeCloudStore(store, records))
  let failure: unknown
  for (const request of device.read().pendingJoins) {
    if (!device.online()) break
    try {
      const started = device.read()
      const record = await cloud.join(request.code)
      accessible.add(record.group.id)
      device.update(store => {
        // The user may have cancelled or replaced this request in another tab.
        if (!store.pendingJoins.some(item => item.code === request.code && item.memberId === request.memberId && item.name === request.name && item.createdAt === request.createdAt)) return store
        let next = restoreInvitation(store, record, started)
        const group = next.groups.find(group => group.id === record.group.id)!
        const existing = group.members.find(member => member.id === request.memberId || member.name.toLowerCase() === request.name.toLowerCase())
        const id = existing?.id ?? request.memberId
        if (!existing) next = queueGroup(next, { ...group, members: [...group.members, { id, name: request.name }], updatedAt: new Date(Math.max(Date.parse(group.updatedAt), Date.parse(request.createdAt))).toISOString() }, id)
        return { ...next, memberByGroup: { ...next.memberByGroup, [group.id]: id }, pendingJoins: next.pendingJoins.filter(item => item.code !== request.code) }
      })
    } catch (error) { failure ??= error }
  }
  for (const id of device.read().outbox.map(item => item.group.id)) {
    // Bound retries if another device is continuously writing. The queue survives.
    for (let attempt = 0; attempt < 3 && device.online(); attempt++) {
      const sent = device.read().outbox.find(item => item.group.id === id)
      if (!sent) break
      try {
        const record = sent.base === null ? await cloud.create(sent.group) : await cloud.save(sent.group, sent.revision)
        accessible.add(id)
        device.update(store => acknowledgeGroup(store, sent, record))
      } catch (error) {
        if (error instanceof CloudConflictError && attempt < 2 && device.online()) {
          try {
            const latest = await cloud.load()
            device.update(store => mergeCloudStore(store, latest))
            continue
          } catch (refreshError) { failure ??= refreshError; break }
        }
        failure ??= error
        break
      }
    }
  }
  if (failure) throw failure
  return [...accessible]
}

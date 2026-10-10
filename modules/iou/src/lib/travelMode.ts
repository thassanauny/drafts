import type { Group } from '../types'

export interface TravelModeSettings {
  enabled: boolean
  defaultGroupId: string | null
}

export const emptyTravelMode = (): TravelModeSettings => ({ enabled: false, defaultGroupId: null })

export function normalizeTravelMode(settings: TravelModeSettings, groups: readonly Pick<Group, 'id'>[]): TravelModeSettings {
  return groups.some(group => group.id === settings.defaultGroupId) ? { ...settings } : emptyTravelMode()
}

/** Apply Travel mode once at launch; explicit destinations and later Home navigation remain available. */
export function travelLaunchHash(hash: string, settings: TravelModeSettings, groups: readonly Pick<Group, 'id' | 'inviteCode'>[]): string {
  if (!settings.enabled || !['', '#', '#/'].includes(hash)) return hash
  const group = groups.find(group => group.id === settings.defaultGroupId)
  return group ? `#/group/${group.inviteCode}` : hash
}

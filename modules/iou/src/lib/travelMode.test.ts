import { describe, expect, it } from 'vitest'
import { emptyTravelMode, normalizeTravelMode, travelLaunchHash } from './travelMode'

const groups = [{ id: 'trip', inviteCode: 'a'.repeat(32) }, { id: 'other', inviteCode: 'b'.repeat(32) }]
const enabled = { enabled: true, defaultGroupId: 'trip' }

describe('Travel mode launches', () => {
  it('opens the saved default group from each app entry URL using cached groups', () => {
    for (const hash of ['', '#', '#/']) expect(travelLaunchHash(hash, enabled, groups)).toBe(`#/group/${groups[0].inviteCode}`)
  })

  it('preserves explicit group, log, invitation, Groups, and Transactions destinations', () => {
    for (const hash of [`#/group/${groups[1].inviteCode}`, `#/group/${groups[1].inviteCode}/log`, `#/join/${groups[1].inviteCode}`, '#/groups', '#/transactions']) {
      expect(travelLaunchHash(hash, enabled, groups)).toBe(hash)
    }
  })

  it('keeps Home available when Travel mode is off or the default group is absent', () => {
    expect(travelLaunchHash('#/', { ...enabled, enabled: false }, groups)).toBe('#/')
    expect(travelLaunchHash('#/', { ...enabled, defaultGroupId: null }, groups)).toBe('#/')
    expect(travelLaunchHash('#/', enabled, [groups[1]])).toBe('#/')
  })

  it('turns off a missing default while retaining the choice when switched off', () => {
    expect(normalizeTravelMode(enabled, [groups[1]])).toEqual(emptyTravelMode())
    expect(normalizeTravelMode({ ...enabled, enabled: false }, groups)).toEqual({ ...enabled, enabled: false })
  })
})

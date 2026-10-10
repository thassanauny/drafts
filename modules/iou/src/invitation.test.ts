// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { emptyStore, loadStore, removeGroupFromDevice, saveStore, STORE_KEY } from './lib/storage'
import type { Group } from './types'

const mocks = vi.hoisted(() => ({ join: vi.fn(), load: vi.fn() }))
vi.mock('./lib/cloud', () => ({ cloudConfigured: true, joinCloudGroup: mocks.join, loadCloudGroups: mocks.load, createCloudGroup: vi.fn(), saveCloudGroup: vi.fn() }))
vi.mock('virtual:pwa-register/react', () => ({ useRegisterSW: () => ({ needRefresh: [false, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: vi.fn() }) }))
const codeA = 'a'.repeat(32), codeB = 'b'.repeat(32)
const group = (code = codeA): Group => ({ id: code[0]!, name: `Group ${code[0]}`, description: '', currency: 'THB', icon: 'trip', color: '#10b981', inviteCode: code, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', members: [{ id: 'amy', name: 'Amy' }], transactions: [] })
let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  localStorage.clear()
  window.history.replaceState(null, '', `#/join/${codeA}`)
  mocks.load.mockResolvedValue([])
  mocks.join.mockReset()
  mocks.join.mockImplementation(async (code: string) => ({ group: group(code), revision: 1 }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const mount = () => act(async () => { root.render(createElement(App)) })
const submit = () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const navigate = (code: string) => act(async () => {
  window.history.replaceState(null, '', `#/join/${code}`)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
})

describe('invitation navigation and late results', () => {
  it('resets the input and loaded group when invitation A changes to B', async () => {
    await mount()
    expect(host.querySelector<HTMLInputElement>('form input')!.value).toBe(codeA)
    await submit()
    expect(host.querySelector('.joined-group-preview')?.textContent).toContain('Group a')
    await navigate(codeB)
    expect(host.querySelector('.joined-group-preview')).toBeNull()
    expect(host.querySelector<HTMLInputElement>('form input')!.value).toBe(codeB)
    await submit()
    expect(host.querySelector('.joined-group-preview')?.textContent).toContain('Group b')
  })
  it('keeps a device removal when an earlier invitation lookup completes', async () => {
    saveStore({ ...emptyStore(), groups: [group()], cloudRevisions: { a: 1 } })
    let finish!: (value: { group: Group; revision: number }) => void
    mocks.join.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await mount(); await submit()
    await act(async () => {
      saveStore(removeGroupFromDevice(loadStore().store, 'a'))
      window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }))
      finish({ group: group(), revision: 1 })
    })
    expect(loadStore().store.groups).toEqual([])
    expect(loadStore().store.removedGroupIds).toEqual(['a'])
    expect(host.textContent).toContain('removed while opening')
  })
  it('does not queue restoration or save membership after another tab removes a loaded preview', async () => {
    saveStore({ ...emptyStore(), groups: [group()], cloudRevisions: { a: 1 } })
    await mount(); await submit()
    await act(async () => {
      const identity = host.querySelector<HTMLSelectElement>('form select')!
      identity.value = 'amy'
      identity.dispatchEvent(new Event('change', { bubbles: true }))
      saveStore(removeGroupFromDevice(loadStore().store, 'a'))
      window.dispatchEvent(new StorageEvent('storage', { key: STORE_KEY }))
    })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await submit()
    const saved = loadStore().store
    expect(saved.groups).toEqual([])
    expect(saved.memberByGroup.a).toBeUndefined()
    expect(saved.pendingJoins).toEqual([])
    expect(host.textContent).toContain('removed from this device')
  })
  it('ignores a lookup belonging to an abandoned invitation form', async () => {
    let finish!: (value: { group: Group; revision: number }) => void
    mocks.join.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await mount(); await submit()
    expect(host.querySelector<HTMLInputElement>('form input')!.disabled).toBe(true)
    await navigate(codeB)
    expect(host.querySelector<HTMLInputElement>('form input')!.disabled).toBe(false)
    await act(async () => finish({ group: group(), revision: 1 }))
    expect(loadStore().store.groups).toEqual([])
    expect(host.querySelector<HTMLInputElement>('form input')!.value).toBe(codeB)
  })
})

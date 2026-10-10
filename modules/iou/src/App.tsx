import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { version as appVersion } from '../package.json'
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleHelp, Clipboard, History, Home, Link, LockKeyhole, LogOut, Pin, Plane, Plus, ReceiptText, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, Users, Wallet, WifiOff, X } from 'lucide-react'
import type { Group, Settlement, Transaction } from './types'
import { formatMoney, getBalances, getCurrencyBalances, getSettlements, totalSpent, validateGroup } from './lib/ledger'
import { cloudConfigured, createCloudGroup, joinCloudGroup, loadCloudGroups, saveCloudGroup } from './lib/cloud'
import { downloadGroup, emptyStore, loadStore, readSavedRaw, removeGroupFromDevice, restoreInvitation, saveStore, STORE_KEY, updateTravelMode, type AppStore } from './lib/storage'
import { travelLaunchHash, type TravelModeSettings } from './lib/travelMode'
import { compareTransactions, getTransactionFeed, type TransactionFilter } from './lib/transactions'
import { mergeLatestGroup, queueGroup, queueJoin } from './lib/offline'
import { syncOffline } from './lib/sync'
import { Modal } from './components/Modal'
import { Avatar, CATEGORIES, GroupIcon, ReceiptArt } from './components/UI'
import { CreateGroupForm, ExpenseForm, FormError, PaymentForm, SettingsForm, SubmitButton, TravelModeForm, type NewGroupValues, type SettingsValues } from './components/GroupForms'

type ModalState = { type: 'create' | 'expense' | 'invite' | 'help' | 'travel' | 'recovery' } | { type: 'settings'; group: Group; removing?: boolean } | { type: 'join'; code?: string } | { type: 'payment'; settlement?: Settlement } | { type: 'delete'; transaction: Transaction }
function route(hash = window.location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/')
  return { groupCode: parts[0] === 'group' ? parts[1] : undefined, groups: parts[0] === 'groups', transactions: parts[0] === 'transactions', log: parts[0] === 'group' && parts[2] === 'log', joinCode: parts[0] === 'join' ? parts[1] : undefined }
}
function navigate(inviteCode?: string, log = false) { window.location.hash = inviteCode ? `/group/${inviteCode}${log ? '/log' : ''}` : '/' }
function navigateGroups() { window.location.hash = '/groups' }
function navigateTransactions() { window.location.hash = '/transactions' }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.' }
function dateLabel(date: string) { return new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) }

export default function App() {
  const [initial] = useState(() => {
    const saved = loadStore()
    return { ...saved, raw: readSavedRaw(), hash: travelLaunchHash(window.location.hash, saved.store.travelMode, saved.store.groups) }
  })
  const [store, setStore] = useState(initial.store)
  const current = useRef(store)
  const knownStorage = useRef(initial.raw)
  const [recoveryRequired, setRecoveryRequired] = useState(Boolean(initial.error && !initial.unavailable))
  const [page, setPage] = useState(() => route(initial.hash))
  const currentRoute = useRef(page)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [toast, setToast] = useState('')
  const [notice, setNotice] = useState(initial.error || '')
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [lastSync, setLastSync] = useState('')
  const [unavailableSharedIds, setUnavailableSharedIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'pinned'>('all')
  const [logFilter, setLogFilter] = useState<TransactionFilter>('all')
  const [feedLimit, setFeedLimit] = useState(50)
  const syncingRef = useRef(false)
  const accessEpoch = useRef(0)
  const { needRefresh: [needsUpdate, setNeedsUpdate], updateServiceWorker } = useRegisterSW()
  const group = store.groups.find(g => g.inviteCode === page.groupCode)
  const canEdit = !!group && cloudConfigured && !recoveryRequired
  const pendingCount = store.outbox.length + store.pendingJoins.length
  const footerMessage = pendingCount ? 'Saved on this device. Waiting to sync.' : cloudConfigured ? 'Shared with your group. Kept in sync.' : 'Connect Supabase to create and join groups.'
  const notify = (message: string) => setToast(message)
  const cacheStore = useCallback((next: AppStore) => { knownStorage.current = saveStore(next) }, [])

  const showStore = useCallback((next: AppStore) => {
    const viewed = current.current.groups.find(group => group.inviteCode === currentRoute.current.groupCode)
    const updated = viewed && next.groups.find(group => group.id === viewed.id)
    if (updated && updated.inviteCode !== viewed.inviteCode) {
      const hash = `#/group/${updated.inviteCode}${currentRoute.current.log ? '/log' : ''}`
      window.history.replaceState(null, '', hash)
      currentRoute.current = route(hash); setPage(currentRoute.current)
    }
    current.current = next; setStore(next)
  }, [])

  const commit = useCallback((next: AppStore) => {
    if (recoveryRequired) throw new Error('Recover or reset your saved data before making changes. Open Help to download a recovery backup.')
    if (readSavedRaw() !== knownStorage.current) throw new Error('Your saved data changed in another tab. Try saving again.')
    cacheStore(next)
    showStore(next)
  }, [recoveryRequired, cacheStore, showStore])

  const latestStore = useCallback(() => {
    const raw = readSavedRaw()
    if (raw !== knownStorage.current) {
      const external = loadStore()
      if (external.error) throw new Error(external.error)
      knownStorage.current = raw
      showStore(external.store)
    }
    return current.current
  }, [showStore])

  const updateLatest = useCallback((change: (latest: AppStore) => AppStore) => {
    commit(change(latestStore()))
  }, [commit, latestStore])

  const sync = useCallback(async () => {
    if (!cloudConfigured || !navigator.onLine || syncingRef.current || recoveryRequired) return
    syncingRef.current = true; setSyncing(true)
    const expectedIds = Object.entries(current.current.cloudRevisions).filter(([, revision]) => revision > 0).map(([id]) => id)
    const epoch = accessEpoch.current
    try {
      const accessible = await syncOffline({ read: latestStore, update: updateLatest, online: () => navigator.onLine }, { load: loadCloudGroups, create: createCloudGroup, save: saveCloudGroup, join: joinCloudGroup })
      if (accessEpoch.current === epoch) setUnavailableSharedIds(expectedIds.filter(id => !current.current.removedGroupIds.includes(id) && !accessible.includes(id)))
      setSyncError(''); setLastSync(new Date().toISOString())
    } catch (err) { setSyncError(errorMessage(err)) }
    finally { syncingRef.current = false; setSyncing(false) }
  }, [latestStore, updateLatest, recoveryRequired])

  useEffect(() => { if (initial.hash !== window.location.hash) window.history.replaceState(null, '', initial.hash) }, [initial.hash])

  useEffect(() => {
    const changed = () => {
      const next = route()
      const changedPage = next.groupCode !== currentRoute.current.groupCode || next.groups !== currentRoute.current.groups || next.transactions !== currentRoute.current.transactions || next.joinCode !== currentRoute.current.joinCode
      if (changedPage) setModal(null)
      currentRoute.current = next; setPage(next); setLogFilter('all'); setFeedLimit(50)
      if (next.joinCode) setModal({ type: 'join', code: next.joinCode })
    }
    const stored = (event: StorageEvent) => {
      if (event.key !== STORE_KEY && event.key !== null) return
      const external = loadStore()
      if (external.error) { setNotice(external.error); setRecoveryRequired(!external.unavailable); return }
      knownStorage.current = readSavedRaw()
      setRecoveryRequired(false); setNotice('')
      showStore(external.store)
    }
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) void sync() }
    const visible = () => { if (document.visibilityState === 'visible') void sync() }
    window.addEventListener('hashchange', changed)
    window.addEventListener('storage', stored)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    document.addEventListener('visibilitychange', visible)
    if (page.joinCode) setModal({ type: 'join', code: page.joinCode })
    void sync()
    const interval = cloudConfigured ? window.setInterval(() => { if (document.visibilityState === 'visible') void sync() }, 10000) : undefined
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('storage', stored); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); document.removeEventListener('visibilitychange', visible); if (interval !== undefined) window.clearInterval(interval) }
  }, [sync, showStore])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer) }, [toast])
  useEffect(() => { document.title = group ? `${group.name} · iou` : page.groups ? 'Groups · iou' : page.transactions ? 'Transactions · iou' : 'iou · Split it. Settle it.' }, [group?.name, page.groups, page.transactions])

  const finishModal = () => { setModal(null); if (page.joinCode) navigate() }
  const closeModal = finishModal
  const resetSavedData = () => {
    const next = emptyStore()
    cacheStore(next)
    current.current = next; setStore(next)
    setRecoveryRequired(false); setUnavailableSharedIds([]); setNotice(''); closeModal()
  }
  const retryCaching = () => {
    if (readSavedRaw() !== knownStorage.current) throw new Error('Your saved data changed in another tab. Reload before retrying caching.')
    cacheStore(current.current); setNotice('')
  }
  const downloadRecovery = () => {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw === null) throw new Error('There is no saved browser data to download.')
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'iou-recovery.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const openSettings = () => { if (group) setModal({ type: 'settings', group }) }
  const saveTravelSettings = async (settings: TravelModeSettings) => {
    const next = updateTravelMode(latestStore(), settings)
    commit(next)
    closeModal()
    if (settings.enabled) navigate(next.groups.find(group => group.id === settings.defaultGroupId)!.inviteCode)
    notify(settings.enabled ? 'Travel mode is on. This group will open when you launch iou.' : 'Travel mode is off.')
  }
  const removeDeviceGroup = (groupId: string) => {
    commit(removeGroupFromDevice(latestStore(), groupId))
    accessEpoch.current++
    setUnavailableSharedIds(ids => ids.filter(id => id !== groupId))
    setModal(null); navigateGroups(); notify('Group removed from this device. Rejoin anytime with its invitation code.')
  }
  const runAction = async (action: () => Promise<void> | void) => { try { await action() } catch (err) { notify(errorMessage(err)) } }
  const updateGroup = async (groupId: string, change: (latest: Group) => Group, identity?: string) => {
    if (recoveryRequired) throw new Error('Recover or reset your saved data before making changes.')
    const base = latestStore()
    const latest = base.groups.find(g => g.id === groupId)
    if (!latest) throw new Error('This group could not be found.')
    const draft = validateGroup({ ...change(latest), updatedAt: new Date().toISOString() })
    if (draft.currency !== latest.currency) throw new Error('The currency is fixed for this group.')
    commit(queueGroup(base, draft, identity))
    void sync()
  }
  const saveNewGroup = async (draft: Group) => {
    if (recoveryRequired) throw new Error('Recover or reset your saved data before creating a group.')
    if (!cloudConfigured) throw new Error('Connect Supabase before creating a shared group.')
    commit(queueGroup(latestStore(), draft, draft.members[0].id))
    finishModal(); navigate(draft.inviteCode); notify('Group saved on this device. Its invitation will be ready after syncing.')
    void sync()
  }
  const createGroup = async (values: NewGroupValues) => {
    const now = new Date().toISOString()
    const newGroup = validateGroup({ id: values.id, name: values.name, description: values.description, currency: values.currency, icon: values.icon, color: values.color, inviteCode: crypto.randomUUID().replaceAll('-', ''), createdAt: now, updatedAt: now, members: values.names.map(name => ({ id: crypto.randomUUID(), name })), transactions: [] })
    await saveNewGroup(newGroup)
  }
  const addTransaction = async (transaction: Transaction) => {
    if (!group) return
    if (current.current.groups.find(g => g.id === group.id)?.transactions.some(t => t.id === transaction.id)) {
      closeModal(); notify('This transaction was already saved. Your balances are up to date.'); return
    }
    await updateGroup(group.id, latest => ({ ...latest, transactions: [...latest.transactions, transaction] }))
    closeModal(); notify(transaction.type === 'expense' ? 'Expense added. The balances are up to date.' : 'Payment recorded. One less loose end.')
  }
  const saveSettings = async (values: SettingsValues) => {
    if (!group || modal?.type !== 'settings') return
    if (group.id !== modal.group.id) throw new Error('The open group changed. Close settings and open them again.')
    const { yourId, ...settings } = values
    await updateGroup(group.id, latest => mergeLatestGroup(modal.group, { ...modal.group, ...settings, updatedAt: new Date().toISOString() }, latest), yourId)
    closeModal(); notify('Group settings saved.')
  }
  const togglePin = (id: string) => { const base = latestStore(); const pinned = base.pinnedIds.includes(id); commit({ ...base, pinnedIds: pinned ? base.pinnedIds.filter(p => p !== id) : [...base.pinnedIds, id] }); notify(pinned ? 'Group unpinned.' : 'Pinned to your home screen.') }
  const saveJoinRequest = (code: string, name: string, memberId: string) => {
    updateLatest(store => queueJoin(store, { code, name, memberId, createdAt: new Date().toISOString() }))
    finishModal(); notify('Join request saved. It will finish when connected.'); void sync()
  }
  const fetchInvitation = async (code: string, isCurrent: () => boolean) => {
    const started = latestStore()
    const cached = started.groups.find(group => group.inviteCode === code)
    if (!navigator.onLine) return cached ?? null
    try {
      const result = await joinCloudGroup(code)
      if (!isCurrent()) throw new Error('This invitation is no longer open. Open it again to rejoin.')
      updateLatest(base => restoreInvitation(base, result, started))
      accessEpoch.current++
      setUnavailableSharedIds(ids => ids.filter(id => id !== result.group.id))
      return current.current.groups.find(group => group.id === result.group.id)!
    } catch (error) {
      if (/connect|network|fetch/i.test(errorMessage(error))) return cached ?? null
      throw error
    }
  }
  const joinGroup = async (joined: Group, selectedId: string, name: string, newMemberId: string) => {
    const requireVisible = (base: AppStore) => {
      const latest = base.groups.find(group => group.id === joined.id)
      if (!latest || base.removedGroupIds.includes(joined.id)) throw new Error('This group was removed from this device. Open its invitation again to rejoin.')
      if (selectedId && !latest.members.some(member => member.id === selectedId)) throw new Error('That member is no longer in this group. Open its invitation again.')
      return latest
    }
    requireVisible(latestStore())
    const id = selectedId || newMemberId
    if (!selectedId && !latestStore().groups.find(group => group.id === joined.id)?.members.some(member => member.id === id)) {
      await updateGroup(joined.id, latest => ({ ...latest, members: [...latest.members, { id, name: name.trim() }] }))
    }
    updateLatest(base => {
      requireVisible(base)
      const next = { ...base, memberByGroup: { ...base.memberByGroup, [joined.id]: id } }
      return !navigator.onLine || syncError ? queueJoin(next, { code: joined.inviteCode, name, memberId: id, createdAt: new Date().toISOString() }) : next
    })
    void sync(); closeModal(); navigate(current.current.groups.find(group => group.id === joined.id)!.inviteCode)
    notify('You’re in! Welcome to the group.')
  }
  const groups = store.groups.filter(g => page.groups ? (filter === 'all' || store.pinnedIds.includes(g.id)) && `${g.name} ${g.description}`.toLowerCase().includes(search.toLowerCase()) : store.pinnedIds.includes(g.id))
  const pinnedGroups = groups.filter(g => store.pinnedIds.includes(g.id))
  const otherGroups = groups.filter(g => !store.pinnedIds.includes(g.id))
  const yourId = group ? store.memberByGroup[group.id] : undefined
  const balancesByGroup = useMemo(() => new Map(store.groups.map(g => [g.id, getBalances(g)])), [store.groups])
  const balances = group ? balancesByGroup.get(group.id)! : []
  const yourBalance = balances.find(b => b.member.id === yourId)
  const settlements = useMemo(() => group ? getSettlements(group) : [], [group])
  const transactions = useMemo(() => group ? [...group.transactions].sort(compareTransactions) : [], [group])
  const visibleTransactions = useMemo(() => transactions.filter(t => logFilter === 'all' || t.type === logFilter), [transactions, logFilter])
  const transactionFeed = useMemo(() => page.transactions ? getTransactionFeed(store.groups, logFilter) : [], [store.groups, page.transactions, logFilter])
  const currencyBalances = useMemo(() => getCurrencyBalances(store.groups.map(g => ({ currency: g.currency, balance: balancesByGroup.get(g.id)!.find(b => b.member.id === store.memberByGroup[g.id])?.balance || 0 }))), [store.groups, store.memberByGroup, balancesByGroup])
  const openCurrencyBalances = currencyBalances.filter(c => c.owed || c.owes)

  const renderCard = (g: Group) => {
    const balance = balancesByGroup.get(g.id)!.find(b => b.member.id === store.memberByGroup[g.id])?.balance
    const pinned = store.pinnedIds.includes(g.id)
    return <article className="group-card" key={g.id}>
      <button className="card-open" onClick={() => navigate(g.inviteCode)} aria-label={`Open ${g.name}`}><span className="card-top"><GroupIcon id={g.icon} color={g.color}/><span className="group-currency">{g.currency}</span></span><h3>{g.name}</h3><p className="card-description">{g.description || `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}, one shared tab.`}</p><span className="card-members"><span className="avatar-stack">{g.members.slice(0, 4).map((m, i) => <Avatar key={m.id} member={m} index={i} small/>)}</span><span>{g.members.length} {g.members.length === 1 ? 'member' : 'members'}</span></span><span className="card-balance"><span>{balance === undefined ? 'Choose your member name' : balance === 0 ? 'All settled up' : balance > 0 ? 'You get back' : 'You owe'}</span><strong className={balance && balance < 0 ? 'amount-owes' : 'amount-owed'}>{balance === undefined ? <ChevronRight size={20}/> : balance === 0 ? <CheckCheck size={20}/> : formatMoney(Math.abs(balance), g.currency)}</strong></span></button>
      <button className={`pin-button ${pinned ? 'pinned' : ''}`} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${g.name}`} aria-pressed={pinned} onClick={() => void runAction(() => togglePin(g.id))}><Pin size={18}/></button>
    </article>
  }
  const transactionRow = (t: Transaction, sourceGroup = group) => {
    if (!sourceGroup) return null
    const isExpense = t.type === 'expense'
    const Icon = isExpense ? CATEGORIES.find(c => c.id === t.category)?.Icon || ReceiptText : ArrowUpRight
    const memberName = (id: string) => sourceGroup.members.find(m => m.id === id)?.name || 'Member'
    return <div className="transaction-row" key={`${sourceGroup.id}:${t.id}`}><div className={`transaction-icon ${isExpense ? '' : 'payment-icon'}`}><Icon size={20}/></div><div className="transaction-description">{page.transactions && <button className="transaction-group" onClick={() => navigate(sourceGroup.inviteCode, true)} aria-label={`Open ${sourceGroup.name} transaction log`}>{sourceGroup.name}<ChevronRight size={12}/></button>}<strong>{isExpense ? t.description : `${memberName(t.fromId)} paid ${memberName(t.toId)}`}</strong><span>{isExpense ? `${memberName(t.paidBy)} paid · Split ${Object.keys(t.shares).length} ways` : t.note || 'Payment recorded'}<span className="transaction-date"> · {dateLabel(t.date)}</span></span></div><div className="transaction-amount"><strong>{page.transactions && `${sourceGroup.currency} `}{formatMoney(t.amount, sourceGroup.currency, { includeCurrency: !page.transactions })}</strong><span>{isExpense ? 'Expense' : 'Payment'}</span></div>{page.log && <button className="icon-button delete-transaction" disabled={!canEdit} aria-label={`Delete ${isExpense ? t.description : 'payment'}`} onClick={() => setModal({ type: 'delete', transaction: t })}><Trash2 size={16}/></button>}</div>
  }

  return <div className={`app-shell ${group ? 'in-group' : ''}`}>
    <header className="site-header"><div className="header-inner"><button className="brand" onClick={() => navigate()} aria-label="iou home"><span className="brand-mark"><span/><span/></span>iou<span className="brand-dot">.</span></button><nav className="desktop-nav" aria-label="Main navigation"><button className={!group && !page.groups && !page.transactions ? 'active' : ''} aria-current={!group && !page.groups && !page.transactions ? 'page' : undefined} onClick={() => navigate()}>Home</button><button className={!group && page.groups ? 'active' : ''} aria-current={!group && page.groups ? 'page' : undefined} onClick={navigateGroups}>Groups</button><button className={page.transactions ? 'active' : ''} aria-current={page.transactions ? 'page' : undefined} onClick={navigateTransactions}>Transactions</button><button aria-haspopup="dialog" aria-expanded={modal?.type === 'travel'} onClick={() => setModal({ type: 'travel' })}>Travel mode</button></nav><div className="header-actions"><span className={`connection ${!online ? 'offline' : ''}`}>{!online ? <WifiOff size={13}/> : <span className="tiny-dot"/>}{!online ? 'Offline' : !cloudConfigured ? 'Setup required' : syncing ? 'Syncing' : syncError ? 'Needs attention' : lastSync ? 'Connected' : 'Connecting'}</span><button className="icon-button help-button" aria-label="Help" onClick={() => setModal({ type: 'help' })}><CircleHelp size={21}/></button></div></div></header>
    <main className={`main-container${page.groups ? ' groups-page' : ''}`}>
      {notice && <div className="notice warning" role="alert"><span>{notice}</span><button className="text-button" onClick={() => recoveryRequired ? setModal({ type: 'recovery' }) : void runAction(retryCaching)}>{recoveryRequired ? 'Recover data' : 'Retry caching'}</button></div>}
      {group && unavailableSharedIds.includes(group.id) && <div className="notice warning" role="alert"><span>Your changes stay on this device. Rejoin this group to sync them.</span><button className="text-button" onClick={() => setModal({ type: 'join', code: group.inviteCode })}>Rejoin group</button></div>}
      {!online && <div className="notice"><WifiOff size={18}/><span>You’re offline. Changes save on this device and sync when connected.</span></div>}
      {cloudConfigured && syncError && online && <div className="notice warning" role="alert"><span>Changes are saved on this device. Could not sync: {syncError}</span><button className="text-button" onClick={() => void sync()}><RefreshCw size={15}/>Retry</button></div>}
      {pendingCount > 0 && online && !syncError && <div className="notice" role="status"><RefreshCw size={16}/><span>{syncing ? 'Syncing saved changes…' : 'Saved on this device. Waiting to sync.'}</span></div>}
      {store.pendingJoins.map(request => <div className="notice" key={request.code}><span>Join request for {request.name} saved. Code: {request.code.slice(0, 8)}…</span><button className="text-button" onClick={() => void runAction(() => { updateLatest(store => ({ ...store, pendingJoins: store.pendingJoins.filter(item => item.code !== request.code) })); notify('Join request cancelled.') })}>Cancel request</button></div>)}
      {page.groupCode && !group ? <div className="empty-state"><Search size={36}/><h2>We couldn’t find that group.</h2><p>Open your groups or use an invitation code to join.</p><button className="button primary" onClick={navigateGroups}>Go to groups</button></div> : page.transactions ? <>
        <section className="transactions-section">
          <div className="section-heading transactions-heading"><div><h1>Transactions<span className="count-pill">{transactionFeed.length}</span></h1><p>Expenses and payments from all your groups.</p></div></div>
          <div className="panel transaction-panel all-transactions-panel">
            <div className="log-filters segmented small" role="group" aria-label="Transaction type">{(['all', 'expense', 'payment'] as const).map(type => <button key={type} className={logFilter === type ? 'active' : ''} aria-pressed={logFilter === type} onClick={() => { setLogFilter(type); setFeedLimit(50) }}>{type === 'all' ? 'All activity' : type === 'expense' ? 'Expenses' : 'Payments'}</button>)}</div>
            {transactionFeed.length ? <>
              <div className="transaction-list">{transactionFeed.slice(0, feedLimit).map(entry => transactionRow(entry.transaction, entry.group))}</div>
              {transactionFeed.length > 50 && <div className="feed-pagination"><span>Showing {Math.min(feedLimit, transactionFeed.length)} of {transactionFeed.length}</span>{feedLimit < transactionFeed.length && <button className="button secondary compact" onClick={() => setFeedLimit(limit => limit + 50)}>Show more</button>}</div>}
            </> : <div className="panel-empty"><ReceiptText size={30}/><h3>No {logFilter === 'all' ? 'transactions' : logFilter === 'expense' ? 'expenses' : 'payments'} yet.</h3><p>{store.groups.length ? 'Your groups’ activity will appear here.' : 'Create or join a group from Home to get started.'}</p></div>}
          </div>
        </section>
        <div className="home-footer"><span><ShieldCheck size={16}/>{footerMessage}</span><span className="app-version">iou · {appVersion}</span></div>
      </> : !group ? <>
        {!page.groups && <><section className="home-hero"><div className="hero-copy"><h1><span>Split it.</span>{' '}<em>Settle it.</em></h1><p>Trips, dinners, everyday things. Split them fairly.</p><div className="hero-buttons"><button className="button primary" onClick={() => setModal({ type: 'create' })}><Plus size={19}/>Create a group</button><button className="button secondary" onClick={() => setModal({ type: 'join' })}><Link size={18}/>Join a group</button></div></div><div className="hero-visual"><ReceiptArt/><div className="hero-caption"><span className="caption-avatar"><Check size={14}/></span><span>More memories. Fewer IOUs.</span><Sparkles size={15}/></div></div></section>
        <section className="home-stats" aria-label="Your summary">
          <div><span className="stat-icon"><Users size={20}/></span><span><strong>{store.groups.length}</strong><span>{store.groups.length === 1 ? 'group together' : 'groups together'}</span></span></div>
          <div><span className="stat-icon lavender"><Pin size={19}/></span><span><strong>{store.pinnedIds.length}</strong><span>pinned for easy access</span></span></div>
          <div className="balance-stat"><div className="balance-stat-content">
            <strong>{openCurrencyBalances.length ? 'Your open balances' : 'No loose ends'}</strong>
            {openCurrencyBalances.length ? <table className="currency-balances" aria-label="Open balances by currency">
              <thead><tr><th scope="col"><span className="sr-only">Currency</span></th><th scope="col">You owe</th><th scope="col">You get back</th></tr></thead>
              <tbody>{openCurrencyBalances.map(c => <tr key={c.code}>
                <th scope="row">{c.code}</th>
                <td className="amount-owes">{c.owes ? formatMoney(c.owes, c.code, { includeCurrency: false }) : <span className="balance-zero" aria-label="0.00">—</span>}</td>
                <td className="amount-owed">{c.owed ? formatMoney(c.owed, c.code, { includeCurrency: false }) : <span className="balance-zero" aria-label="0.00">—</span>}</td>
              </tr>)}</tbody>
            </table> : <p>A good place to start.</p>}
          </div></div>
        </section>
        </>}
        <section className="groups-section"><div className="section-heading"><div><h2>{page.groups ? 'Groups' : 'Pinned groups'}<span className="count-pill">{page.groups ? store.groups.length : store.pinnedIds.length}</span></h2><p>{page.groups ? 'The people you split life with.' : 'Your favourites, close at hand.'}</p></div></div>
          {page.groups && <div className="group-controls">
            <div className="group-controls-toolbar">
              {store.groups.length > 0 && <div className="segmented"><button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All groups</button><button className={filter === 'pinned' ? 'active' : ''} aria-pressed={filter === 'pinned'} onClick={() => setFilter('pinned')}><Pin size={14}/>Pinned</button></div>}
              <div className="groups-page-actions"><button className="button primary" aria-label="Create group" onClick={() => setModal({ type: 'create' })}><Plus size={14}/>Create</button><button className="button secondary" aria-label="Join group" onClick={() => setModal({ type: 'join' })}><Link size={14}/>Join</button></div>
            </div>
            {store.groups.length > 0 && <label className="search-field"><Search size={17}/><input type="search" aria-label="Search groups" placeholder="Find a group…" value={search} onChange={e => setSearch(e.target.value)}/></label>}
          </div>}
          {store.groups.length === 0 ? <div className="home-empty"><div className="empty-illustration"><Users size={33} strokeWidth={1.5}/><span><Plus size={14}/></span></div><h3>Every good story starts with a group.</h3><p>Create one for your next trip, your roommates,<br/>or tonight’s dinner. We’ll handle the maths.</p><button className="button primary" onClick={() => setModal({ type: 'create' })}>Create your first group<ArrowRight size={17}/></button></div> : groups.length === 0 ? <div className="empty-search"><Search size={28}/><h3>{!page.groups || (filter === 'pinned' && !search) ? 'Keep your favourites close.' : 'No groups found.'}</h3><p>{!page.groups || (filter === 'pinned' && !search) ? 'Open Groups and tap the pin on any group to add it here.' : 'Try a different group name.'}</p>{!page.groups && <button className="button secondary" onClick={navigateGroups}>Browse groups<ArrowRight size={17}/></button>}</div> : <>{pinnedGroups.length > 0 && <>{page.groups && <div className="group-list-label"><Pin size={14}/>PINNED GROUPS</div>}<div className="group-grid">{pinnedGroups.map(renderCard)}</div></>}{otherGroups.length > 0 && <>{pinnedGroups.length > 0 && <div className="group-list-label">ALL OTHER GROUPS</div>}<div className="group-grid">{otherGroups.map(renderCard)}</div></>}</>}
        </section>
        <div className="home-footer"><span><ShieldCheck size={16}/>{footerMessage}</span><span className="app-version">iou · {appVersion}</span></div>
      </> : <>
        <div className="group-breadcrumb"><button className="text-button" onClick={() => navigate()}><ArrowLeft size={16}/>Home</button><span><span className="tiny-dot"/>{store.outbox.some(item => item.group.id === group.id) ? 'Saved on this device' : lastSync ? 'Automatically synced' : 'Shared group'}</span></div>
        <section className="group-heading"><GroupIcon id={group.icon} color={group.color} large/><div className="group-heading-text"><div className="group-title-line"><h1>{group.name}</h1><button className={`icon-button group-pin ${store.pinnedIds.includes(group.id) ? 'pinned' : ''}`} aria-label={store.pinnedIds.includes(group.id) ? 'Unpin group' : 'Pin group'} aria-pressed={store.pinnedIds.includes(group.id)} onClick={() => void runAction(() => togglePin(group.id))}><Pin size={19}/></button></div><p>{group.description || 'Good people. Shared expenses.'}</p></div><div className="group-heading-footer"><div className="group-meta"><span><Users size={14}/>{group.members.length} members</span><span className="meta-dot">·</span><span><LockKeyhole size={13}/>{group.currency}</span></div><div className="group-top-actions"><button className="button secondary compact" onClick={() => setModal({ type: 'invite' })}><Link size={16}/><span>Invite</span></button><button className="icon-button settings-button" onClick={openSettings} aria-label="Group settings"><Settings2 size={20}/></button></div></div></section>
        <section className="group-summary"><div className="personal-balance"><div><span className="eyebrow">{yourBalance ? yourBalance.balance > 0 ? 'YOU GET BACK' : yourBalance.balance < 0 ? 'YOU OWE' : 'YOUR BALANCE' : 'YOUR BALANCE'}</span><strong>{yourBalance ? formatMoney(Math.abs(yourBalance.balance), group.currency) : 'Who are you?'}</strong><p>{yourBalance ? yourBalance.balance === 0 ? 'You’re all settled up. Nice.' : yourBalance.balance > 0 ? 'You picked up the tab. Your group has your back.' : 'A little to settle, a lot of good memories.' : 'Choose your member name in group settings.'}</p>{!yourBalance && <button className="text-button" onClick={openSettings}>Choose your name<ArrowRight size={14}/></button>}</div><div className="balance-art"><Wallet size={41} strokeWidth={1.25}/><span><Check size={15}/></span></div></div><div className="group-total"><span>Total group spending</span><strong>{formatMoney(totalSpent(group), group.currency)}</strong><span>{group.transactions.filter(t => t.type === 'expense').length} expenses · {group.currency}</span></div></section>
        <div className="group-toolbar"><div className="segmented page-tabs"><button className={!page.log ? 'active' : ''} onClick={() => navigate(group.inviteCode)}><Users size={17}/>Overview</button><button className={page.log ? 'active' : ''} onClick={() => navigate(group.inviteCode, true)}><History size={17}/>Transaction log</button></div><div className="desktop-actions"><button className="button secondary compact" disabled={!canEdit} onClick={() => setModal({ type: 'payment' })}><ArrowUpRight size={17}/>Add payment</button><button className="button primary compact" disabled={!canEdit} onClick={() => setModal({ type: 'expense' })}><Plus size={18}/>Add expense</button></div></div>
        {page.log ? <section className="panel transaction-panel"><div className="panel-heading"><div><h2>Every little thing</h2><p>The complete expense and payment history.</p></div><span className="count-pill">{group.transactions.length}</span></div><div className="log-filters segmented small">{(['all', 'expense', 'payment'] as const).map(type => <button key={type} className={logFilter === type ? 'active' : ''} onClick={() => setLogFilter(type)}>{type === 'all' ? 'All activity' : type === 'expense' ? 'Expenses' : 'Payments'}</button>)}</div>{visibleTransactions.length > 0 ? <div className="transaction-list">{visibleTransactions.map(t => transactionRow(t))}</div> : <div className="panel-empty"><ReceiptText size={30}/><h3>No {logFilter === 'all' ? 'transactions' : `${logFilter}s`} yet.</h3><p>Add your first expense or record a payment.</p></div>}</section> : <div className="overview-grid"><section className="panel member-panel"><div className="panel-heading"><div><h2>Everyone’s balance</h2><p>A fair share for every person.</p></div><Users size={19}/></div><div className="member-list">{balances.map((b, i) => <div className="balance-row" key={b.member.id}><Avatar member={b.member} index={i}/><div className="balance-member"><strong>{b.member.name}{b.member.id === yourId && <span className="you-tag">YOU</span>}</strong><span>Paid {formatMoney(b.paid, group.currency)}<span className="desktop-member-share"> · Share {formatMoney(b.share, group.currency)}</span></span></div><div className={`member-status ${b.balance < 0 ? 'owes' : b.balance === 0 ? 'settled' : 'owed'}`}><span>{b.balance === 0 ? 'Settled up' : b.balance > 0 ? 'Gets back' : 'Owes'}</span><strong>{b.balance === 0 ? <CheckCheck size={20}/> : formatMoney(Math.abs(b.balance), group.currency)}</strong></div></div>)}</div><div className="panel-footnote"><InfoIcon/><span>Payments are included in each person’s balance.</span></div></section>
          <section className="panel settle-panel"><div className="panel-heading"><div><h2>Settle up simply</h2><p>A few payments. Everyone square.</p></div><ArrowDownLeft size={20}/></div>{settlements.length > 0 ? <div className="settlement-list">{settlements.map((s, i) => <div className="settlement" key={`${s.fromId}-${s.toId}-${i}`}><span className="settlement-number">{i + 1}</span><div><strong>{group.members.find(m => m.id === s.fromId)?.name}<ArrowRight size={13}/>{group.members.find(m => m.id === s.toId)?.name}</strong><span>{formatMoney(s.amount, group.currency)}</span></div><button className="button secondary tiny" disabled={!canEdit} onClick={() => setModal({ type: 'payment', settlement: s })}>Record<span className="sr-only"> payment {i + 1}</span></button></div>)}</div> : <div className="settled-message"><span><CheckCheck size={28}/></span><h3>All square!</h3><p>{group.transactions.length ? 'Everyone is settled up. Onto the next good thing.' : 'No expenses yet. Add the first one when you’re ready.'}</p></div>}<div className="panel-footnote">Suggested payments simplify the group’s net balances.</div></section>
          <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>The latest on your shared tab.</p></div><button className="text-button" onClick={() => navigate(group.inviteCode, true)}>View all<ArrowRight size={15}/></button></div>{transactions.length ? <div className="transaction-list">{transactions.slice(0, 4).map(t => transactionRow(t))}</div> : <div className="panel-empty compact-empty"><ReceiptText size={27}/><p>No activity yet. Make the first expense count.</p><button className="text-button" disabled={!canEdit} onClick={() => setModal({ type: 'expense' })}><Plus size={16}/>Add an expense</button></div>}</section></div>}
        <div className="group-footer"><span><LockKeyhole size={13}/>{group.currency} is fixed for this group.</span><span className="app-version">iou · {appVersion}</span></div>
      </>}
    </main>
    {group ? <div className="mobile-group-actions"><button className="button secondary" disabled={!canEdit} onClick={() => setModal({ type: 'payment' })}><ArrowUpRight size={19}/>Add payment</button><button className="button primary" disabled={!canEdit} onClick={() => setModal({ type: 'expense' })}><Plus size={20}/>Add expense</button></div> : <nav className="mobile-nav" aria-label="Mobile navigation"><button className={!page.groups && !page.transactions ? 'active' : ''} aria-current={!page.groups && !page.transactions ? 'page' : undefined} onClick={() => navigate()}><Home size={22}/><span>Home</span></button><button className={page.groups ? 'active' : ''} aria-current={page.groups ? 'page' : undefined} onClick={navigateGroups}><Users size={23}/><span>Groups</span></button><button className={page.transactions ? 'active' : ''} aria-current={page.transactions ? 'page' : undefined} onClick={navigateTransactions}><History size={22}/><span>Transactions</span></button><button className={modal?.type === 'travel' ? 'active' : ''} aria-haspopup="dialog" aria-expanded={modal?.type === 'travel'} onClick={() => setModal({ type: 'travel' })}><Plane size={22}/><span>Travel mode</span></button></nav>}
    {toast && <div className="toast" role="status"><Check size={18}/><span>{toast}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setToast('')}><X size={15}/></button></div>}
    {needsUpdate && <div className="update-banner" role="status"><span>A fresh version of iou is ready.</span><button onClick={() => void updateServiceWorker(true)}>Update</button><button aria-label="Dismiss update" onClick={() => setNeedsUpdate(false)}><X size={16}/></button></div>}
    {modal?.type === 'create' && <Modal title="Make room for your people." subtitle="Create a group, start a shared tab." onClose={closeModal}><CreateGroupForm onSubmit={createGroup}/></Modal>}
    {modal?.type === 'expense' && group && <Modal title="Add an expense" subtitle={`A little spent together. ${group.currency} only.`} onClose={closeModal}><ExpenseForm group={group} yourId={yourId} onSubmit={addTransaction}/></Modal>}
    {modal?.type === 'payment' && group && <Modal title="Record a payment" subtitle="A step closer to all square." onClose={closeModal}><PaymentForm group={group} initial={modal.settlement} onSubmit={addTransaction}/></Modal>}
    {modal?.type === 'settings' && group && <Modal title={modal.removing ? 'Remove from this device?' : 'Group settings'} subtitle={modal.removing ? modal.group.name : 'A few details that make it yours.'} onClose={closeModal}>
      <div hidden={modal.removing}>
        <SettingsForm group={modal.group} yourId={yourId} onSubmit={saveSettings} onExport={() => void runAction(() => { downloadGroup(group); notify('Group CSV exported.') })}/>
        <div className="device-group-actions"><p>Remove this group from your lists on this device. Everyone else keeps access.</p><button type="button" className="button secondary full" onClick={() => setModal({ ...modal, removing: true })}><LogOut size={17}/>Remove from this device</button></div>
      </div>
      {modal.removing && <RemoveGroupForm group={modal.group} pending={store.outbox.some(item => item.group.id === group.id)} published={store.cloudRevisions[group.id] > 0} travelDefault={store.travelMode.defaultGroupId === modal.group.id} onSubmit={() => removeDeviceGroup(modal.group.id)} onCancel={() => setModal({ ...modal, removing: false })}/>}
    </Modal>}
    {modal?.type === 'join' && <Modal title="Good company awaits." subtitle="Enter your group’s unique invitation code." onClose={closeModal}><JoinForm key={modal.code ?? 'manual'} code={modal.code} configured={cloudConfigured} onQueue={saveJoinRequest} onFetch={fetchInvitation} onJoin={joinGroup}/></Modal>}
    {modal?.type === 'invite'  && group && <Modal title="Bring your people along." subtitle={`Invite someone to ${group.name}.`} onClose={closeModal}><InviteContent group={group} published={store.cloudRevisions[group.id] > 0} onCopy={notify}/></Modal>}
    {modal?.type === 'delete' && group && <Modal title="Delete this transaction?" subtitle="The group’s balances will be recalculated." onClose={closeModal}><div className="delete-preview">{transactionRow(modal.transaction)}</div><p className="help-paragraph">This removes the entry for everyone in the shared group. This action cannot be undone.</p><DeleteForm onSubmit={async () => { await updateGroup(group.id, latest => ({ ...latest, transactions: latest.transactions.filter(t => t.id !== modal.transaction.id) })); closeModal(); notify('Transaction deleted. Balances updated.') }} onCancel={closeModal}/></Modal>}
    {modal?.type === 'travel' && <Modal title="Travel mode" onClose={closeModal}><TravelModeForm groups={store.groups} settings={store.travelMode} onSubmit={saveTravelSettings}/></Modal>}
    {modal?.type === 'help' && <Modal title="Help" onClose={closeModal}><div className="help-content"><ul className="help-list"><li><h3>Split & settle</h3><p>Add expenses, choose a split, and record payments. Each group keeps one fixed currency.</p></li><li><h3>Invite people</h3><p>Share the code from Invite after the first sync. Anyone with it can join and edit. Offline join requests finish when connected.</p></li><li><h3>Travel mode</h3><p>Choose a default group in Travel mode, turn it on, and save. iou opens that group on launch. This setting stays on your device.</p></li><li><h3>Use offline</h3><p>Create and edit offline. Changes save here and sync when connected. If edits conflict, the latest edit wins.</p></li><li><h3>Install on your phone</h3><p>iPhone: Safari → Share → Add to Home Screen.<br/>Android: browser menu → Install app.</p></li><li><h3>Rejoin a group</h3><p>Keep your invitation code to rejoin.</p></li><li><h3>Export a group</h3><p>Export a group CSV from Group settings.</p></li></ul>{!cloudConfigured && <div className="form-note"><InfoIcon/><span>Group creation and joining require Supabase. Set the project URL and public key, and run the included database setup.</span></div>}{recoveryRequired && <button className="text-button" onClick={() => setModal({ type: 'recovery' })}>Recover saved data</button>}</div></Modal>}
    {modal?.type === 'recovery' && <Modal title="Recover your saved data" onClose={closeModal}><p className="help-paragraph">Download the original browser data before resetting. Resetting removes the local cache; your shared groups can be loaded again using your browser session.</p><button className="button secondary full" onClick={() => void runAction(downloadRecovery)}>Download recovery backup</button><button className="button danger full recovery-reset" onClick={() => void runAction(resetSavedData)}>Reset local saved data</button></Modal>}
  </div>
}

function InfoIcon() { return <CircleHelp size={15}/> }
function JoinForm({ code, configured, onFetch, onJoin, onQueue }: { code?: string; configured: boolean; onFetch: (code: string, isCurrent: () => boolean) => Promise<Group | null>; onJoin: (group: Group, selectedId: string, name: string, newMemberId: string) => Promise<void>; onQueue: (code: string, name: string, memberId: string) => void }) {
  const [newMemberId] = useState(() => crypto.randomUUID())
  const [input, setInput] = useState(code || '')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [group, setGroup] = useState<Group | null>(null)
  const [waitingCode, setWaitingCode] = useState('')
  const [identity, setIdentity] = useState('')
  const [yourName, setYourName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try {
      if (!configured) throw new Error('Connect Supabase before creating or joining a group.')
      if (waitingCode) { onQueue(waitingCode, yourName, newMemberId); return }
      if (!group) { const normalized = (input.includes('/join/') ? input.split('/join/').pop()! : input).trim().replace(/\s+/g, '').toLowerCase(); if (!/^[a-f0-9]{32}$/.test(normalized)) throw new Error('Enter the complete 32-character invite code.'); const found = await onFetch(normalized, () => mounted.current); if (!found) setWaitingCode(normalized); else { setGroup(found); setIdentity('') } }
      else { if (!identity && !yourName.trim()) throw new Error('Enter your name or choose an existing member.'); if (!identity && group.members.some(m => m.name.toLowerCase() === yourName.trim().toLowerCase())) throw new Error('That name is already in this group. Select it from the member list.'); await onJoin(group, identity, identity ? group.members.find(m => m.id === identity)!.name : yourName, newMemberId) }
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return <form className="form-stack" onSubmit={submit}>{waitingCode ? <><div className="form-note"><WifiOff size={16}/><span>This group isn’t saved here yet. We’ll join it when connected. Enter your existing member name, or a new name to add.</span></div><label>Your name<input value={yourName} onChange={e => setYourName(e.target.value)} required maxLength={80}/></label><button type="button" className="text-button" onClick={() => setWaitingCode('')}>Use another invitation</button></> : !group ? <><label>Invitation code or link<input disabled={busy} value={input} onChange={e => setInput(e.target.value)} placeholder="Paste your group’s code" required autoCapitalize="none" autoCorrect="off" spellCheck={false}/></label><div className="form-note"><LockKeyhole size={16}/><span>Your invitation unlocks a shared group. Keep it between your people.</span></div></> : <><div className="joined-group-preview"><GroupIcon id={group.icon} color={group.color}/><div><h3>{group.name}</h3><span>{group.members.length} members · {group.currency}</span></div><Check size={20}/></div><label>Who are you in this group?<select value={identity} onChange={e => setIdentity(e.target.value)}><option value="">I’m a new member</option>{group.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{!identity && <label>Your name<input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="Your name in this group" required maxLength={80}/></label>}</>}<FormError error={error}/><SubmitButton busy={busy}>{waitingCode ? 'Save join request' : group ? 'Join group' : 'Find my group'}<ArrowRight size={17}/></SubmitButton>{!configured && <p className="field-hint">Connect Supabase to enable shared invitation codes.</p>}</form>
}
function InviteContent({ group, published, onCopy }: { group: Group; published: boolean; onCopy: (message: string) => void }) {
  const [error, setError] = useState('')
  const link = `${window.location.origin}${window.location.pathname}#/join/${group.inviteCode}`
  const copy = async (text: string, message: string) => { try { await navigator.clipboard.writeText(text); onCopy(message) } catch { setError('Clipboard access is unavailable. Select and copy the code below.') } }
  if (!published) return <div className="form-note"><WifiOff size={17}/><span>Your group is saved on this device. Its invitation code will be ready after the first sync.</span></div>
  return <div className="form-stack"><div className="invite-code-box"><span>YOUR GROUP’S UNIQUE INVITATION CODE</span><input aria-label="Invitation code" readOnly value={group.inviteCode} onFocus={e => e.target.select()}/><button className="button primary full" onClick={() => void copy(group.inviteCode, 'Invitation code copied.')}><Clipboard size={17}/>Copy invitation code</button></div><button className="button secondary full" onClick={() => void copy(link, 'Invite link copied.')}><Link size={17}/>Copy invite link</button><div className="form-note"><Users size={17}/><span>Anyone with this code can join and edit this group. Share it with people you trust.</span></div><FormError error={error}/></div>
}
function DeleteForm({ onSubmit, onCancel }: { onSubmit: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <form className="form-stack" onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); try { await onSubmit() } catch (err) { setError(errorMessage(err)); setBusy(false) } }}><FormError error={error}/><div className="form-columns"><button type="button" className="button secondary" onClick={onCancel}>Keep transaction</button><button className="button danger" disabled={busy}>{busy ? 'Deleting…' : 'Delete transaction'}</button></div></form>
}

function RemoveGroupForm({ group, pending, published, travelDefault, onSubmit, onCancel }: { group: Group; pending: boolean; published: boolean; travelDefault: boolean; onSubmit: () => void; onCancel: () => void }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const copyCode = async () => {
    setError('')
    try { await navigator.clipboard.writeText(group.inviteCode); setCopied(true) }
    catch { setError('Select and copy the invitation code before removing the group.') }
  }
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); setError(''); try { onSubmit() } catch (err) { setError(errorMessage(err)) } }}>
    <p className="help-paragraph">This removes the group, its saved member name, and its pin from this device. The shared group, members, expenses, and payments stay available to everyone else.</p>
    {travelDefault && <div className="form-note"><InfoIcon/><span>Your Travel mode default will also be cleared and Travel mode will turn off.</span></div>}
    {pending && <div className="form-note"><RefreshCw size={17}/><span>Your saved changes will still sync when connected.{!published && ' Sync this new group first if you want to keep its invitation code.'}</span></div>}
    {published && <><label>Invitation code<input readOnly autoFocus value={group.inviteCode} onFocus={event => event.target.select()}/><span className="field-hint">Keep this code to rejoin later.</span></label>
    <button type="button" className="button secondary full" onClick={() => void copyCode()}><Clipboard size={17}/>{copied ? 'Code copied' : 'Copy invitation code'}</button></>}
    <FormError error={error}/>
    <div className="form-columns"><button type="button" className="button secondary" onClick={onCancel}>Keep on this device</button><button type="submit" className="button primary">Remove from this device</button></div>
  </form>
}

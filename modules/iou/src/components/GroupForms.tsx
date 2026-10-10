import { useState, type FormEvent } from 'react'
import { Check, Plus, Trash2, ArrowRight, LoaderCircle, Info } from 'lucide-react'
import type { Group, Member, Transaction } from '../types'
import { CURRENCIES, currencyDigits, formatMoney, parseAmount, splitByPercentages, splitByShares, splitEqually } from '../lib/ledger'
import { GROUP_ICONS, CATEGORIES, Avatar } from './UI'
import type { TravelModeSettings } from '../lib/travelMode'

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function useSubmission(action: () => Promise<void>) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.') } finally { setBusy(false) }
  }
  return { error, busy, submit, clearError: () => setError('') }
}
export function FormError({ error }: { error: string }) { return error ? <div className="form-error" role="alert">{error}</div> : null }
export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) { return <button className="button primary full" type="submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin"/> : null}{busy ? 'Saving…' : children}</button> }

export function TravelModeForm({ groups, settings, onSubmit }: { groups: readonly Group[]; settings: TravelModeSettings; onSubmit: (settings: TravelModeSettings) => Promise<void> }) {
  const [enabled, setEnabled] = useState(settings.enabled)
  const [defaultGroupId, setDefaultGroupId] = useState(settings.defaultGroupId || '')
  const { busy, error, submit } = useSubmission(() => onSubmit({ enabled, defaultGroupId: defaultGroupId || null }))
  return <form className="travel-mode form-stack" onSubmit={submit}>
    <div className="travel-mode-heading"><div><h3>Enable Travel mode</h3><p>Open iou straight to your default group.</p></div><label className="travel-toggle"><input type="checkbox" role="switch" aria-label="Travel mode" checked={enabled} disabled={busy || !groups.length} onChange={event => setEnabled(event.target.checked)}/><span aria-hidden="true"/></label></div>
    {groups.length ? <><label>Default group<select value={defaultGroupId} required={enabled} disabled={busy} onChange={event => setDefaultGroupId(event.target.value)}><option value="">Choose a group</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name} · {group.currency}</option>)}</select></label><span className="field-hint">Saved on this device. You can still open Home and other groups.</span><FormError error={error}/><SubmitButton busy={busy}>Save settings</SubmitButton></> : <p>Create or join a group to use Travel mode.</p>}
  </form>
}

export type NewGroupValues = { id: string; name: string; description: string; currency: string; icon: string; color: string; names: string[] }
export function CreateGroupForm({ onSubmit }: { onSubmit: (values: NewGroupValues) => Promise<void> }) {
  const [groupId] = useState(() => crypto.randomUUID())
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState('THB')
  const [customCurrency, setCustomCurrency] = useState('')
  const [icon, setIcon] = useState(GROUP_ICONS[0])
  const [names, setNames] = useState(['', ''])
  const { busy, error, submit } = useSubmission(async () => {
    const members = names.map(n => n.trim()).filter(Boolean)
    if (!members.length || !names[0].trim()) throw new Error('Add your name to start the group.')
    if (new Set(members.map(n => n.toLowerCase())).size !== members.length) throw new Error('Use a different name for each member.')
    const code = currency === 'custom' ? customCurrency.trim().toUpperCase() : currency
    currencyDigits(code)
    await onSubmit({ id: groupId, name: name.trim(), description: description.trim(), currency: code, icon: icon.id, color: icon.color, names: members })
  })
  return <form onSubmit={submit} className="form-stack">
    <label>Group name<input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bangkok weekend" required maxLength={80}/></label>
    <label>Description <span className="optional">optional</span><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What brings you together?" maxLength={500}/></label>
    <fieldset><legend>Give it a little personality</legend><div className="icon-picker">{GROUP_ICONS.map(item => <button type="button" key={item.id} className={icon.id === item.id ? 'selected' : ''} style={{ background: item.color }} onClick={() => setIcon(item)} aria-label={item.label} aria-pressed={icon.id === item.id}><item.Icon size={24}/>{icon.id === item.id && <Check size={12} className="icon-check"/>}</button>)}</div></fieldset>
    <label>Group currency<select value={currency} onChange={e => setCurrency(e.target.value)}>{CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}<option value="custom">Custom currency</option></select><span className="field-hint">This currency is fixed for the life of the group.</span></label>
    {currency === 'custom' && <label>Currency code<input value={customCurrency} onChange={e => setCustomCurrency(e.target.value.toUpperCase())} placeholder="e.g. GBP" maxLength={3} minLength={3} pattern="[A-Z]{3}" autoCapitalize="characters" autoCorrect="off" spellCheck={false} required/><span className="field-hint">Use a three-letter code. Amounts use two decimal places.</span></label>}
    <fieldset><legend>Who’s in?</legend><div className="member-inputs">{names.map((memberName, i) => <div className="member-input" key={i}><span className="number-dot">{i + 1}</span><input aria-label={i === 0 ? 'Your name' : `Member ${i + 1} name`} placeholder={i === 0 ? 'Your name' : 'Member name'} value={memberName} maxLength={80} required={i === 0} onChange={e => setNames(names.map((n, j) => i === j ? e.target.value : n))}/>{i === 0 ? <span className="you-tag">YOU</span> : <button className="icon-button" type="button" onClick={() => setNames(names.filter((_, j) => i !== j))} aria-label={`Remove member ${i + 1}`}><Trash2 size={16}/></button>}</div>)}</div><button className="text-button" type="button" disabled={names.length >= 100} onClick={() => setNames([...names, ''])}><Plus size={16}/>Add another person</button></fieldset>
    <div className="form-note"><Info size={16}/><span>Every group is shared and gets a unique invitation code. People can join as an existing member or add their name.</span></div>
    <FormError error={error}/><SubmitButton busy={busy}>Create group <ArrowRight size={18}/></SubmitButton>
  </form>
}

const SPLIT_MODES = [
  { id: 'equal', label: 'Equally' },
  { id: 'exact', label: 'Exact amounts' },
  { id: 'percentage', label: 'Percentage' },
  { id: 'shares', label: 'Shares' },
] as const
type SplitMode = typeof SPLIT_MODES[number]['id']

export function ExpenseForm({ group, yourId, onSubmit }: { group: Group; yourId?: string; onSubmit: (transaction: Transaction) => Promise<void> }) {
  const [transactionId] = useState(() => crypto.randomUUID())
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState(yourId || group.members[0].id)
  const [category, setCategory] = useState('food')
  const [date, setDate] = useState(today())
  const [participants, setParticipants] = useState(group.members.map(m => m.id))
  const [mode, setMode] = useState<SplitMode>('equal')
  const [drafts, setDrafts] = useState<Record<Exclude<SplitMode, 'equal'>, Record<string, string>>>(() => ({
    exact: {}, percentage: {}, shares: Object.fromEntries(group.members.map(member => [member.id, '1'])),
  }))
  const calculateShares = (minor: number): Record<string, number> => {
    if (!participants.length) throw new Error('Choose at least one person to split with.')
    if (mode === 'equal') return splitEqually(minor, participants)
    const values = participants.map(id => (drafts[mode][id] || '').trim())
    if (mode === 'percentage') return splitByPercentages(minor, participants, values)
    if (mode === 'shares') return splitByShares(minor, participants, values)
    const shares = Object.fromEntries(participants.map((id, index) => [id, /^0(?:\.0{1,2})?$/.test(values[index]!) ? 0 : parseAmount(values[index]!, group.currency)]))
    if (Object.values(shares).reduce((sum, value) => sum + value, 0) !== minor) throw new Error('The individual amounts must add up to the expense amount.')
    return shares
  }
  let preview: Record<string, number> = {}
  try { preview = calculateShares(parseAmount(amount, group.currency)) } catch { /* Incomplete or invalid splits have no preview yet. */ }
  const { error, busy, submit, clearError } = useSubmission(async () => {
    const minor = parseAmount(amount, group.currency)
    if (!description.trim()) throw new Error('Give this expense a description.')
    const shares = calculateShares(minor)
    await onSubmit({ id: transactionId, type: 'expense', description: description.trim(), amount: minor, paidBy, shares, category, date, createdAt: new Date().toISOString() })
  })
  return <form className="form-stack" onSubmit={submit} onChange={clearError}>
    <label>Description<input placeholder="What was it for?" value={description} onChange={e => setDescription(e.target.value)} required maxLength={160}/></label>
    <label>Amount<div className="amount-input"><span>{group.currency}</span><input inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} required aria-label={`Amount in ${group.currency}`}/></div></label>
    <div className="form-columns"><label>Paid by<select value={paidBy} onChange={e => setPaidBy(e.target.value)}>{group.members.map(m => <option key={m.id} value={m.id}>{m.name}{m.id === yourId ? ' (you)' : ''}</option>)}</select></label><label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} required/></label></div>
    <label>Category<select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
    <fieldset><legend>Split between</legend>
      <div className="segmented small split-modes" role="group" aria-label="Split method">{SPLIT_MODES.map(item => <button key={item.id} type="button" onClick={() => { setMode(item.id); clearError() }} aria-pressed={mode === item.id} className={mode === item.id ? 'active' : ''}>{item.label}</button>)}</div>
      <div className="split-members">{group.members.map((m, i) => <div className="split-member" key={m.id}>
        <label className="checkbox-label"><input type="checkbox" checked={participants.includes(m.id)} onChange={() => setParticipants(participants.includes(m.id) ? participants.filter(id => id !== m.id) : [...participants, m.id])}/><Avatar member={m} index={i} small/><span>{m.name}</span></label>
        {participants.includes(m.id) && (mode === 'equal' ? <span className="split-amount">{preview[m.id] === undefined ? '—' : formatMoney(preview[m.id], group.currency)}</span> : <div className="split-value">
          <div className={`split-input-wrap${mode === 'percentage' ? ' has-suffix' : ''}`}><input className="split-input" inputMode={mode === 'shares' ? 'numeric' : 'decimal'} aria-label={mode === 'exact' ? `${m.name} amount in ${group.currency}` : mode === 'percentage' ? `${m.name} percentage` : `${m.name} shares`} value={drafts[mode][m.id] ?? ''} placeholder={mode === 'exact' ? '0.00' : mode === 'percentage' ? '0' : '1'} onChange={e => setDrafts({ ...drafts, [mode]: { ...drafts[mode], [m.id]: e.target.value } })}/>{mode === 'percentage' && <span aria-hidden="true">%</span>}</div>
          {mode !== 'exact' && <output className="split-preview">{preview[m.id] === undefined ? '—' : formatMoney(preview[m.id], group.currency)}</output>}
        </div>)}
      </div>)}</div>
      <span className="field-hint">{mode === 'equal' ? 'Any leftover satang or cents are distributed one at a time.' : mode === 'exact' ? `Enter each person’s amount in ${group.currency}. All amounts must equal the total.` : mode === 'percentage' ? 'Enter percentages totaling 100%. Rounding keeps every satang or cent accounted for.' : 'Enter whole-number shares. For a total of 30, shares of 3, 2, and 1 split into 15, 10, and 5.'}</span>
    </fieldset>
    <FormError error={error}/><SubmitButton busy={busy}>Add expense</SubmitButton>
  </form>
}

export function PaymentForm({ group, initial, onSubmit }: { group: Group; initial?: { fromId: string; toId: string; amount: number }; onSubmit: (transaction: Transaction) => Promise<void> }) {
  const [transactionId] = useState(() => crypto.randomUUID())
  const [fromId, setFromId] = useState(initial?.fromId || group.members[0].id)
  const [toId, setToId] = useState(initial?.toId || group.members[1]?.id || '')
  const [amount, setAmount] = useState(initial ? (initial.amount / 100).toFixed(2) : '')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(today())
  const { error, busy, submit } = useSubmission(async () => {
    if (fromId === toId) throw new Error('Choose two different people.')
    if (!toId) throw new Error('Add a second member before recording a payment.')
    await onSubmit({ id: transactionId, type: 'payment', fromId, toId, amount: parseAmount(amount, group.currency), note: note.trim(), date, createdAt: new Date().toISOString() })
  })
  return <form className="form-stack" onSubmit={submit}>
    <div className="form-note"><Info size={16}/><span>Record money that has already been paid. iou doesn’t transfer money.</span></div>
    <div className="form-columns"><label>From<select value={fromId} onChange={e => setFromId(e.target.value)}>{group.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>To<select value={toId} onChange={e => setToId(e.target.value)}>{group.members.length < 2 && <option value="">Add a member first</option>}{group.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div>
    <label>Amount<div className="amount-input"><span>{group.currency}</span><input inputMode="decimal" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} required aria-label={`Payment amount in ${group.currency}`}/></div></label>
    <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} required/></label>
    <label>Note <span className="optional">optional</span><input placeholder="e.g. Bank transfer" value={note} onChange={e => setNote(e.target.value)} maxLength={500}/></label>
    <FormError error={error}/><SubmitButton busy={busy}>Record payment</SubmitButton>
  </form>
}

export type SettingsValues = Pick<Group, 'name' | 'description' | 'icon' | 'color' | 'members'> & { yourId: string }
export function SettingsForm({ group, yourId, onSubmit, onExport }: { group: Group; yourId?: string; onSubmit: (values: SettingsValues) => Promise<void>; onExport: () => void }) {
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const [members, setMembers] = useState<Member[]>(group.members.map(m => ({ ...m })))
  const [identity, setIdentity] = useState(yourId || group.members[0].id)
  const [icon, setIcon] = useState(GROUP_ICONS.find(i => i.id === group.icon) || GROUP_ICONS[0])
  const usedIds = new Set(group.transactions.flatMap(t => t.type === 'expense' ? [t.paidBy, ...Object.keys(t.shares)] : [t.fromId, t.toId]))
  const { error, busy, submit } = useSubmission(async () => {
    const cleaned = members.map(m => ({ ...m, name: m.name.trim() }))
    if (!name.trim() || cleaned.some(m => !m.name)) throw new Error('Enter a group name and a name for every member.')
    if (new Set(cleaned.map(m => m.name.toLowerCase())).size !== cleaned.length) throw new Error('Use a different name for each member.')
    if (!cleaned.some(m => m.id === identity)) throw new Error('Choose your member name.')
    await onSubmit({ name: name.trim(), description: description.trim(), members: cleaned, icon: icon.id, color: icon.color, yourId: identity })
  })
  return <form className="form-stack" onSubmit={submit}>
    <label>Group name<input value={name} onChange={e => setName(e.target.value)} required maxLength={80}/></label>
    <label>Description<input value={description} onChange={e => setDescription(e.target.value)} maxLength={500}/></label>
    <div className="fixed-currency"><span>Group currency</span><strong>{group.currency}</strong><span className="field-hint">Fixed when this group was created.</span></div>
    <fieldset><legend>Group icon</legend><div className="icon-picker">{GROUP_ICONS.map(item => <button key={item.id} type="button" style={{ background: item.color }} className={item.id === icon.id ? 'selected' : ''} onClick={() => setIcon(item)} aria-label={item.label} aria-pressed={item.id === icon.id}><item.Icon size={24}/></button>)}</div></fieldset>
    <fieldset><legend>Members</legend><div className="member-inputs">{members.map((m, i) => <div className="member-input" key={m.id}><Avatar member={m} index={i} small/><input aria-label={`Member ${i + 1} name`} value={m.name} required maxLength={80} onChange={e => setMembers(members.map(member => member.id === m.id ? { ...member, name: e.target.value } : member))}/><button type="button" className="icon-button" disabled={usedIds.has(m.id) || members.length === 1} title={usedIds.has(m.id) ? 'Members with transactions cannot be removed' : 'Remove member'} aria-label={`Remove ${m.name}`} onClick={() => setMembers(members.filter(member => member.id !== m.id))}><Trash2 size={16}/></button></div>)}</div><button type="button" className="text-button" disabled={members.length >= 100} onClick={() => setMembers([...members, { id: crypto.randomUUID(), name: '' }])}><Plus size={16}/>Add member</button><span className="field-hint">Members with expenses or payments stay in the group to preserve its history.</span></fieldset>
    <label>Your member name<select value={identity} onChange={e => setIdentity(e.target.value)}>{members.map(m => <option value={m.id} key={m.id}>{m.name || 'New member'}</option>)}</select><span className="field-hint">Used for your balance on this device.</span></label>
    <button className="button secondary full" type="button" onClick={onExport}>Export group CSV</button>
    <FormError error={error}/><SubmitButton busy={busy}>Save changes</SubmitButton>
  </form>
}

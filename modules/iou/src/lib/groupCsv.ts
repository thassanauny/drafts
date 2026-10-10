import type { Group } from '../types'
import { validateGroup } from './ledger'

const COLUMNS = ['record', 'version', 'id', 'name', 'description', 'currency', 'icon', 'color', 'invite_code', 'created_at', 'updated_at', 'date', 'amount', 'paid_by', 'from_id', 'to_id', 'category', 'note'] as const
type Column = typeof COLUMNS[number]

// Protect formulas, numeric-looking identifiers, dates, and literal apostrophes.
// Numeric money cells stay numeric.
function protectText(value: string): string {
  return value.startsWith("'") || /^[\s]*[=+@-]|^[\t\r\n\d]|^\.\d/.test(value) ? "'" + value : value
}
function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}
function decimal(amount: number): string {
  const minor = BigInt(amount)
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`
}

/** A single spreadsheet table preserves group metadata, members, and all transactions. */
export function exportGroupCsv(input: Group): string {
  const group = validateGroup(input)
  const headers = [...COLUMNS, ...group.members.map(member => `share:${member.id}:${member.name}`)]
  const row = (values: Partial<Record<Column, string>>, shares?: Record<string, number>) => [
    ...COLUMNS.map(column => column === 'amount' || column === 'version' ? values[column] || '' : protectText(values[column] || '')),
    ...group.members.map(member => shares?.[member.id] === undefined ? '' : decimal(shares[member.id]!)),
  ].map(quote).join(',')
  const rows = [headers.map(quote).join(','), row({
    record: 'group', version: '1', id: group.id, name: group.name, description: group.description,
    currency: group.currency, icon: group.icon, color: group.color, invite_code: group.inviteCode,
    created_at: group.createdAt, updated_at: group.updatedAt,
  })]
  for (const member of group.members) rows.push(row({ record: 'member', id: member.id, name: member.name }))
  for (const transaction of group.transactions) {
    const common = { record: transaction.type, id: transaction.id, amount: decimal(transaction.amount), date: transaction.date, created_at: transaction.createdAt }
    rows.push(transaction.type === 'expense'
      ? row({ ...common, description: transaction.description, paid_by: transaction.paidBy, category: transaction.category }, transaction.shares)
      : row({ ...common, from_id: transaction.fromId, to_id: transaction.toId, note: transaction.note }))
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n'
}

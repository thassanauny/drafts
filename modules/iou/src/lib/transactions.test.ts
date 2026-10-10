import { describe, expect, it } from 'vitest'
import type { Expense, Group, Payment } from '../types'
import { getTransactionFeed } from './transactions'

const now = '2026-10-08T09:00:00.000Z'
const expense: Expense = { id: 'entry', type: 'expense', description: 'Dinner', amount: 1_001, paidBy: 'alex', shares: { alex: 501, sam: 500 }, category: 'food', date: '2026-10-08', createdAt: now }
const payment: Payment = { id: 'entry', type: 'payment', amount: 500, fromId: 'alex', toId: 'sam', note: 'Transfer', date: '2026-10-08', createdAt: now }
function group(id: string, currency: string, transactions: Group['transactions']): Group {
  return { id, name: `Group ${id}`, description: '', currency, icon: 'food', color: '#faead6', inviteCode: 'a'.repeat(32), createdAt: now, updatedAt: now, members: [{ id: 'alex', name: `${id} Alex` }, { id: 'sam', name: `${id} Sam` }], transactions }
}

describe('transactions across groups', () => {
  it('includes every expense and payment with its own group, currency, and members', () => {
    const groups = [group('usd', 'USD', [expense]), group('cad', 'CAD', [payment]), group('empty', 'THB', [])]
    const before = structuredClone(groups)
    const entries = getTransactionFeed(groups)
    expect(entries).toHaveLength(2)
    expect(entries.map(entry => [entry.group.id, entry.group.currency, entry.transaction.type, entry.transaction.amount])).toEqual([
      ['cad', 'CAD', 'payment', 500], ['usd', 'USD', 'expense', 1_001],
    ])
    expect(entries[0]!.group.members[0]!.name).toBe('cad Alex')
    expect(entries[1]!.group.members[0]!.name).toBe('usd Alex')
    expect(groups).toEqual(before)
  })

  it('orders by ledger date, then recorded time, including equivalent timestamp formats', () => {
    const transactions = [
      { ...expense, id: 'older-date', date: '2026-10-07', createdAt: '2026-10-09T10:00:00.000Z' },
      { ...expense, id: 'earlier', createdAt: '2026-10-08T09:00:00Z' },
      { ...expense, id: 'later', createdAt: '2026-10-08T09:00:00.001Z' },
    ]
    expect(getTransactionFeed([group('trip', 'THB', transactions)]).map(entry => entry.transaction.id)).toEqual(['later', 'earlier', 'older-date'])
    expect(transactions.map(entry => entry.id)).toEqual(['older-date', 'earlier', 'later'])
  })

  it('keeps repeated transaction IDs in different groups and ties stable across refresh order', () => {
    const groups = [group('z', 'USD', [expense]), group('a', 'BDT', [expense])]
    expect(getTransactionFeed(groups).map(entry => entry.group.id)).toEqual(['a', 'z'])
    expect(getTransactionFeed([...groups].reverse()).map(entry => entry.group.id)).toEqual(['a', 'z'])
  })

  it('filters types across every group and handles empty or removed group lists', () => {
    const groups = [group('one', 'USD', [expense, { ...payment, id: 'paid-one' }]), group('two', 'BDT', [{ ...expense, id: 'dinner-two' }, payment])]
    expect(getTransactionFeed(groups, 'expense').map(entry => entry.group.id)).toEqual(['two', 'one'])
    expect(getTransactionFeed(groups, 'payment').map(entry => entry.group.id)).toEqual(['two', 'one'])
    expect(getTransactionFeed(groups.slice(1))).toHaveLength(2)
    expect(getTransactionFeed([])).toEqual([])
    expect(getTransactionFeed([group('empty', 'THB', [])], 'payment')).toEqual([])
  })
})

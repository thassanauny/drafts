import { describe, expect, it } from 'vitest'
import type { Group } from '../types'
import { exportGroupCsv } from './groupCsv'
import { MAX_AMOUNT_MINOR } from './ledger'

const now = '2026-10-08T08:00:00.000Z'
function fixture(currency = 'THB'): Group {
  return {
    id: 'csv-trip', name: 'Trip, together', description: 'Dinner "and" a ride\nBangkok to Dhaka', currency,
    icon: 'adventure', color: '#e8e1f1', inviteCode: 'a'.repeat(32), createdAt: now, updatedAt: now,
    members: [{ id: 'amy', name: 'Amy' }, { id: 'ben', name: 'Ben' }, { id: 'cam', name: 'Cam' }],
    transactions: [
      { id: 'dinner', type: 'expense', description: 'Dinner, "shared"\r\nอร่อย 🍜', amount: 3_000, paidBy: 'amy', shares: { amy: 1_500, ben: 1_000, cam: 500 }, category: 'food', date: '2026-10-08', createdAt: now },
      { id: 'taxi', type: 'expense', description: 'Taxi', amount: 101, paidBy: 'cam', shares: { ben: 101, cam: 0 }, category: 'transport', date: '2026-10-08', createdAt: now },
      { id: 'paid', type: 'payment', fromId: 'ben', toId: 'amy', amount: 1_000, note: 'Transfer, thanks\nধন্যবাদ', date: '2026-10-08', createdAt: now },
    ],
  }
}

describe('complete group CSV export', () => {
  it.each(['THB', 'BDT', 'USD', 'CAD', 'EUR', 'GBP', 'XYZ'])('exports metadata, members, expenses, payments, and exact shares in %s', currency => {
    const original = fixture(currency)
    const csv = exportGroupCsv(original)
    expect(csv).toContain(`,${currency},adventure,#e8e1f1,${original.inviteCode},`)
    expect(csv).toContain('share:amy:Amy,share:ben:Ben,share:cam:Cam')
    expect(csv).toContain('member,,amy,Amy,')
    expect(csv).toContain('30.00,amy')
    expect(csv).toContain('15.00,10.00,5.00')
    expect(csv).toContain('10.00,,ben,amy,')
    expect(original.members[0]!.name).toBe('Amy')
  })

  it('quotes commas, embedded quotes, newlines, and Unicode for spreadsheet readers', () => {
    const csv = exportGroupCsv(fixture())
    expect(csv.startsWith('\uFEFFrecord,version,id,name,description,currency')).toBe(true)
    expect(csv).toContain('"Trip, together"')
    expect(csv).toContain('"Dinner, ""shared""\r\nอร่อย 🍜"')
    expect(csv).toContain('"Transfer, thanks\nধন্যবাদ"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('distinguishes excluded members from selected members with a zero share', () => {
    const row = exportGroupCsv(fixture()).split('\r\n').find(line => line.startsWith('expense,,taxi,'))!
    expect(row.split(',').slice(-3)).toEqual(['', '1.01', '0.00'])
  })

  it('preserves the maximum monetary amount without floating-point conversion', () => {
    const original = fixture()
    const expense = original.transactions[0]!
    if (expense.type === 'expense') { expense.amount = MAX_AMOUNT_MINOR; expense.shares = { amy: MAX_AMOUNT_MINOR - 1, ben: 1, cam: 0 } }
    const csv = exportGroupCsv(original)
    expect(csv).toContain('10000000000.00,amy')
    expect(csv).toContain('9999999999.99,0.01,0.00')
  })

  it('keeps numeric-looking IDs, leading zeros, and dates as spreadsheet text', () => {
    const original: Group = {
      ...fixture(), id: '0001', members: [{ id: '001', name: '007' }, { id: '1e3', name: 'Other' }],
      transactions: [{ id: '0002', type: 'expense', description: 'Lunch', amount: 100, paidBy: '001', shares: { '001': 50, '1e3': 50 }, category: 'food', date: '2026-10-08', createdAt: now }],
    }
    const csv = exportGroupCsv(original)
    expect(csv).toContain("group,1,'0001")
    expect(csv).toContain("member,,'001,'007")
    expect(csv).toContain("'2026-10-08,1.00,'001")
  })

  it('exports empty groups with their metadata and member rows', () => {
    const csv = exportGroupCsv({ ...fixture(), description: '', members: [{ id: 'one', name: 'One' }], transactions: [] })
    expect(csv.split('\r\n')).toHaveLength(4)
    expect(csv).toContain('member,,one,One,')
  })

  it.each(['=SUM(1,2)', '+1+2', '-1+2', '@SUM(A1)', "'literal", "''literal"])('protects spreadsheet text: %s', text => {
    const original = fixture()
    original.name = text
    original.members[0]!.name = text
    const transaction = original.transactions[0]!
    if (transaction.type === 'expense') transaction.description = text
    const protectedText = "'" + text
    const cell = /[",\r\n]/.test(protectedText) ? `"${protectedText.replaceAll('"', '""')}"` : protectedText
    expect(exportGroupCsv(original)).toContain(cell)
  })

  it('rejects invalid group data before exporting', () => {
    const original = fixture()
    const expense = original.transactions[0]!
    if (expense.type === 'expense') expense.paidBy = 'missing'
    expect(() => exportGroupCsv(original)).toThrow(/existing member/)
  })
})

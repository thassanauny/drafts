import type { Group, Transaction } from '../types'

export type TransactionFilter = 'all' | Transaction['type']
export interface GroupTransaction {
  group: Group
  transaction: Transaction
}

/** Newest ledger dates first, with stable ordering for entries recorded together. */
export function compareTransactions(left: Transaction, right: Transaction): number {
  return right.date.localeCompare(left.date)
    || Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || left.id.localeCompare(right.id)
}

export function getTransactionFeed(groups: readonly Group[], filter: TransactionFilter = 'all'): GroupTransaction[] {
  return groups.flatMap(group => group.transactions
    .filter(transaction => filter === 'all' || transaction.type === filter)
    .map(transaction => ({ group, transaction })))
    .sort((left, right) => compareTransactions(left.transaction, right.transaction)
      || left.group.id.localeCompare(right.group.id))
}

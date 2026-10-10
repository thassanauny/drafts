import type { Expense, Group, Member, MemberBalance, Payment, Settlement, Transaction } from '../types';

export const CURRENCIES = [
  { code: 'THB', label: 'Thai baht', digits: 2 },
  { code: 'BDT', label: 'Bangladeshi taka', digits: 2 },
  { code: 'USD', label: 'US dollar', digits: 2 },
  { code: 'CAD', label: 'Canadian dollar', digits: 2 },
  { code: 'EUR', label: 'Euro', digits: 2 },
] as const;

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;
export const MAX_MEMBERS = 100;
export const MAX_TRANSACTIONS = 5_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GROUP_KEYS = ['id', 'name', 'description', 'currency', 'icon', 'color', 'inviteCode', 'createdAt', 'updatedAt', 'members', 'transactions'];
const EXPENSE_KEYS = ['id', 'type', 'description', 'amount', 'paidBy', 'shares', 'category', 'date', 'createdAt'];
const PAYMENT_KEYS = ['id', 'type', 'fromId', 'toId', 'amount', 'note', 'date', 'createdAt'];

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) fail(`${label} contains an unsafe key.`);
    if (allowedKeys && !allowedKeys.includes(key)) fail(`${label} contains an unsupported field: ${key}.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) fail(`${label} must contain ordinary values.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(`${label} must be text of at most ${max} characters.`);
  }
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${label} is required.`);
  return trimmed;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) || FORBIDDEN_KEYS.has(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function day(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be a date in YYYY-MM-DD format.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(`${label} is not a valid date.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) {
    fail(`${label} must be an ISO UTC timestamp.`);
  }
  day(value.slice(0, 10), label);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is invalid.`);
  return value;
}

function money(value: unknown, label: string, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_AMOUNT_MINOR) {
    fail(`${label} must be ${allowZero ? 'a nonnegative' : 'a positive'} integer amount no greater than ${MAX_AMOUNT_MINOR}.`);
  }
  return value;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail('The group total exceeds the supported amount.');
  return result;
}

function validateMembers(members: unknown): Member[] {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS) {
    fail(`A group must have between 1 and ${MAX_MEMBERS} members.`);
  }
  const seen = new Set<string>();
  return members.map((value) => {
    const member = record(value, 'Member', ['id', 'name']);
    const memberId = id(member.id, 'Member ID');
    if (seen.has(memberId)) fail('Member IDs must be unique.');
    seen.add(memberId);
    return { id: memberId, name: string(member.name, 'Member name', 80) };
  });
}

export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) fail('Use a three-letter currency code, such as GBP.');
  return 2;
}

/** Convert decimal text without introducing floating-point rounding. */
export function parseAmount(input: string, currency: string): number {
  const digits = currencyDigits(currency);
  if (typeof input !== 'string') fail('Enter a valid amount.');
  const trimmed = input.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed) || trimmed.length > 32) fail('Enter a valid positive amount.');
  const [whole = '', fraction = ''] = trimmed.split('.');
  if (fraction.length > digits) fail(`${currency} allows ${digits} decimal places.`);
  const minor = BigInt(whole || '0') * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (minor < 1n || minor > BigInt(MAX_AMOUNT_MINOR)) fail('The amount must be positive and within the supported limit.');
  return Number(minor);
}

export function formatMoney(minor: number | bigint, currency: string, options: { includeCurrency?: boolean } = {}): string {
  const digits = currencyDigits(currency);
  if (typeof minor !== 'bigint' && !Number.isSafeInteger(minor)) fail('Money must use integer minor units.');
  const integer = BigInt(minor);
  const formatter = new Intl.NumberFormat('en-US', { style: options.includeCurrency === false ? 'decimal' : 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  const absolute = integer < 0n ? -integer : integer;
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(digits, '0');
  const signedWhole = integer < 0n ? whole === 0n ? -0 : -whole : whole;
  return formatter.formatToParts(signedWhole).map((part) => part.type === 'fraction' ? fraction : part.value).join('');
}

/** Keep credits and debts separate, and aggregate exactly across any number of groups. */
export function getCurrencyBalances(entries: readonly { currency: string; balance: number }[]): Array<{ code: string; label: string; digits: number; owed: bigint; owes: bigint }> {
  const totals: Array<{ code: string; label: string; digits: number; owed: bigint; owes: bigint }> = CURRENCIES.map(({ code, label, digits }) => ({ code, label, digits, owed: 0n, owes: 0n }));
  for (const entry of entries) {
    const digits = currencyDigits(entry.currency);
    let total = totals.find((currency) => currency.code === entry.currency);
    if (!total) {
      total = { code: entry.currency, label: entry.currency, digits, owed: 0n, owes: 0n };
      totals.push(total);
    }
    if (!Number.isSafeInteger(entry.balance)) fail('Money must use integer minor units.');
    const balance = BigInt(entry.balance);
    if (balance > 0n) total.owed += balance;
    else total.owes -= balance;
  }
  return totals;
}

function validateParticipants(memberIds: readonly string[]): void {
  if (memberIds.length < 1 || memberIds.length > MAX_MEMBERS) fail('Choose at least one participant.');
  const seen = new Set<string>();
  for (const memberId of memberIds) {
    id(memberId, 'Participant ID');
    if (seen.has(memberId)) fail('Participants must be unique.');
    seen.add(memberId);
  }
}

/** The first participants receive any indivisible remainder, in the supplied order. */
export function splitEqually(amount: number, memberIds: readonly string[]): Record<string, number> {
  money(amount, 'Expense amount');
  validateParticipants(memberIds);
  const base = Math.floor(amount / memberIds.length);
  const remainder = amount % memberIds.length;
  return Object.fromEntries(memberIds.map((memberId, index) => [memberId, base + (index < remainder ? 1 : 0)]));
}

/** Round proportional splits by largest remainder, breaking ties in participant order. */
function splitProportionally(amount: number, memberIds: readonly string[], weights: readonly bigint[]): Record<string, number> {
  money(amount, 'Expense amount');
  validateParticipants(memberIds);
  if (weights.length !== memberIds.length) fail('Enter a value for every selected participant.');
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (total === 0n) fail('At least one person must have a positive number of shares.');
  const portions = weights.map((weight, index) => {
    const numerator = BigInt(amount) * weight;
    return { index, amount: Number(numerator / total), remainder: numerator % total };
  });
  const leftover = amount - portions.reduce((sum, portion) => sum + portion.amount, 0);
  const ranked = [...portions].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < leftover; index += 1) ranked[index]!.amount += 1;
  return Object.fromEntries(memberIds.map((memberId, index) => [memberId, portions[index]!.amount]));
}

/** Percentages use exact hundredths and must total 100%. */
export function splitByPercentages(amount: number, memberIds: readonly string[], percentages: readonly string[]): Record<string, number> {
  const weights = percentages.map((input) => {
    if (typeof input !== 'string' || input.length > 32 || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(input.trim())) {
      fail('Enter a percentage from 0 to 100 with up to two decimal places for each selected person.');
    }
    const [whole = '', fraction = ''] = input.trim().split('.');
    const value = BigInt(whole || '0') * 100n + BigInt(fraction.padEnd(2, '0') || '0');
    if (value > 10_000n) fail('Each percentage must be between 0 and 100.');
    return value;
  });
  if (weights.reduce((sum, weight) => sum + weight, 0n) !== 10_000n) fail('Percentages must add up to exactly 100%.');
  return splitProportionally(amount, memberIds, weights);
}

/** Whole-number weights express relative shares, such as 3:2:1. */
export function splitByShares(amount: number, memberIds: readonly string[], shares: readonly string[]): Record<string, number> {
  const weights = shares.map((input) => {
    if (typeof input !== 'string' || input.length > 32 || !/^\d+$/.test(input.trim())) {
      fail('Enter a nonnegative whole number of shares for each selected person.');
    }
    const value = BigInt(input.trim());
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('The number of shares is too large.');
    return value;
  });
  return splitProportionally(amount, memberIds, weights);
}

function readTransaction(input: unknown, members: readonly Member[]): Transaction {
  const initial = record(input, 'Transaction');
  const keys = initial.type === 'expense' ? EXPENSE_KEYS : initial.type === 'payment' ? PAYMENT_KEYS : fail('Transaction type is invalid.');
  const value = record(input, 'Transaction', keys);
  const memberIds = new Set(members.map((member) => member.id));
  const memberReference = (inputId: unknown, label: string): string => {
    const memberId = id(inputId, label);
    if (!memberIds.has(memberId)) fail(`${label} must reference an existing member.`);
    return memberId;
  };
  const common = {
    id: id(value.id, 'Transaction ID'),
    amount: money(value.amount, 'Transaction amount'),
    date: day(value.date, 'Transaction date'),
    createdAt: timestamp(value.createdAt, 'Transaction creation time'),
  };
  if (value.type === 'expense') {
    const sharesInput = record(value.shares, 'Expense shares');
    const entries = Object.entries(sharesInput);
    if (entries.length < 1 || entries.length > MAX_MEMBERS) fail('An expense needs participants.');
    let sum = 0;
    const shares: Record<string, number> = {};
    for (const [memberId, amount] of entries) {
      memberReference(memberId, 'Participant');
      const share = money(amount, 'Participant share', true);
      sum = safeAdd(sum, share);
      shares[memberId] = share;
    }
    if (sum !== common.amount) fail('Participant shares must add up to the expense amount.');
    const expense: Expense = {
      ...common,
      type: 'expense',
      description: string(value.description, 'Expense description', 160),
      paidBy: memberReference(value.paidBy, 'Payer'),
      shares,
      category: string(value.category, 'Expense category', 40),
    };
    return expense;
  }
  const fromId = memberReference(value.fromId, 'Payment sender');
  const toId = memberReference(value.toId, 'Payment recipient');
  if (fromId === toId) fail('Payment sender and recipient must be different members.');
  const payment: Payment = { ...common, type: 'payment', fromId, toId, note: string(value.note, 'Payment note', 500, false) };
  return payment;
}

export function validateTransaction(transaction: Transaction, members: readonly Member[]): void {
  readTransaction(transaction, validateMembers(members));
}

/** Validate and clone group data before any of its fields enter local storage. */
export function validateGroup(input: unknown): Group {
  const value = record(input, 'Group', GROUP_KEYS);
  const members = validateMembers(value.members);
  if (!Array.isArray(value.transactions) || value.transactions.length > MAX_TRANSACTIONS) fail(`Groups support up to ${MAX_TRANSACTIONS} transactions.`);
  const seen = new Set<string>();
  const transactions = value.transactions.map((inputTransaction) => {
    const transaction = readTransaction(inputTransaction, members);
    if (seen.has(transaction.id)) fail('Transaction IDs must be unique.');
    seen.add(transaction.id);
    return transaction;
  });
  const currency = string(value.currency, 'Currency', 3);
  currencyDigits(currency);
  const color = string(value.color, 'Group color', 9);
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) fail('Group color must be a hex color.');
  const inviteCode = string(value.inviteCode, 'Invite code', 32);
  if (!/^[a-f0-9]{32}$/.test(inviteCode)) fail('Invite code is invalid.');
  const createdAt = timestamp(value.createdAt, 'Group creation time');
  const updatedAt = timestamp(value.updatedAt, 'Group update time');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('Group update time cannot be before its creation time.');
  const group: Group = {
    id: id(value.id, 'Group ID'),
    name: string(value.name, 'Group name', 80),
    description: string(value.description, 'Group description', 500, false),
    currency,
    icon: string(value.icon, 'Group icon', 32),
    color,
    inviteCode,
    createdAt,
    updatedAt,
    members,
    transactions,
  };
  getBalances(group);
  return group;
}

export function getBalances(group: Group): MemberBalance[] {
  const members = validateMembers(group.members);
  const balances = members.map((member) => ({ member, paid: 0, share: 0, balance: 0 }));
  const byId = new Map(balances.map((entry) => [entry.member.id, entry]));
  for (const input of group.transactions) {
    const transaction = readTransaction(input, members);
    if (transaction.type === 'expense') {
      const payer = byId.get(transaction.paidBy)!;
      payer.paid = safeAdd(payer.paid, transaction.amount);
      payer.balance = safeAdd(payer.balance, transaction.amount);
      for (const [memberId, share] of Object.entries(transaction.shares)) {
        const participant = byId.get(memberId)!;
        participant.share = safeAdd(participant.share, share);
        participant.balance = safeAdd(participant.balance, -share);
      }
    } else {
      const sender = byId.get(transaction.fromId)!;
      const recipient = byId.get(transaction.toId)!;
      sender.balance = safeAdd(sender.balance, transaction.amount);
      recipient.balance = safeAdd(recipient.balance, -transaction.amount);
    }
  }
  return balances;
}

export function getSettlements(group: Group): Settlement[] {
  const balances = getBalances(group);
  const order = (left: { id: string; amount: number }, right: { id: string; amount: number }) => right.amount - left.amount || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const debtors = balances.filter((entry) => entry.balance < 0).map((entry) => ({ id: entry.member.id, amount: -entry.balance })).sort(order);
  const creditors = balances.filter((entry) => entry.balance > 0).map((entry) => ({ id: entry.member.id, amount: entry.balance })).sort(order);
  const settlements: Settlement[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]!;
    const creditor = creditors[creditorIndex]!;
    const amount = Math.min(debtor.amount, creditor.amount, MAX_AMOUNT_MINOR);
    settlements.push({ fromId: debtor.id, toId: creditor.id, amount });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }
  return settlements;
}

export function totalSpent(group: Group): number {
  return group.transactions.reduce((total, transaction) => transaction.type === 'expense' ? safeAdd(total, money(transaction.amount, 'Expense amount')) : total, 0);
}

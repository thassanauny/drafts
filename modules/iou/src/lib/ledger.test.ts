import { describe, expect, it } from 'vitest';
import type { Expense, Group, Payment, Transaction } from '../types';
import { CURRENCIES, MAX_AMOUNT_MINOR, MAX_MEMBERS, MAX_TRANSACTIONS, currencyDigits, formatMoney, getBalances, getCurrencyBalances, getSettlements, parseAmount, splitByPercentages, splitByShares, splitEqually, totalSpent, validateGroup, validateTransaction } from './ledger';

const now = '2026-10-07T09:00:00.000Z';
const members = [{ id: 'amy', name: 'Amy' }, { id: 'ben', name: 'Ben' }, { id: 'cam', name: 'Cam' }];

function expense(overrides: Partial<Expense> = {}): Expense {
  return { id: 'dinner', type: 'expense', description: 'Dinner', amount: 1_000, paidBy: 'amy', shares: { amy: 334, ben: 333, cam: 333 }, category: 'food', date: '2026-10-07', createdAt: now, ...overrides };
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return { id: 'settlement', type: 'payment', fromId: 'ben', toId: 'amy', amount: 333, note: '', date: '2026-10-07', createdAt: now, ...overrides };
}

function group(transactions: Transaction[] = []): Group {
  return { id: 'weekend', name: 'Weekend away', description: '', currency: 'THB', icon: '🌴', color: '#10b981', inviteCode: 'a'.repeat(32), createdAt: now, updatedAt: now, members: structuredClone(members), transactions };
}

describe('integer money', () => {
  it('offers five default currencies and supports custom codes with two decimals', () => {
    expect(CURRENCIES.map((currency) => currency.code)).toEqual(['THB', 'BDT', 'USD', 'CAD', 'EUR']);
    for (const currency of CURRENCIES) expect(currencyDigits(currency.code)).toBe(2);
    expect(currencyDigits('GBP')).toBe(2);
    expect(currencyDigits('XYZ')).toBe(2);
    for (const code of ['usd', 'GB', 'EURO', 'U$D', '']) expect(() => currencyDigits(code)).toThrow(/three-letter/);
  });

  it.each(['CAD', 'EUR', 'GBP', 'XYZ'])('validates and formats exact group money in %s', currency => {
    const value = validateGroup({ ...group([expense(), payment()]), currency });
    expect(value.currency).toBe(currency);
    expect(parseAmount('12.29', currency)).toBe(1229);
    expect(formatMoney(-1, currency)).toContain('0.01');
    expect(formatMoney(10_000_000_000_000_029n, currency)).toContain('100,000,000,000,000.29');
    expect(getBalances(value).reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);
  });

  it('parses decimal text exactly, including small amounts and the supported maximum', () => {
    expect(parseAmount('0.29', 'THB')).toBe(29);
    expect(parseAmount(' 0012.30 ', 'BDT')).toBe(1_230);
    expect(parseAmount('.5', 'USD')).toBe(50);
    expect(parseAmount('0.01', 'USD')).toBe(1);
    expect(parseAmount('10000000000.00', 'USD')).toBe(MAX_AMOUNT_MINOR);
  });

  it.each(['0', '0.00', '-1', '1e3', 'NaN', 'Infinity', '1,000', '1.001', '1.000', '10000000000.01', '9007199254740993', '', '1.', '+1', '1/2'])('rejects an invalid or unsupported amount: %s', (value) => {
    expect(() => parseAmount(value, 'THB')).toThrow();
  });

  it('formats minor units, negative cents, and large exact values without rounding away a cent', () => {
    expect(formatMoney(29, 'USD')).toBe('$0.29');
    expect(formatMoney(-1, 'USD')).toBe('-$0.01');
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91');
    expect(formatMoney(1_230, 'THB')).toContain('12.30');
    expect(formatMoney(1_230, 'BDT')).toContain('12.30');
    expect(() => formatMoney(1.5, 'THB')).toThrow(/integer minor units/);
  });

  it('formats aggregate bigint balances with exact cents beyond the number range', () => {
    expect(formatMoney(10_000_000_000_000_001n, 'USD')).toBe('$100,000,000,000,000.01');
    expect(formatMoney(-10_000_000_000_000_029n, 'USD')).toBe('-$100,000,000,000,000.29');
    expect(formatMoney(-1n, 'USD')).toBe('-$0.01');
    expect(formatMoney(0n, 'USD')).toBe('$0.00');
    expect(() => formatMoney(Number.MAX_SAFE_INTEGER + 1, 'USD')).toThrow(/integer minor units/);
  });

  it('omits the currency for labelled summaries while preserving zero, negative cents, and large aggregate amounts', () => {
    for (const currency of [...CURRENCIES.map(value => value.code), 'GBP']) {
      const options = { includeCurrency: false };
      expect(formatMoney(0n, currency, options)).toBe('0.00');
      expect(formatMoney(302_000, currency, options)).toBe('3,020.00');
      expect(formatMoney(-1n, currency, options)).toBe('-0.01');
      expect(formatMoney(10_000_000_000_000_029n, currency, options)).toBe('100,000,000,000,000.29');
    }
  });

  it('distributes the remainder in participant order and conserves every cent', () => {
    expect(splitEqually(1_000, ['amy', 'ben', 'cam'])).toEqual({ amy: 334, ben: 333, cam: 333 });
    expect(splitEqually(1, ['cam', 'ben', 'amy'])).toEqual({ cam: 1, ben: 0, amy: 0 });
    expect(splitEqually(100, ['ben'])).toEqual({ ben: 100 });
    for (let amount = 1; amount < 200; amount += 1) {
      const split = Object.values(splitEqually(amount, members.map((member) => member.id)));
      expect(split.reduce((sum, share) => sum + share, 0)).toBe(amount);
      expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
    }
  });

  it('rejects empty, duplicate, unsafe, and excessive participant lists', () => {
    expect(() => splitEqually(1, [])).toThrow();
    expect(() => splitEqually(1, ['amy', 'amy'])).toThrow(/unique/);
    expect(() => splitEqually(1, ['__proto__'])).toThrow();
    expect(() => splitEqually(1, Array.from({ length: MAX_MEMBERS + 1 }, (_, index) => `m${index}`))).toThrow();
    expect(() => splitEqually(0, ['amy'])).toThrow();
  });
});

describe('percentage and weighted splits', () => {
  const ids = members.map(member => member.id);

  it('splits 30 by 3:2:1 into 15, 10, and 5', () => {
    expect(splitByShares(3_000, ids, ['3', '2', '1'])).toEqual({ amy: 1_500, ben: 1_000, cam: 500 });
    expect(splitByShares(3_000, ids, ['6', '4', '2'])).toEqual({ amy: 1_500, ben: 1_000, cam: 500 });
  });

  it('parses percentage hundredths exactly and rounds toward the largest remainder', () => {
    expect(splitByPercentages(3_000, ids, ['50', '33.33', '16.67'])).toEqual({ amy: 1_500, ben: 1_000, cam: 500 });
    expect(splitByPercentages(1, ids, ['10', '20', '70'])).toEqual({ amy: 0, ben: 0, cam: 1 });
    expect(splitByPercentages(101, ids, [' 33.33 ', '33.33', '33.34'])).toEqual({ amy: 34, ben: 33, cam: 34 });
    expect(splitByPercentages(10_000, ids, ['.5', '00.50', '99'])).toEqual({ amy: 50, ben: 50, cam: 9_900 });
  });

  it('breaks rounding ties in participant order and gives no cents to zero weights', () => {
    expect(splitByShares(2, ids, ['1', '1', '1'])).toEqual({ amy: 1, ben: 1, cam: 0 });
    expect(splitByShares(1, ['cam', 'ben', 'amy'], ['1', '1', '1'])).toEqual({ cam: 1, ben: 0, amy: 0 });
    expect(splitByShares(1, ids, ['0', '1', '1'])).toEqual({ amy: 0, ben: 1, cam: 0 });
    expect(splitByPercentages(101, ids, ['0', '100', '0.00'])).toEqual({ amy: 0, ben: 101, cam: 0 });
    expect(splitByShares(101, ['ben'], ['1'])).toEqual({ ben: 101 });
  });

  it('conserves every cent while keeping each rounded portion within one cent of its ratio', () => {
    for (const weights of [['3', '2', '1'], ['0', '17', '1'], ['1', '1', '1'], ['9007199254740991', '9007199254740991', '1']]) {
      const totalWeight = weights.reduce((sum, value) => sum + BigInt(value), 0n);
      for (const amount of [1, 2, 29, 100, 10_001, MAX_AMOUNT_MINOR - 1, MAX_AMOUNT_MINOR]) {
        const result = Object.values(splitByShares(amount, ids, weights));
        expect(result.reduce((sum, value) => sum + value, 0)).toBe(amount);
        result.forEach((value, index) => {
          const numerator = BigInt(amount) * BigInt(weights[index]!);
          const floor = numerator / totalWeight;
          expect(BigInt(value)).toBeGreaterThanOrEqual(floor);
          expect(BigInt(value)).toBeLessThanOrEqual(floor + (numerator % totalWeight ? 1n : 0n));
        });
      }
    }
  });

  it.each(['', '-1', '1e2', 'NaN', 'Infinity', '100.001', '100.01', '101', '1.', '1/2', '+100'])('rejects an invalid percentage: %s', value => {
    expect(() => splitByPercentages(100, ['amy'], [value])).toThrow();
  });

  it('requires percentages to total exactly 100 and one value per selected person', () => {
    expect(() => splitByPercentages(100, ids, ['33.33', '33.33', '33.33'])).toThrow(/exactly 100/);
    expect(() => splitByPercentages(100, ids, ['50', '25', '25.01'])).toThrow(/exactly 100/);
    expect(() => splitByPercentages(100, ids, ['100'])).toThrow(/every selected participant/);
    expect(splitByPercentages(100, ['ben', 'cam'], ['25', '75'])).toEqual({ ben: 25, cam: 75 });
  });

  it.each(['', '-1', '0.5', '1.0', '1e3', 'NaN', 'Infinity', '1,000', '+1', '9007199254740992'])('rejects an invalid share weight: %s', value => {
    expect(() => splitByShares(100, ['amy'], [value])).toThrow();
  });

  it('requires a positive total and a weight for every selected person', () => {
    expect(() => splitByShares(100, ids, ['0', '0', '0'])).toThrow(/positive number/);
    expect(() => splitByShares(100, ids, ['1', '1'])).toThrow(/every selected participant/);
    expect(splitByShares(100, ['ben', 'cam'], [' 01 ', '3'])).toEqual({ ben: 25, cam: 75 });
  });

  it('validates amounts and participant identity for both proportional modes', () => {
    for (const split of [splitByPercentages, splitByShares]) {
      expect(() => split(0, ['amy'], ['100'])).toThrow();
      expect(() => split(MAX_AMOUNT_MINOR + 1, ['amy'], ['100'])).toThrow();
      expect(() => split(100, [], [])).toThrow();
      expect(() => split(100, ['amy', 'amy'], ['50', '50'])).toThrow(/unique/);
      expect(() => split(100, ['__proto__'], ['100'])).toThrow();
      expect(() => split(100, Array.from({ length: MAX_MEMBERS + 1 }, (_, index) => `m${index}`), ['100'])).toThrow();
    }
  });

  it('persists ordinary expense amounts with exact balances', () => {
    const value = validateGroup(group([
      expense({ amount: 3_000, shares: splitByShares(3_000, ids, ['3', '2', '1']) }),
      expense({ id: 'percent', amount: 101, shares: splitByPercentages(101, ids, ['25', '25', '50']) }),
    ]));
    expect(validateGroup(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(getBalances(value).map(({ share, balance }) => ({ share, balance }))).toEqual([
      { share: 1_525, balance: 1_576 }, { share: 1_025, balance: -1_025 }, { share: 551, balance: -551 },
    ]);
    expect(totalSpent(value)).toBe(3_101);
  });
});

describe('personal totals across groups', () => {
  it('keeps debts and credits separate for each supported currency in the configured order', () => {
    expect(getCurrencyBalances([
      { currency: 'USD', balance: -123 },
      { currency: 'THB', balance: 501 },
      { currency: 'USD', balance: 99 },
      { currency: 'THB', balance: -1 },
      { currency: 'BDT', balance: 0 },
    ])).toEqual([
      { code: 'THB', label: 'Thai baht', digits: 2, owed: 501n, owes: 1n },
      { code: 'BDT', label: 'Bangladeshi taka', digits: 2, owed: 0n, owes: 0n },
      { code: 'USD', label: 'US dollar', digits: 2, owed: 99n, owes: 123n },
      { code: 'CAD', label: 'Canadian dollar', digits: 2, owed: 0n, owes: 0n },
      { code: 'EUR', label: 'Euro', digits: 2, owed: 0n, owes: 0n },
    ]);
    expect(getCurrencyBalances([]).every(({ owed, owes }) => owed === 0n && owes === 0n)).toBe(true);
  });

  it('keeps custom currencies separate and adds repeated entries exactly', () => {
    const totals = getCurrencyBalances([
      { currency: 'GBP', balance: Number.MAX_SAFE_INTEGER },
      { currency: 'CAD', balance: -101 },
      { currency: 'GBP', balance: Number.MAX_SAFE_INTEGER },
      { currency: 'XYZ', balance: 77 },
      { currency: 'GBP', balance: -29 },
    ]);
    expect(totals.find(total => total.code === 'GBP')).toEqual({ code: 'GBP', label: 'GBP', digits: 2, owed: 18_014_398_509_481_982n, owes: 29n });
    expect(totals.find(total => total.code === 'XYZ')!.owed).toBe(77n);
    expect(totals.find(total => total.code === 'CAD')!.owes).toBe(101n);
  });

  it('adds individually safe balances exactly when their combined total exceeds the number range', () => {
    const balance = 5_000_000_000_000_001;
    const [thb] = getCurrencyBalances([
      { currency: 'THB', balance },
      { currency: 'THB', balance },
      { currency: 'THB', balance: -balance },
      { currency: 'THB', balance: -balance },
    ]);
    expect(thb!.owed).toBe(10_000_000_000_000_002n);
    expect(thb!.owes).toBe(10_000_000_000_000_002n);
    expect(formatMoney(thb!.owed, thb!.code)).toContain('100,000,000,000,000.02');
  });

  it('rejects unsupported currencies and balances already rounded or fractional at the input', () => {
    expect(() => getCurrencyBalances([{ currency: 'usd', balance: 100 }])).toThrow(/three-letter/);
    expect(() => getCurrencyBalances([{ currency: 'THB', balance: 0.5 }])).toThrow(/integer minor units/);
    expect(() => getCurrencyBalances([{ currency: 'USD', balance: Number.MAX_SAFE_INTEGER + 1 }])).toThrow(/integer minor units/);
  });
});

describe('balances and settlements', () => {
  it('tracks the payer separately from selected participants and custom shares', () => {
    const value = group([expense({ shares: { ben: 700, cam: 300 } })]);
    expect(getBalances(value).map(({ member, paid, share, balance }) => ({ id: member.id, paid, share, balance }))).toEqual([
      { id: 'amy', paid: 1_000, share: 0, balance: 1_000 },
      { id: 'ben', paid: 0, share: 700, balance: -700 },
      { id: 'cam', paid: 0, share: 300, balance: -300 },
    ]);
    expect(getSettlements(value)).toEqual([{ fromId: 'ben', toId: 'amy', amount: 700 }, { fromId: 'cam', toId: 'amy', amount: 300 }]);
  });

  it('reduces debt when the debtor makes a payment and excludes payments from total spent', () => {
    const value = group([expense(), payment()]);
    expect(getBalances(value).map((entry) => entry.balance)).toEqual([333, 0, -333]);
    expect(getBalances(value).map((entry) => entry.paid)).toEqual([1_000, 0, 0]);
    expect(getBalances(value).map((entry) => entry.share)).toEqual([334, 333, 333]);
    expect(totalSpent(value)).toBe(1_000);
    expect(getSettlements(value)).toEqual([{ fromId: 'cam', toId: 'amy', amount: 333 }]);
  });

  it('handles overpayment by reversing who owes money', () => {
    const value = group([expense({ amount: 100, shares: { ben: 100 } }), payment({ amount: 125 })]);
    expect(getSettlements(value)).toEqual([{ fromId: 'amy', toId: 'ben', amount: 25 }]);
  });

  it('settles varied participants, multiple payers, and rounding with conservation', () => {
    const value = group([
      expense(),
      expense({ id: 'taxi', paidBy: 'ben', amount: 701, shares: { amy: 350, cam: 351 } }),
      expense({ id: 'coffee', paidBy: 'cam', amount: 401, shares: { amy: 101, ben: 100, cam: 200 } }),
      payment({ amount: 77 }),
    ]);
    expect(getBalances(value).reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);
    const settlements = getSettlements(value);
    const settled = group([...value.transactions, ...settlements.map((settlement, index) => payment({ ...settlement, id: `payment-${index}` }))]);
    expect(getBalances(settled).map((entry) => entry.balance)).toEqual([0, 0, 0]);
    expect(totalSpent(value)).toBe(2_102);
    expect(settlements.every((settlement) => settlement.amount > 0 && Number.isSafeInteger(settlement.amount))).toBe(true);
  });

  it('splits large debts into suggestions that can each be recorded as valid payments', () => {
    const value = group([
      expense({ amount: MAX_AMOUNT_MINOR, shares: { ben: MAX_AMOUNT_MINOR } }),
      expense({ id: 'second-expense', amount: MAX_AMOUNT_MINOR, shares: { ben: MAX_AMOUNT_MINOR } }),
    ]);
    const settlements = getSettlements(value);
    expect(settlements).toEqual([
      { fromId: 'ben', toId: 'amy', amount: MAX_AMOUNT_MINOR },
      { fromId: 'ben', toId: 'amy', amount: MAX_AMOUNT_MINOR },
    ]);
    const payments = settlements.map((settlement, index) => payment({ ...settlement, id: `large-payment-${index}` }));
    for (const transaction of payments) expect(() => validateTransaction(transaction, value.members)).not.toThrow();
    const settled = validateGroup({ ...value, transactions: [...value.transactions, ...payments] });
    expect(getBalances(settled).map(({ balance }) => balance)).toEqual([0, 0, 0]);
    expect(getSettlements(settled)).toEqual([]);
    expect(totalSpent(settled)).toBe(2 * MAX_AMOUNT_MINOR);
  });

  it('uses stable ID ordering to resolve tied debts regardless of member order', () => {
    const value = group([expense({ amount: 2, shares: { ben: 1, cam: 1 } })]);
    const reversed = { ...value, members: [...value.members].reverse() };
    expect(getSettlements(reversed)).toEqual(getSettlements(value));
    expect(getSettlements(value)[0]?.fromId).toBe('ben');
  });

  it('returns zero balances and no settlements for an empty group', () => {
    expect(getBalances(group()).map((entry) => entry.balance)).toEqual([0, 0, 0]);
    expect(getSettlements(group())).toEqual([]);
    expect(totalSpent(group())).toBe(0);
  });

  it('guards aggregate overflow when called with oversized untrusted data', () => {
    const large = expense({ amount: MAX_AMOUNT_MINOR, shares: { ben: MAX_AMOUNT_MINOR } });
    const value = group(Array.from({ length: 9_008 }, () => large));
    expect(() => getBalances(value)).toThrow(/total exceeds/);
    expect(() => totalSpent(value)).toThrow(/total exceeds/);
  });
});

describe('transaction validation', () => {
  it('accepts equal/custom splits, zero shares, and a payer outside the split', () => {
    expect(() => validateTransaction(expense(), members)).not.toThrow();
    expect(() => validateTransaction(expense({ shares: { ben: 1_000, cam: 0 } }), members)).not.toThrow();
    expect(() => validateTransaction(payment(), members)).not.toThrow();
  });

  it.each([
    { amount: 1.5 },
    { amount: 0 },
    { amount: MAX_AMOUNT_MINOR + 1 },
    { shares: { ben: -1, cam: 1_001 } },
    { shares: { amy: 334, ben: 333, cam: 332 } },
    { shares: {} },
    { shares: { missing: 1_000 } },
    { paidBy: 'missing' },
    { date: '2026-02-30' },
    { createdAt: '2026-10-07' },
    { description: '' },
  ] as Partial<Expense>[])('rejects invalid expense fields: %j', (overrides) => {
    expect(() => validateTransaction(expense(overrides), members)).toThrow();
  });

  it('rejects self payments, missing member references, and fractional payments', () => {
    expect(() => validateTransaction(payment({ toId: 'ben' }), members)).toThrow(/different/);
    expect(() => validateTransaction(payment({ fromId: 'missing' }), members)).toThrow(/existing member/);
    expect(() => validateTransaction(payment({ amount: 1.1 }), members)).toThrow(/integer amount/);
  });
});

describe('group data validation', () => {
  it('returns a detached normalized group that round-trips through JSON', () => {
    const original = group([expense(), payment()]);
    original.name = '  Weekend away  ';
    const imported = validateGroup(JSON.parse(JSON.stringify(original)));
    expect(imported.name).toBe('Weekend away');
    expect(validateGroup(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
    imported.members[0]!.name = 'Changed';
    (imported.transactions[0] as Expense).shares.ben = 0;
    expect(original.members[0]!.name).toBe('Amy');
    expect((original.transactions[0] as Expense).shares.ben).toBe(333);
  });

  it('rejects duplicate IDs and references to absent members', () => {
    expect(() => validateGroup({ ...group(), members: [members[0], members[0]] })).toThrow(/unique/);
    expect(() => validateGroup(group([expense(), expense()]))).toThrow(/unique/);
    expect(() => validateGroup(group([expense({ paidBy: 'missing' })]))).toThrow(/existing member/);
    expect(() => validateGroup(group([payment({ toId: 'missing' })]))).toThrow(/existing member/);
  });

  it.each([
    null,
    [],
    'group',
    {},
    { ...group(), currency: 'usd' },
    { ...group(), members: [] },
    { ...group(), name: 'a'.repeat(81) },
    { ...group(), color: 'red' },
    { ...group(), inviteCode: 'A' },
    { ...group(), inviteCode: 'IOU-ABCD' },
    { ...group(), inviteCode: 'A'.repeat(32) },
    { ...group(), id: '__proto__' },
    { ...group(), transactions: 'invalid' },
    { ...group(), createdAt: '2026-13-01T00:00:00Z' },
    { ...group(), updatedAt: '2026-10-06T09:00:00.000Z' },
    { ...group(), createdAt: '2026-10-07T25:00:00Z' },
  ])('rejects malformed group data', (input) => {
    expect(() => validateGroup(input)).toThrow();
  });

  it('rejects prototype keys at the group, member, and share levels', () => {
    const maliciousGroup = JSON.parse(JSON.stringify(group()).replace('"id":"weekend"', '"__proto__":{},"id":"weekend"'));
    expect(() => validateGroup(maliciousGroup)).toThrow(/unsafe key/);
    const maliciousMember = { ...group(), members: [JSON.parse('{"id":"amy","name":"Amy","constructor":{}}')] };
    expect(() => validateGroup(maliciousMember)).toThrow(/unsafe key/);
    const maliciousShares = JSON.parse('{"__proto__":1000}');
    expect(() => validateGroup(group([expense({ shares: maliciousShares })]))).toThrow(/unsafe key/);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('rejects inherited objects, unknown fields, and accessor properties', () => {
    expect(() => validateGroup(Object.assign(Object.create({ hidden: true }), group()))).toThrow(/plain object/);
    expect(() => validateGroup({ ...group(), extra: true })).toThrow(/unsupported field/);
    const input = group();
    Object.defineProperty(input, 'name', { get: () => { throw new Error('getter was run'); }, enumerable: true });
    expect(() => validateGroup(input)).toThrow(/ordinary values/);
  });

  it('bounds group size before processing oversized arrays', () => {
    expect(() => validateGroup({ ...group(), members: Array.from({ length: MAX_MEMBERS + 1 }, (_, index) => ({ id: `member-${index}`, name: 'Member' })) })).toThrow(/members/);
    expect(() => validateGroup(group(Array.from({ length: MAX_TRANSACTIONS + 1 }, () => expense())))).toThrow(/transactions/);
  });
});

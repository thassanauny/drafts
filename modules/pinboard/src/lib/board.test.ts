import { describe, expect, it } from 'vitest';
import type { Board, Card } from '../types';
import { acceptBoard, cardPatch, MAX_POSITION, nextPosition, normalizeInviteCode, readInviteCode, readBoard, sortedCards, validateOperation } from './board';

const card: Card = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Book the room', description: 'Pick a place near the station.', columnId: 'todo', position: 1_024,
  priority: 'medium', assignee: 'Alex', dueDate: '2026-10-20', labels: ['Travel'],
};

const board: Board = {
  id: '22222222-2222-4222-8222-222222222222', invite_code: 'a'.repeat(32),
  title: 'Trip plans', description: '',
  columns: [{ id: 'todo', title: 'To do', color: 'slate' }, { id: 'done', title: 'Done', color: 'emerald' }],
  cards: [card], revision: 1,
  created_at: '2026-10-10T01:00:00.123456+00:00', updated_at: '2026-10-10T01:00:00.123456+00:00',
};

describe('board data and concurrent updates', () => {
  it('accepts codes and invitation links while rejecting incomplete or unrelated links', () => {
    const code = 'a'.repeat(32);
    for (const input of [code.toUpperCase(), `  https://example.test/#join/${code}  `, `https://example.test/#/join/${code}`, `https://example.test/#board/${code}`]) {
      expect(readInviteCode(input)).toBe(code);
    }
    for (const input of ['https://example.test/', `https://example.test/#other/${code}`, `#join/${code}/extra`, '#join/short']) {
      expect(() => readInviteCode(input)).toThrow('32-character');
    }
  });
  it('accepts Postgres timestamps and clones nested data before it enters the UI', () => {
    const result = readBoard({ ...board, revision: '7' });
    expect(result).toEqual({ ...board, revision: 7 });
    result.cards[0]!.labels.push('New');
    result.columns[0]!.title = 'Changed';
    expect(card.labels).toEqual(['Travel']);
    expect(board.columns[0]!.title).toBe('To do');
  });

  it('preserves the server’s column order and metadata without moving cards', () => {
    const columns = [board.columns[1]!, board.columns[0]!];
    const result = readBoard({ ...board, columns });
    expect(result.columns).toEqual(columns);
    expect(result.columns.map((column) => column.id)).toEqual(['done', 'todo']);
    expect(result.cards).toEqual(board.cards);
    result.columns.reverse();
    expect(columns.map((column) => column.id)).toEqual(['done', 'todo']);
  });

  it('rejects malformed dates, dangling cards, duplicate IDs, and unsafe revisions', () => {
    expect(() => readBoard({ ...board, cards: [{ ...card, dueDate: '2026-02-30' }] })).toThrow('date is invalid');
    expect(() => readBoard({ ...board, cards: [{ ...card, columnId: 'missing' }] })).toThrow('existing column');
    expect(() => readBoard({ ...board, cards: [{ ...card, id: 'abcdefab-abcd-4abc-8abc-abcdefabcdef' }, { ...card, id: 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF' }] })).toThrow('unique');
    expect(() => readBoard({ ...board, columns: [board.columns[0], board.columns[0]] })).toThrow('unique');
    expect(() => readBoard({ ...board, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow('revision');
    expect(() => readBoard({ ...board, updated_at: '2026-10-09T00:00:00Z' })).toThrow('precede');
  });

  it('rejects untrusted object fields and accessors without evaluating them', () => {
    expect(() => readBoard({ ...board, unknown: 'hidden' })).toThrow('unsupported field');
    const injected = JSON.parse(JSON.stringify(board).replace('"title":"Trip plans"', '"title":"Trip plans","__proto__":{"polluted":true}'));
    expect(() => readBoard(injected)).toThrow('unsupported field');
    let read = false;
    const accessor = { ...board };
    Object.defineProperty(accessor, 'cards', { get() { read = true; return []; } });
    expect(() => readBoard(accessor)).toThrow('ordinary values');
    expect(read).toBe(false);
  });

  it('bounds board sizes, labels, field lengths, and ordering numbers', () => {
    expect(() => readBoard({ ...board, columns: [] })).toThrow('between 1 and 20');
    expect(() => readBoard({ ...board, columns: Array.from({ length: 21 }, (_, index) => ({ id: `col-${index}`, title: 'Column', color: 'slate' })) })).toThrow('between 1 and 20');
    expect(() => readBoard({ ...board, cards: Array(2_001).fill(card) })).toThrow('2');
    expect(() => readBoard({ ...board, cards: [{ ...card, labels: Array(9).fill('Label') }] })).toThrow('8 labels');
    expect(() => readBoard({ ...board, cards: [{ ...card, title: 'x'.repeat(161) }] })).toThrow('160');
    expect(() => readBoard({ ...board, cards: [{ ...card, position: Infinity }] })).toThrow('position');
    expect(() => readBoard({ ...board, cards: [{ ...card, position: MAX_POSITION + 1 }] })).toThrow('position');
    expect(() => readBoard({ ...board, cards: [{ ...card, position: -1 }] })).toThrow('position');
    expect(() => readBoard({ ...board, columns: Array(1) })).toThrow('object');
    expect(() => readBoard({ ...board, cards: [{ ...card, labels: Array(1) }] })).toThrow('Label');
  });

  it('normalizes invitation whitespace and casing while requiring the whole code', () => {
    expect(normalizeInviteCode(` ${'A'.repeat(16)}\n${'A'.repeat(16)} `)).toBe('a'.repeat(32));
    expect(() => normalizeInviteCode('abcd')).toThrow('32-character');
    expect(() => normalizeInviteCode('g'.repeat(32))).toThrow('32-character');
  });

  it('sends only editor-changed fields so another member’s move is preserved', () => {
    const edited = { ...card, title: 'Book a hotel', labels: ['Travel', 'Booking'] };
    const patch = cardPatch(card, edited);
    expect(patch).toEqual({ title: 'Book a hotel', labels: ['Travel', 'Booking'] });
    const current = { ...card, columnId: 'done', assignee: 'Sam' };
    expect({ ...current, ...patch }).toEqual({ ...edited, columnId: 'done', assignee: 'Sam' });
    expect(cardPatch(card, { ...card, labels: [...card.labels] })).toEqual({});
    patch.labels!.push('Changed copy');
    expect(edited.labels).toEqual(['Travel', 'Booking']);
  });

  it('keeps a newer save when an older refresh finishes afterwards', () => {
    const saved = { ...board, revision: 4, title: 'Saved' };
    const delayed = { ...board, revision: 3, title: 'Old refresh' };
    expect(acceptBoard(saved, delayed)).toBe(saved);
    expect(acceptBoard(saved, { ...board, revision: 4 })).toEqual({ ...board, revision: 4 });
    expect(acceptBoard(saved, { ...board, revision: 5 })).toEqual({ ...board, revision: 5 });
    expect(acceptBoard(undefined, board)).toBe(board);
    const other = { ...board, id: '33333333-3333-4333-8333-333333333333' };
    expect(acceptBoard(saved, other)).toBe(other);
  });

  it('orders a column deterministically without changing the board and bounds appended positions', () => {
    const earlier = { ...card, id: '00000000-0000-4000-8000-000000000000', position: 512 };
    const samePosition = { ...card, id: '00000000-0000-4000-8000-000000000001' };
    const otherColumn = { ...card, id: '00000000-0000-4000-8000-000000000002', columnId: 'done', position: 1 };
    const unordered = { ...board, cards: [card, otherColumn, samePosition, earlier] };
    expect(sortedCards(unordered, 'todo')).toEqual([earlier, samePosition, card]);
    expect(unordered.cards[0]).toBe(card);
    expect(nextPosition(unordered, 'todo')).toBe(2_048);
    expect(nextPosition({ ...board, cards: [] }, 'todo')).toBe(1_024);
    expect(nextPosition({ ...board, cards: [{ ...card, position: MAX_POSITION }] }, 'todo')).toBe(MAX_POSITION);
  });

  it('rejects malformed actions before they can replace unrelated data', () => {
    expect(validateOperation({ type: 'update_card', id: card.id, patch: { title: 'Changed' } })).toEqual({ type: 'update_card', id: card.id, patch: { title: 'Changed' } });
    expect(() => validateOperation({ type: 'update_card', id: card.id, patch: { id: card.id } })).toThrow('unsupported field');
    expect(() => validateOperation({ type: 'move_card', id: card.id, columnId: 'todo', position: NaN })).toThrow('position');
    expect(() => validateOperation({ type: 'delete_column', id: 'todo', targetColumnId: 'todo' })).toThrow('different column');
    expect(() => validateOperation({ type: 'delete_card', id: card.id, cards: [] })).toThrow('unsupported field');
    expect(() => validateOperation({ type: 'unknown' })).toThrow('unsupported');
  });

  it('clones an ordered list of safe column IDs without changing their casing or order', () => {
    const columnIds = ['done', 'Todo_2'];
    const result = validateOperation({ type: 'reorder_columns', columnIds });
    expect(result).toEqual({ type: 'reorder_columns', columnIds: ['done', 'Todo_2'] });
    if (result.type !== 'reorder_columns') throw new Error('Unexpected action type');
    result.columnIds.reverse();
    expect(columnIds).toEqual(['done', 'Todo_2']);
    expect(validateOperation({ type: 'reorder_columns', columnIds: ['todo'] })).toEqual({ type: 'reorder_columns', columnIds: ['todo'] });
    const maximum = Array.from({ length: 20 }, (_, index) => `column-${index}`);
    expect(validateOperation({ type: 'reorder_columns', columnIds: maximum })).toEqual({ type: 'reorder_columns', columnIds: maximum });
  });

  it.each([
    undefined, null, {}, 'todo', [], Array.from({ length: 21 }, (_, index) => `column-${index}`),
  ].map((columnIds) => ({ columnIds })))('rejects missing or unbounded column orders: $columnIds', ({ columnIds }) => {
    expect(() => validateOperation({ type: 'reorder_columns', columnIds })).toThrow('between 1 and 20');
  });

  it.each([
    [null], [1], [''], [' todo'], ['todo '], ['todo/done'], ['x'.repeat(65)],
    ['__proto__'], ['prototype'], ['constructor'], Array(1),
  ].map((columnIds) => ({ columnIds })))('rejects unsafe column IDs in an order: $columnIds', ({ columnIds }) => {
    expect(() => validateOperation({ type: 'reorder_columns', columnIds })).toThrow('Column ID');
  });

  it('rejects duplicate IDs and unrelated fields in a reorder action', () => {
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: ['todo', 'todo'] })).toThrow('unique');
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: ['todo'], columns: board.columns })).toThrow('unsupported field');
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: ['todo'], patch: { title: 'Changed' } })).toThrow('unsupported field');
  });

  it('rejects extraneous array fields and accessors without evaluating them', () => {
    const extra = Object.assign(['todo'], { ignored: 'done' });
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: extra })).toThrow('unsupported field');
    const symbolic = Object.assign(['todo'], { [Symbol('ignored')]: 'done' });
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: symbolic })).toThrow('unsupported field');
    let read = false;
    const accessor = ['todo'];
    Object.defineProperty(accessor, '0', { get() { read = true; return 'done'; } });
    expect(() => validateOperation({ type: 'reorder_columns', columnIds: accessor })).toThrow('ordinary values');
    expect(read).toBe(false);
  });
});

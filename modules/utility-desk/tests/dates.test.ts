import { describe, it, expect } from 'vitest';
import { shiftDate, diffDates, timestampToDate, dateToTimestamp, worldClock } from '../src/lib/dates';

describe('dates', () => {
  it('adds and subtracts with month-end clamping', () => {
    expect(shiftDate('2024-01-31', { months: 1 }, 1)).toBe('2024-02-29');
    expect(shiftDate('2024-03-01', { weeks: 1, days: 2 }, -1)).toBe('2024-02-21');
    expect(shiftDate('2020-02-29', { years: 1 }, 1)).toBe('2021-02-28');
  });
  it('computes differences', () => {
    const d = diffDates('2024-01-01', '2025-03-15');
    expect(d).toMatchObject({ years: 1, months: 2, days: 14, totalDays: 439, weeks: 62, remDays: 5 });
    expect(diffDates('2024-03-01', '2024-01-01').totalDays).toBe(-60);
  });
  it('converts timestamps both ways', () => {
    expect(timestampToDate(0, 'UTC').utc).toBe('1970-01-01T00:00:00Z');
    expect(timestampToDate(1700000000000, 'UTC').utc).toBe('2023-11-14T22:13:20Z');
    expect(timestampToDate(1700000000, 'Asia/Bangkok').iso).toContain('2023-11-15T05:13:20');
    expect(dateToTimestamp('2023-11-14T22:13:20', 'UTC').seconds).toBe(1700000000);
    expect(() => timestampToDate(NaN, 'UTC')).toThrow();
  });
  it('formats world clocks', () => {
    const c = worldClock(new Date('2024-01-01T00:00:00Z'), 'Asia/Tokyo');
    expect(c.time).toContain('09');
    expect(c.offset).toMatch(/GMT\+9/);
  });
});

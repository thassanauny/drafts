import { Temporal } from '@js-temporal/polyfill';

export interface Delta { years?: number; months?: number; weeks?: number; days?: number }

export function shiftDate(iso: string, delta: Delta, sign: 1 | -1): string {
  const d = Temporal.PlainDate.from(iso);
  const f = (n?: number) => (n ?? 0) * sign;
  const dur = { years: f(delta.years), months: f(delta.months), weeks: f(delta.weeks), days: f(delta.days) };
  return d.add(dur, { overflow: 'constrain' }).toString();
}

export function diffDates(a: string, b: string) {
  const from = Temporal.PlainDate.from(a);
  const to = Temporal.PlainDate.from(b);
  const ymd = from.until(to, { largestUnit: 'years' });
  const totalDays = from.until(to, { largestUnit: 'days' }).days;
  return { years: ymd.years, months: ymd.months, days: ymd.days, totalDays, weeks: Math.trunc(totalDays / 7), remDays: totalDays % 7 };
}

/** Accepts seconds or milliseconds (auto-detected by magnitude unless unit is given). */
export function timestampToDate(ts: number, tz: string, unit: 'auto' | 's' | 'ms' = 'auto') {
  if (!Number.isFinite(ts)) throw new Error('Enter a valid number');
  const ms = unit === 'ms' || (unit === 'auto' && Math.abs(ts) >= 1e11) ? ts : ts * 1000;
  const z = Temporal.Instant.fromEpochMilliseconds(Math.trunc(ms)).toZonedDateTimeISO(tz);
  return { iso: z.toString({ timeZoneName: 'never' }), utc: z.toInstant().toString(), zoned: z.toString() };
}

/** `local` is "YYYY-MM-DDTHH:mm[:ss]" interpreted in `tz`. */
export function dateToTimestamp(local: string, tz: string, occurrence: 'earlier' | 'later' = 'earlier') {
  const plain = Temporal.PlainDateTime.from(local);
  const z = plain.toZonedDateTime(tz, { disambiguation: occurrence });
  if (!z.toPlainDateTime().equals(plain)) throw new Error('This local time does not exist because the clocks move forward. Choose another time.');
  return { seconds: Math.floor(z.epochMilliseconds / 1000), milliseconds: z.epochMilliseconds };
}

export const WORLD_ZONES = ['UTC', 'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Tokyo', 'Asia/Shanghai', 'Europe/London', 'Europe/Paris', 'Australia/Sydney', 'America/New_York', 'America/Toronto', 'America/St_Johns', 'America/Vancouver', 'America/Los_Angeles'];

export function worldClock(now: Date, tz: string) {
  const time = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  const date = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? '';
  return { tz, time, date, offset };
}

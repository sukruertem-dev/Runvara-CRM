import { DateTime, IANAZone } from 'luxon';
import { MAX_RELATIVE_AMOUNT, type RelUnit } from './ast';
import { RqlError } from './errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function assertZone(timezone: string): string {
  if (typeof (timezone as unknown) !== 'string' || !IANAZone.isValidZone(timezone)) {
    throw new RqlError('BAD_VALUE', 'context timezone is not a valid IANA zone', 0);
  }
  return timezone;
}

export function nowIn(now: Date, zone: string): DateTime {
  const dt = DateTime.fromJSDate(now, { zone });
  if (!dt.isValid) throw new RqlError('BAD_VALUE', 'context "now" is not a valid date', 0);
  return dt;
}

function inRange(dt: DateTime, pos: number): DateTime {
  if (!dt.isValid || dt.year < 1 || dt.year > 9999) {
    throw new RqlError('BAD_VALUE', 'date is out of the supported range', pos);
  }
  return dt;
}

/** Result is a date-only value (a whole local day) or an exact instant. */
export type Temporal =
  | { readonly kind: 'day'; readonly start: DateTime }
  | { readonly kind: 'instant'; readonly at: DateTime };

/** Parses an ISO date or datetime. Datetimes without an offset are read in `zone`. Returns null when malformed. */
export function parseIso(text: string, zone: string, pos: number): Temporal | null {
  if (DATE_RE.test(text)) {
    const start = DateTime.fromISO(text, { zone });
    return start.isValid ? { kind: 'day', start: inRange(start, pos) } : null;
  }
  if (DATETIME_RE.test(text)) {
    const at = DateTime.fromISO(text, { zone });
    return at.isValid ? { kind: 'instant', at: inRange(at, pos) } : null;
  }
  return null;
}

export function addRelative(now: DateTime, amount: number, unit: RelUnit, pos: number): DateTime {
  if (!Number.isInteger(amount) || Math.abs(amount) > MAX_RELATIVE_AMOUNT) {
    throw new RqlError('BAD_VALUE', `relative amount must be at most ${MAX_RELATIVE_AMOUNT}`, pos);
  }
  switch (unit) {
    case 'm':
      return inRange(now.plus({ minutes: amount }), pos);
    case 'h':
      return inRange(now.plus({ hours: amount }), pos);
    case 'd':
      return inRange(now.plus({ days: amount }), pos);
    case 'w':
      return inRange(now.plus({ weeks: amount }), pos);
    case 'M':
      return inRange(now.plus({ months: amount }), pos);
  }
}

export function startOfDay(dt: DateTime): DateTime {
  return dt.startOf('day');
}
export function startOfWeek(dt: DateTime): DateTime {
  return dt.startOf('week'); // ISO week: Monday
}
export function startOfMonth(dt: DateTime): DateTime {
  return dt.startOf('month');
}
export function nextDayStart(dayStart: DateTime): DateTime {
  return dayStart.plus({ days: 1 }).startOf('day');
}

/** `YYYY-MM-DD` of `dt` in its own zone. */
export function isoDate(dt: DateTime, pos: number): string {
  const text = inRange(dt, pos).toISODate();
  if (text === null) throw new RqlError('BAD_VALUE', 'date is out of the supported range', pos);
  return text;
}

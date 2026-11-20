import { IANAZone } from 'luxon';
import { RRule, type Options } from 'rrule';

export interface SeriesSpec {
  rrule: string;
  /** 'YYYY-MM-DDTHH:mm' local wall-clock time in `tzid`. */
  dtstartLocal: string;
  tzid: string;
}

export type RecurrenceErrorCode = 'RRULE_INVALID' | 'RRULE_UNSUPPORTED' | 'TZ_INVALID';

export class RecurrenceError extends Error {
  readonly code: RecurrenceErrorCode;
  constructor(code: RecurrenceErrorCode, message: string) {
    super(message);
    this.name = 'RecurrenceError';
    this.code = code;
  }
}

export const MAX_INDEX = 10000;
const MAX_RULE_LENGTH = 500;
const MS_MIN = 60_000;
const MS_DAY = 86_400_000;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const SUPPORTED_FREQ: readonly number[] = [RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY];

interface Prepared {
  rule: RRule;
  zone: IANAZone;
}

function parseLocal(value: string): number {
  const m = LOCAL_RE.exec(value);
  if (!m) throw new RecurrenceError('RRULE_INVALID', 'dtstartLocal must be YYYY-MM-DDTHH:mm');
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  ) {
    throw new RecurrenceError('RRULE_INVALID', 'dtstartLocal is not a real calendar date/time');
  }
  return ms;
}

function prepare(spec: SeriesSpec): Prepared {
  if (!IANAZone.isValidZone(spec.tzid)) {
    throw new RecurrenceError('TZ_INVALID', `Invalid IANA time zone: ${spec.tzid}`);
  }
  const zone = IANAZone.create(spec.tzid);
  const startMs = parseLocal(spec.dtstartLocal);
  const text = spec.rrule.trim();
  if (text.length === 0 || spec.rrule.length > MAX_RULE_LENGTH) {
    throw new RecurrenceError('RRULE_INVALID', 'rrule must be 1..500 characters');
  }
  if (/[\r\n]/.test(text) || /DTSTART|TZID/i.test(text)) {
    throw new RecurrenceError('RRULE_INVALID', 'rrule must be a single RRULE without DTSTART/TZID');
  }
  let opts: Partial<Options>;
  try {
    opts = RRule.parseString(text);
  } catch {
    throw new RecurrenceError('RRULE_INVALID', 'rrule cannot be parsed');
  }
  if (typeof opts.freq !== 'number') {
    throw new RecurrenceError('RRULE_INVALID', 'rrule has no valid FREQ');
  }
  if (!SUPPORTED_FREQ.includes(opts.freq)) {
    throw new RecurrenceError('RRULE_UNSUPPORTED', 'FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  }
  let until = opts.until ?? null;
  const untilRaw = /UNTIL=([^;]*)/i.exec(text)?.[1];
  if (until && untilRaw && /Z$/i.test(untilRaw)) {
    // UTC instant -> floating local wall-clock of tzid.
    const t = until.getTime();
    until = new Date(t + zone.offset(t) * MS_MIN);
  }
  try {
    const rule = new RRule({ ...opts, dtstart: new Date(startMs), until });
    return { rule, zone };
  } catch {
    throw new RecurrenceError('RRULE_INVALID', 'rrule is invalid');
  }
}

/**
 * Floating (wall-clock as UTC fields) -> real instant.
 * Overlap (fall-back): the earlier instant (pre-transition offset).
 * Gap (spring-forward): the transition instant, i.e. the next valid local minute.
 */
function toInstant(zone: IANAZone, floating: Date): Date {
  const local = floating.getTime();
  const offBefore = zone.offset(local - MS_DAY);
  const offAfter = zone.offset(local + MS_DAY);
  const candidates = [...new Set([offBefore, offAfter])]
    .map((off) => local - off * MS_MIN)
    .filter((utc) => zone.offset(utc) === (local - utc) / MS_MIN);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Gap: find the first minute whose offset is no longer offBefore.
  let lo = Math.floor((local - offAfter * MS_MIN) / MS_MIN); // offset == offBefore side
  let hi = Math.ceil((local - offBefore * MS_MIN) / MS_MIN); // offset == offAfter side
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (zone.offset(mid * MS_MIN) === offBefore) lo = mid;
    else hi = mid;
  }
  return new Date(hi * MS_MIN);
}

export function validateSeries(spec: SeriesSpec): void {
  prepare(spec);
}

export function occurrence(spec: SeriesSpec, index: number): Date | null {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RecurrenceError('RRULE_INVALID', `index must be an integer in 0..${String(MAX_INDEX)}`);
  }
  const { rule, zone } = prepare(spec);
  const hit: { d: Date | null } = { d: null };
  rule.all((date, i) => {
    if (i === index) {
      hit.d = date;
      return false;
    }
    return true;
  });
  return hit.d ? toInstant(zone, hit.d) : null;
}

export function nextOccurrence(
  spec: SeriesSpec,
  afterIndex: number,
  notBefore: Date | null,
): { index: number; at: Date } | null {
  if (!Number.isInteger(afterIndex) || afterIndex < -1) {
    throw new RecurrenceError('RRULE_INVALID', 'afterIndex must be an integer >= -1');
  }
  const { rule, zone } = prepare(spec);
  let result: { index: number; at: Date } | null = null;
  rule.all((date, i) => {
    if (i > MAX_INDEX) return false;
    if (i <= afterIndex) return true;
    const at = toInstant(zone, date);
    if (notBefore === null || at.getTime() > notBefore.getTime()) {
      result = { index: i, at };
      return false;
    }
    return true;
  });
  return result;
}

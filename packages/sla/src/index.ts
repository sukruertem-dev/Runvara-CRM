import { DateTime, IANAZone } from 'luxon';

export interface BusinessCalendar {
  /** IANA zone, e.g. 'Europe/Istanbul', 'Europe/Berlin'. */
  timezone: string;
  /**
   * Working intervals per ISO weekday (1 = Monday ... 7 = Sunday), local wall-clock 'HH:mm'
   * (end exclusive; '24:00' allowed as end). Several intervals per day allowed (e.g. lunch break).
   * Empty/missing day = closed.
   */
  weeklyHours: { day: 1 | 2 | 3 | 4 | 5 | 6 | 7; start: string; end: string }[];
  /**
   * Local dates 'YYYY-MM-DD'. A full holiday closes the day; a partial holiday replaces that day's
   * hours with the given intervals (e.g. half-day before a national holiday).
   */
  holidays: { date: string; name?: string; hours?: { start: string; end: string }[] }[];
}

export class SlaError extends Error {
  constructor(
    public readonly code: 'CALENDAR_INVALID' | 'NO_WORKING_TIME' | 'RANGE_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'SlaError';
  }
}

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;
const MAX_DAYS = 366;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Working interval in minutes since local midnight (end <= 1440). */
type MinuteInterval = readonly [number, number];
/** Working interval as UTC epoch milliseconds. */
type Span = readonly [number, number];

interface Compiled {
  zone: string;
  /** Index 1..7 (ISO weekday); index 0 unused. */
  week: MinuteInterval[][];
  holidays: Map<string, MinuteInterval[]>;
}

function invalid(message: string): SlaError {
  return new SlaError('CALENDAR_INVALID', message);
}

function parseTime(value: string, allow24: boolean, what: string): number {
  if (allow24 && value === '24:00') return 1440;
  if (!TIME_RE.test(value)) throw invalid(`${what}: invalid time '${value}'`);
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

function parseIntervals(list: readonly { start: string; end: string }[], what: string): MinuteInterval[] {
  const out: MinuteInterval[] = list.map((i) => {
    const s = parseTime(i.start, false, what);
    const e = parseTime(i.end, true, what);
    if (s >= e) throw invalid(`${what}: start '${i.start}' must be before end '${i.end}'`);
    return [s, e] as const;
  });
  out.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    if (prev && cur && cur[0] < prev[1]) throw invalid(`${what}: overlapping intervals`);
  }
  return out;
}

function compile(c: BusinessCalendar): Compiled {
  if (!IANAZone.isValidZone(c.timezone)) throw invalid(`unknown IANA timezone '${c.timezone}'`);
  const week: MinuteInterval[][] = [[], [], [], [], [], [], [], []];
  for (let day = 1; day <= 7; day++) {
    const list = c.weeklyHours.filter((w) => {
      if (!Number.isInteger(w.day) || w.day < 1 || w.day > 7) throw invalid(`invalid weekday ${String(w.day)}`);
      return w.day === day;
    });
    week[day] = parseIntervals(list, `weekday ${String(day)}`);
  }
  if (week.every((d) => d.length === 0)) {
    throw new SlaError('NO_WORKING_TIME', 'calendar has no working time in a week');
  }
  const holidays = new Map<string, MinuteInterval[]>();
  for (const h of c.holidays) {
    const ok = DATE_RE.test(h.date) && DateTime.fromISO(h.date, { zone: 'utc' }).isValid;
    if (!ok) throw invalid(`invalid holiday date '${h.date}'`);
    if (holidays.has(h.date)) throw invalid(`duplicate holiday date '${h.date}'`);
    holidays.set(h.date, h.hours ? parseIntervals(h.hours, `holiday ${h.date}`) : []);
  }
  return { zone: c.timezone, week, holidays };
}

export function validateCalendar(c: BusinessCalendar): void {
  compile(c);
}

function dateKey(d: DateTime): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${String(d.year).padStart(4, '0')}-${mm}-${dd}`;
}

/**
 * Working spans of the local calendar day `day` (a DateTime at local midnight of that day), as UTC instants.
 *
 * DST handling: each wall-clock time is converted to an instant with Luxon. On a spring-forward day a
 * wall-clock time that does not exist (e.g. 02:30 in Europe/Berlin on 2026-03-29) maps to the next valid
 * instant (shifted forward), so an interval touching the gap is simply shorter in real time (and one lying
 * entirely inside the gap collapses and is dropped). On a fall-back day an interval spanning the repeated
 * hour is longer in real time; real elapsed minutes are counted.
 */
function daySpans(day: DateTime, cc: Compiled): Span[] {
  const wall = cc.holidays.get(dateKey(day)) ?? cc.week[day.weekday] ?? [];
  const nextMidnight = day.plus({ days: 1 }).startOf('day').toMillis();
  const at = (min: number): number =>
    min >= 1440
      ? nextMidnight
      : DateTime.fromObject(
          { year: day.year, month: day.month, day: day.day, hour: Math.floor(min / 60), minute: min % 60 },
          { zone: cc.zone },
        ).toMillis();
  const out: Span[] = [];
  for (const [s, e] of wall) {
    const a = at(s);
    const b = at(e);
    if (b > a) out.push([a, b]);
  }
  return out;
}

function localDay(ms: number, zone: string): DateTime {
  return DateTime.fromMillis(ms, { zone }).startOf('day');
}

function checkDate(d: Date): number {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('invalid Date');
  return ms;
}

/**
 * Instant reached after `minutes` business minutes counted from `start`. If start is outside working time,
 * counting begins at the next opening. minutes = 0 moves start to the next opening (or start itself if inside
 * working time). Throws RANGE_EXCEEDED if the result would be more than 366 days after start.
 */
export function businessAdd(start: Date, minutes: number, c: BusinessCalendar): Date {
  const cc = compile(c);
  const startMs = checkDate(start);
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('minutes must be a finite number >= 0');
  const limit = startMs + MAX_DAYS * MS_DAY;
  let remaining = minutes * MS_MIN;
  const first = localDay(startMs, cc.zone);
  for (let i = 0; i <= MAX_DAYS + 1; i++) {
    const day = first.plus({ days: i }).startOf('day');
    if (day.toMillis() > limit) break;
    for (const [s, e] of daySpans(day, cc)) {
      const from = Math.max(s, startMs);
      if (e <= from) continue;
      const avail = e - from;
      if (remaining <= avail) {
        const result = from + remaining;
        if (result > limit) throw new SlaError('RANGE_EXCEEDED', 'result is more than 366 days after start');
        return new Date(result);
      }
      remaining -= avail;
    }
  }
  throw new SlaError('RANGE_EXCEEDED', 'result is more than 366 days after start');
}

/**
 * Business minutes between a and b (a <= b; if a > b the negative of businessDiff(b, a)). Fractional
 * minutes are possible. Throws RANGE_EXCEEDED if the span is longer than 366 days.
 */
export function businessDiff(a: Date, b: Date, c: BusinessCalendar): number {
  const cc = compile(c);
  const aMs = checkDate(a);
  const bMs = checkDate(b);
  if (aMs > bMs) return -businessDiff(b, a, c);
  if (bMs - aMs > MAX_DAYS * MS_DAY) throw new SlaError('RANGE_EXCEEDED', 'range is longer than 366 days');
  let total = 0;
  const first = localDay(aMs, cc.zone);
  for (let i = 0; i <= MAX_DAYS + 1; i++) {
    const day = first.plus({ days: i }).startOf('day');
    if (day.toMillis() >= bMs) break;
    for (const [s, e] of daySpans(day, cc)) {
      const lo = Math.max(s, aMs);
      const hi = Math.min(e, bMs);
      if (hi > lo) total += hi - lo;
    }
  }
  return total / MS_MIN;
}

/** Next instant >= t that is inside working time (t itself if open). */
export function nextOpening(t: Date, c: BusinessCalendar): Date {
  return businessAdd(t, 0, c);
}

export function isOpen(t: Date, c: BusinessCalendar): boolean {
  const cc = compile(c);
  const ms = checkDate(t);
  return daySpans(localDay(ms, cc.zone), cc).some(([s, e]) => s <= ms && ms < e);
}

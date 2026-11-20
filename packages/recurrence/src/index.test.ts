import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { nextOccurrence, occurrence, RecurrenceError, validateSeries, type SeriesSpec } from './index';

function series(s: SeriesSpec, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = occurrence(s, i);
    if (!d) break;
    out.push(d.toISOString());
  }
  return out;
}
const spec = (rrule: string, dtstartLocal: string, tzid: string): SeriesSpec => ({ rrule, dtstartLocal, tzid });
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RecurrenceError ? e.code : 'other';
  }
  return undefined;
}

describe('Europe/Istanbul', () => {
  it('daily 09:00 is 06:00Z', () => {
    expect(series(spec('FREQ=DAILY', '2026-03-28T09:00', 'Europe/Istanbul'), 3)).toEqual([
      '2026-03-28T06:00:00.000Z',
      '2026-03-29T06:00:00.000Z',
      '2026-03-30T06:00:00.000Z',
    ]);
  });
});

describe('Europe/Berlin DST', () => {
  it('daily 09:00 stays 09:00 local across spring-forward', () => {
    expect(series(spec('FREQ=DAILY', '2026-03-28T09:00', 'Europe/Berlin'), 3)).toEqual([
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
  });
  it('daily 09:00 stays 09:00 local across fall-back', () => {
    expect(series(spec('FREQ=DAILY', '2026-10-24T09:00', 'Europe/Berlin'), 3)).toEqual([
      '2026-10-24T07:00:00.000Z',
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ]);
  });
  it('nonexistent 02:30 becomes 03:00 local (01:00Z)', () => {
    expect(series(spec('FREQ=DAILY', '2026-03-28T02:30', 'Europe/Berlin'), 3)).toEqual([
      '2026-03-28T01:30:00.000Z',
      '2026-03-29T01:00:00.000Z',
      '2026-03-30T00:30:00.000Z',
    ]);
  });
  it('ambiguous 02:30 picks the first occurrence (00:30Z)', () => {
    expect(series(spec('FREQ=DAILY', '2026-10-24T02:30', 'Europe/Berlin'), 3)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
  });
});

describe('America/New_York', () => {
  it('weekly MO,WE,FR 18:00 across both transitions', () => {
    expect(series(spec('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-03-06T18:00', 'America/New_York'), 4)).toEqual([
      '2026-03-06T23:00:00.000Z',
      '2026-03-09T22:00:00.000Z',
      '2026-03-11T22:00:00.000Z',
      '2026-03-13T22:00:00.000Z',
    ]);
    expect(series(spec('FREQ=WEEKLY;BYDAY=MO,WE,FR', '2026-10-30T18:00', 'America/New_York'), 3)).toEqual([
      '2026-10-30T22:00:00.000Z',
      '2026-11-02T23:00:00.000Z',
      '2026-11-04T23:00:00.000Z',
    ]);
  });
  it('gap 02:30 on 2026-03-08 becomes 03:00 EDT (07:00Z)', () => {
    expect(series(spec('FREQ=DAILY', '2026-03-08T02:30', 'America/New_York'), 1)).toEqual([
      '2026-03-08T07:00:00.000Z',
    ]);
  });
});

describe('rule semantics', () => {
  it('BYMONTHDAY=31 skips short months', () => {
    expect(series(spec('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T09:00', 'Europe/Istanbul'), 4)).toEqual([
      '2026-01-31T06:00:00.000Z',
      '2026-03-31T06:00:00.000Z',
      '2026-05-31T06:00:00.000Z',
      '2026-07-31T06:00:00.000Z',
    ]);
  });
  it('BYMONTHDAY=-1 is the last day', () => {
    expect(series(spec('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31T09:00', 'Europe/Istanbul'), 3)).toEqual([
      '2026-01-31T06:00:00.000Z',
      '2026-02-28T06:00:00.000Z',
      '2026-03-31T06:00:00.000Z',
    ]);
  });
  it('last Friday via BYSETPOS=-1', () => {
    expect(series(spec('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1', '2026-01-01T10:00', 'Europe/Istanbul'), 3)).toEqual([
      '2026-01-30T07:00:00.000Z',
      '2026-02-27T07:00:00.000Z',
      '2026-03-27T07:00:00.000Z',
    ]);
  });
  it('yearly Feb 29 only in leap years', () => {
    expect(series(spec('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2024-02-29T09:00', 'Europe/Istanbul'), 3)).toEqual([
      '2024-02-29T06:00:00.000Z',
      '2028-02-29T06:00:00.000Z',
      '2032-02-29T06:00:00.000Z',
    ]);
  });
  it('INTERVAL=2', () => {
    expect(series(spec('FREQ=DAILY;INTERVAL=2', '2026-01-01T09:00', 'Europe/Istanbul'), 3)).toEqual([
      '2026-01-01T06:00:00.000Z',
      '2026-01-03T06:00:00.000Z',
      '2026-01-05T06:00:00.000Z',
    ]);
  });
  it('COUNT exhaustion returns null', () => {
    const s = spec('FREQ=DAILY;COUNT=2', '2026-01-01T09:00', 'Europe/Istanbul');
    expect(occurrence(s, 1)?.toISOString()).toBe('2026-01-02T06:00:00.000Z');
    expect(occurrence(s, 2)).toBeNull();
    expect(nextOccurrence(s, 1, null)).toBeNull();
  });
  it('UNTIL without Z is local wall-clock; with Z is UTC', () => {
    const base = '2026-06-01T09:00'; // Berlin summer: 09:00 local = 07:00Z
    expect(series(spec('FREQ=DAILY;UNTIL=20260603T090000', base, 'Europe/Berlin'), 10)).toHaveLength(3);
    expect(series(spec('FREQ=DAILY;UNTIL=20260603T080000', base, 'Europe/Berlin'), 10)).toHaveLength(2);
    expect(series(spec('FREQ=DAILY;UNTIL=20260603T070000Z', base, 'Europe/Berlin'), 10)).toHaveLength(3);
    expect(series(spec('FREQ=DAILY;UNTIL=20260603T065900Z', base, 'Europe/Berlin'), 10)).toHaveLength(2);
  });
});

describe('nextOccurrence', () => {
  const s = spec('FREQ=DAILY', '2026-01-01T09:00', 'Europe/Istanbul');
  it('without notBefore is afterIndex+1', () => {
    expect(nextOccurrence(s, 0, null)).toEqual({ index: 1, at: new Date('2026-01-02T06:00:00.000Z') });
  });
  it('skip_missed returns first occurrence after notBefore with right index', () => {
    const r = nextOccurrence(s, 0, new Date('2026-02-10T12:00:00.000Z'));
    expect(r?.at.toISOString()).toBe('2026-02-11T06:00:00.000Z');
    expect(r?.index).toBe(41);
  });
  it('notBefore equal to an occurrence is skipped (strictly greater)', () => {
    expect(nextOccurrence(s, 0, new Date('2026-01-02T06:00:00.000Z'))?.index).toBe(2);
  });
  it('null when exhausted by UNTIL', () => {
    const u = spec('FREQ=DAILY;UNTIL=20260105T090000', '2026-01-01T09:00', 'Europe/Istanbul');
    expect(nextOccurrence(u, 0, new Date('2026-03-01T00:00:00Z'))).toBeNull();
  });
});

describe('errors', () => {
  const ok = spec('FREQ=DAILY', '2026-01-01T09:00', 'Europe/Berlin');
  it('bad tz', () => {
    expect(code(() => { validateSeries({ ...ok, tzid: 'Mars/Base' }); })).toBe('TZ_INVALID');
  });
  it('HOURLY is unsupported', () => {
    expect(code(() => { validateSeries({ ...ok, rrule: 'FREQ=HOURLY' }); })).toBe('RRULE_UNSUPPORTED');
  });
  it('garbage and oversize rules', () => {
    expect(code(() => { validateSeries({ ...ok, rrule: 'hello world' }); })).toBe('RRULE_INVALID');
    expect(code(() => { validateSeries({ ...ok, rrule: 'FREQ=DAILY;' + 'X'.repeat(500) }); })).toBe('RRULE_INVALID');
    expect(code(() => { validateSeries({ ...ok, rrule: '' }); })).toBe('RRULE_INVALID');
  });
  it('DTSTART/TZID inside the rule', () => {
    expect(code(() => { validateSeries({ ...ok, rrule: 'DTSTART:20260101T090000\nRRULE:FREQ=DAILY' }); })).toBe(
      'RRULE_INVALID',
    );
    expect(code(() => { validateSeries({ ...ok, rrule: 'FREQ=DAILY;TZID=Europe/Berlin' }); })).toBe('RRULE_INVALID');
  });
  it('bad dtstartLocal', () => {
    expect(code(() => { validateSeries({ ...ok, dtstartLocal: '2026-02-30T09:00' }); })).toBe('RRULE_INVALID');
    expect(code(() => { validateSeries({ ...ok, dtstartLocal: '2026-01-01 09:00' }); })).toBe('RRULE_INVALID');
    expect(code(() => { validateSeries({ ...ok, dtstartLocal: '2026-01-01T24:00' }); })).toBe('RRULE_INVALID');
  });
  it('index out of range', () => {
    expect(code(() => { occurrence(ok, 10001); })).toBe('RRULE_INVALID');
    expect(code(() => { occurrence(ok, -1); })).toBe('RRULE_INVALID');
  });
  it('valid spec passes', () => {
    expect(() => {
      validateSeries(ok);
    }).not.toThrow();
  });
});

describe('properties', () => {
  const zones = ['Europe/Istanbul', 'Europe/Berlin', 'America/New_York', 'Pacific/Auckland'];
  const specArb = fc
    .record({
      zone: fc.constantFrom(...zones),
      start: fc.date({
        min: new Date('2024-01-01T00:00:00Z'),
        max: new Date('2030-12-31T00:00:00Z'),
        noInvalidDate: true,
      }),
      interval: fc.integer({ min: 1, max: 3 }),
      weekly: fc.boolean(),
      days: fc.uniqueArray(fc.constantFrom('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'), { minLength: 1, maxLength: 4 }),
    })
    .map(({ zone, start, interval, weekly, days }) => {
      const iso = start.toISOString().slice(0, 16);
      const n = String(interval);
      const rule = weekly ? `FREQ=WEEKLY;INTERVAL=${n};BYDAY=${days.join(',')}` : `FREQ=DAILY;INTERVAL=${n}`;
      return spec(rule, iso, zone);
    });
  it('strictly increasing and consistent with nextOccurrence', () => {
    fc.assert(
      fc.property(specArb, (s) => {
        let prev: Date | null = null;
        for (let i = 0; i < 40; i++) {
          const cur = occurrence(s, i);
          expect(cur).not.toBeNull();
          if (!cur) return;
          if (prev) expect(cur.getTime()).toBeGreaterThan(prev.getTime());
          if (i > 0) expect(nextOccurrence(s, i - 1, null)?.at.getTime()).toBe(cur.getTime());
          prev = cur;
        }
      }),
      { numRuns: 60 },
    );
  });
});

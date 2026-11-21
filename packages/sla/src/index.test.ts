import { DateTime } from 'luxon';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { businessAdd, businessDiff, isOpen, nextOpening, SlaError, validateCalendar, type BusinessCalendar } from './index';

type Day = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const WEEKDAYS: Day[] = [1, 2, 3, 4, 5];
const ALL_DAYS: Day[] = [1, 2, 3, 4, 5, 6, 7];

function cal(
  timezone: string,
  days: Day[],
  hours: { start: string; end: string }[],
  holidays: BusinessCalendar['holidays'] = [],
): BusinessCalendar {
  return { timezone, weeklyHours: days.flatMap((day) => hours.map((h) => ({ day, ...h }))), holidays };
}
const istanbul = (holidays: BusinessCalendar['holidays'] = []): BusinessCalendar =>
  cal('Europe/Istanbul', WEEKDAYS, [{ start: '09:00', end: '18:00' }], holidays);
const berlin247: BusinessCalendar = cal('Europe/Berlin', ALL_DAYS, [{ start: '00:00', end: '24:00' }]);

/** Local wall-clock string to a UTC Date. */
function at(local: string, zone: string): Date {
  return DateTime.fromISO(local, { zone }).toJSDate();
}
/** UTC Date to local wall-clock string. */
function loc(d: Date, zone: string): string {
  return DateTime.fromJSDate(d, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}
function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SlaError ? e.code : 'other';
  }
  return undefined;
}

const IST = 'Europe/Istanbul';

describe('businessAdd, Istanbul Mon-Fri 09:00-18:00', () => {
  it('Friday 17:00 + 120 min lands on Monday 10:00', () => {
    expect(loc(businessAdd(at('2026-03-06T17:00', IST), 120, istanbul()), IST)).toBe('2026-03-09T10:00');
  });
  it('weekend start counts from Monday 09:00', () => {
    expect(loc(businessAdd(at('2026-03-07T12:00', IST), 90, istanbul()), IST)).toBe('2026-03-09T10:30');
  });
  it('minutes = 0 moves to next opening, or stays when open', () => {
    expect(loc(businessAdd(at('2026-03-07T12:00', IST), 0, istanbul()), IST)).toBe('2026-03-09T09:00');
    expect(loc(businessAdd(at('2026-03-04T11:00', IST), 0, istanbul()), IST)).toBe('2026-03-04T11:00');
    expect(loc(nextOpening(at('2026-03-04T19:00', IST), istanbul()), IST)).toBe('2026-03-05T09:00');
  });
  it('ending exactly at closing time stays at closing time', () => {
    expect(loc(businessAdd(at('2026-03-04T10:00', IST), 480, istanbul()), IST)).toBe('2026-03-04T18:00');
  });
  it('a Monday holiday pushes to Tuesday', () => {
    const c = istanbul([{ date: '2026-03-09', name: 'Holiday' }]);
    expect(loc(businessAdd(at('2026-03-06T17:00', IST), 120, c), IST)).toBe('2026-03-10T10:00');
  });
  it('a partial holiday replaces the day hours', () => {
    const c = istanbul([{ date: '2026-03-06', hours: [{ start: '09:00', end: '13:00' }] }]);
    // Friday only open until 13:00: 12:00 + 120 min -> 1h Friday + 1h Monday
    expect(loc(businessAdd(at('2026-03-06T12:00', IST), 120, c), IST)).toBe('2026-03-09T10:00');
    expect(isOpen(at('2026-03-06T14:00', IST), c)).toBe(false);
    expect(isOpen(at('2026-03-06T12:59', IST), c)).toBe(true);
  });
  it('a partial holiday may open a normally closed day', () => {
    const c = istanbul([{ date: '2026-03-07', hours: [{ start: '10:00', end: '12:00' }] }]);
    expect(loc(businessAdd(at('2026-03-06T17:30', IST), 60, c), IST)).toBe('2026-03-07T10:30');
  });
  it('rejects fractional-free invalid inputs and ranges', () => {
    expect(code(() => businessAdd(at('2026-03-06T17:00', IST), 60 * 24 * 400, istanbul()))).toBe('RANGE_EXCEEDED');
    expect(() => businessAdd(new Date(NaN), 5, istanbul())).toThrow(RangeError);
    expect(() => businessAdd(new Date(), -1, istanbul())).toThrow(RangeError);
  });
  it('is pure: input date is not mutated', () => {
    const s = at('2026-03-06T17:00', IST);
    const t = s.getTime();
    businessAdd(s, 500, istanbul());
    expect(s.getTime()).toBe(t);
  });
});

describe('lunch break calendar', () => {
  const lunch = cal('Europe/Istanbul', WEEKDAYS, [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '18:00' },
  ]);
  it('skips lunch', () => {
    expect(loc(businessAdd(at('2026-03-04T11:00', IST), 120, lunch), IST)).toBe('2026-03-04T14:00');
  });
  it('start inside lunch begins at 13:00', () => {
    expect(loc(businessAdd(at('2026-03-04T12:30', IST), 30, lunch), IST)).toBe('2026-03-04T13:30');
    expect(isOpen(at('2026-03-04T12:30', IST), lunch)).toBe(false);
  });
  it('diff across lunch', () => {
    expect(businessDiff(at('2026-03-04T11:00', IST), at('2026-03-04T14:00', IST), lunch)).toBe(120);
  });
});

describe('Europe/Berlin DST', () => {
  const BER = 'Europe/Berlin';
  it('spring-forward 24x7: 00:00 + 240 min -> 05:00 CEST', () => {
    expect(loc(businessAdd(at('2026-03-29T00:00', BER), 240, berlin247), BER)).toBe('2026-03-29T05:00');
  });
  it('fall-back 24x7: 00:00 + 240 min -> 03:00 CET', () => {
    expect(loc(businessAdd(at('2026-10-25T00:00', BER), 240, berlin247), BER)).toBe('2026-10-25T03:00');
  });
  it('real elapsed minutes are counted over the DST days', () => {
    expect(businessDiff(at('2026-03-29T00:00', BER), at('2026-03-30T00:00', BER), berlin247)).toBe(23 * 60);
    expect(businessDiff(at('2026-10-25T00:00', BER), at('2026-10-26T00:00', BER), berlin247)).toBe(25 * 60);
  });
  it('Mon-Fri across the DST weekend keeps Monday hours in local time', () => {
    const c = cal(BER, WEEKDAYS, [{ start: '09:00', end: '18:00' }]);
    expect(loc(businessAdd(at('2026-03-27T17:00', BER), 120, c), BER)).toBe('2026-03-30T10:00');
    expect(loc(businessAdd(at('2026-10-23T17:00', BER), 120, c), BER)).toBe('2026-10-26T10:00');
    expect(loc(nextOpening(at('2026-03-29T12:00', BER), c), BER)).toBe('2026-03-30T09:00');
  });
  it('an interval touching the spring-forward gap is shorter', () => {
    const sunday = cal(BER, [7], [{ start: '01:00', end: '04:00' }]);
    expect(businessDiff(at('2026-03-29T00:00', BER), at('2026-03-30T00:00', BER), sunday)).toBe(120);
  });
  it('an interval spanning the fall-back hour is longer', () => {
    const sunday = cal(BER, [7], [{ start: '01:00', end: '04:00' }]);
    expect(businessDiff(at('2026-10-25T00:00', BER), at('2026-10-26T00:00', BER), sunday)).toBe(240);
  });
});

describe('America/New_York DST', () => {
  const NY = 'America/New_York';
  it('spring-forward 24x7: 00:00 EST + 180 min -> 04:00 EDT', () => {
    const c = cal(NY, ALL_DAYS, [{ start: '00:00', end: '24:00' }]);
    expect(loc(businessAdd(at('2026-03-08T00:00', NY), 180, c), NY)).toBe('2026-03-08T04:00');
  });
  it('Mon-Fri 09:00-17:00 across spring-forward', () => {
    const c = cal(NY, WEEKDAYS, [{ start: '09:00', end: '17:00' }]);
    expect(loc(businessAdd(at('2026-03-06T16:00', NY), 120, c), NY)).toBe('2026-03-09T10:00');
  });
  it('fall-back 24x7: 00:00 EDT + 240 min -> 03:00 EST', () => {
    const c = cal(NY, ALL_DAYS, [{ start: '00:00', end: '24:00' }]);
    expect(loc(businessAdd(at('2026-11-01T00:00', NY), 240, c), NY)).toBe('2026-11-01T03:00');
  });
});

describe('businessDiff', () => {
  it('basic example over a weekend', () => {
    expect(businessDiff(at('2026-03-06T17:00', IST), at('2026-03-09T10:00', IST), istanbul())).toBe(120);
  });
  it('negative when a > b', () => {
    expect(businessDiff(at('2026-03-09T10:00', IST), at('2026-03-06T17:00', IST), istanbul())).toBe(-120);
  });
  it('is zero for equal instants and for a closed range', () => {
    const t = at('2026-03-04T10:00', IST);
    expect(businessDiff(t, t, istanbul())).toBe(0);
    expect(businessDiff(at('2026-03-07T00:00', IST), at('2026-03-08T23:00', IST), istanbul())).toBe(0);
  });
  it('skips a holiday', () => {
    const c = istanbul([{ date: '2026-03-09' }]);
    expect(businessDiff(at('2026-03-06T17:00', IST), at('2026-03-10T10:00', IST), c)).toBe(120);
  });
  it('supports fractional minutes', () => {
    const a = at('2026-03-04T10:00', IST);
    expect(businessDiff(a, new Date(a.getTime() + 30_000), istanbul())).toBe(0.5);
  });
  it('rejects ranges over 366 days', () => {
    expect(code(() => businessDiff(at('2024-01-01T00:00', IST), at('2026-01-01T00:00', IST), istanbul()))).toBe('RANGE_EXCEEDED');
  });
});

describe('validateCalendar', () => {
  const base = (): BusinessCalendar => istanbul();
  it('accepts a valid calendar', () => {
    expect(() => {
      validateCalendar(base());
    }).not.toThrow();
  });
  it('rejects a bad timezone', () => {
    expect(code(() => { validateCalendar({ ...base(), timezone: 'Mars/Olympus' }); })).toBe('CALENDAR_INVALID');
  });
  it('rejects bad HH:mm', () => {
    const c = { ...base(), weeklyHours: [{ day: 1 as const, start: '9:00', end: '18:00' }] };
    expect(code(() => { validateCalendar(c); })).toBe('CALENDAR_INVALID');
    const c2 = { ...base(), weeklyHours: [{ day: 1 as const, start: '24:00', end: '24:00' }] };
    expect(code(() => { validateCalendar(c2); })).toBe('CALENDAR_INVALID');
  });
  it('rejects start >= end', () => {
    const c = { ...base(), weeklyHours: [{ day: 1 as const, start: '18:00', end: '09:00' }] };
    expect(code(() => { validateCalendar(c); })).toBe('CALENDAR_INVALID');
    const c2 = { ...base(), weeklyHours: [{ day: 1 as const, start: '09:00', end: '09:00' }] };
    expect(code(() => { validateCalendar(c2); })).toBe('CALENDAR_INVALID');
  });
  it('rejects overlapping intervals', () => {
    const c = {
      ...base(),
      weeklyHours: [
        { day: 2 as const, start: '09:00', end: '13:00' },
        { day: 2 as const, start: '12:00', end: '18:00' },
      ],
    };
    expect(code(() => { validateCalendar(c); })).toBe('CALENDAR_INVALID');
  });
  it('rejects an empty week', () => {
    expect(code(() => { validateCalendar({ ...base(), weeklyHours: [] }); })).toBe('NO_WORKING_TIME');
  });
  it('rejects bad and duplicate holiday dates and bad holiday hours', () => {
    expect(code(() => { validateCalendar({ ...base(), holidays: [{ date: '2026-02-30' }] }); })).toBe('CALENDAR_INVALID');
    expect(code(() => { validateCalendar({ ...base(), holidays: [{ date: '26-1-1' }] }); })).toBe('CALENDAR_INVALID');
    expect(
      code(() => { validateCalendar({ ...base(), holidays: [{ date: '2026-01-01' }, { date: '2026-01-01' }] }); }),
    ).toBe('CALENDAR_INVALID');
    expect(
      code(() => { validateCalendar({ ...base(), holidays: [{ date: '2026-01-01', hours: [{ start: '12:00', end: '10:00' }] }] }); }),
    ).toBe('CALENDAR_INVALID');
  });
  it('functions validate their calendar', () => {
    expect(code(() => businessAdd(new Date(), 1, { ...base(), timezone: 'Nope/Zone' }))).toBe('CALENDAR_INVALID');
  });
});

describe('properties', () => {
  const templates: BusinessCalendar[] = [
    istanbul([{ date: '2026-04-23' }, { date: '2026-05-01', hours: [{ start: '09:00', end: '12:00' }] }]),
    cal('Europe/Berlin', WEEKDAYS, [{ start: '08:30', end: '12:00' }, { start: '13:00', end: '17:30' }]),
    cal('America/New_York', WEEKDAYS, [{ start: '09:00', end: '17:00' }], [{ date: '2026-03-09' }]),
    berlin247,
    cal('Europe/Berlin', [1, 2, 3, 4, 5, 7], [{ start: '01:00', end: '04:00' }, { start: '10:00', end: '24:00' }]),
  ];
  const start = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) });

  it('businessDiff(nextOpening(s), businessAdd(s, m)) === m', () => {
    fc.assert(
      fc.property(fc.constantFrom(...templates), start, fc.integer({ min: 0, max: 20_000 }), (c, s, m) => {
        const d = new Date(s);
        const end = businessAdd(d, m, c);
        const diff = businessDiff(nextOpening(d, c), end, c);
        expect(Math.abs(diff - m)).toBeLessThan(1e-6);
      }),
      { numRuns: 300 },
    );
  });
  it('businessAdd is monotonic in minutes and lands in working time', () => {
    fc.assert(
      fc.property(fc.constantFrom(...templates), start, fc.integer({ min: 1, max: 5_000 }), (c, s, m) => {
        const d = new Date(s);
        const e1 = businessAdd(d, m, c);
        const e2 = businessAdd(d, m + 1, c);
        expect(e2.getTime()).toBeGreaterThan(e1.getTime());
        expect(isOpen(new Date(e1.getTime() - 1), c)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
  it('businessDiff is antisymmetric', () => {
    fc.assert(
      fc.property(fc.constantFrom(...templates), start, fc.integer({ min: 0, max: 30 * 86_400_000 }), (c, s, delta) => {
        const a = new Date(s);
        const b = new Date(s + delta);
        // Numeric equality (0 and -0 are the same duration).
        expect(businessDiff(a, b, c) + businessDiff(b, a, c)).toBeCloseTo(0, 9);
      }),
      { numRuns: 300 },
    );
  });
});

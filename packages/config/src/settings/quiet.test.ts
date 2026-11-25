import { describe, expect, it } from 'vitest';
import { isQuiet } from './quiet';

const at = (iso: string) => new Date(iso);
const night = { enabled: true, from: '22:00', to: '07:30' };

describe('isQuiet', () => {
  it('runs past midnight in the person’s time zone', () => {
    // Istanbul is UTC+3.
    expect(isQuiet(night, 'Europe/Istanbul', at('2026-11-25T18:59:00Z'))).toBe(false);
    expect(isQuiet(night, 'Europe/Istanbul', at('2026-11-25T19:00:00Z'))).toBe(true);
    expect(isQuiet(night, 'Europe/Istanbul', at('2026-11-26T04:29:00Z'))).toBe(true);
    expect(isQuiet(night, 'Europe/Istanbul', at('2026-11-26T04:30:00Z'))).toBe(false);
    expect(isQuiet(night, 'America/New_York', at('2026-11-25T19:00:00Z'))).toBe(false);
  });

  it('same-day window, empty window and switched off', () => {
    const lunch = { enabled: true, from: '12:00', to: '13:00' };
    expect(isQuiet(lunch, 'UTC', at('2026-11-25T12:30:00Z'))).toBe(true);
    expect(isQuiet(lunch, 'UTC', at('2026-11-25T13:00:00Z'))).toBe(false);
    expect(isQuiet({ ...lunch, to: '12:00' }, 'UTC', at('2026-11-25T12:00:00Z'))).toBe(false);
    expect(isQuiet({ ...lunch, enabled: false }, 'UTC', at('2026-11-25T12:30:00Z'))).toBe(false);
  });
});

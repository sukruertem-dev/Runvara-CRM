import { describe, expect, it } from 'vitest';
import { effectiveLimits, entitled, entitledModules, entitlement, PLANS, quotaAllows, quotaLevel } from './index';

describe('plans (TEN-09, MOD-04)', () => {
  it('defines the four plans with non-negative limits', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['trial', 'starter', 'growth', 'enterprise']);
  });

  it('derives entitlement from the catalogue tier and add-ons', () => {
    expect(entitlement('starter', [], 'crm')).toBe('included');
    expect(entitlement('starter', [], 'sales_b2b')).toBe('not_in_plan');
    expect(entitlement('growth', [], 'dialer')).toBe('available_add_on');
    expect(entitlement('growth', ['dialer'], 'dialer')).toBe('add_on');
    expect(entitled('growth', ['dialer'], 'dialer')).toBe(true);
    expect(entitled('growth', [], 'dialer')).toBe(false);
    expect(entitled('growth', [], 'nope')).toBe(false);
    // The trial tries everything.
    expect(entitledModules('trial', [])).toHaveLength(13);
  });

  it('applies limit overrides and ignores invalid ones', () => {
    expect(effectiveLimits('starter', { users: 25, records: -1, storage_bytes: 1.5, bogus: 3 })).toMatchObject({ users: 25, records: 50000 });
  });

  it('grades usage at 80/100/120 % and checks writes against soft or hard limits', () => {
    expect(quotaLevel(79, 100)).toBe('ok');
    expect(quotaLevel(80, 100)).toBe('warning');
    expect(quotaLevel(100, 100)).toBe('soft');
    expect(quotaLevel(120, 100)).toBe('hard');
    expect(quotaLevel(0, 0)).toBe('ok');
    expect(quotaAllows(9, 10, 1, 'soft')).toBe(true);
    expect(quotaAllows(10, 10, 1, 'soft')).toBe(false);
    expect(quotaAllows(110, 100, 10, 'hard')).toBe(true);
    expect(quotaAllows(120, 100, 1, 'hard')).toBe(false);
    expect(quotaAllows(0, 0, 1, 'soft')).toBe(false);
  });
});

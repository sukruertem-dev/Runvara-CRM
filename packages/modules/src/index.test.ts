import { describe, expect, it } from 'vitest';
import { assertCatalogValid, MODULES, moduleForPath, moduleForPermission, planToggle, type ModuleManifest } from './index';

describe('module catalog', () => {
  it('has the 13 modules of §10.3.1 and is acyclic', () => {
    expect(MODULES.map((m) => m.id).sort()).toEqual(
      ['ai_assistant', 'api_webhooks', 'automation_sla', 'call_center', 'call_qa', 'core', 'crm', 'data_service', 'dialer',
        'reporting_advanced', 'sales_b2b', 'sales_b2c', 'sales_tracking'].sort(),
    );
    expect(() => { assertCatalogValid(); }).not.toThrow();
  });

  it('detects cycles and unknown dependencies', () => {
    const base = MODULES.find((m) => m.id === 'core')!;
    const a: ModuleManifest = { ...base, id: 'crm', dependsOn: [['sales_b2b']], alwaysOn: false };
    const b: ModuleManifest = { ...base, id: 'sales_b2b', dependsOn: [['crm']], alwaysOn: false };
    expect(() => { assertCatalogValid([a, b]); }).toThrow(/cycle/);
    expect(() => { assertCatalogValid([{ ...a, dependsOn: [['dialer']] }]); }).toThrow(/unknown/);
  });
});

describe('planToggle (MOD-02, MOD-03)', () => {
  const on = (...ids: string[]) => new Set(['core', ...ids]);

  it('refuses dialer without call_center (G1 acceptance criterion)', () => {
    expect(planToggle(on('crm', 'sales_b2c'), 'dialer', true)).toEqual({
      ok: false,
      error: { code: 'MODULE_DEPENDENCY_UNMET', missing: [['call_center']] },
    });
  });

  it('accepts dialer when call_center and one sales module are on (OR group)', () => {
    expect(planToggle(on('crm', 'call_center', 'sales_b2b'), 'dialer', true)).toEqual({ ok: true, enable: ['dialer'], disable: [] });
    expect(planToggle(on('crm', 'call_center'), 'dialer', true)).toMatchObject({ ok: false, error: { missing: [['sales_b2b', 'sales_b2c']] } });
  });

  it('refuses to disable a module with dependents unless cascading', () => {
    const current = on('crm', 'call_center', 'sales_b2b', 'dialer', 'call_qa');
    expect(planToggle(current, 'call_center', false)).toEqual({ ok: false, error: { code: 'MODULE_HAS_DEPENDENTS', dependents: ['dialer', 'call_qa'] } });
    expect(planToggle(current, 'call_center', false, { cascade: true })).toEqual({ ok: true, enable: [], disable: ['call_center', 'dialer', 'call_qa'] });
  });

  it('keeps dialer when one of its OR-dependencies remains', () => {
    const current = on('crm', 'call_center', 'sales_b2b', 'sales_b2c', 'dialer');
    expect(planToggle(current, 'sales_b2b', false)).toEqual({ ok: true, enable: [], disable: ['sales_b2b'] });
  });

  it('core is always on and unknown ids are rejected', () => {
    expect(planToggle(on(), 'core', false)).toEqual({ ok: false, error: { code: 'MODULE_ALWAYS_ON' } });
    expect(planToggle(on(), 'payroll', true)).toEqual({ ok: false, error: { code: 'MODULE_UNKNOWN' } });
    expect(planToggle(on('crm'), 'crm', true)).toEqual({ ok: true, enable: [], disable: [] });
  });
});

describe('routing and permissions', () => {
  it('maps API paths to owning modules by longest prefix', () => {
    expect(moduleForPath('/v1/sales/b2b/quotes')).toBe('sales_b2b');
    expect(moduleForPath('/v1/leads/123:convert')).toBe('crm');
    expect(moduleForPath('/dataservice/v1/lookup')).toBe('data_service');
    expect(moduleForPath('/v1/modules')).toBe('core');
    expect(moduleForPath('/v1/auth/login')).toBeNull();
    expect(moduleForPath('/v1/leadsx')).toBeNull();
  });

  it('maps permission keys to modules', () => {
    expect(moduleForPermission('users.invite')).toBe('core');
    expect(moduleForPermission('call_center.recording.listen')).toBe('call_center');
    expect(moduleForPermission('nope.nope')).toBeNull();
  });
});

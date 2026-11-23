import { BUNDLE_FORMAT, ConfigBundle, type ConfigBundleValue } from '@flexa/contracts';
import { describe, expect, it } from 'vitest';
import { BLUEPRINT_LIST } from './blueprints';
import { enableOrder, importedSettingValue, planBundle } from './bundle-plan';

const empty = (over: Partial<ConfigBundleValue> = {}): ConfigBundleValue => ({ ...ConfigBundle.parse({ format: BUNDLE_FORMAT, salesMode: 'both' }), ...over });
const trial = { plan: { id: 'trial', addOns: [] as string[] } };
const starter = { plan: { id: 'starter', addOns: [] as string[] } };

describe('blueprints', () => {
  it('are the three industry blueprints and all valid bundles', () => {
    expect(BLUEPRINT_LIST.map((b) => b.id)).toEqual(['enterprise-b2b', 'retail-b2c', 'telesales-callcenter']);
  });

  it('apply cleanly to an empty workspace on the trial plan', () => {
    for (const b of BLUEPRINT_LIST) {
      const plan = planBundle(empty(), b.bundle, trial);
      expect(plan.blocking, b.id).toBe(0);
      expect(plan.summary.conflict, b.id).toBe(0);
      expect(plan.summary.create, b.id).toBeGreaterThan(5);
    }
  });

  it('are unchanged when applied a second time', () => {
    for (const b of BLUEPRINT_LIST) {
      // The state after applying: the blueprint itself (plus core, which bundles never list).
      const plan = planBundle({ ...b.bundle, modules: b.bundle.modules }, b.bundle, trial);
      expect(plan.operations.filter((o) => o.action !== 'unchanged'), b.id).toEqual([]);
    }
  });
});

describe('planBundle', () => {
  const field = { resourceType: 'account' as const, key: 'cf_tier', type: 'select' as const, label: { tr: 'Seviye' }, required: false, options: [{ id: 'a', label: { tr: 'A' } }], indexed: false };

  it('reports a different definition under the same key as a conflict that keeping can resolve', () => {
    const current = empty({ customFields: [field] });
    const plan = planBundle(current, empty({ customFields: [{ ...field, label: { tr: 'Kademe' } }] }), trial);
    expect(plan.operations).toEqual([
      { section: 'salesMode', key: 'salesMode', action: 'unchanged' },
      expect.objectContaining({ section: 'customFields', key: 'account.cf_tier', action: 'conflict', reason: 'definition_differs', patch: [{ op: 'replace', path: '/label/tr', value: 'Kademe' }] }),
    ]);
    expect(plan.blocking).toBe(0);
    expect(plan.applicable).toBe(true);
  });

  it('blocks modules outside the plan and modules whose dependencies are missing', () => {
    const plan = planBundle(empty(), empty({ modules: ['crm', 'sales_b2b'] }), starter);
    expect(plan.operations.find((o) => o.key === 'sales_b2b')).toMatchObject({ action: 'conflict', reason: 'module_not_in_plan' });
    expect(plan.operations.find((o) => o.key === 'crm')).toMatchObject({ action: 'create' });

    const dialer = planBundle(empty({ modules: ['crm', 'sales_b2c'] }), empty({ modules: ['dialer'] }), trial);
    expect(dialer.operations.find((o) => o.key === 'dialer')).toMatchObject({ action: 'conflict', reason: 'module_dependency', detail: 'call_center' });
    expect(dialer.applicable).toBe(false);
    // Bringing the dependency along resolves it.
    expect(planBundle(empty({ modules: ['crm', 'sales_b2c'] }), empty({ modules: ['dialer', 'call_center'] }), trial).blocking).toBe(0);
  });

  it('does not let a module that cannot be enabled satisfy another one', () => {
    const plan = planBundle(empty(), empty({ modules: ['call_qa', 'call_center'] }), trial);
    // call_center needs crm, which is neither enabled nor in the bundle; call_qa needs call_center.
    expect(plan.operations.filter((o) => o.reason === 'module_dependency').map((o) => o.key).sort()).toEqual(['call_center', 'call_qa']);
  });

  it('blocks an SLA policy whose calendar is neither in the bundle nor in the workspace', () => {
    const policy = { name: 'P', resourceType: 'case' as const, criteria: '', position: 0, calendar: 'Nope', firstResponseMinutes: 60, resolutionMinutes: null, warnPercent: 80, pauseStatuses: [], enabled: true };
    expect(planBundle(empty(), empty({ slaPolicies: [policy] }), trial).operations[1]).toMatchObject({ action: 'conflict', reason: 'calendar_missing', detail: 'Nope' });
  });

  it('treats settings as versioned updates, refuses local and invalid values, keeps the logo', () => {
    const current = empty({ settings: { ui: { theme: 'dark' } } });
    const plan = planBundle(current, empty({ settings: { ui: { theme: 'light' }, brand: { logoAssetId: null }, locale: { timezone: 'Mars/Base' }, onboarding: { status: 'completed' } } }), trial);
    const by = (k: string) => plan.operations.find((o) => o.key === k);
    expect(by('ui')).toMatchObject({ action: 'update', patch: [{ op: 'replace', path: '/theme', value: 'light' }] });
    expect(by('brand')).toMatchObject({ action: 'conflict', reason: 'invalid' });
    expect(by('locale')).toMatchObject({ action: 'conflict', reason: 'invalid', detail: '/timezone: unknown IANA time zone' });
    expect(by('onboarding')).toMatchObject({ action: 'conflict', reason: 'invalid' });
    expect(importedSettingValue('brand', { accent: '#1D4ED8' }, { accent: '#7B3CFF', logoAssetId: 'x' })).toEqual({ accent: '#1D4ED8', logoAssetId: 'x' });
  });

  it('matches tags case-insensitively and ignores transition order', () => {
    const wf = BLUEPRINT_LIST[0]?.bundle.taskWorkflows[0];
    if (!wf) throw new Error('blueprint has no workflow');
    const plan = planBundle(empty({ tags: [{ name: 'vip', colorToken: 'accent' }], taskWorkflows: [{ ...wf, transitions: [...wf.transitions].reverse() }] }), empty({ tags: [{ name: 'VIP', colorToken: 'accent' }], taskWorkflows: [wf] }), trial);
    expect(plan.operations.slice(1).map((o) => o.action)).toEqual(['unchanged', 'unchanged']);
  });
});

describe('enableOrder', () => {
  it('enables dependencies first', () => {
    expect(enableOrder([], ['dialer', 'sales_b2c', 'call_center', 'crm'])).toEqual(['crm', 'sales_b2c', 'call_center', 'dialer']);
  });
});

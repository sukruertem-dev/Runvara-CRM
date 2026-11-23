'use client';

import { Alert, Badge, Checkbox, SegmentedControl } from '@flexa/ui';
import { useState } from 'react';
import { moduleLabel, t, tOptional, type MessageKey } from '../../../../lib/i18n';
import type { ConflictPolicy, Plan, PlanOperation } from '../../../../lib/platform';
import { keyLabel } from './config-parts';

// Dry run of a configuration import, blueprint or onboarding choice (docs/p7-plan.md §7): what will be
// added, updated or left alone, and every conflict with its reason.

const TONE = { create: 'success', update: 'info', unchanged: 'neutral', conflict: 'danger' } as const;

function itemLabel(op: PlanOperation): string {
  if (op.section === 'modules') return moduleLabel(op.key);
  if (op.section === 'settings') return keyLabel(op.key);
  if (op.section === 'salesMode') return t('modules.salesMode.title');
  return op.key;
}

function result(op: PlanOperation): string {
  if (op.action !== 'conflict' || !op.reason) return t(`plan.action.${op.action}`);
  return t(`plan.reason.${op.reason}` as MessageKey, { detail: op.detail ?? '' });
}

/** Summary line, the table (unchanged rows hidden unless asked for) and the blocking notice. */
export function PlanView({ plan, testId = 'plan-view' }: { plan: Plan; testId?: string }) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const rows = plan.operations.filter((o) => showUnchanged || o.action !== 'unchanged');
  const s = plan.summary;
  return (
    <section aria-label={t('plan.dryRun')} className="flex flex-col gap-3" data-testid={testId}>
      <p className="m-0 text-sm font-medium" data-testid="plan-summary">
        {t('plan.summary', { create: String(s.create), update: String(s.update), unchanged: String(s.unchanged), conflict: String(s.conflict) })}
      </p>
      {plan.blocking > 0 ? <Alert kind="error">{t('plan.blocking', { count: String(plan.blocking) })}</Alert> : null}
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('plan.nothing')}</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-subtle text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">{t('plan.col.section')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('plan.col.item')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('plan.col.result')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((op) => (
                <tr key={`${op.section}:${op.key}`} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{tOptional(`plan.section.${op.section}`) ?? op.section}</td>
                  <td className="px-3 py-2 font-medium">{itemLabel(op)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={TONE[op.action]}>{t(`plan.action.${op.action}`)}</Badge>
                    {op.action === 'conflict' ? <p className="m-0 mt-1 text-xs text-fg-muted">{result(op)}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.unchanged > 0 ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={showUnchanged} onCheckedChange={(v) => { setShowUnchanged(v === true); }} />
          {t('plan.showUnchanged')}
        </label>
      ) : null}
    </section>
  );
}

/** Choice between keeping the tenant's definitions and refusing on conflicts (only when there are any). */
export function ConflictPolicyControl({ plan, value, onChange }: { plan: Plan; value: ConflictPolicy; onChange: (v: ConflictPolicy) => void }) {
  if (plan.summary.conflict === 0 || plan.blocking > 0) return null;
  return (
    <SegmentedControl
      label={t('plan.policy.title')}
      value={value}
      onValueChange={onChange}
      options={[{ value: 'keep', label: t('plan.policy.keep') }, { value: 'fail', label: t('plan.policy.fail') }]}
    />
  );
}

/** Whether applying would change anything under the policy. */
export function hasWork(plan: Plan, policy: ConflictPolicy): boolean {
  if (plan.blocking > 0) return false;
  if (policy === 'fail' && plan.summary.conflict > 0) return false;
  return plan.summary.create + plan.summary.update > 0;
}

'use client';

import { Alert, Button, ErrorState, Field, Input, Skeleton, useToast } from '@flexa/ui';
import { useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { useApprovalLimits, useSetLimit } from '../../../../lib/approvals';
import { errorText } from '../../../../lib/catalog';
import { useConfigKeys, useConfigLayer, type ConfigLayer } from '../../../../lib/config';
import { t } from '../../../../lib/i18n';
import { PageContainer } from '../../../_components/app-shell';
import { overridesOf, sameJson, SaveConfigDialog, type PendingChange } from '../_parts/config-parts';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Approval rules (ADR-0021, docs/p8-plan.md §8): the versioned `approvals` key and personal limits.

interface Rules { freePercent: number; managerPercent: number; timeoutHours: number }

export default function ApprovalRulesPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']} module="sales_b2b">
        <RulesPage />
      </SettingsGate>
    </PageContainer>
  );
}

function RulesPage() {
  const layer = useConfigLayer('approvals', 'tenant');
  const keys = useConfigKeys();
  const header = <SettingsHeader title={t('apol.title')} lead={t('apol.lead')} />;
  if (layer.isError || keys.isError) return <>{header}<ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void layer.refetch(); void keys.refetch(); }} /></>;
  if (!layer.data || !keys.data) return <>{header}<Skeleton className="h-48 w-full" /></>;
  const defaults = (keys.data.data.find((k) => k.key === 'approvals')?.default ?? {});
  return (
    <>
      {header}
      <RulesForm key={layer.data.version} layer={layer.data} defaults={defaults} />
      <Limits />
    </>
  );
}

function RulesForm({ layer, defaults }: { layer: ConfigLayer; defaults: Record<string, unknown> }) {
  const { can } = useApp();
  const { toast } = useToast();
  const readOnly = !can('tenant.config.manage');
  const [draft, setDraft] = useState<Rules>(() => (layer.effective as unknown as { discount: Rules }).discount);
  const [review, setReview] = useState<PendingChange[] | null>(null);
  const value = overridesOf({ discount: draft }, defaults);
  const invalid = Object.values(draft).some((v: number) => Number.isNaN(v));
  const order = draft.managerPercent < draft.freePercent;
  const field = (k: keyof Rules, label: string, max: number, min: number) => (
    <Field label={label}>
      <Input type="number" inputMode="decimal" min={min} max={max} step={k === 'timeoutHours' ? 1 : 0.01} value={Number.isNaN(draft[k]) ? '' : String(draft[k])} data-testid={`apol-${k}`}
        onChange={(e) => { setDraft((d) => ({ ...d, [k]: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })); }} />
    </Field>
  );
  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); setReview([{ key: 'approvals', scope: 'tenant', value, version: layer.version }]); }} className="rounded-card border border-line bg-surface p-4" data-testid="apol-form">
      {readOnly ? <ReadOnlyNotice /> : null}
      <fieldset disabled={readOnly} className="m-0 grid items-end gap-3 border-0 p-0 sm:grid-cols-3">
        {field('freePercent', t('apol.free'), 100, 0)}
        {field('managerPercent', t('apol.manager'), 100, 0)}
        {field('timeoutHours', t('apol.timeout'), 720, 1)}
      </fieldset>
      {order ? <div className="mt-3"><Alert kind="warning">{t('apol.order')}</Alert></div> : null}
      {readOnly ? null : <div className="mt-4 flex justify-end"><Button type="submit" disabled={invalid || order || sameJson(value, layer.value)} data-testid="apol-save">{t('policy.review')}</Button></div>}
      {review ? <SaveConfigDialog changes={review} onClose={() => { setReview(null); }} onSaved={() => { setReview(null); toast({ kind: 'success', title: t('apol.saved') }); }} /> : null}
    </form>
  );
}

function Limits() {
  const { can } = useApp();
  const list = useApprovalLimits();
  const readOnly = !can('tenant.config.manage');
  return (
    <section className="mt-6 flex flex-col gap-3 rounded-card border border-line bg-surface p-4" aria-labelledby="limits-h">
      <h2 id="limits-h" className="m-0 text-base font-semibold">{t('apol.limits')}</h2>
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-16 w-full" />
      ) : list.data.data.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">{t('apol.limitsEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="limit-list">
          {list.data.data.map((l) => <LimitRow key={`${l.user.id}${l.maxPercent ?? ''}`} user={l.user} max={l.maxPercent} effective={l.effectivePercent} readOnly={readOnly} />)}
        </ul>
      )}
    </section>
  );
}

function LimitRow({ user, max, effective, readOnly }: { user: { id: string; displayName: string }; max: string | null; effective: string; readOnly: boolean }) {
  const set = useSetLimit();
  const { toast } = useToast();
  const shown = max === null ? '' : String(Number(max));
  const [value, setValue] = useState(shown);
  return (
    <li>
      <form method="post" className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => {
        e.preventDefault();
        set.mutateAsync({ userId: user.id, maxPercent: value.trim() === '' ? null : value.trim().replace(',', '.') }).then(
          () => { toast({ kind: 'success', title: t('cat.saved') }); },
          (err: unknown) => { toast({ kind: 'error', title: errorText(err) }); },
        );
      }}>
        <span className="min-w-40 flex-1">{user.displayName}</span>
        <Input className="w-40" inputMode="decimal" aria-label={t('apol.limitOf', { name: user.displayName })} placeholder={t('apol.default', { percent: String(Number(effective)) })} value={value} disabled={readOnly} onChange={(e) => { setValue(e.target.value); }} />
        {readOnly ? null : <Button type="submit" size="sm" variant="secondary" aria-label={t('apol.save', { name: user.displayName })} loading={set.isPending} disabled={value.trim() === shown}>{t('common.save')}</Button>}
      </form>
    </li>
  );
}

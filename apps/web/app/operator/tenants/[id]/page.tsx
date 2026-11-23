'use client';

import { Badge, Button, Checkbox, Field, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../../../lib/api';
import { messageForCode } from '../../../../lib/errors';
import { dateTime, formatDate, formatNumber } from '../../../../lib/format';
import { moduleLabel, t, tOptional } from '../../../../lib/i18n';
import {
  GRANT_TONE, useOperatorExport, useOperatorTenant, useRequestSupport, useSetPlan, useTransition, type OpTenantDetail, type PlanId,
} from '../../../../lib/operator';
import { formatBytes } from '../../../../lib/platform';
import { OperatorError, PLAN_IDS, StatusBadge } from '../../_parts';

// One workspace in the operator console: metadata, plan, status, support access, export, operator log.

const ADD_ONS = ['call_center', 'dialer', 'call_qa', 'data_service', 'ai_assistant'] as const;
const LIMITS = ['users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens', 'api_rpm', 'api_rpm_per_user'] as const;
const NEXT: Record<string, readonly ('active' | 'suspended' | 'pending_deletion')[]> = {
  trial: ['active', 'suspended', 'pending_deletion'], active: ['suspended', 'pending_deletion'], suspended: ['active', 'pending_deletion'], pending_deletion: ['active'], deleted: [],
};

function Section({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4" aria-label={title} data-testid={testId}>
      <h2 className="m-0 mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const problem = (err: unknown): string => (err instanceof ApiError ? messageForCode(err.code) : t('error.fallback'));

export default function OperatorTenantPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useOperatorTenant(id);
  if (detail.isError) return <OperatorError error={detail.error} onRetry={() => { void detail.refetch(); }} />;
  if (!detail.data) return <Skeleton className="h-96 w-full" />;
  const d = detail.data;
  const live = d.status !== 'deleted';
  return (
    <>
      <Link href="/operator" className="mb-3 inline-flex items-center gap-1 text-sm text-fg-muted"><ArrowLeft aria-hidden size={14} /> {t('op.nav.tenants')}</Link>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="m-0 font-display text-xl font-bold" data-testid="op-tenant-name">{d.name}</h1>
        <StatusBadge status={d.status} />
        <span className="text-sm text-fg-muted">{d.slug}</span>
      </div>
      {d.deletionScheduledAt ? <p className="m-0 mb-4 text-sm text-danger">{t('op.detail.deletion', { date: formatDate(d.deletionScheduledAt) })}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('op.detail.overview')} testId="op-overview">
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-fg-muted">{t('op.col.plan')}</dt><dd className="m-0">{d.plan ? (tOptional(`plan.${d.plan.id}.name`) ?? d.plan.id) : '—'}</dd>
            <dt className="text-fg-muted">{t('op.col.members')}</dt><dd className="m-0 tabular-nums">{formatNumber(d.members)}</dd>
            <dt className="text-fg-muted">{t('op.col.created')}</dt><dd className="m-0">{formatDate(d.createdAt)}</dd>
            <dt className="text-fg-muted">{t('op.detail.modules')}</dt><dd className="m-0">{d.modules.map(moduleLabel).join(', ') || '—'}</dd>
          </dl>
          {d.usage.length > 0 ? (
            <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0 text-sm" aria-label={t('op.detail.usage')}>
              {d.usage.map((u) => (
                <li key={u.dimension} className="flex justify-between gap-2">
                  <span className="text-fg-muted">{t(`usage.dim.${u.dimension}`)}</span>
                  <span className="tabular-nums">{t('usage.of', u.dimension === 'storage_bytes'
                    ? { used: formatBytes(u.used, formatNumber), limit: formatBytes(u.limit, formatNumber) }
                    : { used: formatNumber(u.used), limit: formatNumber(u.limit) })}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
        {live ? <PlanForm d={d} /> : null}
        {live ? <StatusForm d={d} /> : null}
        {live && (d.status === 'trial' || d.status === 'active') ? <SupportForm d={d} /> : null}
        {live ? <ExportCard id={d.id} /> : null}
        <Section title={t('op.actions')} testId="op-actions">
          {d.actions.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('op.actions.empty')}</p> : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {d.actions.map((a) => (
                <li key={`${a.at}:${a.action}`} className="flex flex-wrap justify-between gap-2">
                  <span><code>{a.action}</code>{a.operator ? ` · ${a.operator}` : ''}</span>
                  <span className="text-fg-muted">{dateTime(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}

function PlanForm({ d }: { d: OpTenantDetail }) {
  const setPlan = useSetPlan();
  const toast = useToast();
  const [plan, setPlanId] = useState<PlanId>((d.plan?.id ?? 'trial') as PlanId);
  const [addOns, setAddOns] = useState<string[]>(d.plan?.addOns ?? []);
  const [overrides, setOverrides] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(d.plan?.limitOverrides ?? {}).map(([k, v]) => [k, String(v)])));
  const [reason, setReason] = useState('');
  return (
    <Section title={t('op.plan.title')} testId="op-plan">
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        const limitOverrides = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, Number(v)]));
        setPlan.mutate({ id: d.id, plan, addOns, limitOverrides, reason: reason.trim() }, {
          onSuccess: () => { toast.toast({ kind: 'success', title: t('op.plan.saved') }); setReason(''); },
          onError: (err) => { toast.toast({ kind: 'error', title: problem(err) }); },
        });
      }}>
        <Field label={t('op.col.plan')}>
          <Select value={plan} onValueChange={(v) => { setPlanId(v as PlanId); }} options={PLAN_IDS.map((p) => ({ value: p, label: tOptional(`plan.${p}.name`) ?? p }))} />
        </Field>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t('op.plan.addOns')}</legend>
          <div className="flex flex-wrap gap-3">
            {ADD_ONS.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <Checkbox checked={addOns.includes(m)} onCheckedChange={(v) => { setAddOns((c) => (v === true ? [...c, m] : c.filter((x) => x !== m))); }} />
                {moduleLabel(m)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t('op.plan.overrides')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {LIMITS.map((k) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-fg-muted">
                {k}
                <Input inputMode="numeric" pattern="[0-9]*" value={overrides[k] ?? ''} onChange={(e) => { setOverrides((o) => ({ ...o, [k]: e.target.value })); }} />
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t('op.plan.reason')}><Input value={reason} required minLength={3} maxLength={500} onChange={(e) => { setReason(e.target.value); }} /></Field>
        <div><Button type="submit" loading={setPlan.isPending}>{t('op.plan.save')}</Button></div>
      </form>
    </Section>
  );
}

function StatusForm({ d }: { d: OpTenantDetail }) {
  const transition = useTransition();
  const toast = useToast();
  const options = NEXT[d.status] ?? [];
  const [to, setTo] = useState<string>(options[0] ?? '');
  const [reason, setReason] = useState('');
  return (
    <Section title={t('op.status.title')} testId="op-status">
      {options.length === 0 ? <p className="m-0 text-sm text-fg-muted">{t('op.status.none')}</p> : (
        <form className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          transition.mutate({ id: d.id, to: (to || options[0]) as 'active' | 'suspended' | 'pending_deletion', reason: reason.trim() }, {
            onSuccess: () => { toast.toast({ kind: 'success', title: t('op.status.saved') }); setReason(''); },
            onError: (err) => { toast.toast({ kind: 'error', title: problem(err) }); },
          });
        }}>
          <Field label={t('op.status.to')}>
            <Select value={to || options[0]} onValueChange={setTo} options={options.map((o) => ({ value: o, label: t(`op.status.${o}`) }))} />
          </Field>
          <Field label={t('op.status.reason')}><Input value={reason} required minLength={3} maxLength={500} onChange={(e) => { setReason(e.target.value); }} /></Field>
          <div><Button type="submit" variant="secondary" loading={transition.isPending}>{t('op.status.apply')}</Button></div>
        </form>
      )}
    </Section>
  );
}

function SupportForm({ d }: { d: OpTenantDetail }) {
  const request = useRequestSupport();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('240');
  const [modules, setModules] = useState<string[]>([]);
  return (
    <Section title={t('op.support.title')} testId="op-support">
      <form className="flex flex-col gap-3" onSubmit={(e) => {
        e.preventDefault();
        request.mutate({ id: d.id, reason: reason.trim(), modules, durationMinutes: Number(minutes) }, {
          onSuccess: () => { toast.toast({ kind: 'success', title: t('op.support.requested') }); setReason(''); },
          onError: (err) => { toast.toast({ kind: 'error', title: problem(err) }); },
        });
      }}>
        <Field label={t('op.support.reason')}><Input value={reason} required minLength={10} maxLength={500} onChange={(e) => { setReason(e.target.value); }} /></Field>
        <Field label={t('op.support.minutes')}><Input type="number" min={15} max={480} value={minutes} required onChange={(e) => { setMinutes(e.target.value); }} /></Field>
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t('op.support.modules')}</legend>
          <div className="flex flex-wrap gap-3">
            {d.modules.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <Checkbox checked={modules.includes(m)} onCheckedChange={(v) => { setModules((c) => (v === true ? [...c, m] : c.filter((x) => x !== m))); }} />
                {moduleLabel(m)}
              </label>
            ))}
          </div>
        </fieldset>
        <div><Button type="submit" loading={request.isPending}>{t('op.support.request')}</Button></div>
      </form>
      {d.support.length > 0 ? (
        <>
          <h3 className="m-0 mb-2 mt-4 text-sm font-semibold">{t('op.support.history')}</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {d.support.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate">{g.operator.name} · {g.reason}</span>
                <Badge tone={GRANT_TONE[g.status]}>{t(`grant.status.${g.status}`)}</Badge>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

function ExportCard({ id }: { id: string }) {
  const start = useOperatorExport();
  const toast = useToast();
  return (
    <Section title={t('op.export.title')} testId="op-export">
      <p className="m-0 mb-3 text-sm text-fg-muted">{t('op.export.body')}</p>
      <Button variant="secondary" loading={start.isPending} onClick={() => {
        start.mutate(id, { onSuccess: () => { toast.toast({ kind: 'info', title: t('op.export.started') }); }, onError: (err) => { toast.toast({ kind: 'error', title: problem(err) }); } });
      }}>
        {t('op.export.start')}
      </Button>
    </Section>
  );
}

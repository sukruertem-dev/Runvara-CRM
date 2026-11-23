'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, ErrorState, Field, Input, Skeleton, StatusBadge } from '@flexa/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { t } from '../../../../lib/i18n';
import { labelOf, toKey, useCreateWorkflow, useWorkflows, type Workflow } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

const ORDER = ['task', 'lead', 'opportunity', 'case'];

/** A new task workflow starts as a copy of the default one (the engine needs a valid machine from the start). */
function copyOf(base: Workflow, name: string) {
  const keyOf = new Map(base.statuses.map((s) => [s.id, s.key]));
  return {
    key: toKey(name) || 'akis',
    name: name.trim(),
    statuses: base.statuses.map((s) => ({ key: s.key, label: s.label, category: s.category, colorToken: s.colorToken, isInitial: s.isInitial, wipLimit: s.wipLimit })),
    transitions: base.transitions.map((x) => ({
      key: x.key, label: x.label, from: x.fromStatusId ? (keyOf.get(x.fromStatusId) ?? null) : null, to: keyOf.get(x.toStatusId) ?? '',
      conditions: x.conditions as never[], validators: x.validators as never[], postFunctions: x.postFunctions as never[],
    })),
  };
}

function NewWorkflow({ base }: { base: Workflow }) {
  const router = useRouter();
  const create = useCreateWorkflow();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(): Promise<void> {
    setError(null);
    try {
      const wf = await create.mutateAsync(copyOf(base, name));
      setOpen(false);
      router.push(`/settings/workflows/${wf.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? messageForCode(e.code) : t('error.fallback'));
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setOpen(true); setName(''); }}>{t('settings.wf.create')}</Button>
      <DialogContent title={t('settings.wf.create')} description={t('settings.wf.createLead')} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('settings.wf.name')} hint={name ? t('settings.keyPreview', { key: toKey(name) }) : undefined}>
            <Input value={name} onChange={(e) => { setName(e.target.value); }} maxLength={120} required autoFocus />
          </Field>
          <DialogFooter>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>{t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WorkflowsInner() {
  const { can } = useApp();
  const q = useWorkflows();
  const list = [...(q.data?.data ?? [])].sort((a, b) => ORDER.indexOf(a.resourceType) - ORDER.indexOf(b.resourceType));
  const base = list.find((w) => w.resourceType === 'task' && w.isDefault);
  return (
    <PageContainer>
      <SettingsHeader title={t('settings.workflows')} lead={t('settings.wf.lead')} actions={can('tenant.config.manage') && base ? <NewWorkflow base={base} /> : undefined} />
      {can('tenant.config.manage') ? null : <ReadOnlyNotice />}
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map((w) => (
            <li key={w.id} className="rounded-card border border-line bg-surface p-4" data-testid="wf-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/settings/workflows/${w.id}`} className="font-semibold text-fg">{w.name}</Link>
                  <p className="m-0 mt-0.5 text-xs text-fg-muted">
                    {t(`settings.resource.${w.resourceType}` as 'settings.resource.task')} · {t('settings.wf.counts', { statuses: String(w.statuses.length), transitions: String(w.transitions.length) })}
                  </p>
                </div>
                {w.isDefault ? <Badge tone="neutral">{t('settings.wf.default')}</Badge> : null}
              </div>
              <ul className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0" aria-label={t('settings.wf.statuses')}>
                {w.statuses.map((s) => (
                  <li key={s.id}><StatusBadge category={s.category} colorToken={s.colorToken} label={labelOf(s.label, s.key)} /></li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

export default function WorkflowsPage() {
  return (
    <SettingsGate anyOf={['tenant.config.read']}>
      <WorkflowsInner />
    </SettingsGate>
  );
}

'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, ErrorState, Field, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../../../lib/app-context';
import { useCreatePipeline, usePatchPipeline } from '../../../../lib/b2b';
import { errorText } from '../../../../lib/catalog';
import { t } from '../../../../lib/i18n';
import { usePipelines } from '../../../../lib/records';
import { labelOf, toKey, useWorkflows } from '../../../../lib/settings';
import { PageContainer } from '../../../_components/app-shell';
import { ReadOnlyNotice, SettingsGate, SettingsHeader } from '../_parts/settings-nav';

// Settings → Sales pipelines (B2B-02, docs/p9-plan.md §8).

type Pipeline = NonNullable<ReturnType<typeof usePipelines>['data']>['data'][number];
const ANY = 'any';

export default function PipelinesPage() {
  return (
    <PageContainer>
      <SettingsGate anyOf={['tenant.config.read']}><Inner /></SettingsGate>
    </PageContainer>
  );
}

function Inner() {
  const { can } = useApp();
  const list = usePipelines();
  const write = can('tenant.config.manage');
  return (
    <>
      <SettingsHeader title={t('settings.pipelines')} lead={t('pipe.lead')} actions={write ? <NewPipeline /> : undefined} />
      {write ? null : <ReadOnlyNotice />}
      {list.isError ? <ErrorState title={t('error.fallback')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-40 w-full" /> : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {list.data.data.map((p) => <PipelineCard key={`${p.id}${p.stages.map((s) => s.probability).join()}`} p={p} write={write} />)}
          </ul>
        )}
    </>
  );
}

function PipelineCard({ p, write }: { p: Pipeline; write: boolean }) {
  const patch = usePatchPipeline();
  const { toast } = useToast();
  const [prob, setProb] = useState<Record<string, string>>(() => Object.fromEntries(p.stages.map((s) => [s.id, String(s.probability)])));
  const changed = p.stages.filter((s) => prob[s.id] !== String(s.probability));
  const valid = Object.values(prob).every((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100);
  const done = (): void => { toast({ kind: 'success', title: t('pipe.saved') }); };
  const fail = (e: unknown): void => { toast({ kind: 'error', title: errorText(e) }); };
  return (
    <li className="rounded-card border border-line bg-surface p-4" data-testid="pipe-item">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex-1 font-semibold">{p.name}</span>
        <Badge tone="neutral">{p.segment ? t(`shell.segment.${p.segment}`) : t('pipe.anySegment')}</Badge>
        {p.isDefault ? <Badge tone="info">{t('pipe.default')}</Badge> : write ? (
          <Button size="sm" variant="ghost" onClick={() => { patch.mutateAsync({ id: p.id, patch: { isDefault: true } }).then(done, fail); }}>{t('pipe.makeDefault')}</Button>
        ) : null}
      </div>
      <form method="post" onSubmit={(e) => { e.preventDefault(); patch.mutateAsync({ id: p.id, patch: { stages: changed.map((s) => ({ statusId: s.id, probability: Number(prob[s.id]) })) } }).then(done, fail); }}>
        <fieldset disabled={!write} className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-3">
          {p.stages.map((s) => {
            const label = t('pipe.probability', { stage: labelOf(s.label, s.key) });
            return (
              <Field key={s.id} label={label}>
                <Input type="number" min={0} max={100} value={prob[s.id] ?? ''} aria-label={`${p.name}: ${label}`} onChange={(e) => { setProb((x) => ({ ...x, [s.id]: e.target.value })); }} />
              </Field>
            );
          })}
        </fieldset>
        {write ? <div className="mt-3 flex justify-end"><Button type="submit" size="sm" disabled={changed.length === 0 || !valid} loading={patch.isPending} aria-label={`${t('pipe.save')}: ${p.name}`}>{t('pipe.save')}</Button></div> : null}
      </form>
    </li>
  );
}

function NewPipeline() {
  const create = useCreatePipeline();
  const workflows = useWorkflows();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [segment, setSegment] = useState<string>(ANY);
  const [workflowId, setWorkflowId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const flows = (workflows.data?.data ?? []).filter((w) => w.resourceType === 'opportunity');
  const chosen = workflowId || flows[0]?.id || '';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setOpen(true); setName(''); setError(null); }} data-testid="pipe-new">{t('pipe.new')}</Button>
      <DialogContent title={t('pipe.new')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutateAsync({ key: toKey(name).replace(/-/g, '_').slice(0, 48) || 'hat', name: name.trim(), segment: segment === ANY ? null : (segment as 'b2b' | 'b2c'), workflowId: chosen }).then(
            () => { toast({ kind: 'success', title: t('pipe.created') }); setOpen(false); },
            (x: unknown) => { setError(errorText(x)); },
          );
        }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('pipe.name')}><Input value={name} maxLength={120} onChange={(e) => { setName(e.target.value); }} required autoFocus /></Field>
          <Field label={t('pipe.segment')}>
            <Select aria-label={t('pipe.segment')} value={segment} onValueChange={setSegment} options={[{ value: ANY, label: t('pipe.anySegment') }, { value: 'b2b', label: t('shell.segment.b2b') }, { value: 'b2c', label: t('shell.segment.b2c') }]} />
          </Field>
          <Field label={t('pipe.workflow')}><Select aria-label={t('pipe.workflow')} value={chosen} onValueChange={setWorkflowId} options={flows.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <DialogFooter>
            <Button type="submit" loading={create.isPending} disabled={!name.trim() || !chosen}>{t('settings.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

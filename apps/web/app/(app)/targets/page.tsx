'use client';

import { Alert, Badge, Button, cn, Combobox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, IconButton, Input, SegmentBadge, Select, Skeleton, useToast } from '@flexa/ui';
import { Pencil, PlugZap, Target as TargetIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../../../lib/app-context';
import { useCreateTarget, useDeleteTarget, useTargets, useUpdateTarget, type Target, type TargetInput } from '../../../lib/approvals';
import { errorText, useTeams } from '../../../lib/catalog';
import { formatDate, formatNumber } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { useDirectorySearch } from '../../../lib/tasks';
import { PageContainer } from '../../_components/app-shell';

// Sales targets and attainment (TRK-02, docs/p8-plan.md §10–11).

const ALL = 'all';
type Metric = Target['metric'];
type SubjectType = Target['subject']['type'];

const amount = (x: Target, v: string): string => `${formatNumber(Number(v), { maximumFractionDigits: 2 })}${x.currency ? ` ${x.currency}` : ''}`;

export default function TargetsPage() {
  const { nav, can } = useApp();
  const on = nav?.menu.some((m) => m.id === 'targets') ?? false;
  const list = useTargets();
  const [editing, setEditing] = useState<Target | 'new' | null>(null);
  const [removing, setRemoving] = useState<Target | null>(null);
  if (!nav) return null;
  if (!on) {
    return <PageContainer><h1 className="sr-only">{t('tgt.title')}</h1><EmptyState icon={PlugZap} title={t('settings.moduleOff')} description={t('settings.moduleOffBody')} /></PageContainer>;
  }
  return (
    <PageContainer wide>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-xl font-bold">{t('tgt.title')}</h1>
          <p className="m-0 mt-1 text-sm text-fg-muted">{t('tgt.lead')}</p>
        </div>
        {can('sales_tracking.target.manage') ? <Button onClick={() => { setEditing('new'); }} data-testid="target-add">{t('tgt.add')}</Button> : null}
      </div>
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : list.data.data.length === 0 ? (
        <EmptyState icon={TargetIcon} title={t('tgt.empty')} description={t('tgt.emptyBody')} />
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0 md:grid-cols-2" data-testid="target-list">
          {list.data.data.map((x) => <TargetCard key={x.id} x={x} onEdit={() => { setEditing(x); }} onRemove={() => { setRemoving(x); }} />)}
        </ul>
      )}
      {editing === 'new' ? <CreateDialog onClose={() => { setEditing(null); }} /> : editing ? <EditDialog x={editing} onClose={() => { setEditing(null); }} /> : null}
      {removing ? <RemoveDialog x={removing} onClose={() => { setRemoving(null); }} /> : null}
    </PageContainer>
  );
}

const nameOf = (x: Target): string => (x.subject.type === 'segment' ? t(`shell.segment.${x.segment ?? 'b2b'}`) : x.subject.name);

function TargetCard({ x, onEdit, onRemove }: { x: Target; onEdit: () => void; onRemove: () => void }) {
  const label = `${nameOf(x)}: ${t(`tgt.metric.${x.metric}`)}`;
  const progress = t('tgt.progress', { progress: formatNumber(x.progressPercent), elapsed: formatNumber(x.elapsedPercent) });
  return (
    <li className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4" data-testid="target-card">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-40 flex-1">
          <p className="m-0 font-semibold">{nameOf(x)}</p>
          <p className="m-0 text-xs text-fg-muted">{t(`tgt.metric.${x.metric}`)} · {t(`tgt.period.${x.period}`)} · {formatDate(x.periodStart)} – {formatDate(x.periodEnd)}</p>
        </div>
        {x.segment && x.subject.type !== 'segment' ? <SegmentBadge segment={x.segment} label={t(`shell.segment.${x.segment}`)} /> : null}
        {x.atRisk ? <Badge tone="danger">{t('tgt.risk')}</Badge> : null}
        {x.canEdit ? (
          <>
            <IconButton size="sm" label={`${t('tgt.edit')}: ${label}`} onClick={onEdit}><Pencil aria-hidden size={14} /></IconButton>
            <IconButton size="sm" label={`${t('tgt.delete')}: ${label}`} onClick={onRemove}><Trash2 aria-hidden size={14} /></IconButton>
          </>
        ) : null}
      </div>
      <p className="m-0 text-lg font-semibold tabular-nums">{t('tgt.of', { actual: amount(x, x.actual), target: amount(x, x.targetValue) })}</p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, x.progressPercent)} aria-valuetext={progress} className="h-2 overflow-hidden rounded-full bg-subtle">
        <div className={cn('h-full rounded-full', x.atRisk ? 'bg-danger' : 'bg-info')} style={{ width: `${String(Math.min(100, x.progressPercent))}%` }} />
      </div>
      <p className="m-0 text-xs text-fg-muted">{progress}</p>
      {x.otherCurrencyCount > 0 ? <p className="m-0 text-xs text-fg-muted">{t('tgt.other', { count: String(x.otherCurrencyCount) })}</p> : null}
    </li>
  );
}

/** First days of the current and next months or quarters. */
function periodStarts(period: 'month' | 'quarter'): string[] {
  const now = new Date();
  const step = period === 'month' ? 1 : 3;
  const first = period === 'month' ? now.getMonth() : Math.floor(now.getMonth() / 3) * 3;
  return [0, 1, 2, 3].map((i) => {
    const d = new Date(now.getFullYear(), first + i * step, 1);
    return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  });
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { nav, tenant, me } = useApp();
  const create = useCreateTarget();
  const { toast } = useToast();
  const teams = useTeams();
  const [term, setTerm] = useState('');
  const people = useDirectorySearch(term);
  const admin = nav?.roles.includes('admin') ?? false;
  const [type, setType] = useState<SubjectType>('user');
  const [userId, setUserId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const [segment, setSegment] = useState<string>(ALL);
  const [period, setPeriod] = useState<'month' | 'quarter'>('month');
  const [start, setStart] = useState(periodStarts('month')[0] ?? '');
  const [metric, setMetric] = useState<Metric>('won_amount');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const types: SubjectType[] = admin ? ['user', 'team', 'segment'] : ['user', 'team'];
  const metrics: Metric[] = type === 'segment' ? ['won_amount', 'won_count'] : ['won_amount', 'won_count', 'tasks_closed'];
  const seg = segment === 'b2b' || segment === 'b2c' ? segment : null;
  const subject: TargetInput['subject'] | null = type === 'segment' ? (seg ? { type } : null) : type === 'team' ? (teamId ? { type, id: teamId } : null) : userId ? { type, id: userId } : null;

  function submit(): void {
    if (!subject) return;
    setError(null);
    create.mutateAsync({ subject, segment: seg, period, periodStart: start, metric, targetValue: value.trim().replace(',', '.') }).then(
      () => { toast({ kind: 'success', title: t('cat.saved') }); onClose(); },
      (e: unknown) => { setError(errorText(e)); },
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('tgt.add')} closeLabel={t('common.close')} wide>
        <form method="post" onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3" data-testid="target-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('tgt.subjectType')}>
              <Select value={type} onValueChange={(v) => { setType(v as SubjectType); if (v === 'segment' && metric === 'tasks_closed') setMetric('won_amount'); }} options={types.map((x) => ({ value: x, label: t(`tgt.type.${x}`) }))} />
            </Field>
            {type === 'user' ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{t('tgt.person')}</span>
                <Combobox aria-label={t('tgt.person')} value={userId} onValueChange={setUserId} options={(people.data?.data ?? []).filter((u) => admin || u.id !== me.user.id).map((u) => ({ value: u.id, label: u.displayName }))} placeholder={t('tgt.pick')} searchPlaceholder={t('common.searchPlaceholder')} emptyText={t('common.noResults')} onSearch={setTerm} />
              </div>
            ) : null}
            {type === 'team' ? <Field label={t('tgt.team')}><Select value={teamId} placeholder={t('tgt.pick')} onValueChange={setTeamId} options={(teams.data?.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field> : null}
            <Field label={t('tgt.segment')}>
              <Select value={segment} onValueChange={setSegment} options={[...(type === 'segment' ? [] : [{ value: ALL, label: t('plist.allSegments') }]), ...(nav?.segments ?? []).map((s) => ({ value: s, label: t(`shell.segment.${s}`) }))]} />
            </Field>
            <Field label={t('tgt.period')}>
              <Select value={period} onValueChange={(v) => { const p = v as 'month' | 'quarter'; setPeriod(p); setStart(periodStarts(p)[0] ?? ''); }} options={(['month', 'quarter'] as const).map((x) => ({ value: x, label: t(`tgt.period.${x}`) }))} />
            </Field>
            <Field label={t('plist.validFrom')}><Select value={start} onValueChange={setStart} options={periodStarts(period).map((d) => ({ value: d, label: formatDate(d) }))} /></Field>
            <Field label={t('tgt.metric')}><Select value={metric} onValueChange={(v) => { setMetric(v as Metric); }} options={metrics.map((m) => ({ value: m, label: t(`tgt.metric.${m}`) }))} /></Field>
            <Field label={metric === 'won_amount' ? `${t('tgt.value')} (${tenant?.currency ?? 'TRY'})` : t('tgt.value')}><Input inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); }} required /></Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending} disabled={!subject || !value.trim()} data-testid="target-save">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ x, onClose }: { x: Target; onClose: () => void }) {
  const update = useUpdateTarget();
  const { toast } = useToast();
  const [value, setValue] = useState(x.targetValue);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('tgt.edit')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          update.mutateAsync({ target: x, targetValue: value.trim().replace(',', '.') }).then(() => { toast({ kind: 'success', title: t('cat.saved') }); onClose(); }, (err: unknown) => { setError(errorText(err)); });
        }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('tgt.value')}><Input inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); }} required autoFocus /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={update.isPending} disabled={!value.trim()}>{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({ x, onClose }: { x: Target; onClose: () => void }) {
  const remove = useDeleteTarget();
  const { toast } = useToast();
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('tgt.delete')} description={`${nameOf(x)}: ${t(`tgt.metric.${x.metric}`)}. ${t('tgt.deleteBody')}`} closeLabel={t('common.close')}>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => { remove.mutateAsync(x.id).then(onClose, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }}>{t('common.delete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { Alert, Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Skeleton, Tabs, TabsList, TabsTrigger, Textarea, useToast } from '@flexa/ui';
import { Stamp } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '../../../lib/app-context';
import { useApprovals, useApprovalUpdates, useDecide, useWithdraw, type Approval, type ApprovalBox } from '../../../lib/approvals';
import { errorText } from '../../../lib/catalog';
import { dateTime } from '../../../lib/format';
import { t, type MessageKey } from '../../../lib/i18n';
import { PageContainer } from '../../_components/app-shell';

// Approval inbox (MGR-04, docs/p8-plan.md §11).

const BOXES: readonly ApprovalBox[] = ['inbox', 'mine', 'all'];
const TONE = { pending: 'info', approved: 'success', rejected: 'danger', expired: 'neutral', cancelled: 'neutral' } as const;

export default function ApprovalsPage() {
  const [box, setBox] = useState<ApprovalBox>('inbox');
  useApprovalUpdates();
  return (
    <PageContainer>
      <h1 className="m-0 mb-4 font-display text-xl font-bold">{t('appr.title')}</h1>
      <Tabs value={box} onValueChange={(v) => { setBox(v as ApprovalBox); }}>
        <TabsList label={t('appr.title')} className="mb-4 overflow-x-auto">
          {BOXES.map((b) => <TabsTrigger key={b} value={b} aria-controls="approval-list">{t(`appr.${b}`)}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div id="approval-list" role="tabpanel" aria-label={t(`appr.${box}`)}><Box key={box} box={box} /></div>
    </PageContainer>
  );
}

function Box({ box }: { box: ApprovalBox }) {
  const list = useApprovals(box);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [deciding, setDeciding] = useState<{ ids: string[]; decision: 'approve' | 'reject' } | null>(null);
  if (list.isError) return <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />;
  if (!list.data) return <Skeleton className="h-48 w-full" />;
  const rows = list.data.data;
  if (rows.length === 0) return <EmptyState icon={Stamp} title={t('appr.empty')} description={t('appr.emptyBody')} />;
  // A request decided elsewhere leaves the selection.
  const selected = picked.filter((id) => rows.some((r) => r.id === id && r.canDecide));
  return (
    <div className="flex flex-col gap-3">
      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-subtle px-3 py-2" data-testid="approval-bulk">
          <span className="flex-1 text-sm" role="status">{t('appr.selected', { count: String(selected.length) })}</span>
          <Button size="sm" onClick={() => { setDeciding({ ids: selected, decision: 'approve' }); }}>{t('appr.approve')}</Button>
          <Button size="sm" variant="secondary" onClick={() => { setDeciding({ ids: selected, decision: 'reject' }); }}>{t('appr.reject')}</Button>
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="approval-rows">
        {rows.map((a) => (
          <ApprovalCard
            key={a.id}
            a={a}
            picked={selected.includes(a.id)}
            onPick={(on) => { setPicked(on ? [...selected, a.id] : selected.filter((x) => x !== a.id)); }}
            onDecide={(decision) => { setDeciding({ ids: [a.id], decision }); }}
          />
        ))}
      </ul>
      {deciding ? <DecisionDialog {...deciding} onClose={(done) => { setDeciding(null); if (done) setPicked([]); }} /> : null}
    </div>
  );
}

function ApprovalCard({ a, picked, onPick, onDecide }: { a: Approval; picked: boolean; onPick: (on: boolean) => void; onDecide: (d: 'approve' | 'reject') => void }) {
  const { me } = useApp();
  const withdraw = useWithdraw();
  const { toast } = useToast();
  const title = a.subject.title ?? t('appr.hidden');
  return (
    <li className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4" data-testid="approval-row">
      <div className="flex flex-wrap items-start gap-3">
        {a.canDecide ? <Checkbox className="mt-1" checked={picked} aria-label={t('appr.select', { title })} onCheckedChange={(v) => { onPick(v === true); }} /> : null}
        <div className="min-w-40 flex-1">
          <p className="m-0 font-semibold">{t('appr.kind.discount', { percent: String(Number(a.percent)) })} · {a.subject.title ? <Link href={`/crm/opportunity/${a.subject.id}`}>{title}</Link> : title}</p>
          {a.quote ? <p className="m-0 mt-1 text-sm"><Link href={`/sales/b2b/quotes/${a.quote.id}`}>{t('quote.approvalFor', { number: a.quote.number, version: String(a.quote.version) })}</Link></p> : null}
          <p className="m-0 mt-1 text-sm">{a.reason}</p>
          <p className="m-0 mt-1 text-xs text-fg-muted">
            {t('appr.requestedBy', { name: a.requestedBy.displayName })}
            {a.state === 'pending' ? ` · ${t('appr.assigned', { name: a.assignedTo?.displayName ?? t('appr.anyAdmin') })}` : ''}
            {a.dueAt ? ` · ${t('appr.due', { date: dateTime(a.dueAt) })}` : ''}
            {a.automatic ? ` · ${t('appr.automatic')}` : ''}
          </p>
          {a.decisionNote ? <p className="m-0 mt-1 text-sm text-fg-muted">{a.decidedBy?.displayName}: {a.decisionNote}</p> : null}
        </div>
        <Badge tone={TONE[a.state]}>{t(`appr.state.${a.state}`)}</Badge>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <details className="min-w-24 flex-1 text-sm">
          <summary className="cursor-pointer text-fg-muted">{t('appr.history')}</summary>
          <ol className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-xs">
            {a.steps.map((s) => (
              <li key={`${s.at}${s.action}`}>
                {dateTime(s.at)} · {t(`appr.step.${s.action}` as MessageKey)}
                {s.actor ? ` · ${s.actor.displayName}` : ''}
                {s.action === 'assigned' || s.action === 'escalated' ? ` → ${s.assignedTo?.displayName ?? t('appr.anyAdmin')}` : ''}
              </li>
            ))}
          </ol>
        </details>
        {a.canDecide ? (
          <div className="flex gap-2">
            <Button size="sm" aria-label={`${t('appr.approve')}: ${title}`} onClick={() => { onDecide('approve'); }}>{t('appr.approve')}</Button>
            <Button size="sm" variant="secondary" aria-label={`${t('appr.reject')}: ${title}`} onClick={() => { onDecide('reject'); }}>{t('appr.reject')}</Button>
          </div>
        ) : null}
        {a.state === 'pending' && a.requestedBy.id === me.user.id ? (
          <Button size="sm" variant="ghost" aria-label={`${t('appr.withdraw')}: ${title}`} loading={withdraw.isPending} onClick={() => {
            withdraw.mutateAsync(a.id).then(() => { toast({ kind: 'success', title: t('appr.withdrawn') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
          }}>{t('appr.withdraw')}</Button>
        ) : null}
      </div>
    </li>
  );
}

function DecisionDialog({ ids, decision, onClose }: { ids: string[]; decision: 'approve' | 'reject'; onClose: (done: boolean) => void }) {
  const decide = useDecide();
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  function submit(): void {
    setError(null);
    decide.mutateAsync({ ids, decision, ...(note.trim() ? { note: note.trim() } : {}) }).then(
      (res) => {
        const failed = res.data.filter((r) => !r.ok).length;
        if (failed === 0) toast({ kind: 'success', title: t('appr.decided') });
        else toast({ kind: 'error', title: t('appr.partial', { ok: String(res.data.length - failed), failed: String(failed) }) });
        onClose(true);
      },
      (e: unknown) => { setError(errorText(e)); },
    );
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(false); }}>
      <DialogContent title={ids.length > 1 ? t('appr.decideTitle', { count: String(ids.length) }) : t(`appr.${decision}`)} closeLabel={t('common.close')}>
        <form method="post" onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex flex-col gap-3" data-testid="decision-dialog">
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('appr.note')}><Textarea value={note} onChange={(e) => { setNote(e.target.value); }} maxLength={500} rows={3} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { onClose(false); }}>{t('common.cancel')}</Button>
            <Button type="submit" variant={decision === 'reject' ? 'danger' : 'primary'} loading={decide.isPending} data-testid="decision-save">{t(`appr.${decision}`)}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

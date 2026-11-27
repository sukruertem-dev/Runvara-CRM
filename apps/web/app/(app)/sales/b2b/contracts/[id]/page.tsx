'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Input, Skeleton, Switch, Textarea, useToast } from '@flexa/ui';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '../../../../../../lib/api';
import { CONTRACT_TONE, useB2bUpdates, useContract, usePatchContract, useRenewContract, useTerminateContract, type Contract } from '../../../../../../lib/b2b';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime, formatDate } from '../../../../../../lib/format';
import { t } from '../../../../../../lib/i18n';
import { quoteMoney } from '../../../../../../lib/quotes';
import { PageContainer } from '../../../../../_components/app-shell';
import { FieldRow, Section } from '../../../../../_components/record-parts';

const day = (d: string): string => formatDate(`${d}T12:00:00`);

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  const q = useContract(id);
  useB2bUpdates();
  if (q.isLoading) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (!q.data) {
    return (
      <PageContainer>
        {q.error instanceof ApiError && q.error.status === 404
          ? <EmptyState icon={FileQuestion} title={t('contract.notFound')} description={t('quote.notFoundBody')} />
          : <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />}
      </PageContainer>
    );
  }
  return <ContractScreen key={q.data.version} c={q.data} />;
}

function ContractScreen({ c }: { c: Contract }) {
  const [open, setOpen] = useState<'renew' | 'terminate' | null>(null);
  return (
    <PageContainer>
      <Button asChild variant="ghost" size="sm" icon={<ArrowLeft aria-hidden size={14} />}><Link href="/sales/b2b/contracts">{t('contract.title')}</Link></Button>
      <div className="mb-4 mt-3 flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <h1 className="m-0 font-display text-2xl font-bold" data-testid="contract-number">{c.number}</h1>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            <Link href={`/crm/opportunity/${c.opportunity.id}`}>{c.opportunity.name}</Link>{c.account ? ` · ${c.account.name}` : ''}
            {c.quote ? <> · <Link href={`/sales/b2b/quotes/${c.quote.id}`}>{t('contract.fromQuote', { number: c.quote.number })}</Link></> : null}
          </p>
        </div>
        <span data-testid="contract-status"><Badge tone={CONTRACT_TONE[c.status]}>{t(`contract.status.${c.status}`)}</Badge></span>
        {c.canEdit ? <Button size="sm" onClick={() => { setOpen('renew'); }} data-testid="contract-renew">{t('contract.renew')}</Button> : null}
        {c.canEdit ? <Button size="sm" variant="secondary" onClick={() => { setOpen('terminate'); }}>{t('contract.terminate')}</Button> : null}
      </div>
      {c.terminationReason ? <div className="mb-4"><Alert kind="info">{c.terminatedOn ? day(c.terminatedOn) : ''} · {c.terminationReason}</Alert></div> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {c.canEdit ? <Terms c={c} /> : (
          <Section title={t('contract.one')}>
            <FieldRow label={t('contract.name')}>{c.title}</FieldRow>
            <FieldRow label={t('contract.start')}>{day(c.startDate)}</FieldRow>
            <FieldRow label={t('contract.end')}>{day(c.endDate)}</FieldRow>
            <FieldRow label={t('contract.value')}><span className="tabular-nums">{c.value ? quoteMoney(c.value, c.currency) : '—'}</span></FieldRow>
            {c.note ? <p className="m-0 mt-2 whitespace-pre-wrap text-sm">{c.note}</p> : null}
          </Section>
        )}
        <Section title={t('contract.renew')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
            <li>{t('contract.renewalDue', { date: day(c.renewalDueOn) })}</li>
            {c.remindedAt ? <li>{t('contract.reminded', { date: dateTime(c.remindedAt) })}</li> : null}
            <li>{t('contract.autoRenew')}: {c.autoRenew ? '✓' : '—'}</li>
            {c.renewedFrom ? <li><Link href={`/sales/b2b/contracts/${c.renewedFrom.id}`}>{t('contract.renewedFrom', { number: c.renewedFrom.number })}</Link></li> : null}
            {c.renewedBy ? <li><Link href={`/sales/b2b/contracts/${c.renewedBy.id}`} data-testid="contract-next">{t('contract.renewedBy', { number: c.renewedBy.number })}</Link></li> : null}
          </ul>
        </Section>
      </div>
      {open === 'renew' ? <RenewDialog c={c} onClose={() => { setOpen(null); }} /> : null}
      {open === 'terminate' ? <TerminateDialog c={c} onClose={() => { setOpen(null); }} /> : null}
    </PageContainer>
  );
}

function Terms({ c }: { c: Contract }) {
  const save = usePatchContract();
  const { toast } = useToast();
  const [d, setD] = useState({ title: c.title, startDate: c.startDate, endDate: c.endDate, value: c.value ?? '', autoRenew: c.autoRenew, renewalNoticeDays: String(c.renewalNoticeDays), note: c.note });
  const set = (p: Partial<typeof d>): void => { setD((x) => ({ ...x, ...p })); };
  const value = d.value.trim().replace(',', '.');
  const valid = d.title.trim() !== '' && d.endDate >= d.startDate && (value === '' || /^\d{1,14}(\.\d{1,4})?$/.test(value)) && /^\d{1,3}$/.test(d.renewalNoticeDays) && Number(d.renewalNoticeDays) <= 365;
  function run(): void {
    save.mutateAsync({ contract: c, patch: { title: d.title.trim(), startDate: d.startDate, endDate: d.endDate, value: value === '' ? null : value, autoRenew: d.autoRenew, renewalNoticeDays: Number(d.renewalNoticeDays), note: d.note } }).then(
      () => { toast({ kind: 'success', title: t('contract.saved') }); },
      (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); },
    );
  }
  return (
    <form method="post" onSubmit={(e) => { e.preventDefault(); if (valid) run(); }} data-testid="contract-terms">
      <Section title={t('contract.one')}>
        <div className="flex flex-col gap-3">
          <Field label={t('contract.name')}><Input value={d.title} maxLength={300} onChange={(e) => { set({ title: e.target.value }); }} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('contract.start')}><Input type="date" value={d.startDate} onChange={(e) => { set({ startDate: e.target.value }); }} /></Field>
            <Field label={t('contract.end')}><Input type="date" value={d.endDate} onChange={(e) => { set({ endDate: e.target.value }); }} /></Field>
            <Field label={`${t('contract.value')} (${c.currency})`}><Input inputMode="decimal" value={d.value} onChange={(e) => { set({ value: e.target.value }); }} /></Field>
            <Field label={t('contract.notice')}><Input type="number" min={0} max={365} value={d.renewalNoticeDays} onChange={(e) => { set({ renewalNoticeDays: e.target.value }); }} /></Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm"><Switch checked={d.autoRenew} onCheckedChange={(v) => { set({ autoRenew: v }); }} aria-label={t('contract.autoRenew')} />{t('contract.autoRenew')}</label>
          <Field label={t('contract.note')}><Textarea value={d.note} maxLength={4000} rows={3} onChange={(e) => { set({ note: e.target.value }); }} /></Field>
          <div className="flex justify-end"><Button type="submit" disabled={!valid} loading={save.isPending} data-testid="contract-terms-save">{t('common.save')}</Button></div>
        </div>
      </Section>
    </form>
  );
}

function RenewDialog({ c, onClose }: { c: Contract; onClose: () => void }) {
  const renew = useRenewContract();
  const { toast } = useToast();
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('contract.renewTitle')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" data-testid="renew-dialog" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          renew.mutateAsync({ id: c.id, ...(end ? { endDate: end } : {}) }).then(() => { toast({ kind: 'success', title: t('contract.renewed') }); onClose(); }, (x: unknown) => { setError(errorText(x)); });
        }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <p className="m-0 text-sm">{t('contract.renewBody')}</p>
          <Field label={t('contract.end')}><Input type="date" value={end} min={c.endDate} onChange={(e) => { setEnd(e.target.value); }} /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" loading={renew.isPending} data-testid="renew-save">{t('contract.renew')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TerminateDialog({ c, onClose }: { c: Contract; onClose: () => void }) {
  const terminate = useTerminateContract();
  const { toast } = useToast();
  const [on, setOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={t('contract.terminateTitle')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          terminate.mutateAsync({ id: c.id, on, reason: reason.trim() }).then(() => { toast({ kind: 'success', title: t('contract.terminated') }); onClose(); }, (x: unknown) => { setError(errorText(x)); });
        }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('contract.terminateOn')}><Input type="date" value={on} min={c.startDate} max={c.endDate} onChange={(e) => { setOn(e.target.value); }} required /></Field>
          <Field label={t('contract.reason')}><Textarea value={reason} maxLength={500} rows={3} onChange={(e) => { setReason(e.target.value); }} required /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="danger" loading={terminate.isPending} disabled={!on || !reason.trim()}>{t('contract.terminate')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { Alert, Badge, Button, ErrorState, Field, Skeleton, Textarea, useToast } from '@flexa/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime } from '../../../../../../lib/format';
import { t } from '../../../../../../lib/i18n';
import { RETURN_TONE, useCancelReturn, useDecideReturn, useOrderUpdates, useReturn, type Return } from '../../../../../../lib/orders';
import { quoteMoney } from '../../../../../../lib/quotes';
import { PageContainer } from '../../../../../_components/app-shell';

// One return (B2C-05): what comes back, why, and the decision (A16).

export default function ReturnPage() {
  const { id } = useParams<{ id: string }>();
  const q = useReturn(id);
  useOrderUpdates();
  return (
    <PageContainer>
      {q.isError ? <ErrorState title={errorText(q.error)} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
        : !q.data ? <Skeleton className="h-48 w-full" /> : <ReturnBody r={q.data} />}
    </PageContainer>
  );
}

function ReturnBody({ r }: { r: Return }) {
  const decide = useDecideReturn(r.id);
  const cancel = useCancelReturn(r.id);
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const run = (decision: 'approve' | 'reject'): void => {
    setError(null);
    decide.mutateAsync({ decision, note: note.trim() }).then(() => { toast({ kind: 'success', title: t(`return.decided.${decision}`) }); }, (e: unknown) => { setError(errorText(e)); });
  };
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold"><span data-testid="return-number">{r.number}</span> · <Link href={`/sales/b2c/orders/${r.order.id}`}>{r.order.number}</Link></h1>
        <Badge tone={RETURN_TONE[r.status]} data-testid="return-status">{t(`return.status.${r.status}`)}</Badge>
      </div>
      <p className="m-0 text-sm text-fg-muted">
        <Link href={`/crm/contact/${r.customer.id}`}>{r.customer.fullName}</Link> · {t(`return.reason.${r.reasonCode}`)}{r.reason ? ` · ${r.reason}` : ''} · {r.requestedBy.displayName} · {dateTime(r.createdAt)}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 rounded-card border border-line bg-surface p-4 text-sm" data-testid="return-lines">
        {r.lines.map((l) => (
          <li key={l.orderLineId} className="flex gap-2"><span className="flex-1">{l.name} × {l.quantity}</span><span className="tabular-nums">{quoteMoney(l.amount, r.currency)}</span></li>
        ))}
        <li className="flex gap-2 border-t border-line pt-1.5 font-semibold"><span className="flex-1">{t('return.amount')}</span><span className="tabular-nums" data-testid="return-amount">{quoteMoney(r.amount, r.currency)}</span></li>
      </ul>
      {r.decidedBy ? <p className="m-0 text-sm">{t('return.decidedBy', { name: r.decidedBy.displayName, when: r.decidedAt ? dateTime(r.decidedAt) : '' })}{r.decisionNote ? ` · ${r.decisionNote}` : ''}</p> : null}
      {error ? <Alert kind="error">{error}</Alert> : null}
      {r.canDecide ? (
        <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4" data-testid="return-decide">
          <Field label={t('return.decisionNote')}><Textarea value={note} maxLength={500} rows={2} onChange={(e) => { setNote(e.target.value); }} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { run('reject'); }} loading={decide.isPending} data-testid="return-reject">{t('return.reject')}</Button>
            <Button onClick={() => { run('approve'); }} loading={decide.isPending} data-testid="return-approve">{t('return.approve')}</Button>
          </div>
        </div>
      ) : r.status === 'requested' ? <p className="m-0 text-sm text-fg-muted">{t('return.waiting')}</p> : null}
      {r.canCancel ? (
        <div><Button variant="ghost" onClick={() => { cancel.mutateAsync(undefined).then(() => { toast({ kind: 'success', title: t('return.cancelled') }); }, (e: unknown) => { setError(errorText(e)); }); }} loading={cancel.isPending}>{t('return.withdraw')}</Button></div>
      ) : null}
    </div>
  );
}

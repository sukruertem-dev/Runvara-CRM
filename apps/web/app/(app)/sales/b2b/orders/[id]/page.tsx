'use client';

import { Alert, Badge, Button, Dialog, DialogContent, DialogFooter, EmptyState, ErrorState, Field, Skeleton, Textarea, useToast } from '@flexa/ui';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError } from '../../../../../../lib/api';
import { ORDER_TONE, useB2bUpdates, useOrder, useOrderStatus, type Order } from '../../../../../../lib/b2b';
import { errorText } from '../../../../../../lib/catalog';
import { dateTime } from '../../../../../../lib/format';
import { t } from '../../../../../../lib/i18n';
import { quoteMoney } from '../../../../../../lib/quotes';
import { PageContainer } from '../../../../../_components/app-shell';
import { Section } from '../../../../../_components/record-parts';

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const q = useOrder(id);
  useB2bUpdates();
  if (q.isLoading) return <PageContainer><Skeleton className="h-64" /></PageContainer>;
  if (!q.data) {
    return (
      <PageContainer>
        {q.error instanceof ApiError && q.error.status === 404
          ? <EmptyState icon={FileQuestion} title={t('order.notFound')} description={t('quote.notFoundBody')} />
          : <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />}
      </PageContainer>
    );
  }
  return <OrderScreen o={q.data} />;
}

function OrderScreen({ o }: { o: Order }) {
  const status = useOrderStatus();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const row = (label: string, value: string, strong = false) => (
    <div key={label} className={`flex justify-between gap-4 ${strong ? 'font-bold' : ''}`}><dt>{label}</dt><dd className="m-0 tabular-nums">{quoteMoney(value, o.currency)}</dd></div>
  );
  return (
    <PageContainer>
      <Button asChild variant="ghost" size="sm" icon={<ArrowLeft aria-hidden size={14} />}><Link href="/sales/b2b/orders">{t('order.title')}</Link></Button>
      <div className="mb-4 mt-3 flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <h1 className="m-0 font-display text-2xl font-bold" data-testid="order-number">{o.number}</h1>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            {o.opportunity ? <Link href={`/crm/opportunity/${o.opportunity.id}`}>{o.opportunity.name}</Link> : null}
            {o.quote ? <> · <Link href={`/sales/b2b/quotes/${o.quote.id}`}>{t('contract.fromQuote', { number: o.quote.number })}</Link></> : null}
            {o.contract ? <> · <Link href={`/sales/b2b/contracts/${o.contract.id}`}>{o.contract.number}</Link></> : null}
            {' · '}{dateTime(o.createdAt)}
          </p>
        </div>
        <span data-testid="order-status"><Badge tone={ORDER_TONE[o.status]}>{t(`order.status.${o.status}`)}</Badge></span>
        {o.canEdit ? (
          <>
            <Button size="sm" loading={status.isPending} data-testid="order-fulfil" onClick={() => {
              status.mutateAsync({ id: o.id, status: 'fulfilled' }).then(() => { toast({ kind: 'success', title: t('order.saved') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
            }}>{t('order.fulfil')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setCancelling(true); }}>{t('order.cancel')}</Button>
          </>
        ) : null}
      </div>
      {o.statusReason ? <div className="mb-4"><Alert kind="info">{o.statusReason}</Alert></div> : null}
      <Section title={t('quote.lines')}>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('quote.lines')}>
          <table className="w-full border-collapse text-sm" data-testid="order-lines">
            <thead>
              <tr className="border-b border-line text-left text-xs text-fg-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">{t('quote.product')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.qty')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.unitPrice')}</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">{t('quote.lineDiscount')}</th>
                <th scope="col" className="py-2 text-right font-semibold">{t('quote.lineNet')}</th>
              </tr>
            </thead>
            <tbody>
              {o.lines.map((l, i) => (
                <tr key={`${l.productId}${String(i)}`} className="border-b border-line">
                  <td className="py-2 pr-3">{l.name} ({l.sku})</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{l.quantity} {l.unit}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{quoteMoney(l.unitPrice, o.currency)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{Number(l.discountPercent) > 0 ? l.discountPercent : ''}</td>
                  <td className="py-2 text-right tabular-nums">{quoteMoney(l.net, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="m-0 ml-auto mt-4 flex w-full max-w-sm flex-col gap-1 text-sm">
          {row(t('quote.subtotal'), o.totals.subtotal)}
          {Number(o.totals.discount) > 0 ? row(t('quote.discount'), o.totals.discount) : null}
          {row(t('quote.net'), o.totals.net)}
          {row(t('quote.tax', { percent: '' }).replace(/ %$|%$/, '').trim(), o.totals.tax)}
          {row(t('quote.total'), o.totals.total, true)}
        </dl>
      </Section>
      {cancelling ? <CancelDialog o={o} onClose={() => { setCancelling(false); }} /> : null}
    </PageContainer>
  );
}

function CancelDialog({ o, onClose }: { o: Order; onClose: () => void }) {
  const status = useOrderStatus();
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(x) => { if (!x) onClose(); }}>
      <DialogContent title={t('order.cancelTitle')} closeLabel={t('common.close')}>
        <form method="post" className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          status.mutateAsync({ id: o.id, status: 'cancelled', reason: reason.trim() }).then(() => { toast({ kind: 'success', title: t('order.saved') }); onClose(); }, (x: unknown) => { setError(errorText(x)); });
        }}>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <Field label={t('order.reason')}><Textarea value={reason} maxLength={500} rows={3} onChange={(e) => { setReason(e.target.value); }} required /></Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" variant="danger" loading={status.isPending} disabled={!reason.trim()}>{t('order.cancel')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

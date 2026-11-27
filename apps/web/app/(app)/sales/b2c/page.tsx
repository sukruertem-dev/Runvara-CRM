'use client';

import { Badge, Button, Checkbox, EmptyState, ErrorState, Input, Select, Skeleton, useToast } from '@flexa/ui';
import { ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { errorText } from '../../../../lib/catalog';
import { formatDate } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { CHANNELS, ORDER_TONE, PAYMENT_TONE, useB2cOrders, useBulkStep, useOrderUpdates } from '../../../../lib/orders';
import { quoteMoney } from '../../../../lib/quotes';
import { PageContainer } from '../../../_components/app-shell';

// B2C orders (B2C-02, docs/p9-plan.md §36): filters, and one step on several orders at once.

const ALL = 'all';
const STATUSES = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned'] as const;
const BULK = ['confirm', 'prepare', 'ship', 'deliver'] as const;

export default function B2cOrdersPage() {
  const [status, setStatus] = useState<string>(ALL);
  const [channel, setChannel] = useState<string>(ALL);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkStep, setBulkStep] = useState<(typeof BULK)[number]>('confirm');
  const bulk = useBulkStep();
  const { toast } = useToast();
  useOrderUpdates();
  useEffect(() => {
    const h = setTimeout(() => { setQ(text.trim()); }, 300);
    return () => { clearTimeout(h); };
  }, [text]);
  const list = useB2cOrders({ status: status === ALL ? '' : status, channel: channel === ALL ? '' : channel, q });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const toggle = (id: string, on: boolean): void => { setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }); };
  function runBulk(): void {
    bulk.mutateAsync({ ids: [...picked], step: bulkStep }).then((r) => {
      const done = r.data.filter((x) => x.ok).length;
      toast({ kind: done === r.data.length ? 'success' : 'info', title: t('b2corder.bulkDone', { done: String(done), total: String(r.data.length) }) });
      setPicked(new Set());
    }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); });
  }
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('b2corder.title')}</h1>
        <Button asChild variant="secondary" size="sm"><Link href="/sales/b2c/returns" data-testid="returns-link">{t('return.title')}</Link></Button>
        <Button asChild variant="secondary" size="sm"><Link href="/sales/b2c/customers">{t('customer.title')}</Link></Button>
      </div>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Input type="search" value={text} onChange={(e) => { setText(e.target.value); }} aria-label={t('b2corder.search')} placeholder={t('b2corder.search')} />
        <Select aria-label={t('b2corder.status')} value={status} onValueChange={setStatus} options={[{ value: ALL, label: t('b2corder.allStatuses') }, ...STATUSES.map((s) => ({ value: s, label: t(`b2corder.status.${s}`) }))]} />
        <Select aria-label={t('b2corder.channel')} value={channel} onValueChange={setChannel} options={[{ value: ALL, label: t('b2corder.allChannels') }, ...CHANNELS.map((c) => ({ value: c, label: t(`b2corder.channel.${c}`) }))]} />
      </div>
      {picked.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-subtle p-2" data-testid="bulk-bar">
          <span className="text-sm">{t('b2corder.picked', { count: String(picked.size) })}</span>
          <div className="w-48"><Select aria-label={t('b2corder.bulkStep')} value={bulkStep} onValueChange={(v) => { setBulkStep(v as (typeof BULK)[number]); }} options={BULK.map((s) => ({ value: s, label: t(`b2corder.step.${s}`) }))} /></div>
          <Button size="sm" onClick={runBulk} loading={bulk.isPending} data-testid="bulk-run">{t('b2corder.bulkRun')}</Button>
        </div>
      ) : null}
      {list.isError ? <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={ShoppingBag} title={t('b2corder.empty')} description={t('b2corder.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="b2corder-list">
              {rows.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <Checkbox checked={picked.has(o.id)} onCheckedChange={(v) => { toggle(o.id, v === true); }} aria-label={t('b2corder.pick', { number: o.number })} />
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/sales/b2c/orders/${o.id}`}>{o.number}</Link> · {o.customer.fullName}</p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{t(`b2corder.channel.${o.channel}`)} · {formatDate(o.createdAt)}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{quoteMoney(o.total, o.currency)}</span>
                  <Badge tone={PAYMENT_TONE[o.paymentStatus]}>{t(`b2corder.payment.${o.paymentStatus}`)}</Badge>
                  <Badge tone={ORDER_TONE[o.status]}>{t(`b2corder.status.${o.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

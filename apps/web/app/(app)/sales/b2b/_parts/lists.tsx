'use client';

import { Badge, Button, EmptyState, ErrorState, Select, Skeleton } from '@flexa/ui';
import { FileSignature, PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CONTRACT_TONE, ORDER_TONE, useB2bUpdates, useContracts, useOrders } from '../../../../../lib/b2b';
import { formatDate } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { quoteMoney } from '../../../../../lib/quotes';
import { PageContainer } from '../../../../_components/app-shell';

const ALL = 'all';
const day = (d: string): string => formatDate(`${d}T12:00:00`);

function Header({ title, value, onChange, options, all }: { title: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; all: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <h1 className="m-0 flex-1 font-display text-xl font-bold">{title}</h1>
      <div className="w-52"><Select aria-label={t('quote.status')} value={value} onValueChange={onChange} options={[{ value: ALL, label: all }, ...options]} /></div>
    </div>
  );
}

export function ContractList() {
  const [status, setStatus] = useState(ALL);
  const list = useContracts(status === ALL ? {} : { status });
  useB2bUpdates();
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PageContainer>
      <Header title={t('contract.title')} value={status} onChange={setStatus} all={t('contract.all')}
        options={(['active', 'ended', 'renewed', 'terminated'] as const).map((s) => ({ value: s, label: t(`contract.status.${s}`) }))} />
      {list.isError ? <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={FileSignature} title={t('contract.empty')} description={t('contract.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="contract-list">
              {rows.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/sales/b2b/contracts/${c.id}`}>{c.number}</Link> · {c.title}</p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{c.account?.name ?? c.opportunity.name} · {t('contract.period', { start: day(c.startDate), end: day(c.endDate) })}</p>
                  </div>
                  {c.value ? <span className="tabular-nums">{quoteMoney(c.value, c.currency)}</span> : null}
                  <Badge tone={CONTRACT_TONE[c.status]}>{t(`contract.status.${c.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

export function OrderList() {
  const [status, setStatus] = useState(ALL);
  const list = useOrders(status === ALL ? {} : { status });
  useB2bUpdates();
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PageContainer>
      <Header title={t('order.title')} value={status} onChange={setStatus} all={t('order.all')}
        options={(['open', 'fulfilled', 'cancelled'] as const).map((s) => ({ value: s, label: t(`order.status.${s}`) }))} />
      {list.isError ? <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={PackageCheck} title={t('order.empty')} description={t('order.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="order-list">
              {rows.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/sales/b2b/orders/${o.id}`}>{o.number}</Link>{o.opportunity ? ` · ${o.opportunity.name}` : ''}</p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{o.quote ? t('contract.fromQuote', { number: o.quote.number }) : ''} · {o.createdBy.displayName}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{quoteMoney(o.totals.total, o.currency)}</span>
                  <Badge tone={ORDER_TONE[o.status]}>{t(`order.status.${o.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

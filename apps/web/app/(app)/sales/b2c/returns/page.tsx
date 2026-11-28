'use client';

import { Badge, Button, EmptyState, ErrorState, Select, Skeleton } from '@flexa/ui';
import { Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { RETURN_TONE, useOrderUpdates, useReturns } from '../../../../../lib/orders';
import { quoteMoney } from '../../../../../lib/quotes';
import { PageContainer } from '../../../../_components/app-shell';

// B2C returns (B2C-05, docs/p9-plan.md §36); the pending ones first by default.

const ALL = 'all';
const STATUSES = ['requested', 'approved', 'rejected', 'cancelled'] as const;

export default function ReturnsPage() {
  const [status, setStatus] = useState<string>('requested');
  const list = useReturns({ status: status === ALL ? '' : status });
  useOrderUpdates();
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('return.title')}</h1>
        <div className="w-52"><Select aria-label={t('return.statusLabel')} value={status} onValueChange={setStatus} options={[{ value: ALL, label: t('return.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`return.status.${s}`) }))]} /></div>
      </div>
      {list.isError ? <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
        : !list.data ? <Skeleton className="h-48 w-full" />
          : rows.length === 0 ? <EmptyState icon={Undo2} title={t('return.empty')} description={t('return.emptyBody')} /> : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="return-list">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                  <div className="min-w-48 flex-1">
                    <p className="m-0 font-semibold"><Link href={`/sales/b2c/returns/${r.id}`}>{r.number}</Link> · {r.customer.fullName}</p>
                    <p className="m-0 mt-0.5 text-xs text-fg-muted">{r.order.number} · {t(`return.reason.${r.reasonCode}`)} · {r.requestedBy.displayName} · {formatDate(r.createdAt)}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{quoteMoney(r.amount, r.currency)}</span>
                  <Badge tone={RETURN_TONE[r.status]}>{t(`return.status.${r.status}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

'use client';

import { Badge, Button, EmptyState, ErrorState, Select, Skeleton } from '@flexa/ui';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { formatDate } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { QUOTE_TONE, quoteMoney, useQuotes, useQuoteUpdates, type QuoteStatusKey } from '../../../../../lib/quotes';
import { PageContainer } from '../../../../_components/app-shell';

const STATUSES: readonly QuoteStatusKey[] = ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired'];
const ALL = 'all';

/** Quotes of every opportunity the caller can read, newest first. */
export default function QuotesPage() {
  const [status, setStatus] = useState<string>(ALL);
  const list = useQuotes(status === ALL ? {} : { status });
  useQuoteUpdates();
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('quote.title')}</h1>
        <div className="w-52">
          <Select aria-label={t('quote.status')} value={status} onValueChange={setStatus} options={[{ value: ALL, label: t('quote.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`quote.status.${s}`) }))]} />
        </div>
      </div>
      {list.isError ? (
        <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => { void list.refetch(); }} />
      ) : !list.data ? (
        <Skeleton className="h-48 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={FileText} title={t('quote.empty')} description={t('quote.emptyBody')} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="quote-list">
          {rows.map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
              <div className="min-w-48 flex-1">
                <p className="m-0 font-semibold"><Link href={`/sales/b2b/quotes/${q.id}`}>{q.number}</Link> · <Link href={`/crm/opportunity/${q.opportunity.id}`} className="text-fg">{q.opportunity.name}</Link></p>
                <p className="m-0 mt-0.5 text-xs text-fg-muted">{t('quote.version', { version: String(q.currentVersion) })} · {q.createdBy.displayName} · {t('quote.validUntil')}: {formatDate(`${q.validUntil}T12:00:00`)}</p>
              </div>
              <span className="font-semibold tabular-nums">{quoteMoney(q.total, q.currency)}</span>
              <Badge tone={QUOTE_TONE[q.status]}>{t(`quote.status.${q.status}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? <Button className="mt-3" variant="secondary" loading={list.isFetchingNextPage} onClick={() => { void list.fetchNextPage(); }}>{t('quote.more')}</Button> : null}
    </PageContainer>
  );
}

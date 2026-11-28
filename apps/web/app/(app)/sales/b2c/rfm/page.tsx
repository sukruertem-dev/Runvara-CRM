'use client';

import { Badge, Button, EmptyState, ErrorState, Skeleton, useToast } from '@flexa/ui';
import { BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useApp } from '../../../../../lib/app-context';
import { RFM_SEGMENTS, RFM_TONE, useRecomputeRfm, useRfm } from '../../../../../lib/campaigns';
import { errorText } from '../../../../../lib/catalog';
import { relativeTime } from '../../../../../lib/format';
import { t } from '../../../../../lib/i18n';
import { quoteMoney } from '../../../../../lib/quotes';
import { PageContainer } from '../../../../_components/app-shell';

// RFM segments (B2C-07, docs/p9-plan.md §47): how many customers in each, and who (e.g. the win-back list).

export default function RfmPage() {
  const { can, tenant } = useApp();
  const [segment, setSegment] = useState<string>('hibernating');
  const q = useRfm(segment);
  const recompute = useRecomputeRfm();
  const { toast } = useToast();
  const count = (s: string): number => q.data?.segments.find((x) => x.segment === s)?.count ?? 0;
  return (
    <PageContainer>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="m-0 flex-1 font-display text-xl font-bold">{t('rfm.title')}</h1>
        {q.data?.computedAt ? <span className="text-sm text-fg-muted">{t('rfm.computed', { when: relativeTime(q.data.computedAt) })}</span> : null}
        {can('tenant.config.manage') ? (
          <Button size="sm" variant="secondary" loading={recompute.isPending} data-testid="rfm-recompute"
            onClick={() => { recompute.mutateAsync().then(() => { toast({ kind: 'success', title: t('rfm.recomputed') }); }, (e: unknown) => { toast({ kind: 'error', title: errorText(e) }); }); }}>
            {t('rfm.recompute')}
          </Button>
        ) : null}
      </div>
      <p className="m-0 mb-4 max-w-3xl text-sm text-fg-muted">{t('rfm.lead')}</p>
      {q.isError ? <ErrorState title={errorText(q.error)} retryLabel={t('common.retry')} onRetry={() => { void q.refetch(); }} />
        : !q.data ? <Skeleton className="h-48 w-full" /> : (
          <>
            <div className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label={t('rfm.segments')} data-testid="rfm-segments">
              {RFM_SEGMENTS.map((s) => (
                <button key={s} type="button" aria-pressed={segment === s} onClick={() => { setSegment(s); }}
                  className={`rounded-card border p-3 text-left ${segment === s ? 'border-accent bg-accent-soft' : 'border-line bg-surface'}`}>
                  <span className="block text-xs font-semibold text-fg-muted">{t(`rfm.segment.${s}`)}</span>
                  <span className="block font-display text-lg font-bold tabular-nums">{count(s)}</span>
                </button>
              ))}
            </div>
            {q.data.customers.length === 0 ? <EmptyState icon={BarChart3} title={t('rfm.empty')} description={t('rfm.emptyBody')} /> : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="rfm-list">
                {q.data.customers.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3">
                    <div className="min-w-48 flex-1">
                      <p className="m-0 font-semibold"><Link href={`/crm/contact/${c.id}`}>{c.fullName}</Link></p>
                      <p className="m-0 mt-0.5 text-xs text-fg-muted">{c.owner.displayName} · {t('rfm.line', { days: String(c.rfm.recencyDays), orders: String(c.rfm.frequency) })} · {quoteMoney(c.rfm.monetary, tenant?.currency ?? 'TRY')}</p>
                    </div>
                    <Badge tone="neutral">RFM {c.rfm.score}</Badge>
                    <Badge tone={RFM_TONE[c.rfm.segment]}>{t(`rfm.segment.${c.rfm.segment}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </PageContainer>
  );
}

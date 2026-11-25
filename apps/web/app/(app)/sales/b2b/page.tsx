'use client';

import { Button } from '@flexa/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { t } from '../../../../lib/i18n';
import { FilterBar } from '../../../_components/filter-bar';
import { PipelineBoard } from '../../crm/_parts/pipeline-board';

/** Sales pipeline (menu entry of the B2B sales module): B2B opportunities by stage. Quotes have their own list. */
function PipelineInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const q = sp.get('rql') ?? '';
  const scoped = ['segment = b2b', q ? `(${q})` : ''].filter(Boolean).join(' AND ');
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start gap-3 px-4 pb-1 pt-5 md:px-6">
        <h1 className="m-0 font-display text-xl font-bold">{t('pipeline.title')}</h1>
        <FilterBar resource="opportunity" value={q} onChange={(next) => { router.replace(next ? `${pathname}?rql=${encodeURIComponent(next)}` : pathname); }} className="min-w-64" />
        <Button asChild variant="secondary" size="sm"><Link href="/sales/b2b/quotes" data-testid="pipeline-quotes">{t('quote.title')}</Link></Button>
      </div>
      <PipelineBoard q={scoped} />
    </div>
  );
}

export default function PipelinePage() {
  return (
    <Suspense>
      <PipelineInner />
    </Suspense>
  );
}

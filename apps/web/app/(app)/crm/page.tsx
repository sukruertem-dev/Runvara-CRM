'use client';

import { SegmentedControl } from '@flexa/ui';
import { KanbanSquare, Table2 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { t } from '../../../lib/i18n';
import type { CrmResource, View } from '../../../lib/records';
import { FilterBar } from '../../_components/filter-bar';
import { ViewsMenu } from '../../_components/views-menu';
import { TYPE_LABEL } from './_parts/columns';
import { PipelineBoard } from './_parts/pipeline-board';
import { RecordTable } from './_parts/record-table';

const TYPES: CrmResource[] = ['account', 'contact', 'lead', 'opportunity', 'case'];

function CrmInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const type: CrmResource = TYPES.includes(sp.get('type') as CrmResource) ? (sp.get('type') as CrmResource) : 'account';
  const q = sp.get('rql') ?? '';
  const sort = sp.get('sort') ?? '-updated';
  const pipeline = type === 'opportunity' && sp.get('view') === 'pipeline';

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [sp, router, pathname],
  );

  function applyView(v: View): void {
    update({ sv: v.id, rql: v.query || null, sort: v.sort, view: v.viewType === 'pipeline' ? 'pipeline' : null });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-5 md:px-6">
        <h1 className="m-0 font-display text-xl font-bold">{t('crm.title')}</h1>
      </div>
      <div className="overflow-x-auto px-4 md:px-6">
        <SegmentedControl<CrmResource>
          label={t('crm.title')}
          value={type}
          onValueChange={(v) => { update({ type: v === 'account' ? null : v, rql: null, sort: null, sv: null, view: null }); }}
          options={TYPES.map((x) => ({ value: x, label: t(TYPE_LABEL[x]) }))}
        />
      </div>
      <section aria-label={t(TYPE_LABEL[type])} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-start gap-2 px-4 py-3 md:px-6">
          {type === 'opportunity' ? (
            <SegmentedControl<'table' | 'pipeline'>
              label={t('tasks.view')}
              value={pipeline ? 'pipeline' : 'table'}
              onValueChange={(v) => { update({ view: v === 'pipeline' ? 'pipeline' : null }); }}
              options={[
                { value: 'table', label: t('crm.view.table'), icon: <Table2 aria-hidden size={14} /> },
                { value: 'pipeline', label: t('crm.view.pipeline'), icon: <KanbanSquare aria-hidden size={14} /> },
              ]}
            />
          ) : null}
          <ViewsMenu resource={type} activeId={sp.get('sv')} onApply={applyView} current={{ viewType: pipeline ? 'pipeline' : 'table', query: q, sort: sort === '-updated' ? null : sort, config: {} }} />
          <FilterBar resource={type} value={q} onChange={(next) => { update({ rql: next || null, sv: null }); }} className="min-w-64" />
        </div>
        {pipeline ? <PipelineBoard q={q} /> : <RecordTable type={type} q={q} sort={sort} onSort={(s) => { update({ sort: s === '-updated' ? null : s }); }} />}
      </section>
    </div>
  );
}

export default function CrmPage() {
  return (
    <Suspense>
      <CrmInner />
    </Suspense>
  );
}

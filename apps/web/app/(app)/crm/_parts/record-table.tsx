'use client';

import { Button, cn, EmptyState, ErrorState, focusRing, Skeleton } from '@flexa/ui';
import { ArrowDown, ArrowUp, ArrowUpDown, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { fmt, formatNumber } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { useRecordList, type CrmResource } from '../../../../lib/records';
import { useDirectory } from '../../../../lib/tasks';
import { COLUMNS, recordName, type CrmRecord } from './columns';

/** Paged table of one CRM resource with server sort; rows link to the record page. */
export function RecordTable({ type, q, sort, onSort }: { type: CrmResource; q: string; sort: string; onSort: (sort: string) => void }) {
  const params = useMemo(() => ({ ...(q ? { q } : {}), sort, limit: '100' }), [q, sort]);
  const list = useRecordList<CrmRecord>(type, params);
  const names = useDirectory(useMemo(() => list.rows.map((r) => (typeof r['ownerUserId'] === 'string' ? r['ownerUserId'] : null)), [list.rows]));
  const cols = COLUMNS[type];

  if (list.error) return <ErrorState title={t('common.loadError')} description={t('common.loadErrorBody')} retryLabel={t('common.retry')} onRetry={() => void list.refetch()} />;
  if (list.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4 md:px-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (list.rows.length === 0) {
    return q ? <EmptyState icon={Search} title={t('crm.emptyFiltered')} /> : <EmptyState icon={Users} title={t('crm.empty')} description={t('crm.emptyBody')} />;
  }

  const dir = (field: string | undefined): 'asc' | 'desc' | null => (!field ? null : sort === field ? 'asc' : sort === `-${field}` ? 'desc' : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="m-0 px-4 pb-2 text-sm tabular-nums text-fg-muted md:px-6" aria-live="polite" data-testid="crm-count">
        {list.total !== undefined ? fmt('crm.count', { count: formatNumber(list.total) }) : ' '}
      </p>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line">
        <table className="w-full min-w-[720px] border-collapse text-sm" data-testid="crm-table">
          <thead className="sticky top-0 z-10 bg-subtle">
            <tr>
              {cols.map((c) => {
                const d = dir(c.sort);
                return (
                  <th key={c.id} scope="col" aria-sort={d === 'asc' ? 'ascending' : d === 'desc' ? 'descending' : undefined} className="h-9 border-b border-line px-3 text-left text-xs font-semibold text-fg-muted">
                    {c.sort ? (
                      <button
                        type="button"
                        onClick={() => { onSort(d === 'asc' ? `-${c.sort ?? ''}` : (c.sort ?? '-updated')); }}
                        className={cn('inline-flex items-center gap-1 rounded-input hover:text-fg', focusRing)}
                      >
                        {t(c.label)}
                        {d === 'asc' ? <ArrowUp aria-hidden size={12} /> : d === 'desc' ? <ArrowDown aria-hidden size={12} /> : <ArrowUpDown aria-hidden size={12} className="opacity-50" />}
                      </button>
                    ) : (
                      t(c.label)
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.id} className="h-row border-b border-line bg-surface hover:bg-subtle" data-testid="crm-row">
                {cols.map((c, i) => (
                  <td key={c.id} className="max-w-64 truncate px-3">
                    {i === 0 ? (
                      <Link href={`/crm/${type}/${r.id}`} className={cn('font-medium text-fg no-underline hover:underline', focusRing)}>
                        {recordName(type, r) || '—'}
                      </Link>
                    ) : (
                      c.render(r, names)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {list.hasNextPage ? (
          <div className="p-3">
            <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('common.more')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

'use client';

import {
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  focusRing,
  Spinner,
} from '@flexa/ui';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  useReactTable,
  type ColumnDef,
  type GroupingState,
  type Row,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Columns3 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateTime } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { statusLabel, type Task, type Workflow } from '../../../../lib/tasks';
import { AssigneeCell, DueCell, InlineTitle, PriorityCell, priorityLabel, StatusCell } from '../_parts/cells';
import type { SelectionApi } from './list-view';
import { useMounted, useRowHeight } from './list-view';

export type TableGroup = 'none' | 'status' | 'assignee' | 'priority';

/** Columns whose sort the API supports (task RQL registry, `sortable: true`). */
const SORT_FIELD: Record<string, string> = { title: 'title', priority: 'priority', due: 'due', start: 'start', created: 'created', updated: 'updated', estimate: 'estimate', status: 'statusCategory' };

const PREFS_KEY = 'fx.tasks.table.columns';

function readHidden(): VisibilityState {
  try {
    const v = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as VisibilityState) : {};
  } catch {
    return {};
  }
}

/**
 * Table: column visibility (remembered per browser), server-side sort by clicking headers, client grouping
 * by status / assignee / priority, sticky selection + title columns, virtualised rows.
 */
export function TableView({
  tasks,
  workflow,
  names,
  selection,
  editable,
  sort,
  onSort,
  group,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  tasks: Task[];
  workflow: Workflow | undefined;
  names: Map<string, string>;
  selection: SelectionApi;
  editable: boolean;
  sort: string;
  onSort: (sort: string) => void;
  group: TableGroup;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState<VisibilityState>({});
  useEffect(() => {
    setVisibility(readHidden());
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(visibility));
    } catch {
      // ignore
    }
  }, [visibility]);

  const allIds = useMemo(() => tasks.map((x) => x.id), [tasks]);
  const allSelected = tasks.length > 0 && allIds.every((id) => selection.selected.has(id));
  const someSelected = !allSelected && allIds.some((id) => selection.selected.has(id));

  const columns = useMemo<ColumnDef<Task>[]>(
    () => [
      {
        id: 'select',
        enableHiding: false,
        size: 44,
        header: () => (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            aria-label={t('tasks.selectAll')}
            onCheckedChange={(v) => { selection.setMany(allIds, v === true); }}
          />
        ),
        cell: ({ row }) => (
          <Checkbox checked={selection.selected.has(row.original.id)} aria-label={t('tasks.select', { title: row.original.title ?? '' })} onCheckedChange={() => { selection.toggle(row.original.id); }} />
        ),
      },
      {
        id: 'title',
        header: t('tasks.col.title'),
        enableHiding: false,
        size: 360,
        cell: ({ row }) => <InlineTitle task={row.original} editable={editable} onOpen={() => { router.push(`/tasks/${row.original.id}`); }} />,
      },
      {
        id: 'status',
        header: t('tasks.col.status'),
        size: 150,
        accessorFn: (x) => x.status?.id ?? '',
        cell: ({ row }) => <StatusCell task={row.original} workflow={workflow} editable={editable} />,
      },
      { id: 'priority', header: t('tasks.col.priority'), size: 120, accessorFn: (x) => x.priority ?? 0, cell: ({ row }) => <PriorityCell task={row.original} editable={editable} /> },
      { id: 'assignee', header: t('tasks.col.assignee'), size: 180, accessorFn: (x) => x.assigneeUserId ?? '', cell: ({ row }) => <AssigneeCell id={row.original.assigneeUserId} names={names} /> },
      { id: 'due', header: t('tasks.col.due'), size: 120, cell: ({ row }) => <DueCell task={row.original} /> },
      { id: 'start', header: t('tasks.col.start'), size: 150, cell: ({ row }) => <span className="text-xs text-fg-muted">{dateTime(row.original.startAt)}</span> },
      { id: 'estimate', header: t('tasks.col.estimate'), size: 110, cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.estimateMinutes ?? ''}</span> },
      { id: 'created', header: t('tasks.col.created'), size: 160, cell: ({ row }) => <span className="text-xs text-fg-muted">{dateTime(row.original.createdAt)}</span> },
      { id: 'updated', header: t('tasks.col.updated'), size: 160, cell: ({ row }) => <span className="text-xs text-fg-muted">{dateTime(row.original.updatedAt)}</span> },
    ],
    [allSelected, someSelected, allIds, selection, editable, workflow, names, router],
  );

  // Stable references: a new grouping array each render makes TanStack recompute the grouped model, which
  // auto-resets `expanded`, which renders again — an endless render loop on the next parent update.
  const grouping = useMemo<GroupingState>(() => (group === 'none' ? [] : [group]), [group]);
  // No pagination here (rows are virtualized). Left on, the page-index reset is queued as a microtask whenever
  // the row model recomputes and can call setState before the first commit ("hasn't mounted yet").
  const table = useReactTable({
    autoResetExpanded: false,
    autoResetPageIndex: false,
    data: tasks,
    columns,
    getRowId: (x) => x.id,
    state: { columnVisibility: visibility, grouping, expanded: true },
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    groupedColumnMode: false,
  });

  const rows = table.getRowModel().rows;
  const parent = useRef<HTMLDivElement>(null);
  const rowHeight = useRowHeight();
  const mounted = useMounted();
  const virtualizer = useVirtualizer({ enabled: mounted, count: rows.length, getScrollElement: () => parent.current, estimateSize: () => rowHeight, overscan: 10 });
  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);
  useEffect(() => {
    if (last && last.index >= rows.length - 1 && hasMore && !loadingMore) onLoadMore();
  }, [last, rows.length, hasMore, loadingMore, onLoadMore]);

  const groupLabel = (row: Row<Task>): string => {
    const v = row.groupingValue;
    if (group === 'status') {
      const s = workflow?.statuses.find((x) => x.id === v);
      return s ? statusLabel(s.label) : '';
    }
    if (group === 'priority') return priorityLabel(Number(v));
    if (group === 'assignee') return typeof v === 'string' && v ? (names.get(v) ?? t('common.unknownUser')) : t('common.unassigned');
    return '';
  };

  const sortState = (id: string): 'asc' | 'desc' | null => {
    const field = SORT_FIELD[id];
    if (!field) return null;
    if (sort === field) return 'asc';
    if (sort === `-${field}`) return 'desc';
    return null;
  };

  const visibleColumns = table.getVisibleLeafColumns();
  const template = visibleColumns.map((c) => `${String(c.getSize())}px`).join(' ');
  const width = visibleColumns.reduce((n, c) => n + c.getSize(), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-2 px-4 pb-2 md:px-6">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" icon={<Columns3 aria-hidden size={14} />}>
              {t('tasks.columns')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t('tasks.columns')}</DropdownMenuLabel>
            {table
              .getAllLeafColumns()
              .filter((c) => c.getCanHide())
              .map((c) => (
                <label key={c.id} className="flex min-h-8 cursor-pointer items-center gap-2 rounded-input px-2 py-1.5 text-sm hover:bg-subtle">
                  <Checkbox checked={c.getIsVisible()} onCheckedChange={(v) => { c.toggleVisibility(v === true); }} />
                  {typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id}
                </label>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={parent} className="min-h-0 flex-1 overflow-auto border-t border-line" data-testid="task-table">
        <div role="table" aria-label={t('tasks.title')} aria-rowcount={rows.length + 1} style={{ width, minWidth: '100%' }}>
          <div role="rowgroup" className="sticky top-0 z-20">
            {table.getHeaderGroups().map((hg) => (
              <div role="row" key={hg.id} className="grid border-b border-line bg-subtle" style={{ gridTemplateColumns: template }}>
                {hg.headers.map((h, i) => {
                  const dir = sortState(h.column.id);
                  const sortable = SORT_FIELD[h.column.id] !== undefined;
                  return (
                    <div
                      role="columnheader"
                      key={h.id}
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                      className={cn('flex h-9 items-center px-3 text-xs font-semibold text-fg-muted', i < 2 && 'sticky z-10 bg-subtle', i === 1 && 'border-r border-line')}
                      style={i < 2 ? { left: i === 0 ? 0 : visibleColumns[0]?.getSize() } : undefined}
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className={cn('inline-flex items-center gap-1 rounded-input hover:text-fg', focusRing)}
                          aria-label={t(dir === 'asc' ? 'tasks.sort.desc' : 'tasks.sort.asc', { column: String(h.column.columnDef.header) })}
                          onClick={() => { onSort(dir === 'asc' ? `-${SORT_FIELD[h.column.id] ?? ''}` : (SORT_FIELD[h.column.id] ?? 'position')); }}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === 'asc' ? <ArrowUp aria-hidden size={12} /> : dir === 'desc' ? <ArrowDown aria-hidden size={12} /> : <ArrowUpDown aria-hidden size={12} className="opacity-50" />}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((v) => {
              const row = rows[v.index];
              if (!row) return null;
              if (row.getIsGrouped()) {
                return (
                  <div role="row" key={row.id} className="absolute inset-x-0 flex items-center border-b border-line bg-canvas px-3" style={{ top: v.start, height: v.size }} aria-rowindex={v.index + 2}>
                    <div role="cell" className="sticky left-3 flex items-center gap-2 text-sm font-semibold">
                      <button type="button" onClick={row.getToggleExpandedHandler()} aria-expanded={row.getIsExpanded()} className={cn('inline-flex items-center gap-1 rounded-input', focusRing)}>
                        {row.getIsExpanded() ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
                        {groupLabel(row)}
                      </button>
                      <span className="text-xs font-normal tabular-nums text-fg-muted">{row.subRows.length}</span>
                    </div>
                  </div>
                );
              }
              const selected = selection.selected.has(row.original.id);
              return (
                <div
                  role="row"
                  key={row.id}
                  aria-rowindex={v.index + 2}
                  aria-selected={selected}
                  data-testid="table-row"
                  className={cn('group absolute inset-x-0 grid border-b border-line', selected ? 'bg-accent-soft' : 'bg-surface hover:bg-subtle')}
                  style={{ top: v.start, height: v.size, gridTemplateColumns: template }}
                >
                  {row.getVisibleCells().map((cell, i) => (
                    <div
                      role="cell"
                      key={cell.id}
                      className={cn('flex min-w-0 items-center px-3', i < 2 && cn('sticky z-10', selected ? 'bg-accent-soft' : 'bg-surface group-hover:bg-subtle'), i === 1 && 'border-r border-line')}
                      style={i < 2 ? { left: i === 0 ? 0 : visibleColumns[0]?.getSize() } : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        {loadingMore ? (
          <p className="flex items-center justify-center gap-2 py-3 text-sm text-fg-muted">
            <Spinner /> {t('tasks.loadingMore')}
          </p>
        ) : null}
      </div>
    </div>
  );
}

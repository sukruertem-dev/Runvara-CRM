'use client';

import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
  SegmentedControl,
} from '@flexa/ui';
import { CalendarDays, ChartGantt, CheckSquare, KanbanSquare, List, Plus, Search, Table2 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../../lib/app-context';
import { fmt } from '../../../lib/format';
import { useHotkeys } from '../../../lib/hotkeys';
import { t } from '../../../lib/i18n';
import { DEFAULT_FILTERS, useDirectory, useTaskList, useTaskWorkflow, type TaskFilters, type TaskScope } from '../../../lib/tasks';
import { useShell } from '../../_components/shell/shell-context';
import { BulkBar } from './_parts/bulk-bar';
import { FilterBar } from '../../_components/filter-bar';
import { ViewsMenu } from '../../_components/views-menu';
import type { View as SavedView } from '../../../lib/records';
import { BoardView, type Swimlane } from './_views/board-view';
import { CalendarView } from './_views/calendar-view';
import { GanttView } from './_views/gantt-view';
import { ListView, type SelectionApi } from './_views/list-view';
import { TableView, type TableGroup } from './_views/table-view';

type View = 'list' | 'board' | 'table' | 'calendar' | 'gantt';
const VIEWS: View[] = ['list', 'board', 'table', 'calendar', 'gantt'];

/** Filters and view live in the URL, so a filtered view is a shareable link. */
function useUrlState() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view: View = VIEWS.includes(sp.get('view') as View) ? (sp.get('view') as View) : 'list';
  const filters: TaskFilters = {
    scope: (['all', 'mine', 'created'] as TaskScope[]).includes(sp.get('scope') as TaskScope) ? (sp.get('scope') as TaskScope) : DEFAULT_FILTERS.scope,
    openOnly: sp.get('open') === '1',
    search: sp.get('q') ?? '',
    sort: sp.get('sort') ?? DEFAULT_FILTERS.sort,
    rql: sp.get('rql') ?? '',
  };
  const swimlane: Swimlane = sp.get('lane') === 'assignee' || sp.get('lane') === 'priority' ? (sp.get('lane') as Swimlane) : 'none';
  const group: TableGroup = (['status', 'assignee', 'priority'] as TableGroup[]).includes(sp.get('group') as TableGroup) ? (sp.get('group') as TableGroup) : 'none';

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
  return { view, filters, swimlane, group, update, savedViewId: sp.get('sv') };
}

interface Selection extends SelectionApi {
  clear: () => void;
  /** Visible row order, for Shift-range selection. */
  order: { current: string[] };
}

function useSelection(): Selection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const order = useRef<string[]>([]);
  const toggle = useCallback((id: string, range = false) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = order.current;
      const a = anchor.current ? ids.indexOf(anchor.current) : -1;
      const b = ids.indexOf(id);
      if (range && a !== -1 && b !== -1) {
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
        return next;
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      return next;
    });
  }, []);
  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);
  return useMemo(() => ({ selected, toggle, setMany, clear, order }), [selected, toggle, setMany, clear]);
}

function TasksPageInner() {
  const { can } = useApp();
  const { setNewTaskOpen } = useShell();
  const { view, filters, swimlane, group, update, savedViewId } = useUrlState();
  const { workflow, isLoading: wfLoading } = useTaskWorkflow();
  const list = useTaskList(filters);
  const names = useDirectory(useMemo(() => list.tasks.map((x) => x.assigneeUserId), [list.tasks]));
  const selection = useSelection();
  const [search, setSearch] = useState(filters.search);
  const searchRef = useRef<HTMLInputElement>(null);
  const editable = can('task.update');

  selection.order.current = list.tasks.map((x) => x.id);

  // Debounced search → URL.
  useEffect(() => {
    if (search === filters.search) return;
    const id = window.setTimeout(() => {
      update({ q: search.trim() || null });
    }, 250);
    return () => {
      window.clearTimeout(id);
    };
  }, [search, filters.search, update]);

  // Selection only keeps rows that are still listed.
  const { selected, setMany } = selection;
  useEffect(() => {
    const ids = new Set(list.tasks.map((x) => x.id));
    const stale = [...selected].filter((id) => !ids.has(id));
    if (stale.length > 0) setMany(stale, false);
  }, [list.tasks, selected, setMany]);

  useHotkeys([
    { key: '1', handler: () => { update({ view: null }); } },
    { key: '2', handler: () => { update({ view: 'board' }); } },
    { key: '3', handler: () => { update({ view: 'table' }); } },
    { key: '4', handler: () => { update({ view: 'calendar' }); } },
    { key: '5', handler: () => { update({ view: 'gantt' }); } },
    { key: 'f', handler: () => searchRef.current?.focus() },
    { key: 'Escape', when: () => selection.selected.size > 0, handler: () => { selection.clear(); } },
  ]);

  const selectedTasks = list.tasks.filter((x) => selection.selected.has(x.id));
  const filtered = filters.scope !== 'all' || filters.openOnly || filters.search !== '' || filters.rql !== '';
  const dated = view === 'calendar' || view === 'gantt';

  /** A saved view replaces the advanced filter, sort and view options (quick filters are cleared). */
  function applyView(v: SavedView): void {
    const cfg = v.config;
    update({
      sv: v.id,
      rql: v.query || null,
      sort: v.sort,
      view: v.viewType === 'list' || v.viewType === 'pipeline' ? null : v.viewType,
      lane: typeof cfg['lane'] === 'string' ? cfg['lane'] : null,
      group: typeof cfg['group'] === 'string' ? cfg['group'] : null,
      scope: null,
      open: null,
      q: null,
    });
  }
  const loading = list.isLoading || wfLoading;
  const loadMore = useCallback(() => {
    void list.fetchNextPage();
  }, [list]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 pb-3 pt-5 md:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-display text-xl font-bold">{t('tasks.title')}</h1>
          <p className="m-0 text-sm tabular-nums text-fg-muted" aria-live="polite" data-testid="task-count">
            {list.total !== undefined ? fmt('tasks.count', { count: list.total.toLocaleString('tr-TR') }) : ' '}
          </p>
        </div>
        {can('task.create') ? (
          <Button icon={<Plus aria-hidden size={16} />} onClick={() => { setNewTaskOpen(true); }} aria-keyshortcuts="C">
            {t('tasks.new')}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 pb-3 md:px-6">
        <SegmentedControl<View>
          label={t('tasks.view')}
          value={view}
          onValueChange={(v) => {
            update({ view: v === 'list' ? null : v });
          }}
          options={[
            { value: 'list', label: t('tasks.view.list'), icon: <List aria-hidden size={14} /> },
            { value: 'board', label: t('tasks.view.board'), icon: <KanbanSquare aria-hidden size={14} /> },
            { value: 'table', label: t('tasks.view.table'), icon: <Table2 aria-hidden size={14} /> },
            { value: 'calendar', label: t('tasks.view.calendar'), icon: <CalendarDays aria-hidden size={14} /> },
            { value: 'gantt', label: t('tasks.view.gantt'), icon: <ChartGantt aria-hidden size={14} /> },
          ]}
        />
        <ViewsMenu
          resource="task"
          activeId={savedViewId}
          onApply={applyView}
          current={{
            viewType: view,
            query: filters.rql,
            sort: filters.sort === DEFAULT_FILTERS.sort ? null : filters.sort,
            config: { ...(swimlane !== 'none' ? { lane: swimlane } : {}), ...(group !== 'none' ? { group } : {}) },
          }}
        />
        <span className="hidden flex-1 md:block" />
        <div className="relative w-full sm:w-56">
          <Search aria-hidden size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
            placeholder={t('tasks.filter.search')}
            aria-label={t('tasks.filter.search')}
            className="h-8 pl-8"
            data-testid="task-search"
          />
        </div>
        <Select
          aria-label={t('tasks.filter.scope')}
          className="h-8 w-44"
          value={filters.scope}
          onValueChange={(v) => { update({ scope: v === 'all' ? null : v }); }}
          options={[
            { value: 'all', label: t('tasks.filter.all') },
            { value: 'mine', label: t('tasks.filter.mine') },
            { value: 'created', label: t('tasks.filter.created') },
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={filters.openOnly} onCheckedChange={(v) => { update({ open: v ? '1' : null }); }} />
          {t('tasks.filter.open')}
        </label>
        {view === 'board' ? (
          <Select
            aria-label={t('tasks.swimlane')}
            className="h-8 w-40"
            value={swimlane}
            onValueChange={(v) => { update({ lane: v === 'none' ? null : v }); }}
            options={[
              { value: 'none', label: t('tasks.swimlane.none') },
              { value: 'assignee', label: t('tasks.group.assignee') },
              { value: 'priority', label: t('tasks.group.priority') },
            ]}
          />
        ) : null}
        {view === 'table' ? (
          <Select
            aria-label={t('tasks.group')}
            className="h-8 w-40"
            value={group}
            onValueChange={(v) => { update({ group: v === 'none' ? null : v }); }}
            options={[
              { value: 'none', label: t('tasks.group.none') },
              { value: 'status', label: t('tasks.group.status') },
              { value: 'assignee', label: t('tasks.group.assignee') },
              { value: 'priority', label: t('tasks.group.priority') },
            ]}
          />
        ) : null}
      </div>

      <div className="flex items-start gap-2 border-b border-line px-4 py-2 md:px-6">
        <FilterBar
          resource="task"
          value={filters.rql}
          onChange={(q) => {
            update({ rql: q || null, sv: null });
          }}
        />
      </div>

      {dated ? (
        view === 'calendar' ? (
          <CalendarView filters={filters} editable={editable} />
        ) : (
          <GanttView filters={filters} editable={editable} />
        )
      ) : list.error ? (
        <ErrorState title={t('common.loadError')} description={t('common.loadErrorBody')} retryLabel={t('common.retry')} onRetry={() => void list.refetch()} />
      ) : loading ? (
        <div className="flex flex-col gap-2 p-4 md:px-6" aria-busy="true">
          <p role="status" className="sr-only">
            {t('common.loading')}
          </p>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : list.tasks.length === 0 ? (
        filtered ? (
          <EmptyState icon={Search} title={t('tasks.emptyFiltered')} description={t('tasks.emptyFilteredBody')} />
        ) : (
          <EmptyState
            icon={CheckSquare}
            title={t('tasks.empty')}
            description={t('tasks.emptyBody')}
            action={
              can('task.create') ? (
                <Button size="sm" icon={<Plus aria-hidden size={14} />} onClick={() => { setNewTaskOpen(true); }}>
                  {t('tasks.new')}
                </Button>
              ) : undefined
            }
          />
        )
      ) : view === 'board' && workflow ? (
        <BoardView
          tasks={list.tasks}
          workflow={workflow}
          names={names}
          swimlane={swimlane}
          editable={editable}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={loadMore}
        />
      ) : view === 'table' ? (
        <TableView
          tasks={list.tasks}
          workflow={workflow}
          names={names}
          selection={selection}
          editable={editable}
          sort={filters.sort}
          onSort={(s) => { update({ sort: s === DEFAULT_FILTERS.sort ? null : s }); }}
          group={group}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={loadMore}
        />
      ) : (
        <ListView
          tasks={list.tasks}
          workflow={workflow}
          names={names}
          selection={selection}
          editable={editable}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={loadMore}
        />
      )}

      {view !== 'board' ? <BulkBar selected={selectedTasks} onClear={selection.clear} workflow={workflow} /> : null}
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksPageInner />
    </Suspense>
  );
}

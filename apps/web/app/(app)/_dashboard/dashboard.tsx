'use client';

import type { DashboardLayout, SlaSummary } from '@flexa/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorState,
  focusRing,
  Skeleton,
  useToast,
} from '@flexa/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { request } from '../../../lib/api';
import { useApp } from '../../../lib/app-context';
import { t, type MessageKey } from '../../../lib/i18n';
import { rk, useAggregate, usePipelines } from '../../../lib/records';
import { statusLabel, useTaskWorkflow } from '../../../lib/tasks';
import { money } from '../crm/_parts/columns';
import { priorityLabel } from '../tasks/_parts/cells';
import { BarList, Funnel, Kpi, PairedColumns } from './charts';
import { Tile, type TileDrag } from './tile';

// Drag-and-drop reordering is needed only in edit mode: loaded when editing starts.
const SortableGrid = lazy(() => import('./sortable-grid').then((m) => ({ default: m.SortableGrid<Widget> })));

type Out<T extends { _output: unknown }> = T['_output'];
type Layout = Out<typeof DashboardLayout>;
type Widget = Layout['widgets'][number];
type Kind = Widget['kind'];

const KINDS: Kind[] = ['kpi_open_tasks', 'kpi_my_tasks', 'kpi_overdue_tasks', 'sla_status', 'tasks_by_status', 'burndown', 'tasks_by_priority', 'pipeline_funnel'];
const MODULE_OF: Partial<Record<Kind, string>> = { pipeline_funnel: 'crm', sla_status: 'automation_sla' };
const DEFAULT_SIZE: Record<Kind, { w: number; h: number }> = {
  kpi_open_tasks: { w: 3, h: 2 },
  kpi_my_tasks: { w: 3, h: 2 },
  kpi_overdue_tasks: { w: 3, h: 2 },
  sla_status: { w: 3, h: 2 },
  tasks_by_status: { w: 6, h: 4 },
  burndown: { w: 6, h: 4 },
  tasks_by_priority: { w: 6, h: 4 },
  pipeline_funnel: { w: 6, h: 4 },
};
const titleOf = (kind: Kind): string => t(`dash.widget.${kind}` as MessageKey);
const OPEN = 'statusCategory != closed';

/** Flow positions (x, y) from the order and sizes, so the saved layout matches what is shown. */
function pack(widgets: Widget[]): Widget[] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return widgets.map((w) => {
    if (x + w.w > 12) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    const placed = { ...w, x, y };
    x += w.w;
    rowH = Math.max(rowH, w.h);
    return placed;
  });
}

function KpiWidget({ q, tone, testId, href }: { q: string; tone?: 'danger'; testId: string; href: string }) {
  const agg = useAggregate('task', { q });
  return (
    <Link href={href} className={cn('block rounded-input text-fg no-underline', focusRing)}>
      <Kpi value={agg.data?.total} {...(tone ? { tone } : {})} testId={testId} />
    </Link>
  );
}

function StatusWidget() {
  const { workflow } = useTaskWorkflow();
  const agg = useAggregate('task', { groupBy: 'status' });
  const order = workflow?.statuses.map((s) => s.key) ?? [];
  const data = (agg.data?.data ?? [])
    .slice()
    .sort((a, b) => order.indexOf(a.key ?? '') - order.indexOf(b.key ?? ''))
    .map((g) => ({ label: statusLabel(workflow?.statuses.find((s) => s.key === g.key)?.label) || (g.key ?? ''), value: g.count }));
  return <BarList title={titleOf('tasks_by_status')} data={data} testId="chart-status" />;
}

function PriorityWidget() {
  const agg = useAggregate('task', { groupBy: 'priority', q: OPEN });
  const data = (agg.data?.data ?? [])
    .slice()
    .sort((a, b) => Number(b.key) - Number(a.key))
    .map((g) => ({ label: priorityLabel(Number(g.key)), value: g.count }));
  return <BarList title={titleOf('tasks_by_priority')} data={data} testId="chart-priority" />;
}

function BurndownWidget() {
  const opened = useAggregate('task', { groupBy: 'created', interval: 'day', q: 'created >= -14d' });
  const closed = useAggregate('task', { groupBy: 'closed', interval: 'day', q: 'closed >= -14d' });
  const days = useMemo(() => {
    const out: string[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push(`${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return out;
  }, []);
  const count = (data: { key: string | null; count: number }[] | undefined, day: string): number => data?.find((g) => g.key === day)?.count ?? 0;
  return (
    <PairedColumns
      title={titleOf('burndown')}
      days={days}
      a={days.map((d) => count(opened.data?.data, d))}
      b={days.map((d) => count(closed.data?.data, d))}
      labels={[t('dash.opened'), t('dash.closed')]}
      testId="chart-burndown"
    />
  );
}

function FunnelWidget() {
  const { tenant } = useApp();
  const pipelines = usePipelines();
  const pipeline = pipelines.data?.data.find((p) => p.isDefault) ?? pipelines.data?.data[0];
  const agg = useAggregate('opportunity', { groupBy: 'status', metric: 'sum:amount', ...(pipeline ? { q: `pipeline = "${pipeline.id}"` } : {}) }, Boolean(pipeline));
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => (a.position < b.position ? -1 : 1)).filter((s) => s.category !== 'closed' || s.probability > 0);
  const data = stages.map((s) => {
    const g = agg.data?.data.find((x) => x.key === s.key);
    return { label: statusLabel(s.label), value: g?.count ?? 0, display: `${String(g?.count ?? 0)} · ${money(g?.sum ?? 0, tenant?.currency ?? 'TRY') || '0'}` };
  });
  return <Funnel title={titleOf('pipeline_funnel')} data={data} testId="chart-funnel" />;
}

function SlaWidget() {
  const q = useQuery({ queryKey: ['sla-summary', 'case'], queryFn: () => request<Out<typeof SlaSummary>>('/v1/sla/summary?recordType=case') });
  return (
    <div className="flex flex-col gap-1">
      <Kpi value={q.data?.breached} tone="danger" testId="kpi-sla" />
      {q.data ? (
        <p className="m-0 text-xs text-fg-muted">
          {q.data.running} · {q.data.paused} · {q.data.met}
        </p>
      ) : null}
    </div>
  );
}

function body(kind: Kind): ReactNode {
  switch (kind) {
    case 'kpi_open_tasks':
      return <KpiWidget q={OPEN} testId="kpi-open" href="/tasks?open=1" />;
    case 'kpi_my_tasks':
      return <KpiWidget q={`assignee = me() AND ${OPEN}`} testId="kpi-mine" href="/tasks?scope=mine&open=1" />;
    case 'kpi_overdue_tasks':
      return <KpiWidget q={`${OPEN} AND due < now()`} tone="danger" testId="kpi-overdue" href={`/tasks?rql=${encodeURIComponent('due < now()')}&open=1`} />;
    case 'tasks_by_status':
      return <StatusWidget />;
    case 'tasks_by_priority':
      return <PriorityWidget />;
    case 'burndown':
      return <BurndownWidget />;
    case 'pipeline_funnel':
      return <FunnelWidget />;
    case 'sla_status':
      return <SlaWidget />;
  }
}

/**
 * Personal dashboard: widgets on a 12-column grid. In edit mode they are reordered by drag (or Space + arrows),
 * resized with buttons and added/removed; the layout is saved per user (`PUT /v1/me/dashboard`).
 */
export function Dashboard() {
  const { nav } = useApp();
  const qc = useQueryClient();
  const { toast } = useToast();
  const layout = useQuery({ queryKey: rk.dashboard, queryFn: () => request<Layout>('/v1/me/dashboard') });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Widget[]>([]);
  const enabled = useMemo(() => new Set(nav?.modules.map((m) => m.id) ?? []), [nav]);
  const available = (k: Kind): boolean => !MODULE_OF[k] || enabled.has(MODULE_OF[k] ?? '');

  useEffect(() => {
    if (layout.data && !editing) setDraft(layout.data.widgets);
  }, [layout.data, editing]);

  const save = useMutation({
    mutationFn: (widgets: Widget[]) => request<Layout>('/v1/me/dashboard', { method: 'PUT', body: { widgets: pack(widgets) } }),
    onSuccess: (data) => {
      qc.setQueryData(rk.dashboard, data);
      setEditing(false);
      toast({ kind: 'success', title: t('dash.saved') });
    },
  });


  if (layout.isLoading) return <Skeleton className="h-64" />;
  if (layout.error) return <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void layout.refetch()} />;
  const widgets = (editing ? draft : (layout.data?.widgets ?? [])).filter((w) => available(w.kind));
  const missing = KINDS.filter((k) => available(k) && !draft.some((w) => w.kind === k));

  const editTile = (w: Widget, drag?: TileDrag): ReactNode => (
    <Tile
      key={w.id}
      widget={w}
      title={titleOf(w.kind)}
      editing
      {...(drag ? { drag } : {})}
      onChange={(next) => { setDraft((list) => list.map((x) => (x.id === next.id ? next : x))); }}
      onRemove={() => { setDraft((list) => list.filter((x) => x.id !== w.id)); }}
    >
      {body(w.kind)}
    </Tile>
  );
  const staticGrid = (edit: boolean): ReactNode => (
    <div className="grid auto-rows-[3.25rem] grid-cols-12 gap-3">
      {widgets.map((w) =>
        edit ? (
          editTile(w)
        ) : (
          <Tile key={w.id} widget={w} title={titleOf(w.kind)} editing={false} onChange={() => undefined} onRemove={() => undefined}>
            {body(w.kind)}
          </Tile>
        ),
      )}
    </div>
  );

  return (
    <section aria-labelledby="dash-h" className="flex flex-col gap-3" data-testid="dashboard">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="dash-h" className="m-0 flex-1 font-display text-lg font-bold">
          {t('dash.title')}
        </h2>
        {editing ? (
          <>
            {missing.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" icon={<Plus aria-hidden size={14} />}>
                    {t('dash.add')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {missing.map((k) => (
                    <DropdownMenuItem key={k} onSelect={() => { setDraft((list) => [...list, { id: k.replaceAll('_', '-').slice(0, 40), kind: k, x: 0, y: 0, ...DEFAULT_SIZE[k] }]); }}>
                      {titleOf(k)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Button variant="ghost" size="sm" icon={<RotateCcw aria-hidden size={14} />} onClick={() => { setDraft(KINDS.filter(available).map((k) => ({ id: k.replaceAll('_', '-'), kind: k, x: 0, y: 0, ...DEFAULT_SIZE[k] }))); }}>
              {t('dash.reset')}
            </Button>
            <Button size="sm" loading={save.isPending} onClick={() => { save.mutate(draft); }} data-testid="dash-done">
              {t('dash.done')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" icon={<Pencil aria-hidden size={14} />} onClick={() => { setEditing(true); }} data-testid="dash-edit">
            {t('dash.edit')}
          </Button>
        )}
      </div>
      {editing ? (
        // Until the drag-and-drop module arrives the same tiles show with their edit controls (no blank frame).
        <Suspense fallback={staticGrid(true)}>
          <SortableGrid widgets={widgets} onChange={setDraft} render={editTile} />
        </Suspense>
      ) : (
        staticGrid(false)
      )}
    </section>
  );
}

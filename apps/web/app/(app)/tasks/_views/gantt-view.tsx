'use client';

import { Badge, cn, focusRing, SegmentedControl, Skeleton, useToast } from '@flexa/ui';
import { Route } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { fmt, formatLocale } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { useDependencyEdges, useTaskList, useUpdateTask, type Task, type TaskFilters } from '../../../../lib/tasks';
import { useMutationErrorToast } from '../_parts/cells';

const DAY = 86_400_000;
const ROW = 36;

interface Bar {
  task: Task;
  start: number; // ms, start of day
  end: number; // ms, exclusive end of day
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};
const daysBetween = (a: number, b: number): number => Math.round((b - a) / DAY);

/** A task's bar: start date → due date (inclusive). A task with only one of them gets a one-day bar. */
function toBar(task: Task): Bar | null {
  const due = task.dueAt ? startOfDay(new Date(task.dueAt).getTime()) : null;
  const start = task.startAt ? startOfDay(new Date(task.startAt).getTime()) : null;
  if (due === null && start === null) return null;
  const s = start ?? due ?? 0;
  const e = Math.max(due ?? s, s);
  return { task, start: s, end: addDays(e, 1) };
}

/**
 * Critical path: the longest chain of dependent tasks by duration (classic CPM on the dependency DAG).
 * Returns the ids on that chain and the edges between them.
 */
export function criticalPath(bars: readonly Bar[], edges: readonly { blockerId: string; blockedId: string }[]): { tasks: Set<string>; edges: Set<string> } {
  const dur = new Map(bars.map((b) => [b.task.id, Math.max(1, daysBetween(b.start, b.end))]));
  const preds = new Map<string, string[]>();
  for (const e of edges) if (dur.has(e.blockerId) && dur.has(e.blockedId)) preds.set(e.blockedId, [...(preds.get(e.blockedId) ?? []), e.blockerId]);
  const best = new Map<string, { len: number; via: string | null }>();
  const visiting = new Set<string>();
  const solve = (id: string): number => {
    const known = best.get(id);
    if (known) return known.len;
    if (visiting.has(id)) return 0; // the API rejects cycles; guard anyway
    visiting.add(id);
    let via: string | null = null;
    let longest = 0;
    for (const p of preds.get(id) ?? []) {
      const l = solve(p);
      if (l > longest) {
        longest = l;
        via = p;
      }
    }
    visiting.delete(id);
    const len = longest + (dur.get(id) ?? 1);
    best.set(id, { len, via });
    return len;
  };
  let endId: string | null = null;
  let max = 0;
  for (const id of dur.keys()) {
    const l = solve(id);
    if (l > max) {
      max = l;
      endId = id;
    }
  }
  const tasks = new Set<string>();
  const crit = new Set<string>();
  // A single task is not a "path"; highlight only chains.
  for (let id = endId; id; id = best.get(id)?.via ?? null) {
    tasks.add(id);
    const via = best.get(id)?.via;
    if (via) crit.add(`${via}>${id}`);
  }
  return tasks.size > 1 ? { tasks, edges: crit } : { tasks: new Set(), edges: new Set() };
}

type Drag = { id: string; mode: 'move' | 'resize'; x0: number; start: number; end: number };

export function GanttView({ filters, editable }: { filters: TaskFilters; editable: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const [scale, setScale] = useState<'days' | 'weeks'>('days');
  const dayWidth = scale === 'days' ? 32 : 12;
  const list = useTaskList({ ...filters, sort: 'start', rql: filters.rql ? `(${filters.rql}) AND (start NOT EMPTY OR due NOT EMPTY)` : 'start NOT EMPTY OR due NOT EMPTY' });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string; start: number; end: number } | null>(null);
  const moved = useRef(false);

  const bars = useMemo(() => list.tasks.map(toBar).filter((b): b is Bar => b !== null), [list.tasks]);
  const ids = useMemo(() => bars.map((b) => b.task.id), [bars]);
  const deps = useDependencyEdges(ids);
  const edges = useMemo(() => deps.data ?? [], [deps.data]);
  const crit = useMemo(() => criticalPath(bars, edges), [bars, edges]);

  const shown = bars.map((b) => (preview?.id === b.task.id ? { ...b, start: preview.start, end: preview.end } : b));
  const min = shown.length ? Math.min(...shown.map((b) => b.start)) : startOfDay(Date.now());
  const max = shown.length ? Math.max(...shown.map((b) => b.end)) : addDays(startOfDay(Date.now()), 14);
  const origin = addDays(min, -3);
  const span = Math.max(21, daysBetween(origin, max) + 7);
  const x = (ms: number): number => daysBetween(origin, ms) * dayWidth;
  const row = new Map(shown.map((b, i) => [b.task.id, i]));
  const dfmt = new Intl.DateTimeFormat(formatLocale(), { day: 'numeric', month: 'short' });

  function save(task: Task, start: number, end: number): void {
    const toIso = (ms: number, endOfDay: boolean): string => {
      const d = new Date(ms);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), endOfDay ? 23 : 9, endOfDay ? 59 : 0).toISOString();
    };
    update.mutate(
      { task, patch: { startAt: toIso(start, false), dueAt: toIso(addDays(end, -1), true) } },
      {
        onSuccess: () => {
          toast({ kind: 'success', title: fmt('gantt.saved', { title: task.title ?? '' }) });
        },
        onError,
      },
    );
  }

  function onPointerDown(e: ReactPointerEvent, bar: Bar, mode: Drag['mode']): void {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    moved.current = false;
    setDrag({ id: bar.task.id, mode, x0: e.clientX, start: bar.start, end: bar.end });
  }

  function onPointerMove(e: ReactPointerEvent): void {
    if (!drag) return;
    const delta = Math.round((e.clientX - drag.x0) / dayWidth);
    if (delta !== 0) moved.current = true;
    if (drag.mode === 'move') setPreview({ id: drag.id, start: addDays(drag.start, delta), end: addDays(drag.end, delta) });
    else setPreview({ id: drag.id, start: drag.start, end: Math.max(addDays(drag.start, 1), addDays(drag.end, delta)) });
  }

  function onPointerUp(): void {
    if (!drag) return;
    const bar = bars.find((b) => b.task.id === drag.id);
    if (bar && preview && moved.current && (preview.start !== bar.start || preview.end !== bar.end)) save(bar.task, preview.start, preview.end);
    setDrag(null);
    setPreview(null);
  }

  function onBarKey(e: KeyboardEvent, bar: Bar): void {
    if (e.key === 'Enter') {
      router.push(`/tasks/${bar.task.id}`);
      return;
    }
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d || !editable) return;
    e.preventDefault();
    if (e.shiftKey) {
      const end = addDays(bar.end, d);
      if (end > bar.start) save(bar.task, bar.start, end);
    } else save(bar.task, addDays(bar.start, d), addDays(bar.end, d));
  }

  if (list.isLoading) return <Skeleton className="mx-4 h-96 md:mx-6" />;

  const height = shown.length * ROW;
  const today = x(startOfDay(Date.now()));
  const ticks = Array.from({ length: span }, (_, i) => addDays(origin, i));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 md:px-6" data-testid="task-gantt">
      <p id="gantt-hint" className="sr-only">
        {t('gantt.barHint')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 font-display text-base font-bold">{t('gantt.title')}</h2>
        {crit.tasks.size > 0 ? (
          <Badge tone="danger" icon={Route} title={t('gantt.criticalHint')} data-testid="critical-legend">
            {t('gantt.critical')}
          </Badge>
        ) : null}
        <span className="flex-1" />
        <SegmentedControl<'days' | 'weeks'>
          label={t('gantt.zoom')}
          value={scale}
          onValueChange={setScale}
          options={[
            { value: 'days', label: t('gantt.days') },
            { value: 'weeks', label: t('gantt.weeks') },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto rounded-card border border-line bg-surface">
        <ul className="sticky left-0 z-20 m-0 w-56 shrink-0 list-none border-r border-line bg-surface p-0 pt-8" aria-label={t('gantt.task')}>
          {shown.map((b) => (
            <li key={b.task.id} className="flex items-center gap-1.5 truncate border-b border-line px-3 text-sm" style={{ height: ROW }}>
              {crit.tasks.has(b.task.id) ? <Route aria-label={t('gantt.critical')} role="img" size={12} className="shrink-0 text-danger" /> : null}
              <span className="truncate">{b.task.title}</span>
            </li>
          ))}
        </ul>
        <div className="relative shrink-0" style={{ width: span * dayWidth, height: height + 32 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="sticky top-0 z-10 flex h-8 border-b border-line bg-subtle" aria-hidden>
            {ticks.map((d) => {
              const date = new Date(d);
              const showLabel = scale === 'days' || date.getDay() === 1;
              return (
                <span key={d} className={cn('shrink-0 border-r border-line text-center text-[10px] leading-8 text-fg-muted', (date.getDay() === 0 || date.getDay() === 6) && 'bg-canvas')} style={{ width: dayWidth }}>
                  {showLabel ? (scale === 'days' ? date.getDate() : dfmt.format(date)) : ''}
                </span>
              );
            })}
          </div>
          <div aria-hidden className="absolute bottom-0 top-8 w-px bg-accent" style={{ left: today }} />
          {/* Dependency arrows: blocker end → blocked start; critical edges in the danger tone. */}
          <svg aria-hidden className="pointer-events-none absolute left-0 top-8" width={span * dayWidth} height={height}>
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--text-secondary)" />
              </marker>
              <marker id="gantt-arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 L8 4 L0 8 z" fill="var(--danger)" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = shown.find((b) => b.task.id === e.blockerId);
              const b = shown.find((bb) => bb.task.id === e.blockedId);
              const ra = row.get(e.blockerId);
              const rb = row.get(e.blockedId);
              if (!a || !b || ra === undefined || rb === undefined) return null;
              const x1 = x(a.end);
              const y1 = ra * ROW + ROW / 2;
              const x2 = x(b.start);
              const y2 = rb * ROW + ROW / 2;
              const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 8));
              const critical = crit.edges.has(`${e.blockerId}>${e.blockedId}`);
              return (
                <path
                  key={`${e.blockerId}-${e.blockedId}`}
                  d={`M${String(x1)} ${String(y1)} H${String(mid)} V${String(y2)} H${String(x2 - 1)}`}
                  fill="none"
                  stroke={critical ? 'var(--danger)' : 'var(--text-secondary)'}
                  strokeWidth={critical ? 2 : 1.25}
                  markerEnd={critical ? 'url(#gantt-arrow-crit)' : 'url(#gantt-arrow)'}
                  data-testid={critical ? 'critical-edge' : 'dependency-edge'}
                />
              );
            })}
          </svg>
          {shown.map((b, i) => {
            const critical = crit.tasks.has(b.task.id);
            const closed = b.task.status?.category === 'closed';
            const label = fmt('gantt.barLabel', { title: b.task.title ?? '', start: dfmt.format(new Date(b.start)), end: dfmt.format(new Date(addDays(b.end, -1))) });
            return (
              <div key={b.task.id} className="absolute" style={{ top: 32 + i * ROW + 6, left: x(b.start), width: Math.max(dayWidth, x(b.end) - x(b.start)), height: ROW - 12 }}>
                <button
                  type="button"
                  aria-label={label}
                  aria-describedby="gantt-hint"
                  data-testid="gantt-bar"
                  data-task-id={b.task.id}
                  data-critical={critical || undefined}
                  onPointerDown={(e) => {
                    onPointerDown(e, b, 'move');
                  }}
                  onClick={() => {
                    if (!moved.current) router.push(`/tasks/${b.task.id}`);
                  }}
                  onKeyDown={(e) => {
                    onBarKey(e, b);
                  }}
                  className={cn(
                    'size-full touch-none truncate rounded-[6px] border px-2 text-left text-xs font-medium',
                    closed ? 'border-line bg-success-soft text-success' : critical ? 'border-danger bg-danger-soft text-danger' : 'border-accent bg-accent-soft text-fg',
                    editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                    focusRing,
                  )}
                >
                  {b.task.title}
                </button>
                {editable ? (
                  <span
                    aria-hidden
                    onPointerDown={(e) => {
                      onPointerDown(e, b, 'resize');
                    }}
                    className="absolute inset-y-0 right-0 w-2 cursor-ew-resize touch-none rounded-r-[6px] hover:bg-accent/30"
                    data-testid="gantt-resize"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

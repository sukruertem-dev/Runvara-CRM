'use client';

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { cn, EmptyState, ErrorState, focusRing, Skeleton, StatusBadge, useToast } from '@flexa/ui';
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { Briefcase } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { ApiError, request } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { messageForCode } from '../../../../lib/errors';
import { fmt } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { rk, useAggregate, usePipelines, useRecordList, type Pipeline, type RecordPage } from '../../../../lib/records';
import { statusLabel, useDirectory } from '../../../../lib/tasks';
import { money, recordName, type CrmRecord } from './columns';

type Stage = Pipeline['stages'][number];

const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

function OppCard({ r, names, overlay = false }: { r: CrmRecord; names: Map<string, string>; overlay?: boolean }) {
  const owner = typeof r['ownerUserId'] === 'string' ? names.get(r['ownerUserId']) : undefined;
  return (
    <div className={cn('flex flex-col gap-1 rounded-input border border-line bg-surface p-3 shadow-card', overlay && 'border-accent shadow-popover')}>
      <span className="text-sm font-medium">{recordName('opportunity', r)}</span>
      <span className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="font-semibold tabular-nums text-fg">{money(r['amount'], r['currency']) || t('pipeline.noAmount')}</span>
        <span className="truncate">{owner ?? ''}</span>
      </span>
    </div>
  );
}

function DraggableOpp({ r, names, onOpen }: { r: CrmRecord; names: Map<string, string>; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: r.id });
  return (
    <li className="list-none">
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        aria-describedby="pipeline-hint"
        data-testid="pipeline-card"
        data-id={r.id}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          listeners?.['onKeyDown']?.(e);
          if (e.key === 'Enter' && !e.defaultPrevented) onOpen();
        }}
        className={cn('rounded-input', focusRing, isDragging && 'opacity-40')}
      >
        <OppCard r={r} names={names} />
      </div>
    </li>
  );
}

function StageColumn({ stage, rows, names, total, currency, onOpen }: { stage: Stage; rows: CrmRecord[]; names: Map<string, string>; total: { sum: number; count: number } | undefined; currency: string; onOpen: (r: CrmRecord) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const sum = total?.sum ?? 0;
  const label = statusLabel(stage.label);
  return (
    <section
      ref={setNodeRef}
      aria-label={fmt('pipeline.stage', { stage: label, count: total?.count ?? rows.length })}
      data-testid="pipeline-stage"
      data-stage-key={stage.key}
      className={cn('flex max-h-full w-72 shrink-0 flex-col rounded-card border border-line bg-subtle', isOver && 'border-accent')}
    >
      <header className="flex flex-col gap-1 px-3 py-2.5">
        <span className="flex items-center gap-2">
          <StatusBadge category={stage.category} colorToken={stage.colorToken} label={label} />
          <span className="text-xs tabular-nums text-fg-muted">%{stage.probability}</span>
          <span className="ml-auto text-xs tabular-nums text-fg-muted">{total?.count ?? rows.length}</span>
        </span>
        {/* Totals come from the API over every opportunity in the stage (in the tenant currency; P9 adds conversion). */}
        <span className="text-sm font-semibold tabular-nums" data-testid="stage-total">
          {fmt('pipeline.total', { amount: money(sum, currency) || '0' })}
        </span>
        <span className="text-xs tabular-nums text-fg-muted">{fmt('pipeline.weighted', { amount: money((sum * stage.probability) / 100, currency) || '0' })}</span>
      </header>
      <ul className="m-0 flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-0">
        {rows.map((r) => (
          <DraggableOpp
            key={r.id}
            r={r}
            names={names}
            onOpen={() => {
              onOpen(r);
            }}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Opportunity pipeline: stages of the default pipeline as columns with total and probability-weighted amounts.
 * Dropping a card moves the opportunity to that stage (workflow transition; optimistic, reverts with a reason).
 */
export function PipelineBoard({ q }: { q: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { tenant } = useApp();
  const currency = tenant?.currency ?? 'TRY';
  const { toast } = useToast();
  const pipelines = usePipelines();
  const pipeline = pipelines.data?.data.find((p) => p.isDefault) ?? pipelines.data?.data[0];
  const scoped = pipeline ? `pipeline = "${pipeline.id}"` : '';
  const query = [scoped, q ? `(${q})` : ''].filter(Boolean).join(' AND ');
  const params = useMemo(() => ({ ...(query ? { q: query } : {}), sort: '-updated', limit: '200' }), [query]);
  const list = useRecordList<CrmRecord>('opportunity', params, Boolean(pipeline));
  const totals = useAggregate('opportunity', { groupBy: 'status', metric: 'sum:amount', ...(query ? { q: query } : {}) }, Boolean(pipeline));
  const names = useDirectory(useMemo(() => list.rows.map((r) => (typeof r['ownerUserId'] === 'string' ? r['ownerUserId'] : null)), [list.rows]));
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const stages = useMemo(() => [...(pipeline?.stages ?? [])].sort((a, b) => (a.position < b.position ? -1 : 1)), [pipeline]);
  const byStage = useMemo(() => {
    const m = new Map<string, CrmRecord[]>();
    for (const r of list.rows) {
      const id = (r['status'] as { id?: string } | undefined)?.id ?? '';
      m.set(id, [...(m.get(id) ?? []), r]);
    }
    return m;
  }, [list.rows]);
  const totalByKey = useMemo(() => new Map((totals.data?.data ?? []).map((g) => [g.key ?? '', { sum: Number(g.sum ?? 0), count: g.count }])), [totals.data]);

  const move = useMutation({
    mutationFn: ({ r, stage }: { r: CrmRecord; stage: Stage }) => request<CrmRecord>(`/v1/opportunities/${r.id}/transition`, { method: 'POST', body: { toStatusId: stage.id } }),
    onMutate: ({ r, stage }) => {
      const snap = qc.getQueriesData({ queryKey: rk.recordLists('opportunity') });
      // Same tick as the drop, then again after cancelling in-flight lists (a cancel may revert the cache).
      const apply = (): void => {
        qc.setQueriesData<InfiniteData<RecordPage<CrmRecord>>>({ queryKey: rk.recordLists('opportunity') }, (data) =>
          data
            ? { ...data, pages: data.pages.map((p) => ({ ...p, data: p.data.map((x) => (x.id === r.id ? { ...x, status: { id: stage.id, key: stage.key, category: stage.category, label: stage.label, colorToken: stage.colorToken } } : x)) })) }
            : data,
        );
      };
      apply();
      void qc.cancelQueries({ queryKey: rk.recordLists('opportunity') }).then(apply);
      return { snap };
    },
    onError: (err, _v, ctx) => {
      for (const [key, data] of ctx?.snap ?? []) qc.setQueryData(key, data);
      toast({ kind: 'error', title: t('common.saveFailed'), description: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['aggregate', 'opportunity'] });
      void qc.invalidateQueries({ queryKey: rk.recordLists('opportunity') });
    },
  });

  const stageIds = useRef<string[]>([]);
  stageIds.current = stages.map((s) => s.id);
  const rowsRef = useRef(list.rows);
  rowsRef.current = list.rows;
  const coordinateGetter = useRef<KeyboardCoordinateGetter>((event, { context }) => {
    const d = event.code === 'ArrowRight' ? 1 : event.code === 'ArrowLeft' ? -1 : 0;
    if (!d) return undefined;
    event.preventDefault();
    const ids = stageIds.current;
    const cur = context.over?.id ? String(context.over.id) : ((rowsRef.current.find((x) => x.id === context.active?.id)?.['status'] as { id?: string } | undefined)?.id ?? '');
    const next = ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(cur) + d))];
    const rect = next ? context.droppableRects.get(next) : undefined;
    return rect ? { x: rect.left + 8, y: rect.top + 8 } : undefined;
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: coordinateGetter.current, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } }),
  );

  const nameOf = (id: UniqueIdentifier | null): string => (() => { const r = list.rows.find((x) => x.id === id); return r ? recordName('opportunity', r) : ''; })();
  const stageOf = (id: UniqueIdentifier | null | undefined): string => statusLabel(stages.find((s) => s.id === id)?.label);
  const announcements: Announcements = {
    onDragStart: ({ active }) => nameOf(active.id),
    onDragOver: ({ active, over }) => (over ? fmt('pipeline.moved', { name: nameOf(active.id), stage: stageOf(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? fmt('pipeline.moved', { name: nameOf(active.id), stage: stageOf(over.id) }) : t('tasks.board.cancelled')),
    onDragCancel: () => t('tasks.board.cancelled'),
  };

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    const r = list.rows.find((x) => x.id === e.active.id);
    const stage = stages.find((s) => s.id === e.over?.id);
    if (!r || !stage || (r['status'] as { id?: string } | undefined)?.id === stage.id) return;
    move.mutate({ r, stage });
  }

  if (pipelines.isLoading || list.isLoading) return <Skeleton className="mx-4 h-96 md:mx-6" />;
  if (!pipeline) return <EmptyState icon={Briefcase} title={t('pipeline.empty')} />;
  if (list.error) return <ErrorState title={t('common.loadError')} retryLabel={t('common.retry')} onRetry={() => void list.refetch()} />;
  const active = list.rows.find((x) => x.id === activeId);
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(e) => { setActiveId(e.active.id); }}
      onDragEnd={onDragEnd}
      onDragCancel={() => { setActiveId(null); }}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('tasks.board.dragHint') } }}
    >
      <p id="pipeline-hint" className="sr-only">
        {t('tasks.board.dragHint')}
      </p>
      <div className="flex min-h-0 flex-1 gap-3 overflow-auto p-4 md:px-6" data-testid="pipeline-board">
        {stages.map((s) => (
          <StageColumn key={s.id} stage={s} rows={byStage.get(s.id) ?? []} names={names} total={totalByKey.get(s.key)} currency={currency} onOpen={(r) => { router.push(`/crm/opportunity/${r.id}`); }} />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{active ? <OppCard r={active} names={names} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

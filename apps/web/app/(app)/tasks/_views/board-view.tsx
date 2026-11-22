'use client';

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Badge, Button, cn, PriorityBadge, StatusBadge } from '@flexa/ui';
import { TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { fmt } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { patchTaskInCache, statusLabel, useMoveTask, useUpdateTask, type Task, type Workflow, type WorkflowStatus } from '../../../../lib/tasks';
import { useQueryClient } from '@tanstack/react-query';
import { AssigneeCell, DueCell, priorityLabel, useMutationErrorToast } from '../_parts/cells';

export type Swimlane = 'none' | 'assignee' | 'priority';

interface Lane {
  key: string;
  label: string;
  /** Field value a card takes when dropped into this lane. */
  value: { assigneeUserId: string | null } | { priority: number } | null;
}

/** Pointer drags target what is under the pointer; keyboard drags (no pointer) the area the card overlaps most.
 *  Corner distance alone picks the card's own column when the neighbour column is tall and empty. */
const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

const SEP = '::';
const containerId = (lane: string, statusId: string): string => `${lane}${SEP}${statusId}`;
const parseContainer = (id: string): { lane: string; statusId: string } => {
  const [lane = '', statusId = ''] = id.split(SEP);
  return { lane, statusId };
};

const byPosition = (a: Task, b: Task): number => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0);

function laneOf(task: Task, swimlane: Swimlane): string {
  if (swimlane === 'assignee') return task.assigneeUserId ?? 'none';
  if (swimlane === 'priority') return String(task.priority ?? 0);
  return 'all';
}

function Card({ task, names, overlay = false }: { task: Task; names: Map<string, string>; overlay?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-2 rounded-input border border-line bg-surface p-3 text-left shadow-card', overlay && 'rotate-1 border-accent shadow-popover')}>
      <span className="text-sm font-medium text-fg">{task.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={task.priority ?? 0} label={priorityLabel(task.priority ?? 0)} />
        <DueCell task={task} />
        <span className="ml-auto">
          <AssigneeCell id={task.assigneeUserId} names={names} compact />
        </span>
      </span>
    </div>
  );
}

function SortableCard({ task, names, onOpen }: { task: Task; names: Map<string, string>; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  // The list item stays a plain <li>; the draggable (role="button" from dnd-kit) lives inside it.
  return (
    <li className="list-none">
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        className={cn('rounded-input outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent', isDragging && 'opacity-40')}
        data-testid="board-card"
        data-task-id={task.id}
        {...attributes}
        {...listeners}
        aria-roledescription={t('tasks.view.board')}
        aria-describedby="board-drag-hint"
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          listeners?.['onKeyDown']?.(e);
          if (e.key === 'Enter' && !e.defaultPrevented) onOpen();
        }}
      >
        <Card task={task} names={names} />
      </div>
    </li>
  );
}

function Column({
  id,
  status,
  tasks,
  total,
  names,
  onOpen,
}: {
  id: string;
  status: WorkflowStatus;
  tasks: Task[];
  total: number;
  names: Map<string, string>;
  onOpen: (task: Task) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const limit = status.wipLimit;
  const exceeded = limit !== null && total > limit;
  const label = statusLabel(status.label);
  return (
    <section
      aria-label={fmt('tasks.board.column', { status: label, count: tasks.length })}
      className={cn('flex w-72 shrink-0 flex-col rounded-card border border-line bg-subtle', isOver && 'border-accent', exceeded && 'border-warning')}
      data-testid="board-column"
      data-status-key={status.key}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <StatusBadge category={status.category} colorToken={status.colorToken} label={label} />
        <span className="text-xs tabular-nums text-fg-muted" data-testid="column-count">
          {tasks.length}
        </span>
        {limit !== null ? (
          exceeded ? (
            <Badge tone="warning" icon={TriangleAlert} className="ml-auto" data-testid="wip-exceeded">
              {fmt('tasks.wip', { count: total, limit })}
              <span className="sr-only">{fmt('tasks.wipExceeded', { count: total, limit })}</span>
            </Badge>
          ) : (
            <span className="ml-auto text-xs tabular-nums text-fg-muted">{fmt('tasks.wip', { count: total, limit })}</span>
          )
        ) : null}
      </header>
      <SortableContext id={id} items={tasks.map((x) => x.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="m-0 flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto p-2 pt-0">
          {tasks.map((task) => (
            <SortableCard
              key={task.id}
              task={task}
              names={names}
              onOpen={() => {
                onOpen(task);
              }}
            />
          ))}
        </ul>
      </SortableContext>
    </section>
  );
}

/**
 * Kanban: workflow statuses are columns. Drop = optimistic cache move (the card is in its new column in the
 * same frame) + POST /move; a refusal snaps it back with the reason. Keyboard: Space to lift, arrows, Space
 * to drop (dnd-kit keyboard sensor, announcements in Turkish). Cards across swimlanes take the lane's value.
 */
export function BoardView({
  tasks,
  workflow,
  names,
  swimlane,
  editable,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  tasks: Task[];
  workflow: Workflow;
  names: Map<string, string>;
  swimlane: Swimlane;
  editable: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const move = useMoveTask();
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  // Left/Right jump to the neighbouring status column of the same lane; Up/Down reorder within a column.
  const columnStep = useRef<(fromId: UniqueIdentifier, delta: number) => string | null>(() => null);
  const coordinateGetter = useRef<KeyboardCoordinateGetter>((event, args) => {
    const delta = event.code === 'ArrowRight' ? 1 : event.code === 'ArrowLeft' ? -1 : 0;
    if (delta !== 0) {
      const { over, active, droppableRects } = args.context;
      const target = columnStep.current(over?.id ?? active?.id ?? '', delta);
      const rect = target ? droppableRects.get(target) : undefined;
      event.preventDefault();
      return rect ? { x: rect.left, y: rect.top } : undefined;
    }
    return sortableKeyboardCoordinates(event, args);
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space lifts and drops (as the on-screen hint says); Enter stays free to open the card.
    useSensor(KeyboardSensor, { coordinateGetter: coordinateGetter.current, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } }),
  );

  const lanes: Lane[] = useMemo(() => {
    if (swimlane === 'assignee') {
      const ids = [...new Set(tasks.map((x) => x.assigneeUserId ?? null))];
      return ids
        .map((id) => ({ key: id ?? 'none', label: id ? (names.get(id) ?? t('common.unknownUser')) : t('common.unassigned'), value: { assigneeUserId: id } }))
        .sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : a.label.localeCompare(b.label, 'tr')));
    }
    if (swimlane === 'priority') return [4, 3, 2, 1, 0].map((p) => ({ key: String(p), label: priorityLabel(p), value: { priority: p } }));
    return [{ key: 'all', label: '', value: null }];
  }, [swimlane, tasks, names]);

  const containers = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const lane of lanes) for (const s of workflow.statuses) map.set(containerId(lane.key, s.id), []);
    for (const task of tasks) {
      const key = containerId(laneOf(task, swimlane), task.status?.id ?? '');
      map.get(key)?.push(task);
    }
    for (const list of map.values()) list.sort(byPosition);
    return map;
  }, [lanes, workflow.statuses, tasks, swimlane]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const task of tasks) m.set(task.status?.id ?? '', (m.get(task.status?.id ?? '') ?? 0) + 1);
    return m;
  }, [tasks]);

  const findContainer = (id: UniqueIdentifier): string | null => {
    const key = String(id);
    if (containers.has(key)) return key;
    for (const [c, list] of containers) if (list.some((x) => x.id === key)) return c;
    return null;
  };
  columnStep.current = (fromId, delta) => {
    const from = findContainer(fromId);
    if (!from) return null;
    const { lane, statusId } = parseContainer(from);
    const i = workflow.statuses.findIndex((x) => x.id === statusId);
    const next = workflow.statuses[i + delta];
    return next ? containerId(lane, next.id) : null;
  };
  const taskById = (id: UniqueIdentifier | null): Task | undefined => (id === null ? undefined : tasks.find((x) => x.id === String(id)));
  const statusName = (container: string | null): string => {
    const s = workflow.statuses.find((x) => x.id === (container ? parseContainer(container).statusId : ''));
    return s ? statusLabel(s.label) : '';
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => fmt('tasks.board.picked', { title: taskById(active.id)?.title ?? '' }),
    onDragOver: ({ active, over }) => (over ? fmt('tasks.board.over', { title: taskById(active.id)?.title ?? '', status: statusName(findContainer(over.id)) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? fmt('tasks.board.dropped', { title: taskById(active.id)?.title ?? '', status: statusName(findContainer(over.id)) }) : t('tasks.board.cancelled')),
    onDragCancel: () => t('tasks.board.cancelled'),
  };

  function onDragStart(e: DragStartEvent): void {
    setActiveId(e.active.id);
  }

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    const task = taskById(e.active.id);
    if (!task || !e.over) return;
    const from = findContainer(e.active.id);
    const to = findContainer(e.over.id);
    if (!from || !to) return;
    const target = parseContainer(to);
    const status = workflow.statuses.find((s) => s.id === target.statusId);
    if (!status) return;

    // Final order of the target column with the card in place.
    const list = (containers.get(to) ?? []).filter((x) => x.id !== task.id);
    const overIndex = list.findIndex((x) => x.id === String(e.over?.id));
    const originalIndex = (containers.get(from) ?? []).findIndex((x) => x.id === task.id);
    let index = overIndex === -1 ? list.length : overIndex;
    // Moving down inside the same column: the card lands below the item it is over.
    if (from === to && overIndex !== -1 && originalIndex <= overIndex) index = overIndex + 1;
    if (from === to && index === originalIndex) return;
    const beforeId = list[index - 1]?.id ?? null;
    const afterId = list[index]?.id ?? null;

    const lane = lanes.find((l) => l.key === target.lane);
    const laneChanged = parseContainer(from).lane !== target.lane && lane?.value;
    if (laneChanged && lane.value) {
      const patch = lane.value;
      patchTaskInCache(qc, task.id, (x) => ({ ...x, ...patch }));
    }
    move.mutate(
      { task, toStatus: status, beforeId, afterId },
      {
        onSuccess: (moved) => {
          if (laneChanged && lane.value) update.mutate({ task: moved, patch: lane.value }, { onError });
        },
        onError,
      },
    );
  }

  const active = taskById(activeId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p id="board-drag-hint" className="sr-only">
        {t('tasks.board.dragHint')}
      </p>
      <DndContext
        sensors={editable ? sensors : []}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => { setActiveId(null); }}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('tasks.board.dragHint') } }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 md:px-6" data-testid="task-board">
          {lanes.map((lane) => (
            // Without swimlanes the single lane fills the height and each column scrolls on its own.
            <div key={lane.key} className={cn('flex flex-col gap-2', swimlane === 'none' && 'min-h-0 flex-1')}>
              {swimlane !== 'none' ? <h3 className="m-0 text-sm font-semibold text-fg-muted">{lane.label}</h3> : null}
              <div className={cn('flex items-stretch gap-3', swimlane === 'none' && 'min-h-0 flex-1 [&>section]:max-h-full')}>
                {workflow.statuses.map((s) => {
                  const id = containerId(lane.key, s.id);
                  return (
                    <Column key={id} id={id} status={s} tasks={containers.get(id) ?? []} total={totals.get(s.id) ?? 0} names={names} onOpen={(x) => { router.push(`/tasks/${x.id}`); }} />
                  );
                })}
              </div>
            </div>
          ))}
          {hasMore ? (
            <div>
              <Button variant="secondary" size="sm" onClick={onLoadMore} loading={loadingMore}>
                {t('common.more')}
              </Button>
            </div>
          ) : null}
        </div>
        <DragOverlay dropAnimation={null}>{active ? <Card task={active} names={names} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

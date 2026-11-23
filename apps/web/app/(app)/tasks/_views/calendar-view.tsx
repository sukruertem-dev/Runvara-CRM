'use client';

import {
  MeasuringStrategy,
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
import { Button, cn, focusRing, IconButton, SegmentedControl, Skeleton, useToast } from '@flexa/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { fmt } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { useTaskList, useUpdateTask, type Task, type TaskFilters } from '../../../../lib/tasks';
import { useMutationErrorToast } from '../_parts/cells';

const MEASURING = { droppable: { strategy: MeasuringStrategy.BeforeDragging } };

export type CalendarMode = 'month' | 'week' | 'day';

const LOCALE = 'tr-TR';

const pad = (n: number): string => String(n).padStart(2, '0');
export const dayKey = (d: Date): string => `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k: string): Date => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Monday of the week containing `d`. */
const startOfWeek = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));

/** Visible days for a mode around an anchor date. */
export function calendarDays(mode: CalendarMode, anchor: Date): Date[] {
  if (mode === 'day') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i));
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** Same time of day on another date (the task keeps its hour; ADR-0020: times are instants). */
function moveToDay(iso: string, day: string): string {
  const src = new Date(iso);
  const d = fromKey(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), src.getHours(), src.getMinutes(), src.getSeconds()).toISOString();
}

function Chip({ task, overlay = false }: { task: Task; overlay?: boolean }) {
  const closed = task.status?.category === 'closed';
  return (
    <span
      className={cn(
        'block truncate rounded-[6px] border-l-2 bg-surface px-1.5 py-0.5 text-left text-xs text-fg shadow-card',
        closed ? 'border-success text-fg-muted line-through' : (task.priority ?? 0) >= 3 ? 'border-danger' : 'border-accent',
        overlay && 'shadow-popover',
      )}
    >
      {task.title}
    </span>
  );
}

function DraggableChip({ task, onOpen, editable }: { task: Task; onOpen: () => void; editable: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: !editable });
  return (
    <li className="list-none">
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        aria-describedby="cal-drag-hint"
        data-testid="calendar-chip"
        data-task-id={task.id}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          listeners?.['onKeyDown']?.(e);
          if (e.key === 'Enter' && !e.defaultPrevented) onOpen();
        }}
        className={cn('rounded-[6px]', focusRing, isDragging && 'opacity-40')}
      >
        <Chip task={task} />
      </div>
    </li>
  );
}

function DayCell({ day, tasks, inMonth, mode, editable, onOpen, today }: { day: Date; tasks: Task[]; inMonth: boolean; mode: CalendarMode; editable: boolean; onOpen: (task: Task) => void; today: string }) {
  const id = dayKey(day);
  const { setNodeRef, isOver } = useDroppable({ id });
  const limit = mode === 'month' ? 3 : 50;
  const label = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }).format(day);
  return (
    <section
      ref={setNodeRef}
      aria-label={fmt('cal.day.label', { date: label, count: tasks.length })}
      data-testid="calendar-day"
      data-day={id}
      className={cn(
        'flex min-h-0 flex-col gap-1 border-b border-r border-line p-1.5',
        mode === 'month' ? 'min-h-24' : 'min-h-64',
        inMonth ? 'bg-surface' : 'bg-subtle',
        isOver && 'bg-accent-soft',
      )}
    >
      <span className={cn('inline-flex size-6 items-center justify-center self-end rounded-full text-xs tabular-nums', id === today ? 'bg-primary font-semibold text-on-primary' : inMonth ? 'text-fg' : 'text-fg-muted')}>{day.getDate()}</span>
      <ul className="m-0 flex flex-col gap-1 p-0">
        {tasks.slice(0, limit).map((task) => (
          <DraggableChip
            key={task.id}
            task={task}
            editable={editable}
            onOpen={() => {
              onOpen(task);
            }}
          />
        ))}
      </ul>
      {tasks.length > limit ? <span className="px-1 text-xs text-fg-muted">{fmt('cal.more', { count: tasks.length - limit })}</span> : null}
    </section>
  );
}

/**
 * Calendar of due dates: month / week / day. Dragging a task (mouse, touch, or Space + arrows + Space) to another
 * day moves its due date to that day at the same time; the change is optimistic and reverts with a reason.
 */
/** Pointer drags use what is under the pointer; keyboard drags the day the chip overlaps most. */
const collision: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

export function CalendarView({ filters, editable }: { filters: TaskFilters; editable: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const [mode, setMode] = useState<CalendarMode>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const days = useMemo(() => calendarDays(mode, anchor), [mode, anchor]);
  const first = days[0] ?? anchor;
  const end = addDays(days.at(-1) ?? anchor, 1);
  const range = `due >= ${dayKey(first)} AND due < ${dayKey(end)}`;
  const list = useTaskList({ ...filters, sort: 'due', rql: filters.rql ? `(${filters.rql}) AND ${range}` : range });
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const task of list.tasks) {
      if (!task.dueAt) continue;
      const k = dayKey(new Date(task.dueAt));
      m.set(k, [...(m.get(k) ?? []), task]);
    }
    return m;
  }, [list.tasks]);
  const today = dayKey(new Date());

  // Arrow keys jump a day (left/right) or a week (up/down) while a task is lifted.
  const dayIds = useRef<string[]>([]);
  dayIds.current = days.map(dayKey);
  const live = useRef({ mode, tasks: list.tasks });
  live.current = { mode, tasks: list.tasks };
  const coordinateGetter = useRef<KeyboardCoordinateGetter>((event, { context }) => {
    const week = live.current.mode === 'month';
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: week ? -7 : -1, ArrowDown: week ? 7 : 1 }[event.code];
    if (step === undefined) return undefined;
    event.preventDefault();
    const ids = dayIds.current;
    const current = context.over?.id ? String(context.over.id) : (() => {
      const task = live.current.tasks.find((x) => x.id === context.active?.id);
      return task?.dueAt ? dayKey(new Date(task.dueAt)) : ids[0];
    })();
    const i = Math.max(0, Math.min(ids.length - 1, ids.indexOf(current ?? '') + step));
    // Days may not be measured yet right after pick-up: fall back to the DOM.
    const rect = context.droppableRects.get(ids[i] ?? '') ?? context.droppableContainers.get(ids[i] ?? '')?.node.current?.getBoundingClientRect();
    return rect ? { x: rect.left + 4, y: rect.top + 4 } : undefined;
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: coordinateGetter.current, keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] } }),
  );

  const title = (id: UniqueIdentifier | null): string => list.tasks.find((x) => x.id === id)?.title ?? '';
  const dateLabel = (id: UniqueIdentifier | null | undefined): string => (id ? new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' }).format(fromKey(String(id))) : '');
  const announcements: Announcements = {
    onDragStart: ({ active }) => title(active.id),
    onDragOver: ({ active, over }) => (over ? fmt('cal.moved', { title: title(active.id), date: dateLabel(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? fmt('cal.moved', { title: title(active.id), date: dateLabel(over.id) }) : t('tasks.board.cancelled')),
    onDragCancel: () => t('tasks.board.cancelled'),
  };

  function onDragEnd(e: DragEndEvent): void {
    setActiveId(null);
    const task = list.tasks.find((x) => x.id === e.active.id);
    if (!task?.dueAt || !e.over) return;
    const day = String(e.over.id);
    if (dayKey(new Date(task.dueAt)) === day) return;
    const dueAt = moveToDay(task.dueAt, day);
    // A start date after the new due date would be invalid: shift it by the same amount.
    const shift = new Date(dueAt).getTime() - new Date(task.dueAt).getTime();
    const startAt = task.startAt ? new Date(new Date(task.startAt).getTime() + shift).toISOString() : undefined;
    update.mutate(
      { task, patch: { dueAt, ...(startAt ? { startAt } : {}) } },
      {
        onSuccess: () => {
          toast({ kind: 'success', title: fmt('cal.moved', { title: task.title ?? '', date: dateLabel(day) }) });
        },
        onError,
      },
    );
  }

  const step = (dir: -1 | 1): void => {
    setAnchor((a) => (mode === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, dir * (mode === 'week' ? 7 : 1))));
  };
  const heading = new Intl.DateTimeFormat(LOCALE, mode === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' }).format(mode === 'week' ? first : anchor);
  const active = list.tasks.find((x) => x.id === activeId);
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }).format(d));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4 md:px-6" data-testid="task-calendar">
      <p id="cal-drag-hint" className="sr-only">
        {t('cal.dragHint')}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <IconButton label={t('cal.prev')} size="sm" onClick={() => { step(-1); }}>
          <ChevronLeft aria-hidden size={16} />
        </IconButton>
        <IconButton label={t('cal.next')} size="sm" onClick={() => { step(1); }}>
          <ChevronRight aria-hidden size={16} />
        </IconButton>
        <Button variant="secondary" size="sm" onClick={() => { setAnchor(new Date()); }}>
          {t('cal.today')}
        </Button>
        <h2 className="m-0 font-display text-base font-bold capitalize" aria-live="polite" data-testid="calendar-heading">
          {heading}
        </h2>
        <span className="flex-1" />
        <SegmentedControl<CalendarMode>
          label={t('cal.range')}
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'month', label: t('cal.month') },
            { value: 'week', label: t('cal.week') },
            { value: 'day', label: t('cal.day') },
          ]}
        />
      </div>
      {list.isLoading ? (
        <Skeleton className="h-96" />
      ) : (
        <DndContext
          sensors={editable ? sensors : []}
          collisionDetection={collision}
          // Measure the drop targets before the drag starts: a key press right after pick-up must find them.
          measuring={MEASURING}
          onDragStart={(e) => { setActiveId(e.active.id); }}
          onDragEnd={onDragEnd}
          onDragCancel={() => { setActiveId(null); }}
          accessibility={{ announcements, screenReaderInstructions: { draggable: t('cal.dragHint') } }}
        >
          <div className="min-h-0 flex-1 overflow-auto rounded-card border-l border-t border-line">
            {mode !== 'day' ? (
              <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-r border-line bg-subtle text-xs font-medium text-fg-muted" aria-hidden>
                {weekdays.map((w) => (
                  <span key={w} className="px-2 py-1.5 capitalize">
                    {w}
                  </span>
                ))}
              </div>
            ) : null}
            <div className={cn('grid', mode === 'day' ? 'grid-cols-1' : 'grid-cols-7')}>
              {days.map((d) => (
                <DayCell
                  key={dayKey(d)}
                  day={d}
                  tasks={byDay.get(dayKey(d)) ?? []}
                  inMonth={mode !== 'month' || d.getMonth() === anchor.getMonth()}
                  mode={mode}
                  editable={editable}
                  today={today}
                  onOpen={(task) => { router.push(`/tasks/${task.id}`); }}
                />
              ))}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>{active ? <Chip task={active} overlay /> : null}</DragOverlay>
        </DndContext>
      )}
      <p className="m-0 text-xs text-fg-muted">{t('cal.noDate')}</p>
    </div>
  );
}

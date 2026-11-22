'use client';

import { Checkbox, cn, Spinner } from '@flexa/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { isInteractiveTarget, useHotkeys } from '../../../../lib/hotkeys';
import { t } from '../../../../lib/i18n';
import type { Task, Workflow } from '../../../../lib/tasks';
import { AssigneeCell, DueCell, InlineTitle, PriorityCell, StatusCell } from '../_parts/cells';

export interface SelectionApi {
  selected: ReadonlySet<string>;
  toggle: (id: string, range?: boolean) => void;
  setMany: (ids: string[], on: boolean) => void;
}

/**
 * Virtualised list (10 000+ rows stay smooth: only the visible rows are in the DOM). J/K move, Enter opens,
 * X selects; Shift+click selects a range; title and priority edit in place.
 */
export function ListView({
  tasks,
  workflow,
  names,
  selection,
  editable,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  tasks: Task[];
  workflow: Workflow | undefined;
  names: Map<string, string>;
  selection: SelectionApi;
  editable: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const router = useRouter();
  const parent = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const rowHeight = useRowHeight();
  const mounted = useMounted();

  const virtualizer = useVirtualizer({ enabled: mounted, count: tasks.length + (hasMore ? 1 : 0), getScrollElement: () => parent.current, estimateSize: () => rowHeight, overscan: 12 });
  const items = virtualizer.getVirtualItems();
  const last = items.at(-1);

  useEffect(() => {
    if (last && last.index >= tasks.length - 1 && hasMore && !loadingMore) onLoadMore();
  }, [last, tasks.length, hasMore, loadingMore, onLoadMore]);

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const move = (delta: number): void => {
    setActive((i) => {
      const next = Math.max(0, Math.min(tasks.length - 1, i + delta));
      virtualizer.scrollToIndex(next, { align: 'auto' });
      return next;
    });
  };

  const free = (e: KeyboardEvent): boolean => !isInteractiveTarget(e.target);
  useHotkeys([
    { key: 'j', handler: () => { move(1); } },
    { key: 'k', handler: () => { move(-1); } },
    { key: 'ArrowDown', when: free, handler: () => { move(1); } },
    { key: 'ArrowUp', when: free, handler: () => { move(-1); } },
    {
      key: 'Enter',
      when: free,
      handler: () => {
        const task = tasks[active];
        if (task) router.push(`/tasks/${task.id}`);
      },
    },
    {
      key: 'x',
      when: free,
      handler: () => {
        const task = tasks[active];
        if (task) selection.toggle(task.id);
      },
    },
  ]);

  function onRowClick(e: MouseEvent, index: number, id: string): void {
    setActive(index);
    if (e.shiftKey) selection.toggle(id, true);
  }

  return (
    <div
      ref={parent}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="task-list"
      role="list"
      aria-label={t('tasks.title')}
      data-count={tasks.length}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((v) => {
          const task = tasks[v.index];
          if (!task) {
            return (
              <div key="more" role="listitem" className="absolute inset-x-0 flex items-center justify-center gap-2 text-sm text-fg-muted" style={{ top: v.start, height: v.size }}>
                <Spinner /> {t('tasks.loadingMore')}
              </div>
            );
          }
          const isActive = v.index === active;
          const isSelected = selection.selected.has(task.id);
          return (
            <div
              key={task.id}
              role="listitem"
              aria-posinset={v.index + 1}
              aria-setsize={tasks.length}
              aria-current={isActive ? 'true' : undefined}
              data-index={v.index}
              data-testid="task-row"
              onClick={(e) => {
                onRowClick(e, v.index, task.id);
              }}
              className={cn(
                'group absolute inset-x-0 flex items-center gap-3 border-b border-line px-4 md:px-6',
                isSelected ? 'bg-accent-soft' : 'bg-surface hover:bg-subtle',
                isActive && 'shadow-[inset_2px_0_0_var(--accent)]',
              )}
              style={{ top: v.start, height: v.size }}
            >
              <Checkbox
                checked={isSelected}
                aria-label={t('tasks.select', { title: task.title ?? '' })}
                onClick={(e) => {
                  e.stopPropagation();
                  selection.toggle(task.id, e.shiftKey);
                }}
              />
              <span className="hidden w-32 shrink-0 sm:block">
                <StatusCell task={task} workflow={workflow} editable={editable} />
              </span>
              <InlineTitle task={task} editable={editable} className="min-w-0 flex-1" onOpen={() => { router.push(`/tasks/${task.id}`); }} />
              <span className="hidden w-24 shrink-0 md:block">
                <PriorityCell task={task} editable={editable} />
              </span>
              <span className="hidden w-40 shrink-0 lg:block">
                <AssigneeCell id={task.assigneeUserId} names={names} />
              </span>
              <span className="w-24 shrink-0 text-right">
                <DueCell task={task} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Measuring starts after mount: the virtualizer must not update state while the view is still rendering. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

/** Row height follows the density token (Rahat 40 px / Kompakt 32 px). */
export function useRowHeight(): number {
  const [h, setH] = useState(40);
  useEffect(() => {
    const read = (): void => {
      const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10);
      setH(Number.isFinite(v) && v > 0 ? v + 4 : 44);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-density'] });
    return () => {
      obs.disconnect();
    };
  }, []);
  return h;
}

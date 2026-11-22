'use client';

import {
  Avatar,
  Badge,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  focusRing,
  PriorityBadge,
  StatusBadge,
  useToast,
} from '@flexa/ui';
import { CalendarClock, CircleAlert, Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../../../../lib/api';
import { messageForCode } from '../../../../lib/errors';
import { dueLabel } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import { statusLabel, useTransition, useUpdateTask, type Task, type Workflow } from '../../../../lib/tasks';

export const PRIORITY_KEYS = [0, 1, 2, 3, 4] as const;
export const priorityLabel = (p: number): string => t(`tasks.priority.${Math.max(0, Math.min(4, p)) as 0 | 1 | 2 | 3 | 4}`);

/** Shows API refusals (403, 412, workflow rules) as a toast with the reason in words. */
export function useMutationErrorToast(): (err: unknown) => void {
  const { toast } = useToast();
  return (err) => {
    toast({ kind: 'error', title: t('common.saveFailed'), description: err instanceof ApiError ? messageForCode(err.code) : t('error.fallback') });
  };
}

export function StatusCell({ task, workflow, editable }: { task: Task; workflow: Workflow | undefined; editable: boolean }) {
  const transition = useTransition();
  const onError = useMutationErrorToast();
  const status = task.status;
  if (!status) return null;
  const badge = <StatusBadge category={status.category} colorToken={status.colorToken} label={statusLabel(status.label)} />;
  // Allowed targets: transitions from this status or from any status (ADR-0019).
  const targets = (workflow?.transitions ?? [])
    .filter((tr) => tr.fromStatusId === null || tr.fromStatusId === status.id)
    .map((tr) => workflow?.statuses.find((s) => s.id === tr.toStatusId))
    .filter((s): s is NonNullable<typeof s> => s !== undefined && s.id !== status.id);
  const unique = [...new Map(targets.map((s) => [s.id, s])).values()];
  if (!editable || unique.length === 0) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`${t('tasks.col.status')}: ${statusLabel(status.label)}`} className={cn('rounded-full', focusRing)}>
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t('task.transition')}</DropdownMenuLabel>
        {unique.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => { transition.mutate({ task, toStatusId: s.id }, { onError }); }}>
            <StatusBadge category={s.category} colorToken={s.colorToken} label={statusLabel(s.label)} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PriorityCell({ task, editable }: { task: Task; editable: boolean }) {
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const p = task.priority ?? 0;
  const badge = <PriorityBadge priority={p} label={priorityLabel(p)} />;
  if (!editable) return badge;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`${t('tasks.col.priority')}: ${priorityLabel(p)}`} className={cn('rounded-full', focusRing)}>
        {badge}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={String(p)} onValueChange={(v) => { update.mutate({ task, patch: { priority: Number(v) } }, { onError }); }}>
          {PRIORITY_KEYS.map((k) => (
            <DropdownMenuRadioItem key={k} value={String(k)}>
              <PriorityBadge priority={k} label={priorityLabel(k)} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AssigneeCell({ id, names, compact = false }: { id: string | null | undefined; names: Map<string, string>; compact?: boolean }) {
  if (!id) return <span className="text-xs text-fg-muted">{t('common.unassigned')}</span>;
  const name = names.get(id) ?? t('common.unknownUser');
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm" title={name}>
      <Avatar name={name} size={20} decorative />
      {compact ? <span className="sr-only">{name}</span> : <span className="truncate">{name}</span>}
    </span>
  );
}

export function DueCell({ task }: { task: Task }) {
  const due = dueLabel(task.dueAt);
  if (!due) return <span className="text-xs text-fg-muted">—</span>;
  const overdue = due.overdue && task.status?.category !== 'closed';
  return overdue ? (
    <Badge tone="danger" icon={CircleAlert} title={t('common.overdue')}>
      {due.text}
      <span className="sr-only"> ({t('common.overdue')})</span>
    </Badge>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
      <CalendarClock aria-hidden size={12} />
      {due.text}
    </span>
  );
}

/** Click (or Enter) to edit; Enter saves, Escape cancels. Saves with If-Match. */
export function InlineTitle({ task, editable, className, onOpen }: { task: Task; editable: boolean; className?: string; onOpen?: () => void }) {
  const update = useUpdateTask();
  const onError = useMutationErrorToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title ?? '');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(task.title ?? '');
  }, [task.title, editing]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function commit(): void {
    setEditing(false);
    const next = value.trim();
    if (next && next !== task.title) update.mutate({ task, patch: { title: next } }, { onError });
    else setValue(task.title ?? '');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setValue(task.title ?? '');
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={input}
        value={value}
        maxLength={500}
        aria-label={t('tasks.editTitle', { title: task.title ?? '' })}
        onChange={(e) => { setValue(e.target.value); }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className={cn('h-7 w-full min-w-0 rounded-input border border-accent bg-surface px-1.5 text-sm text-fg outline-none', className)}
      />
    );
  }
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <button
        type="button"
        onClick={onOpen}
        className={cn('min-w-0 truncate rounded-input text-left text-sm font-medium text-fg hover:underline', focusRing)}
        data-testid="task-title"
      >
        {task.title}
      </button>
      {editable ? (
        <button
          type="button"
          onClick={() => { setEditing(true); }}
          aria-label={t('tasks.editTitle', { title: task.title ?? '' })}
          className={cn('shrink-0 rounded-input px-1 text-xs text-fg-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100', focusRing)}
        >
          <Pencil aria-hidden size={12} />
        </button>
      ) : null}
    </span>
  );
}

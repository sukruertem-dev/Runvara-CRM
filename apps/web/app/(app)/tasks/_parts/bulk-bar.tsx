'use client';

import {
  Button,
  Combobox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PriorityBadge,
  StatusBadge,
  useToast,
} from '@flexa/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpDown, CircleDot, Trash2, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { request } from '../../../../lib/api';
import { useApp } from '../../../../lib/app-context';
import { fmt } from '../../../../lib/format';
import { t } from '../../../../lib/i18n';
import {
  mapLimit,
  patchTaskInCache,
  restoreTasks,
  statusLabel,
  useBulkUpdate,
  useDeleteTasks,
  useDirectorySearch,
  type BulkPatch,
  type Task,
  type Workflow,
} from '../../../../lib/tasks';
import { PRIORITY_KEYS, priorityLabel, useMutationErrorToast } from './cells';

/**
 * Bulk actions on the selection: priority and assignee through POST /v1/tasks/bulk, status through per-task
 * transitions, delete with an 8-second undo. Every change offers "Undo" (inverse request).
 */
export function BulkBar({ selected, onClear, workflow }: { selected: Task[]; onClear: () => void; workflow: Workflow | undefined }) {
  const { can } = useApp();
  const qc = useQueryClient();
  const { toast } = useToast();
  const onError = useMutationErrorToast();
  const bulk = useBulkUpdate();
  const del = useDeleteTasks();
  const [peopleQuery, setPeopleQuery] = useState('');
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const people = useDirectorySearch(peopleQuery);
  const count = selected.length;
  if (count === 0) return null;

  function report(ok: number, failed: number, undo?: () => void): void {
    toast({
      kind: failed > 0 ? 'error' : 'success',
      title: failed > 0 ? fmt('tasks.bulk.partial', { ok, failed }) : fmt('tasks.bulk.done', { count: ok }),
      ...(undo && ok > 0 ? { action: { label: t('common.undo'), onAction: undo } } : {}),
    });
  }

  /** Inverse of a bulk patch: one bulk request per distinct previous value. */
  function undoPatch(previous: Task[], field: 'priority' | 'assigneeUserId'): () => void {
    return () => {
      const groups = new Map<string, string[]>();
      for (const task of previous) {
        const key = JSON.stringify(task[field] ?? null);
        groups.set(key, [...(groups.get(key) ?? []), task.id]);
      }
      for (const [key, ids] of groups) {
        const value = JSON.parse(key) as number | string | null;
        bulk.mutate({ ids, patch: field === 'priority' ? { priority: value as number } : { assigneeUserId: value as string | null } }, { onError });
      }
    };
  }

  function applyPatch(patch: BulkPatch, field: 'priority' | 'assigneeUserId'): void {
    const previous = selected.map((x) => ({ ...x }));
    bulk.mutate(
      { ids: selected.map((x) => x.id), patch },
      {
        onSuccess: (r) => {
          report(r.succeeded, r.failed, undoPatch(previous.filter((p) => r.results.find((x) => x.id === p.id)?.ok), field));
        },
        onError,
      },
    );
  }

  async function applyStatus(toStatusId: string): Promise<void> {
    const previous = selected.map((x) => ({ id: x.id, statusId: x.status?.id ?? null }));
    const results = await mapLimit(selected, 6, async (task) => {
      try {
        const next = await request<Task>(`/v1/tasks/${task.id}/transition`, { method: 'POST', body: { toStatusId } });
        patchTaskInCache(qc, task.id, () => next);
        return { id: task.id, ok: true };
      } catch {
        return { id: task.id, ok: false };
      }
    });
    const ok = results.filter((r) => r.ok);
    report(ok.length, results.length - ok.length, () => {
      void mapLimit(
        previous.filter((p) => p.statusId && ok.some((r) => r.id === p.id)),
        6,
        async (p) => {
          try {
            const back = await request<Task>(`/v1/tasks/${p.id}/transition`, { method: 'POST', body: { toStatusId: p.statusId } });
            patchTaskInCache(qc, p.id, () => back);
          } catch (e) {
            onError(e);
          }
        },
      );
    });
  }

  function remove(): void {
    const tasks = [...selected];
    del.mutate(tasks, {
      onSuccess: (results) => {
        const ok = results.filter((r) => r.ok).map((r) => r.id);
        onClear();
        toast({
          kind: ok.length < results.length ? 'error' : 'info',
          title: ok.length < results.length ? fmt('tasks.bulk.partial', { ok: ok.length, failed: results.length - ok.length }) : fmt('tasks.deletedMany', { count: ok.length }),
          ...(ok.length > 0
            ? {
                action: {
                  label: t('common.undo'),
                  onAction: () => {
                    void restoreTasks(qc, ok).then((n) => toast({ kind: 'success', title: `${t('tasks.restored')} (${String(n)})` }));
                  },
                },
              }
            : {}),
        });
      },
    });
  }

  return (
    <div
      role="region"
      aria-label={fmt('tasks.selected', { count })}
      className="fixed inset-x-3 bottom-4 z-30 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-card border border-line bg-raised px-3 py-2 shadow-popover md:inset-x-auto md:left-1/2 md:-translate-x-1/2"
      data-testid="bulk-bar"
    >
      <span className="px-1 text-sm font-semibold" aria-live="polite">
        {fmt('tasks.selected', { count })}
      </span>
      {workflow ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" icon={<CircleDot aria-hidden size={14} />}>
              {t('tasks.bulk.status')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {workflow.statuses.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => void applyStatus(s.id)}>
                <StatusBadge category={s.category} colorToken={s.colorToken} label={statusLabel(s.label)} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {can('task.bulk') ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="sm" icon={<ArrowUpDown aria-hidden size={14} />}>
                {t('tasks.bulk.priority')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {PRIORITY_KEYS.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => { applyPatch({ priority: p }, 'priority'); }}>
                  <PriorityBadge priority={p} label={priorityLabel(p)} />
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover open={assigneeOpen} onOpenChange={setAssigneeOpen}>
            <PopoverTrigger asChild>
              <Button variant="secondary" size="sm" icon={<UserRound aria-hidden size={14} />}>
                {t('tasks.bulk.assignee')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72">
              <Combobox
                aria-label={t('tasks.bulk.assignee')}
                value={null}
                onValueChange={(v) => {
                  setAssigneeOpen(false);
                  applyPatch({ assigneeUserId: v }, 'assigneeUserId');
                }}
                onSearch={setPeopleQuery}
                options={(people.data?.data ?? []).map((u) => ({ value: u.id, label: u.displayName }))}
                placeholder={t('task.form.assigneeSearch')}
                searchPlaceholder={t('task.form.assigneeSearch')}
                emptyText={t('common.noResults')}
              />
            </PopoverContent>
          </Popover>
        </>
      ) : null}
      {can('task.delete') ? (
        <Button variant="danger" size="sm" icon={<Trash2 aria-hidden size={14} />} loading={del.isPending} onClick={remove}>
          {t('tasks.bulk.delete')}
        </Button>
      ) : null}
      <span className="flex-1" />
      <IconButton label={t('tasks.bulk.clear')} size="sm" onClick={onClear}>
        <X aria-hidden size={16} />
      </IconButton>
    </div>
  );
}

'use client';

import type {
  CommentListResponse,
  DependencyListResponse,
  DirectoryUsersResponse,
  SubtaskListResponse,
  TaskBulkResponse,
  TaskListResponse,
  TaskView,
  TimelineResponse,
  WorkflowListResponse,
} from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ApiError, request } from './api';
import { qk } from './query';

type Out<T extends { _output: unknown }> = T['_output'];
export type Task = Out<typeof TaskView>;
export type TaskPage = Out<typeof TaskListResponse>;
export type Workflow = Out<typeof WorkflowListResponse>['data'][number];
export type WorkflowStatus = Workflow['statuses'][number];
export type Timeline = Out<typeof TimelineResponse>;
export type Comments = Out<typeof CommentListResponse>;
export type Subtasks = Out<typeof SubtaskListResponse>;
export type Dependencies = Out<typeof DependencyListResponse>;
export type BulkResult = Out<typeof TaskBulkResponse>;
export type DirectoryUser = Out<typeof DirectoryUsersResponse>['data'][number];

// ---------------------------------------------------------------- filters → RQL
export type TaskScope = 'all' | 'mine' | 'created';

export interface TaskFilters {
  scope: TaskScope;
  openOnly: boolean;
  search: string;
  sort: string;
}

export const DEFAULT_FILTERS: TaskFilters = { scope: 'all', openOnly: false, search: '', sort: 'position' };

/** RQL string literal (ADR-0008 lexer escapes). */
export function rqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

export function filtersToRql(f: TaskFilters): string {
  const parts: string[] = [];
  if (f.scope === 'mine') parts.push('assignee = me()');
  if (f.scope === 'created') parts.push('createdBy = me()');
  if (f.openOnly) parts.push('statusCategory != closed');
  const term = f.search.trim();
  if (term) parts.push(`title ~ ${rqlString(term)}`);
  return parts.join(' AND ');
}

// ---------------------------------------------------------------- queries
export function useWorkflows() {
  return useQuery({ queryKey: qk.workflows, queryFn: () => request<Out<typeof WorkflowListResponse>>('/v1/workflows'), staleTime: 300_000 });
}

/** The tenant's default task workflow: Kanban columns, transitions and status order. */
export function useTaskWorkflow(): { workflow: Workflow | undefined; isLoading: boolean; error: unknown } {
  const q = useWorkflows();
  const workflow = useMemo(() => {
    const list = q.data?.data.filter((w) => w.resourceType === 'task') ?? [];
    const wf = list.find((w) => w.isDefault) ?? list[0];
    if (!wf) return undefined;
    return { ...wf, statuses: [...wf.statuses].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)) };
  }, [q.data]);
  return { workflow, isLoading: q.isLoading, error: q.error };
}

const PAGE = '200';

export function taskListParams(f: TaskFilters): Record<string, string> {
  const q = filtersToRql(f);
  return { ...(q ? { q } : {}), sort: f.sort, limit: PAGE };
}

export function useTaskList(f: TaskFilters) {
  const params = taskListParams(f);
  const query = useInfiniteQuery({
    queryKey: qk.taskList(params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams(params);
      if (pageParam) sp.set('cursor', pageParam);
      else sp.set('count', 'true');
      return request<TaskPage>(`/v1/tasks?${sp.toString()}`, { signal });
    },
    getNextPageParam: (last) => (last.page.hasMore ? last.page.nextCursor : null),
  });
  const tasks = useMemo(() => query.data?.pages.flatMap((p) => p.data) ?? [], [query.data]);
  const total = query.data?.pages[0]?.meta?.total;
  return { ...query, tasks, total };
}

export function useTask(id: string) {
  return useQuery({ queryKey: qk.task(id), queryFn: ({ signal }) => request<Task>(`/v1/tasks/${id}`, { signal }) });
}

export function useTaskPart<T>(id: string, part: 'timeline' | 'comments' | 'subtasks' | 'dependencies') {
  return useQuery({ queryKey: qk.taskPart(id, part), queryFn: ({ signal }) => request<T>(`/v1/tasks/${id}/${part}`, { signal }) });
}

/** Resolves user ids to names; unknown ids (left the tenant) fall back to a placeholder label. */
export function useDirectory(ids: readonly (string | null | undefined)[]) {
  const unique = useMemo(() => [...new Set(ids.filter((x): x is string => typeof x === 'string'))].sort(), [ids]);
  const key = unique.join(',');
  const q = useQuery({
    queryKey: qk.directory(`ids:${key}`),
    queryFn: async () => {
      const out: DirectoryUser[] = [];
      for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        out.push(...(await request<{ data: DirectoryUser[] }>(`/v1/directory/users?ids=${chunk.join(',')}`)).data);
      }
      return out;
    },
    enabled: unique.length > 0,
    staleTime: 300_000,
  });
  return useMemo(() => new Map((q.data ?? []).map((u) => [u.id, u.displayName])), [q.data]);
}

export function useDirectorySearch(term: string) {
  return useQuery({
    queryKey: qk.directory(`q:${term}`),
    queryFn: ({ signal }) => request<{ data: DirectoryUser[] }>(`/v1/directory/users?limit=20${term ? `&q=${encodeURIComponent(term)}` : ''}`, { signal }),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- cache helpers (optimistic updates)
type ListData = InfiniteData<TaskPage, string | null>;

/** Applies `fn` to a task wherever it is cached (every list page and the detail query). */
export function patchTaskInCache(qc: QueryClient, id: string, fn: (t: Task) => Task): void {
  qc.setQueriesData<ListData>({ queryKey: qk.taskLists }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, data: p.data.map((t) => (t.id === id ? fn(t) : t)) })) } : data,
  );
  qc.setQueryData<Task>(qk.task(id), (t) => (t ? fn(t) : t));
}

export function removeTasksFromCache(qc: QueryClient, ids: ReadonlySet<string>): void {
  qc.setQueriesData<ListData>({ queryKey: qk.taskLists }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, data: p.data.filter((t) => !ids.has(t.id)) })) } : data,
  );
}

function snapshot(qc: QueryClient) {
  return qc.getQueriesData<ListData | Task>({ queryKey: ['tasks'] });
}

function restore(qc: QueryClient, snap: ReturnType<typeof snapshot>): void {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

// ---------------------------------------------------------------- mutations
export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; priority?: number; assigneeUserId?: string | null; dueAt?: string | null }) =>
      request<Task>('/v1/tasks', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (task) => {
      qc.setQueryData(qk.task(task.id), task);
      void qc.invalidateQueries({ queryKey: qk.taskLists });
    },
  });
}

export type TaskPatchBody = Partial<Pick<Task, 'title' | 'priority' | 'assigneeUserId' | 'dueAt' | 'startAt' | 'estimateMinutes' | 'description' | 'descriptionText'>>;

/** PATCH with If-Match (the cached version). A 412 means someone else changed the task first. */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, patch }: { task: Task; patch: TaskPatchBody }) =>
      request<Task>(`/v1/tasks/${task.id}`, { method: 'PATCH', body: patch, ifMatch: task.version ?? 0 }),
    onMutate: async ({ task, patch }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const snap = snapshot(qc);
      patchTaskInCache(qc, task.id, (t) => ({ ...t, ...patch }));
      return { snap };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
    },
    onSuccess: (task) => {
      patchTaskInCache(qc, task.id, () => task);
    },
  });
}

export interface MoveInput {
  task: Task;
  toStatus: WorkflowStatus;
  /** The card just above the drop spot (sorts before it), or null at the top. */
  beforeId: string | null;
  /** The card just below the drop spot (sorts after it), or null at the bottom. */
  afterId: string | null;
}

/**
 * Kanban move: the card changes column and order in the cache at once (< 100 ms acceptance), then
 * POST /move (fractional position + transition). A refusal restores the previous cache.
 */
export function useMoveTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, toStatus, beforeId, afterId }: MoveInput) =>
      request<Task>(`/v1/tasks/${task.id}/move`, {
        method: 'POST',
        body: { beforeId, afterId, ...(task.status?.id === toStatus.id ? {} : { toStatusId: toStatus.id }) },
      }),
    onMutate: async ({ task, toStatus, beforeId, afterId }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const snap = snapshot(qc);
      const position = optimisticPosition(qc, beforeId, afterId);
      patchTaskInCache(qc, task.id, (t) => ({
        ...t,
        status: { id: toStatus.id, key: toStatus.key, category: toStatus.category, label: toStatus.label, colorToken: toStatus.colorToken },
        ...(position ? { position } : {}),
      }));
      return { snap };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
    },
    onSuccess: (task) => {
      patchTaskInCache(qc, task.id, () => task);
    },
  });
}

/** A key strictly between the neighbours' positions, so the cached order is right before the server answers. */
function optimisticPosition(qc: QueryClient, beforeId: string | null, afterId: string | null): string | null {
  const all = qc.getQueriesData<ListData>({ queryKey: qk.taskLists }).flatMap(([, d]) => d?.pages.flatMap((p) => p.data) ?? []);
  const pos = (id: string | null): string | null => (id ? (all.find((t) => t.id === id)?.position ?? null) : null);
  // API semantics (tasks.service move): beforeId sorts before the new spot, afterId after it.
  const lo = pos(beforeId);
  const hi = pos(afterId);
  return keyBetween(lo, hi);
}

/**
 * A string strictly between `lo` and `hi` in code-unit order (null = open end). Only orders the cache until
 * the server's real fractional key arrives; it is never sent to the API.
 */
export function keyBetween(lo: string | null, hi: string | null): string {
  const LOW = 0x20;
  const HIGH = 0x7f;
  const a = lo ?? '';
  let b = hi;
  let out = '';
  for (let i = 0; i < 64; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : LOW;
    const cb = b !== null && i < b.length ? b.charCodeAt(i) : HIGH;
    if (cb - ca > 1) return out + String.fromCharCode(Math.floor((ca + cb) / 2));
    out += String.fromCharCode(ca);
    if (cb > ca) b = null; // the prefix is now below hi; only lo constrains the rest
  }
  return out;
}

export function useTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, toStatusId }: { task: Task; toStatusId: string }) => request<Task>(`/v1/tasks/${task.id}/transition`, { method: 'POST', body: { toStatusId } }),
    onSuccess: (task) => {
      patchTaskInCache(qc, task.id, () => task);
    },
  });
}

/** Soft-deletes tasks (If-Match each); the caller offers undo via `restoreTasks`. */
export function useDeleteTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tasks: readonly Task[]) => {
      const results = await mapLimit(tasks, 8, async (t) => {
        try {
          await request<undefined>(`/v1/tasks/${t.id}`, { method: 'DELETE', ifMatch: t.version ?? 0 });
          return { id: t.id, ok: true as const };
        } catch (e) {
          return { id: t.id, ok: false as const, code: e instanceof ApiError ? e.code : 'UNKNOWN' };
        }
      });
      return results;
    },
    onMutate: async (tasks) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const snap = snapshot(qc);
      removeTasksFromCache(qc, new Set(tasks.map((t) => t.id)));
      return { snap };
    },
    onSettled: (results, _e, _v, ctx) => {
      if (!results && ctx) restore(qc, ctx.snap);
      void qc.invalidateQueries({ queryKey: qk.taskLists });
    },
  });
}

export async function restoreTasks(qc: QueryClient, ids: readonly string[]): Promise<number> {
  const results = await mapLimit(ids, 8, async (id) => {
    try {
      const task = await request<Task>(`/v1/tasks/${id}/restore`, { method: 'POST' });
      qc.setQueryData(qk.task(id), task);
      return true;
    } catch {
      return false;
    }
  });
  void qc.invalidateQueries({ queryKey: qk.taskLists });
  return results.filter(Boolean).length;
}

export type BulkPatch = { priority?: number; assigneeUserId?: string | null; dueAt?: string | null };

export function useBulkUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: BulkPatch }) =>
      request<BulkResult>('/v1/tasks/bulk', { method: 'POST', body: { ids, patch }, idempotencyKey: crypto.randomUUID() }),
    onMutate: async ({ ids, patch }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const snap = snapshot(qc);
      for (const id of ids) patchTaskInCache(qc, id, (t) => ({ ...t, ...patch }));
      return { snap };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) restore(qc, ctx.snap);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.taskLists });
    },
  });
}

/** Runs `fn` over `items` with at most `limit` requests in flight. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export function statusLabel(label: Record<string, string> | undefined, locale = 'tr'): string {
  if (!label) return '';
  return label[locale] ?? label['tr'] ?? label['en'] ?? Object.values(label)[0] ?? '';
}

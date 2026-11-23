import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError } from './api';
import type { StreamEvent } from './realtime';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // 4xx are answers, not outages: retry only network/5xx failures.
        retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.status === 0 || err.status >= 500),
      },
      mutations: { retry: false },
    },
  });
}

export const qk = {
  navigation: ['navigation'] as const,
  tenant: ['tenant'] as const,
  workflows: ['workflows'] as const,
  directory: (key: string) => ['directory', key] as const,
  taskLists: ['tasks', 'list'] as const,
  taskList: (params: Record<string, string>) => ['tasks', 'list', params] as const,
  task: (id: string) => ['tasks', 'detail', id] as const,
  taskPart: (id: string, part: 'timeline' | 'comments' | 'subtasks' | 'dependencies') => ['tasks', 'part', id, part] as const,
  taskSearch: (q: string) => ['tasks', 'search', q] as const,
  notifications: ['notifications'] as const,
};

/** Resource type in stream events → query key prefixes it affects. */
const crm = (type: string) => (id: string): QueryKey[] => [['records', type, 'list'], ['records', type, 'detail', id], ['records', type, 'part', id], ['aggregate', type]];
const PREFIXES: Record<string, (id: string) => QueryKey[]> = {
  task: (id) => [qk.taskLists, qk.task(id), ['tasks', 'part', id], ['tasks', 'search'], ['aggregate', 'task'], ['tasks', 'deps']],
  account: crm('account'),
  contact: crm('contact'),
  lead: crm('lead'),
  opportunity: crm('opportunity'),
  case: crm('case'),
};

const pending = new Map<string, QueryKey>();
let flushTimer: number | null = null;

/**
 * Invalidates the queries an event affects. Bursts (bulk edits, automation chains) are coalesced into one
 * refetch per key every 300 ms.
 */
export function invalidateForEvent(qc: QueryClient, event: StreamEvent): void {
  const keys: QueryKey[] = [];
  if (event.type.startsWith('notification.')) keys.push(qk.notifications);
  // Another tab or an admin changed configuration: effective values, layers, history (and tenant zone/currency).
  else if (event.type === 'config.changed') keys.push(['config'], qk.tenant);
  else if (event.resource) {
    const prefixes = PREFIXES[event.resource.type];
    if (prefixes) keys.push(...prefixes(event.resource.id));
    // A change to a record can change the tasks related to it (related record titles, counts).
    if (event.resource.type !== 'task') keys.push(qk.taskLists);
  }
  for (const k of keys) pending.set(JSON.stringify(k), k);
  if (flushTimer !== null || pending.size === 0) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const queryKey of batch) void qc.invalidateQueries({ queryKey });
  }, 300);
}

'use client';

import type { AggregateResponse, PipelineListResponse, RqlFieldsResponse, SavedView, SavedViewCreate, SavedViewPatch } from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { request } from './api';

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];

export type Resource = 'task' | 'account' | 'contact' | 'lead' | 'opportunity' | 'case';
export type CrmResource = Exclude<Resource, 'task'>;
export type View = Out<typeof SavedView>;
export type ViewInput = In<typeof SavedViewCreate>;
export type ViewPatch = In<typeof SavedViewPatch>;
export type RqlField = Out<typeof RqlFieldsResponse>['data'][number];
export type Aggregate = Out<typeof AggregateResponse>;
export type Pipeline = Out<typeof PipelineListResponse>['data'][number];

/** API collection path of a resource. */
export const PATH: Record<Resource, string> = {
  task: 'tasks',
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  opportunity: 'opportunities',
  case: 'cases',
};

export const rk = {
  views: (resource: Resource) => ['views', resource] as const,
  rqlFields: (resource: Resource) => ['rql-fields', resource] as const,
  aggregate: (resource: Resource, params: Record<string, string>) => ['aggregate', resource, params] as const,
  records: (resource: Resource, params: Record<string, string>) => ['records', resource, 'list', params] as const,
  recordLists: (resource: Resource) => ['records', resource, 'list'] as const,
  record: (resource: Resource, id: string) => ['records', resource, 'detail', id] as const,
  recordPart: (resource: Resource, id: string, part: string) => ['records', resource, 'part', id, part] as const,
  pipelines: ['pipelines'] as const,
  dashboard: ['dashboard'] as const,
};

// ---------------------------------------------------------------- RQL support (filter bar)
export function useRqlFields(resource: Resource) {
  return useQuery({ queryKey: rk.rqlFields(resource), queryFn: () => request<Out<typeof RqlFieldsResponse>>(`/v1/rql/fields?resource=${resource}`), staleTime: 300_000 });
}

export interface RqlCheck {
  ok: boolean;
  error?: { code: string; message: string; position?: number };
}

export function validateRql(resource: Resource, q: string, signal?: AbortSignal): Promise<RqlCheck> {
  return request<RqlCheck>('/v1/rql/validate', { method: 'POST', body: { resource, q }, ...(signal ? { signal } : {}) });
}

// ---------------------------------------------------------------- saved views
export function useViews(resource: Resource) {
  return useQuery({ queryKey: rk.views(resource), queryFn: () => request<{ data: View[] }>(`/v1/views?resource=${resource}`) });
}

export function useSaveView(resource: Resource) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ViewInput) => request<View>('/v1/views', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.views(resource) }),
  });
}

export function useUpdateView(resource: Resource) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ view, patch }: { view: View; patch: ViewPatch }) => request<View>(`/v1/views/${view.id}`, { method: 'PATCH', body: patch, ifMatch: view.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.views(resource) }),
  });
}

export function useDeleteView(resource: Resource) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (view: View) => request(`/v1/views/${view.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.views(resource) }),
  });
}

// ---------------------------------------------------------------- aggregation
export function useAggregate(resource: Resource, params: { q?: string; groupBy?: string; metric?: string; interval?: string }, enabled = true) {
  const clean = useMemo(() => Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')), [params]);
  return useQuery({
    queryKey: rk.aggregate(resource, clean),
    queryFn: ({ signal }) => request<Aggregate>(`/v1/${PATH[resource]}/aggregate?${new URLSearchParams(clean).toString()}`, { signal }),
    enabled,
  });
}

// ---------------------------------------------------------------- CRM records
export interface RecordPage<T> {
  data: T[];
  page: { nextCursor: string | null; hasMore: boolean };
  meta?: { total: number };
}

export function useRecordList<T extends { id: string }>(resource: CrmResource, params: Record<string, string>, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: rk.records(resource, params),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const sp = new URLSearchParams(params);
      if (pageParam) sp.set('cursor', pageParam);
      else sp.set('count', 'true');
      return request<RecordPage<T>>(`/v1/${PATH[resource]}?${sp.toString()}`, { signal });
    },
    getNextPageParam: (last) => (last.page.hasMore ? last.page.nextCursor : null),
    enabled,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.data) ?? [], [q.data]);
  return { ...q, rows, total: q.data?.pages[0]?.meta?.total };
}

export function usePipelines(enabled = true) {
  return useQuery({ queryKey: rk.pipelines, queryFn: () => request<Out<typeof PipelineListResponse>>('/v1/pipelines'), staleTime: 300_000, enabled });
}

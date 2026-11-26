'use client';

import type { ContractCreate, ContractListResponse, ContractPatch, ContractView, OrderListResponse, OrderView, PipelineCreate, PipelinePatch } from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { rk } from './records';
import { useRealtimeEvent } from './realtime';

// Contracts, B2B orders and sales pipelines (P9b, docs/p9-plan.md §8–13).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type Contract = Out<typeof ContractView>;
export type Order = Out<typeof OrderView>;
export type OrderSummary = Out<typeof OrderListResponse>['data'][number];

const CONTRACTS = ['contracts'] as const;
const ORDERS = ['orders'] as const;
const C = '/v1/sales/b2b/contracts';
const O = '/v1/sales/b2b/orders';

export const CONTRACT_TONE = { active: 'success', ended: 'neutral', renewed: 'info', terminated: 'danger' } as const;
export const ORDER_TONE = { open: 'info', fulfilled: 'success', cancelled: 'neutral' } as const;

export function useB2bUpdates(): void {
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type.startsWith('contract.')) void qc.invalidateQueries({ queryKey: CONTRACTS });
    if (e.type.startsWith('order.')) void qc.invalidateQueries({ queryKey: ORDERS });
  });
}

function list<T>(key: readonly string[], base: string, filter: { opportunityId?: string; status?: string }, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...key, 'list', filter.opportunityId ?? '', filter.status ?? ''],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ ...(filter.opportunityId ? { opportunityId: filter.opportunityId } : {}), ...(filter.status ? { status: filter.status } : {}), ...(pageParam ? { cursor: pageParam } : {}) });
      return request<T & { nextCursor: string | null }>(`${base}?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
export const useContracts = (filter: { opportunityId?: string; status?: string }, enabled = true) => list<Out<typeof ContractListResponse>>(CONTRACTS, C, filter, enabled);
export const useOrders = (filter: { opportunityId?: string; status?: string }, enabled = true) => list<Out<typeof OrderListResponse>>(ORDERS, O, filter, enabled);
export const useContract = (id: string) => useQuery({ queryKey: [...CONTRACTS, 'one', id], queryFn: ({ signal }) => request<Contract>(`${C}/${id}`, { signal }), retry: false });
export const useOrder = (id: string) => useQuery({ queryKey: [...ORDERS, 'one', id], queryFn: ({ signal }) => request<Order>(`${O}/${id}`, { signal }), retry: false });

function useWrite<V, R extends { id: string }>(key: readonly string[], fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      qc.setQueryData([...key, 'one', r.id], r);
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
export const useCreateContract = () => useWrite(CONTRACTS, (body: In<typeof ContractCreate>) => request<Contract>(C, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
export const usePatchContract = () => useWrite(CONTRACTS, (v: { contract: Contract; patch: In<typeof ContractPatch> }) => request<Contract>(`${C}/${v.contract.id}`, { method: 'PATCH', body: v.patch, ifMatch: v.contract.version }));
export const useRenewContract = () => useWrite(CONTRACTS, (v: { id: string; endDate?: string }) => request<Contract>(`${C}/${v.id}/renew`, { method: 'POST', body: v.endDate ? { endDate: v.endDate } : {}, idempotencyKey: crypto.randomUUID() }));
export const useTerminateContract = () => useWrite(CONTRACTS, (v: { id: string; on: string; reason: string }) => request<Contract>(`${C}/${v.id}/terminate`, { method: 'POST', body: { on: v.on, reason: v.reason } }));
export const useCreateOrder = () => useWrite(ORDERS, (v: { quoteId: string; contractId?: string | null }) => request<Order>(O, { method: 'POST', body: { quoteId: v.quoteId, contractId: v.contractId ?? null }, idempotencyKey: crypto.randomUUID() }));
export const useOrderStatus = () => useWrite(ORDERS, (v: { id: string; status: 'fulfilled' | 'cancelled'; reason?: string }) => request<Order>(`${O}/${v.id}/status`, { method: 'POST', body: { status: v.status, ...(v.reason ? { reason: v.reason } : {}) } }));

export function useCreatePipeline() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: In<typeof PipelineCreate>) => request<{ id: string }>('/v1/pipelines', { method: 'POST', body }), onSuccess: () => qc.invalidateQueries({ queryKey: rk.pipelines }) });
}
export function usePatchPipeline() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (v: { id: string; patch: In<typeof PipelinePatch> }) => request(`/v1/pipelines/${v.id}`, { method: 'PATCH', body: v.patch }), onSuccess: () => qc.invalidateQueries({ queryKey: rk.pipelines }) });
}

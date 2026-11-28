'use client';

import type { B2cOrderBulkStep, B2cOrderCreate, B2cOrderListResponse, B2cOrderPayment, B2cOrderStepRequest, B2cOrderView, CustomerAnonymize, CustomerView, ReturnCreate, ReturnDecision, ReturnListResponse, ReturnView } from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { useRealtimeEvent } from './realtime';

// B2C orders, returns and KVKK requests (P9e, docs/p9-plan.md §30–37).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type B2cOrder = Out<typeof B2cOrderView>;
export type B2cOrderSummary = Out<typeof B2cOrderListResponse>['data'][number];
export type Return = Out<typeof ReturnView>;
export type OrderStep = B2cOrder['steps'][number];

const ORDERS = ['b2c-orders'] as const;
const RETURNS = ['b2c-returns'] as const;
const O = '/v1/sales/b2c/orders';
const R = '/v1/sales/b2c/returns';

export const ORDER_TONE = { new: 'info', confirmed: 'info', preparing: 'warning', shipped: 'accent', delivered: 'success', cancelled: 'neutral', returned: 'neutral' } as const;
export const PAYMENT_TONE = { pending: 'warning', paid: 'success', failed: 'danger', refunded: 'neutral', partially_refunded: 'neutral' } as const;
export const RETURN_TONE = { requested: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const;
export const CHANNELS = ['web', 'store', 'phone', 'social'] as const;
export const PAYMENTS = ['pending', 'paid', 'failed', 'refunded', 'partially_refunded'] as const;
export const REASONS = ['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other'] as const;

export function useOrderUpdates(): void {
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type.startsWith('order.')) void qc.invalidateQueries({ queryKey: ORDERS });
    if (e.type.startsWith('return.')) {
      void qc.invalidateQueries({ queryKey: RETURNS });
      void qc.invalidateQueries({ queryKey: ORDERS });
    }
  });
}

export function useB2cOrders(filter: { status?: string; channel?: string; customerId?: string; q?: string }) {
  return useInfiniteQuery({
    queryKey: [...ORDERS, 'list', filter.status ?? '', filter.channel ?? '', filter.customerId ?? '', filter.q ?? ''],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams(Object.fromEntries(Object.entries({ ...filter, cursor: pageParam }).filter((x): x is [string, string] => typeof x[1] === 'string' && x[1] !== '')));
      return request<Out<typeof B2cOrderListResponse>>(`${O}?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export const useB2cOrder = (id: string) => useQuery({ queryKey: [...ORDERS, 'one', id], queryFn: ({ signal }) => request<B2cOrder>(`${O}/${id}`, { signal }), retry: false });

export function useReturns(filter: { status?: string; orderId?: string }) {
  return useInfiniteQuery({
    queryKey: [...RETURNS, 'list', filter.status ?? '', filter.orderId ?? ''],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams(Object.fromEntries(Object.entries({ ...filter, cursor: pageParam }).filter((x): x is [string, string] => typeof x[1] === 'string' && x[1] !== '')));
      return request<Out<typeof ReturnListResponse>>(`${R}?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
export const useReturn = (id: string) => useQuery({ queryKey: [...RETURNS, 'one', id], queryFn: ({ signal }) => request<Return>(`${R}/${id}`, { signal }), retry: false });

function useOrderWrite<V>(fn: (v: V) => Promise<B2cOrder>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (o) => {
      qc.setQueryData([...ORDERS, 'one', o.id], o);
      void qc.invalidateQueries({ queryKey: [...ORDERS, 'list'] });
    },
  });
}
export const useCreateB2cOrder = () => useOrderWrite((body: In<typeof B2cOrderCreate>) => request<B2cOrder>(O, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
export const useOrderStep = (id: string) => useOrderWrite((body: In<typeof B2cOrderStepRequest>) => request<B2cOrder>(`${O}/${id}/step`, { method: 'POST', body }));
export const useOrderPayment = (id: string) => useOrderWrite((body: In<typeof B2cOrderPayment>) => request<B2cOrder>(`${O}/${id}/payment`, { method: 'POST', body }));
export function useBulkStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof B2cOrderBulkStep>) => request<{ data: { id: string; ok: boolean; code: string | null }[] }>(`${O}/steps`, { method: 'POST', body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ORDERS }); },
  });
}

function useReturnWrite<V>(fn: (v: V) => Promise<Return>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      qc.setQueryData([...RETURNS, 'one', r.id], r);
      void qc.invalidateQueries({ queryKey: RETURNS });
      void qc.invalidateQueries({ queryKey: [...ORDERS, 'one', r.order.id] });
    },
  });
}
export const useCreateReturn = () => useReturnWrite((body: In<typeof ReturnCreate>) => request<Return>(R, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
export const useDecideReturn = (id: string) => useReturnWrite((body: In<typeof ReturnDecision>) => request<Return>(`${R}/${id}/decision`, { method: 'POST', body }));
export const useCancelReturn = (id: string) => useReturnWrite(() => request<Return>(`${R}/${id}/cancel`, { method: 'POST' }));

/** KVKK: the export as a JSON file, and the anonymization. */
export async function downloadCustomerExport(customerId: string): Promise<void> {
  const data = await request<Record<string, unknown>>(`/v1/sales/b2c/customers/${customerId}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `musteri-${customerId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
export function useAnonymize(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof CustomerAnonymize>) => request<Out<typeof CustomerView>>(`/v1/sales/b2c/customers/${customerId}/anonymize`, { method: 'POST', body }),
    onSuccess: () => { void qc.invalidateQueries(); },
  });
}

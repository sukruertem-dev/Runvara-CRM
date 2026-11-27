'use client';

import type { ConsentHistoryResponse, ConsentSet, CustomerAddressInput, CustomerListResponse, CustomerProfilePut, CustomerView } from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { useRealtimeEvent } from './realtime';

// B2C customers: profile, addresses and channel consent (P9d, docs/p9-plan.md §22–28).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type Customer = Out<typeof CustomerView>;
export type CustomerSummary = Out<typeof CustomerListResponse>['data'][number];
export type Channel = Customer['consents'][number]['channel'];
export const CHANNELS: readonly Channel[] = ['email', 'sms', 'phone', 'whatsapp'];
export const SOURCES = ['web_form', 'phone', 'store', 'email', 'import', 'api', 'other'] as const;

const KEY = ['customers'] as const;
const C = '/v1/sales/b2c/customers';

export function useCustomers(filter: { q?: string; tag?: string; reachable?: string }) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'list', filter.q ?? '', filter.tag ?? '', filter.reachable ?? ''],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({
        ...(filter.q ? { q: filter.q } : {}), ...(filter.tag ? { tag: filter.tag } : {}), ...(filter.reachable ? { reachable: filter.reachable } : {}), ...(pageParam ? { cursor: pageParam } : {}),
      });
      return request<Out<typeof CustomerListResponse>>(`${C}?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCustomer(id: string, enabled = true) {
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type === 'consent.changed' || e.type === 'customer.updated') void qc.invalidateQueries({ queryKey: [...KEY, 'one', id] });
  });
  return useQuery({ queryKey: [...KEY, 'one', id], queryFn: ({ signal }) => request<Customer>(`${C}/${id}`, { signal }), retry: false, enabled });
}

export function useConsentHistory(id: string, enabled: boolean) {
  return useQuery({ queryKey: [...KEY, 'history', id], queryFn: ({ signal }) => request<Out<typeof ConsentHistoryResponse>>(`${C}/${id}/consents/history?limit=100`, { signal }), enabled, retry: false });
}

function useWrite<V>(id: string, fn: (v: V) => Promise<Customer>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      qc.setQueryData([...KEY, 'one', id], r);
      void qc.invalidateQueries({ queryKey: [...KEY, 'list'] });
      void qc.invalidateQueries({ queryKey: [...KEY, 'history', id] });
    },
  });
}
export const usePutProfile = (id: string) => useWrite(id, (v: { version: number; body: In<typeof CustomerProfilePut> }) => request<Customer>(`${C}/${id}/profile`, { method: 'PUT', body: v.body, ifMatch: v.version }));
export const useSaveAddress = (id: string) => useWrite(id, (v: { addressId?: string; body: In<typeof CustomerAddressInput> }) =>
  request<Customer>(v.addressId ? `${C}/${id}/addresses/${v.addressId}` : `${C}/${id}/addresses`, { method: v.addressId ? 'PUT' : 'POST', body: v.body }));
export const useDeleteAddress = (id: string) => useWrite(id, (addressId: string) => request<Customer>(`${C}/${id}/addresses/${addressId}`, { method: 'DELETE' }));
export const useSetConsent = (id: string) => useWrite(id, (body: In<typeof ConsentSet>) => request<Customer>(`${C}/${id}/consents`, { method: 'POST', body }));

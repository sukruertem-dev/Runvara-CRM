'use client';

import type {
  FxRate, FxRateListResponse, PriceListCreate, PriceListItemsResponse, PriceListListResponse, PriceListPatch, PriceResolveRequest, PriceResolveResponse, ProductCreate, ProductListResponse,
  ProductPatch, TaxRateCreate, TaxRateListResponse, TaxRatePatch, TeamCreate, TeamListResponse, TeamPatch,
} from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, request } from './api';
import { messageForCode } from './errors';
import { t } from './i18n';

// Product catalogue, prices and teams (P8a, docs/p8-plan.md §5).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];

export type Product = Out<typeof ProductListResponse>['data'][number];
export type PriceList = Out<typeof PriceListListResponse>['data'][number];
export type PriceItem = Out<typeof PriceListItemsResponse>['data'][number];
export type TaxRate = Out<typeof TaxRateListResponse>['data'][number];
export type Team = Out<typeof TeamListResponse>['data'][number];
export type ProductInput = In<typeof ProductCreate>;
export type PriceListInput = In<typeof PriceListCreate>;
type FxInput = In<typeof FxRate>;

const KEY = ['catalog'] as const;
const TEAMS = ['teams'] as const;

/** Error text for a toast or form: the code's message, plus the API's detail when it names the duplicate. */
export function errorText(err: unknown): string {
  return err instanceof ApiError ? messageForCode(err.code) : t('error.fallback');
}

function useWrite<V>(fn: (v: V) => Promise<unknown>, key: readonly string[]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
}

// ---------------------------------------------------------------- products
export function useProducts(q: string, all: boolean) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'products', q, all],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ active: all ? 'all' : 'true', ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) });
      return request<Out<typeof ProductListResponse>>(`/v1/products?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}
export const useCreateProduct = () => useWrite((body: ProductInput) => request('/v1/products', { method: 'POST', body }), KEY);
export const useUpdateProduct = () =>
  useWrite(({ product, patch }: { product: Product; patch: In<typeof ProductPatch> }) => request(`/v1/products/${product.id}`, { method: 'PATCH', body: patch, ifMatch: product.version }), KEY);

// ---------------------------------------------------------------- price lists
export function usePriceLists() {
  return useQuery({ queryKey: [...KEY, 'lists'], queryFn: () => request<Out<typeof PriceListListResponse>>('/v1/price-lists') });
}
export function usePriceItems(listId: string) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'items', listId],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => request<Out<typeof PriceListItemsResponse>>(`/v1/price-lists/${listId}/items${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
}
export const useCreatePriceList = () => useWrite((body: PriceListInput) => request('/v1/price-lists', { method: 'POST', body }), KEY);
export const useUpdatePriceList = () =>
  useWrite(({ list, patch }: { list: PriceList; patch: In<typeof PriceListPatch> }) => request(`/v1/price-lists/${list.id}`, { method: 'PATCH', body: patch, ifMatch: list.version }), KEY);
export const useSetPrices = () =>
  useWrite(({ listId, productId, breaks }: { listId: string; productId: string; breaks: { minQty: string; unitPrice: string }[] }) => request(`/v1/price-lists/${listId}/products/${productId}`, { method: 'PUT', body: { breaks } }), KEY);

export function resolvePrice(body: In<typeof PriceResolveRequest>): Promise<Out<typeof PriceResolveResponse>> {
  return request('/v1/prices/resolve', { method: 'POST', body });
}

// ---------------------------------------------------------------- taxes and exchange rates
export function useTaxRates(enabled = true) {
  return useQuery({ queryKey: [...KEY, 'taxes'], queryFn: () => request<Out<typeof TaxRateListResponse>>('/v1/tax-rates'), enabled });
}
export const useCreateTaxRate = () => useWrite((body: In<typeof TaxRateCreate>) => request('/v1/tax-rates', { method: 'POST', body }), KEY);
export const useUpdateTaxRate = () =>
  useWrite(({ rate, patch }: { rate: TaxRate; patch: In<typeof TaxRatePatch> }) => request(`/v1/tax-rates/${rate.id}`, { method: 'PATCH', body: patch, ifMatch: rate.version }), KEY);
export function useFxRates() {
  return useQuery({ queryKey: [...KEY, 'fx'], queryFn: () => request<Out<typeof FxRateListResponse>>('/v1/fx-rates') });
}
export const useSetFx = () => useWrite((body: FxInput) => request('/v1/fx-rates', { method: 'PUT', body }), KEY);
export const useRemoveFx = () => useWrite((k: { base: string; quote: string; validOn: string }) => request(`/v1/fx-rates?${new URLSearchParams(k).toString()}`, { method: 'DELETE' }), KEY);

// ---------------------------------------------------------------- customers (picker)
export function useAccountSearch(term: string) {
  const q = term.trim().replace(/["\\]/g, '');
  return useQuery({
    queryKey: ['account-search', q],
    queryFn: ({ signal }) => request<{ data: { id: string; name: string }[] }>(`/v1/accounts?limit=20${q ? `&q=${encodeURIComponent(`name ~ "${q}"`)}` : ''}`, { signal }),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- teams
export function useTeams(enabled = true) {
  return useQuery({ queryKey: TEAMS, queryFn: () => request<Out<typeof TeamListResponse>>('/v1/teams'), enabled });
}
export const useCreateTeam = () => useWrite((body: In<typeof TeamCreate>) => request('/v1/teams', { method: 'POST', body }), TEAMS);
export const useUpdateTeam = () => useWrite(({ id, patch }: { id: string; patch: In<typeof TeamPatch> }) => request(`/v1/teams/${id}`, { method: 'PATCH', body: patch }), TEAMS);
export const useSetTeamMember = () =>
  useWrite(({ teamId, userId, role }: { teamId: string; userId: string; role: 'member' | 'manager' }) => request(`/v1/teams/${teamId}/members/${userId}`, { method: 'PUT', body: { role } }), TEAMS);
export const useRemoveTeamMember = () => useWrite(({ teamId, userId }: { teamId: string; userId: string }) => request(`/v1/teams/${teamId}/members/${userId}`, { method: 'DELETE' }), TEAMS);
export const useSetPrimaryTeam = () => useWrite(({ teamId, userId }: { teamId: string; userId: string }) => request(`/v1/users/${userId}/primary-team`, { method: 'PUT', body: { teamId } }), TEAMS);

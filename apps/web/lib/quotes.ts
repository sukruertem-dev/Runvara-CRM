'use client';

import type { QuoteDraft, QuoteListResponse, QuoteView } from '@flexa/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { formatLocale } from './format';
import { useRealtimeEvent } from './realtime';

// Quotes (P9a, docs/p9-plan.md §6).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type Quote = Out<typeof QuoteView>;
export type QuoteStatusKey = Quote['status'];
export type QuoteDraftInput = In<typeof QuoteDraft>;
type Page = Out<typeof QuoteListResponse>;

const KEY = ['quotes'] as const;
const BASE = '/v1/sales/b2b/quotes';

export const QUOTE_TONE = { draft: 'neutral', pending_approval: 'info', approved: 'info', sent: 'warning', accepted: 'success', rejected: 'danger', expired: 'neutral' } as const;

/** Exact amounts: digits as the API sends them, grouped for the reader. */
export function quoteMoney(amount: string, currency: string): string {
  const [i = '0', f] = amount.split('.');
  const tr = formatLocale().startsWith('tr');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, tr ? '.' : ',');
  return `${grouped}${f ? `${tr ? ',' : '.'}${f}` : ''} ${currency}`;
}

export function useQuotes(filter: { opportunityId?: string; status?: string }, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'list', filter.opportunityId ?? '', filter.status ?? ''],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const p = new URLSearchParams({ ...(filter.opportunityId ? { opportunityId: filter.opportunityId } : {}), ...(filter.status ? { status: filter.status } : {}), ...(pageParam ? { cursor: pageParam } : {}) });
      return request<Page>(`${BASE}?${p.toString()}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
export function useQuote(id: string) {
  return useQuery({ queryKey: [...KEY, 'one', id], queryFn: ({ signal }) => request<Quote>(`${BASE}/${id}`, { signal }), retry: false });
}

/** Decisions and changes elsewhere show up without reloading. */
export function useQuoteUpdates(): void {
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type.startsWith('quote.') || e.type.startsWith('approval.')) void qc.invalidateQueries({ queryKey: KEY });
  });
}

function useQuoteWrite<V>(fn: (v: V) => Promise<Quote>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (q) => {
      qc.setQueryData([...KEY, 'one', q.id], q);
      void qc.invalidateQueries({ queryKey: [...KEY, 'list'] });
    },
  });
}
export const useCreateQuote = () => useQuoteWrite((opportunityId: string) => request<Quote>(BASE, { method: 'POST', body: { opportunityId }, idempotencyKey: crypto.randomUUID() }));
export const useSaveQuote = () => useQuoteWrite((v: { quote: Quote; draft: QuoteDraftInput }) => request<Quote>(`${BASE}/${v.quote.id}/draft`, { method: 'PUT', body: v.draft, ifMatch: v.quote.version }));
export const useQuoteNote = () => useQuoteWrite((v: { id: string; note: unknown }) => request<Quote>(`${BASE}/${v.id}/note`, { method: 'PUT', body: { note: v.note } }));
export const useSubmitQuote = () => useQuoteWrite((v: { id: string; reason?: string }) => request<Quote>(`${BASE}/${v.id}/submit`, { method: 'POST', body: v.reason ? { reason: v.reason } : {} }));
export const useReviseQuote = () => useQuoteWrite((id: string) => request<Quote>(`${BASE}/${id}/versions`, { method: 'POST', idempotencyKey: crypto.randomUUID() }));
export const useSendQuote = () => useQuoteWrite((v: { id: string; to: string[]; message: string }) => request<Quote>(`${BASE}/${v.id}/send`, { method: 'POST', body: { to: v.to, message: v.message } }));
export const useQuoteOutcome = () => useQuoteWrite((v: { id: string; outcome: 'accepted' | 'rejected'; reason?: string }) => request<Quote>(`${BASE}/${v.id}/outcome`, { method: 'POST', body: { outcome: v.outcome, ...(v.reason ? { reason: v.reason } : {}) } }));
export const quotePdfPath = (id: string, version: number): string => `${BASE}/${id}/versions/${String(version)}/pdf`;

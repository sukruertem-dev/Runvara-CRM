'use client';

import type { ForecastAdjust, ForecastSnapshotListResponse, ForecastSnapshotView, ForecastView, OpportunityPulse, StaleOpportunityListResponse } from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';

// Forecast, snapshots, untouched opportunities and the next step (P9c, docs/p9-plan.md §15–20).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type Forecast = Out<typeof ForecastView>;
export type Snapshot = Out<typeof ForecastSnapshotView>;
export type Pulse = Out<typeof OpportunityPulse>;

const KEY = ['forecast'] as const;
const F = '/v1/sales/b2b/forecast';

/** `2026-11` → `2026-10`; `2026-Q1` → `2025-Q4` (and forward with +1). */
export function shiftPeriod(period: string, by: 1 | -1): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const n = Number(q[1]) * 4 + Number(q[2]) - 1 + by;
    return `${String(Math.floor(n / 4))}-Q${String((n % 4) + 1)}`;
  }
  const [y = '1970', m = '01'] = period.split('-');
  const n = Number(y) * 12 + Number(m) - 1 + by;
  return `${String(Math.floor(n / 12))}-${String((n % 12) + 1).padStart(2, '0')}`;
}

/** This month or quarter in the browser's time zone. */
export function thisPeriod(kind: 'month' | 'quarter', now = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth();
  return kind === 'month' ? `${String(y)}-${String(m + 1).padStart(2, '0')}` : `${String(y)}-Q${String(Math.floor(m / 3) + 1)}`;
}

export const useForecast = (period: string) => useQuery({ queryKey: [...KEY, period], queryFn: ({ signal }) => request<Forecast>(`${F}?period=${period}`, { signal }), retry: false });
export const useSnapshots = (period: string) =>
  useQuery({ queryKey: [...KEY, 'snapshots', period], queryFn: ({ signal }) => request<Out<typeof ForecastSnapshotListResponse>>(`${F}/snapshots?period=${period}`, { signal }), retry: false });
export const useStale = (enabled = true) =>
  useQuery({ queryKey: [...KEY, 'stale'], queryFn: ({ signal }) => request<Out<typeof StaleOpportunityListResponse>>('/v1/sales/b2b/opportunities/stale', { signal }), retry: false, enabled });
export const usePulse = (id: string) =>
  useQuery({ queryKey: [...KEY, 'pulse', id], queryFn: ({ signal }) => request<Pulse>(`/v1/sales/b2b/opportunities/${id}/pulse`, { signal }), retry: false });

export function useAdjust() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof ForecastAdjust>) => request<Forecast>(`${F}/adjustments`, { method: 'PUT', body }),
    onSuccess: (r) => { qc.setQueryData([...KEY, r.period], r); },
  });
}

export function useTakeSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (period: string) => request<Snapshot>(`${F}/snapshots`, { method: 'POST', body: { period }, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (s) => { void qc.invalidateQueries({ queryKey: [...KEY, 'snapshots', s.period] }); },
  });
}

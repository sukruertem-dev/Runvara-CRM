'use client';

import type { CampaignAudience, CampaignCreate, CampaignListResponse, CampaignPatch, CampaignSendResult, CampaignView, CouponCheck, CouponCreate, CouponView, RfmSummary } from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';

// B2C campaigns, coupons and RFM (P9f, docs/p9-plan.md §39–46).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];
export type Campaign = Out<typeof CampaignView>;
export type CampaignSummary = Out<typeof CampaignListResponse>['data'][number];
export type Rfm = Out<typeof RfmSummary>;

const KEY = ['campaigns'] as const;
const K = '/v1/sales/b2c/campaigns';
export const RFM_SEGMENTS = ['champions', 'loyal', 'new', 'at_risk', 'hibernating', 'regular'] as const;
export const CAMPAIGN_TONE = { draft: 'neutral', pending_approval: 'warning', active: 'success', ended: 'neutral', cancelled: 'neutral' } as const;
export const RFM_TONE = { champions: 'success', loyal: 'success', new: 'info', at_risk: 'warning', hibernating: 'danger', regular: 'neutral' } as const;

export const useCampaigns = () => useQuery({ queryKey: [...KEY, 'list'], queryFn: ({ signal }) => request<Out<typeof CampaignListResponse>>(K, { signal }), retry: false });
export const useCampaign = (id: string) => useQuery({ queryKey: [...KEY, 'one', id], queryFn: ({ signal }) => request<Campaign>(`${K}/${id}`, { signal }), retry: false });
export const useAudience = (id: string, enabled: boolean) =>
  useQuery({ queryKey: [...KEY, 'audience', id], queryFn: ({ signal }) => request<Out<typeof CampaignAudience>>(`${K}/${id}/audience`, { signal }), enabled, retry: false });

function useCampaignWrite<V>(fn: (v: V) => Promise<Campaign>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (c) => {
      qc.setQueryData([...KEY, 'one', c.id], c);
      void qc.invalidateQueries({ queryKey: [...KEY, 'list'] });
      void qc.invalidateQueries({ queryKey: [...KEY, 'audience', c.id] });
    },
  });
}
export const useCreateCampaign = () => useCampaignWrite((body: In<typeof CampaignCreate>) => request<Campaign>(K, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
export const usePatchCampaign = (id: string) => useCampaignWrite((v: { version: number; body: In<typeof CampaignPatch> }) => request<Campaign>(`${K}/${id}`, { method: 'PATCH', body: v.body, ifMatch: v.version }));
export const useCampaignAction = (id: string) => useCampaignWrite((action: 'submit' | 'approve' | 'reject' | 'cancel') => request<Campaign>(`${K}/${id}/${action}`, { method: 'POST' }));

export function useSendCampaign(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Out<typeof CampaignSendResult>>(`${K}/${id}/send`, { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
export function useAddCoupon(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: In<typeof CouponCreate>) => request<Out<typeof CouponView>>(`${K}/${campaignId}/coupons`, { method: 'POST', body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [...KEY, 'one', campaignId] }); },
  });
}
export function useToggleCoupon(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; active: boolean }) => request<Out<typeof CouponView>>(`/v1/sales/b2c/coupons/${v.id}`, { method: 'PATCH', body: { active: v.active } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [...KEY, 'one', campaignId] }); },
  });
}
export const checkCoupon = (code: string, customerId: string) =>
  request<Out<typeof CouponCheck>>(`/v1/sales/b2c/coupons/check?${new URLSearchParams({ code, customerId }).toString()}`);

export const useRfm = (segment: string) =>
  useQuery({ queryKey: ['rfm', segment], queryFn: ({ signal }) => request<Rfm>(`/v1/sales/b2c/rfm?${segment ? `segment=${segment}&` : ''}limit=100`, { signal }), retry: false });
export function useRecomputeRfm() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => request<Rfm>('/v1/sales/b2c/rfm/recompute', { method: 'POST' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rfm'] }); } });
}

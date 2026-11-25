'use client';

import type { ApprovalBulkResult, ApprovalCreate, ApprovalLimitListResponse, ApprovalListResponse, TargetCreate, TargetListResponse } from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import { useRealtimeEvent } from './realtime';

// Approvals and sales targets (P8b, docs/p8-plan.md §11).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];

export type Approval = Out<typeof ApprovalListResponse>['data'][number];
export type Target = Out<typeof TargetListResponse>['data'][number];
export type TargetInput = In<typeof TargetCreate>;
export type ApprovalBox = 'inbox' | 'mine' | 'all';
type Decision = 'approve' | 'reject';

const APPROVALS = ['approvals'] as const;
const TARGETS = ['targets'] as const;

function useWrite<V, R = unknown>(fn: (v: V) => Promise<R>, key: readonly string[]) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: key }) });
}

/** Open lists follow the stream: a request or decision elsewhere shows up without reloading. */
export function useApprovalUpdates(): void {
  const qc = useQueryClient();
  useRealtimeEvent((e) => {
    if (e.type.startsWith('approval.') || e.type === 'notification.created') void qc.invalidateQueries({ queryKey: APPROVALS });
  });
}

export function useApprovals(box: ApprovalBox) {
  return useQuery({ queryKey: [...APPROVALS, box], queryFn: () => request<Out<typeof ApprovalListResponse>>(`/v1/approvals?box=${box}`) });
}
export function useSubjectApprovals(id: string, enabled: boolean) {
  return useQuery({ queryKey: [...APPROVALS, 'subject', id], queryFn: () => request<Out<typeof ApprovalListResponse>>(`/v1/approvals?box=subject&subjectType=opportunity&subjectId=${id}`), enabled });
}
export const useAskApproval = () => useWrite((body: In<typeof ApprovalCreate>) => request<Approval>('/v1/approvals', { method: 'POST', body }), APPROVALS);
export const useDecide = () =>
  useWrite((v: { ids: string[]; decision: Decision; note?: string }) => request<Out<typeof ApprovalBulkResult>>('/v1/approvals/decisions', { method: 'POST', body: v }), APPROVALS);
export const useWithdraw = () => useWrite((id: string) => request(`/v1/approvals/${id}/cancel`, { method: 'POST' }), APPROVALS);

export function useApprovalLimits() {
  return useQuery({ queryKey: [...APPROVALS, 'limits'], queryFn: () => request<Out<typeof ApprovalLimitListResponse>>('/v1/approvals/limits') });
}
export const useSetLimit = () => useWrite((v: { userId: string; maxPercent: string | null }) => request(`/v1/approvals/limits/${v.userId}`, { method: 'PUT', body: { maxPercent: v.maxPercent } }), APPROVALS);

export function useTargets() {
  return useQuery({ queryKey: TARGETS, queryFn: () => request<Out<typeof TargetListResponse>>('/v1/targets') });
}
export const useCreateTarget = () => useWrite((body: TargetInput) => request('/v1/targets', { method: 'POST', body }), TARGETS);
export const useUpdateTarget = () => useWrite((v: { target: Target; targetValue: string }) => request(`/v1/targets/${v.target.id}`, { method: 'PATCH', body: { targetValue: v.targetValue }, ifMatch: v.target.version }), TARGETS);
export const useDeleteTarget = () => useWrite((id: string) => request(`/v1/targets/${id}`, { method: 'DELETE' }), TARGETS);

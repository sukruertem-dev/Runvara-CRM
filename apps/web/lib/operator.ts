'use client';

import type {
  OperatorTenant,
  OperatorTenantDetail,
  OperatorTenantList,
  SessionResponse,
  SupportGrant,
  SupportGrantList,
  TenantDeletionState,
  TenantExport,
  TenantExportDownload,
  TenantExportList,
} from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, setAccessToken } from './api';

// Platform operator console, support access and the workspace's data and deletion screens (P7c,
// docs/p7-plan.md §13–17).

type Out<T extends { _output: unknown }> = T['_output'];

export type OpTenant = Out<typeof OperatorTenant>;
export type OpTenantDetail = Out<typeof OperatorTenantDetail>;
export type Grant = Out<typeof SupportGrant>;
export type TenantExportView = Out<typeof TenantExport>;
export type DeletionState = Out<typeof TenantDeletionState>;
export type PlanId = 'trial' | 'starter' | 'growth' | 'enterprise';

/** Badge tone per support grant status. */
export const GRANT_TONE = { pending: 'warning', approved: 'success', denied: 'neutral', revoked: 'neutral', cancelled: 'neutral', expired: 'neutral' } as const;

export const opk = {
  tenants: ['operator', 'tenants'] as const,
  tenant: (id: string) => ['operator', 'tenant', id] as const,
  grants: ['operator', 'grants'] as const,
  support: ['support-access'] as const,
  exports: ['tenant', 'exports'] as const,
  deletion: ['tenant', 'deletion'] as const,
};

// ------------------------------------------------------------------ operator console
export function useOperatorTenants() {
  return useQuery({ queryKey: opk.tenants, queryFn: () => request<Out<typeof OperatorTenantList>>('/v1/operator/tenants') });
}

export function useOperatorTenant(id: string) {
  return useQuery({ queryKey: opk.tenant(id), queryFn: () => request<OpTenantDetail>(`/v1/operator/tenants/${encodeURIComponent(id)}`) });
}

export function useOperatorGrants() {
  return useQuery({ queryKey: opk.grants, queryFn: () => request<Out<typeof SupportGrantList>>('/v1/operator/support') });
}

function useOperatorMutation<A, R>(fn: (arg: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['operator'] }); } });
}

export const useCreateTenant = () =>
  useOperatorMutation((body: { name: string; slug: string; adminEmail: string; plan: PlanId }) => request<OpTenant>('/v1/operator/tenants', { method: 'POST', body }));

export const useSetPlan = () =>
  useOperatorMutation(({ id, ...body }: { id: string; plan: PlanId; addOns: string[]; limitOverrides: Record<string, number>; reason: string }) =>
    request<OpTenant>(`/v1/operator/tenants/${encodeURIComponent(id)}/plan`, { method: 'PUT', body }));

export const useTransition = () =>
  useOperatorMutation(({ id, ...body }: { id: string; to: 'active' | 'suspended' | 'pending_deletion'; reason: string }) =>
    request<OpTenant>(`/v1/operator/tenants/${encodeURIComponent(id)}/status`, { method: 'POST', body }));

export const useRequestSupport = () =>
  useOperatorMutation(({ id, ...body }: { id: string; reason: string; modules: string[]; durationMinutes: number }) =>
    request<Grant>(`/v1/operator/tenants/${encodeURIComponent(id)}/support`, { method: 'POST', body }));

export const useCancelGrant = () =>
  useOperatorMutation((id: string) => request<Grant>(`/v1/operator/support/${encodeURIComponent(id)}/cancel`, { method: 'POST' }));

export const useOperatorExport = () =>
  useOperatorMutation((id: string) => request<TenantExportView>(`/v1/operator/tenants/${encodeURIComponent(id)}/exports`, { method: 'POST' }));

/** Enters the workspace under an approved grant. A full page load starts the app from the new session. */
export async function enterSupport(grantId: string): Promise<void> {
  const s = await request<Out<typeof SessionResponse>>(`/v1/operator/support/${encodeURIComponent(grantId)}/enter`, { method: 'POST' });
  setAccessToken(s.accessToken);
  window.location.assign('/');
}

export async function exitSupport(): Promise<void> {
  const s = await request<Out<typeof SessionResponse>>('/v1/operator/support/exit', { method: 'POST' });
  setAccessToken(s.accessToken);
  window.location.assign('/operator/support');
}

// ------------------------------------------------------------------ workspace: support access
export function useSupportGrants(enabled = true) {
  return useQuery({ queryKey: opk.support, queryFn: () => request<Out<typeof SupportGrantList>>('/v1/support-access'), enabled });
}

export function useDecideGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: 'approve' | 'deny' | 'revoke'; note?: string }) =>
      request<Grant>(`/v1/support-access/${encodeURIComponent(id)}/${action}`, { method: 'POST', ...(action === 'revoke' ? {} : { body: note ? { note } : {} }) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: opk.support }), qc.invalidateQueries({ queryKey: ['navigation'] })]);
    },
  });
}

// ------------------------------------------------------------------ workspace: data and deletion
export function useExports(enabled = true) {
  return useQuery({
    queryKey: opk.exports,
    queryFn: () => request<Out<typeof TenantExportList>>('/v1/tenant/exports'),
    enabled,
    // While a file is being built the list refreshes on its own.
    refetchInterval: (q) => (q.state.data?.data.some((e) => e.status === 'pending' || e.status === 'running') ? 3_000 : false),
  });
}

export function useStartExport() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => request<TenantExportView>('/v1/tenant/exports', { method: 'POST' }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: opk.exports }); } });
}

export async function downloadExport(id: string): Promise<void> {
  const r = await request<Out<typeof TenantExportDownload>>(`/v1/tenant/exports/${encodeURIComponent(id)}/download`);
  window.location.assign(r.url);
}

export function useDeletionState(enabled = true) {
  return useQuery({ queryKey: opk.deletion, queryFn: () => request<DeletionState>('/v1/tenant/deletion'), enabled });
}

export function useDeletion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: { action: 'schedule'; confirmSlug: string; reason?: string } | { action: 'cancel' }) =>
      arg.action === 'schedule'
        ? request<DeletionState>('/v1/tenant/deletion', { method: 'POST', body: { confirmSlug: arg.confirmSlug, ...(arg.reason ? { reason: arg.reason } : {}) } })
        : request<DeletionState>('/v1/tenant/deletion/cancel', { method: 'POST' }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: opk.deletion }), qc.invalidateQueries({ queryKey: ['navigation'] }), qc.invalidateQueries({ queryKey: ['tenant'] })]);
    },
  });
}

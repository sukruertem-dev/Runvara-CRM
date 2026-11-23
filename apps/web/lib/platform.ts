'use client';

import type {
  BlueprintListResponse,
  BundlePlan,
  ConfigBundle,
  ConfigImportResponse,
  ModuleListResponse,
  ModuleToggleResponse,
  OnboardingState,
  TenantResponse,
  UsageResponse,
} from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { request } from './api';
import { qk } from './query';

// Tenant platform in the web app (docs/p7-plan.md §7–11): module catalogue, plan and usage, configuration
// export/import, blueprints and onboarding.

type Out<T extends { _output: unknown }> = T['_output'];

export type ModuleState = Out<typeof ModuleListResponse>['data'][number];
export type Usage = Out<typeof UsageResponse>;
export type UsageDimension = Usage['dimensions'][number];
export type Blueprint = Out<typeof BlueprintListResponse>['data'][number];
export type Plan = Out<typeof BundlePlan>;
export type PlanOperation = Plan['operations'][number];
export type Bundle = Out<typeof ConfigBundle>;
export type Onboarding = Out<typeof OnboardingState>;
export type SalesMode = 'b2b_only' | 'b2c_only' | 'both';
export type ConflictPolicy = 'fail' | 'keep';
export interface OnboardingChoice {
  blueprint: string | null;
  salesMode: SalesMode;
  modules: string[];
}

export const pk = {
  modules: ['platform', 'modules'] as const,
  usage: ['platform', 'usage'] as const,
  blueprints: ['platform', 'blueprints'] as const,
  onboarding: ['platform', 'onboarding'] as const,
};

export function useModules(enabled = true) {
  return useQuery({ queryKey: pk.modules, queryFn: () => request<Out<typeof ModuleListResponse>>('/v1/modules'), enabled });
}

export function useUsage(enabled = true) {
  return useQuery({ queryKey: pk.usage, queryFn: () => request<Usage>('/v1/usage'), enabled, staleTime: 60_000 });
}

export function useBlueprints(enabled = true) {
  return useQuery({ queryKey: pk.blueprints, queryFn: () => request<Out<typeof BlueprintListResponse>>('/v1/blueprints'), enabled, staleTime: Infinity });
}

export function useOnboarding(enabled = true) {
  return useQuery({ queryKey: pk.onboarding, queryFn: () => request<Onboarding>('/v1/onboarding'), enabled, staleTime: 300_000 });
}

/** After anything that changes modules, sales mode or configuration: navigation, capabilities and every
 *  configuration screen read again. */
export async function refreshWorkspace(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['platform'] }),
    qc.invalidateQueries({ queryKey: ['config'] }),
    qc.invalidateQueries({ queryKey: qk.tenant }),
    qc.invalidateQueries({ queryKey: qk.navigation }),
  ]);
}

export function useToggleModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enable, cascade = false }: { id: string; enable: boolean; cascade?: boolean }) =>
      request<Out<typeof ModuleToggleResponse>>(`/v1/modules/${encodeURIComponent(id)}/${enable ? 'enable' : 'disable'}${cascade ? '?cascade=true' : ''}`, { method: 'POST' }),
    onSuccess: async () => { await refreshWorkspace(qc); },
  });
}

export function useSetSalesMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (salesMode: SalesMode) => request<Out<typeof TenantResponse>>('/v1/tenant/sales-mode', { method: 'PUT', body: { salesMode } }),
    onSuccess: async () => { await refreshWorkspace(qc); },
  });
}

export const exportBundle = () => request<Bundle>('/v1/config/export');
export const previewImport = (bundle: unknown) => request<Plan>('/v1/config/import/preview', { method: 'POST', body: { bundle } });
export const previewBlueprint = (id: string) => request<Plan>(`/v1/blueprints/${encodeURIComponent(id)}/preview`, { method: 'POST' });
export const previewOnboarding = (choice: OnboardingChoice) => request<Plan>('/v1/onboarding/preview', { method: 'POST', body: choice });

type ImportArg =
  | { kind: 'bundle'; bundle: unknown; onConflict: ConflictPolicy; note?: string }
  | { kind: 'blueprint'; id: string; onConflict: ConflictPolicy }
  | { kind: 'onboarding'; choice: OnboardingChoice };

export function useApplyConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (arg: ImportArg) => {
      if (arg.kind === 'bundle') return request<Out<typeof ConfigImportResponse>>('/v1/config/import', { method: 'POST', body: { bundle: arg.bundle, onConflict: arg.onConflict, ...(arg.note ? { note: arg.note } : {}) } });
      if (arg.kind === 'blueprint') return request<Out<typeof ConfigImportResponse>>(`/v1/blueprints/${encodeURIComponent(arg.id)}/apply`, { method: 'POST', body: { onConflict: arg.onConflict } });
      return request<Out<typeof ConfigImportResponse>>('/v1/onboarding/complete', { method: 'POST', body: arg.choice });
    },
    onSuccess: async () => { await refreshWorkspace(qc); },
  });
}

export function useSkipOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<Onboarding>('/v1/onboarding/skip', { method: 'POST' }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: pk.onboarding }); },
  });
}

/** Saves the bundle as a JSON file named after the workspace and the date. */
export function downloadBundle(bundle: Bundle, slug: string): void {
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flexa-config-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Bytes as KB/MB/GB with the UI number format. */
export function formatBytes(n: number, format: (v: number, opts?: Intl.NumberFormatOptions) => string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${format(v, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i] ?? ''}`;
}

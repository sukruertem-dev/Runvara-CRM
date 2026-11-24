'use client';

import type { AccessTokenResponse, CreateSsoProviderRequest, SsoDiscoverResponse, SsoProviderResponse, UpdateSsoProviderRequest } from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, request, setAccessToken } from './api';
import { t, tOptional } from './i18n';

// Single sign-on providers, the tenant security policy blocks and their remedies (P7d, docs/p7-plan.md §19–21).

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];

export type SsoProvider = Out<typeof SsoProviderResponse>;
export type SsoProviderInput = In<typeof CreateSsoProviderRequest>;
export type SsoProviderPatch = In<typeof UpdateSsoProviderRequest>;
export type SsoDiscovery = Out<typeof SsoDiscoverResponse>;

const SSO_KEY = ['sso-providers'] as const;

export function useSsoProviders(enabled = true) {
  return useQuery({ queryKey: SSO_KEY, queryFn: () => request<SsoProvider[]>('/v1/sso-providers'), enabled });
}

export function useCreateSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SsoProviderInput) => request<SsoProvider>('/v1/sso-providers', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SSO_KEY }),
  });
}

export function useUpdateSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SsoProviderPatch }) => request<SsoProvider>(`/v1/sso-providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SSO_KEY }),
  });
}

export function useDeleteSsoProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<undefined>(`/v1/sso-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SSO_KEY }),
  });
}

export function discoverSso(email: string): Promise<SsoDiscovery> {
  return request<SsoDiscovery>('/v1/auth/sso/discover', { method: 'POST', auth: false, body: { email } });
}

/** Adds a second factor to the current session; the new token carries it (tenant two-factor policy). */
export async function stepUp(input: { code: string } | { recoveryCode: string }): Promise<void> {
  const res = await request<Out<typeof AccessTokenResponse>>('/v1/auth/step-up', { method: 'POST', body: input });
  setAccessToken(res.accessToken);
}

export function changePassword(body: { currentPassword: string; newPassword: string; tenantId?: string }): Promise<undefined> {
  return request<undefined>('/v1/me/password', { method: 'POST', body });
}

/** Why a workspace did not open (tenant security policy), with what the screen needs to resolve it. */
export type TenantBlock =
  | { code: 'TENANT_MFA_REQUIRED'; enrolled: boolean }
  | { code: 'PASSWORD_CHANGE_REQUIRED'; reasons: string[]; rules: { minLength: number; requireMixed: boolean } }
  | { code: 'TENANT_SSO_REQUIRED'; providers: SsoDiscovery['providers'] };

export function tenantBlockOf(err: unknown): TenantBlock | null {
  if (!(err instanceof ApiError)) return null;
  const p = err.problem;
  if (err.code === 'TENANT_MFA_REQUIRED') return { code: err.code, enrolled: p.enrolled === true };
  if (err.code === 'PASSWORD_CHANGE_REQUIRED') {
    const rules = (p.rules ?? {}) as { minLength?: unknown; requireMixed?: unknown };
    return { code: err.code, reasons: err.reasons, rules: { minLength: typeof rules.minLength === 'number' ? rules.minLength : 12, requireMixed: rules.requireMixed === true } };
  }
  if (err.code === 'TENANT_SSO_REQUIRED') return { code: err.code, providers: Array.isArray(p.providers) ? (p.providers as SsoDiscovery['providers']) : [] };
  return null;
}

/** Password reasons as sentences; the tenant's minimum length when known. */
export function passwordReasonText(reasons: readonly string[], minLength?: number): string {
  return reasons.map((r) => (r === 'too_short' && minLength && minLength > 12 ? t('reason.tenant_too_short', { min: String(minLength) }) : (tOptional(`reason.${r}`) ?? r))).join(' ');
}

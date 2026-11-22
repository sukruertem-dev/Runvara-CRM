'use client';

import type {
  ApiKeyCreate,
  ApiKeyListResponse,
  AssignmentPolicyListResponse,
  AutomationRuleCreate,
  AutomationRuleDefinition,
  AutomationRuleListResponse,
  AutomationRulePatch,
  AutomationRunListResponse,
  BusinessCalendarInput,
  BusinessCalendarListResponse,
  CustomFieldCreate,
  CustomFieldListResponse,
  CustomFieldPatch,
  MatrixChange,
  MatrixDiff,
  MatrixVersionListResponse,
  MatrixView,
  SlaPolicyCreate,
  SlaPolicyListResponse,
  SlaPolicyPatch,
  WebhookCreate,
  WebhookDeliveryListResponse,
  WebhookListResponse,
  WebhookPatch,
  WorkflowCreate,
  WorkflowListResponse,
  WorkflowUpdate,
  WorkflowUpdatePreview,
} from '@flexa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './api';
import type { Resource } from './records';

type Out<T extends { _output: unknown }> = T['_output'];
type In<T extends { _input: unknown }> = T['_input'];

export type Workflow = Out<typeof WorkflowListResponse>['data'][number];
export type WorkflowStatus = Workflow['statuses'][number];
export type WorkflowTransition = Workflow['transitions'][number];
export type WorkflowDraft = In<typeof WorkflowUpdate>;
export type WorkflowPreview = Out<typeof WorkflowUpdatePreview>;
export type CustomField = Out<typeof CustomFieldListResponse>['data'][number];
export type CustomFieldInput = In<typeof CustomFieldCreate>;
export type CustomFieldChange = In<typeof CustomFieldPatch>;
export type Matrix = Out<typeof MatrixView>;
export type MatrixCell = Matrix['cells'][number];
export type Grant = NonNullable<MatrixCell['grant']>;
export type MatrixChanges = In<typeof MatrixChange>;
export type MatrixPreview = Out<typeof MatrixDiff>;
export type MatrixVersion = Out<typeof MatrixVersionListResponse>['data'][number];
export type Rule = Out<typeof AutomationRuleListResponse>['data'][number];
export type RuleDefinition = Out<typeof AutomationRuleDefinition>;
export type RuleInput = In<typeof AutomationRuleCreate>;
export type RulePatch = In<typeof AutomationRulePatch>;
export type RuleRun = Out<typeof AutomationRunListResponse>['data'][number];
export type AssignmentPolicy = Out<typeof AssignmentPolicyListResponse>['data'][number];
export type Webhook = Out<typeof WebhookListResponse>['data'][number];
export type WebhookInput = In<typeof WebhookCreate>;
export type WebhookChange = In<typeof WebhookPatch>;
export type Delivery = Out<typeof WebhookDeliveryListResponse>['data'][number];
export type ApiKey = Out<typeof ApiKeyListResponse>['data'][number];
export type ApiKeyInput = In<typeof ApiKeyCreate>;
export type Calendar = Out<typeof BusinessCalendarListResponse>['data'][number];
export type CalendarInput = In<typeof BusinessCalendarInput>;
export type SlaPolicy = Out<typeof SlaPolicyListResponse>['data'][number];
export type SlaPolicyInput = In<typeof SlaPolicyCreate>;
export type SlaPolicyChange = In<typeof SlaPolicyPatch>;

export const sk = {
  workflows: ['settings', 'workflows'] as const,
  fields: (resource: Resource) => ['settings', 'fields', resource] as const,
  matrix: ['settings', 'matrix'] as const,
  matrixVersions: ['settings', 'matrix', 'versions'] as const,
  rules: ['settings', 'rules'] as const,
  rule: (id: string) => ['settings', 'rules', id] as const,
  runs: (ruleId: string) => ['settings', 'runs', ruleId] as const,
  policies: ['settings', 'assignment-policies'] as const,
  webhooks: ['settings', 'webhooks'] as const,
  deliveries: (id: string) => ['settings', 'webhooks', id, 'deliveries'] as const,
  apiKeys: ['settings', 'api-keys'] as const,
  calendars: ['settings', 'calendars'] as const,
  slaPolicies: ['settings', 'sla-policies'] as const,
};

/** Mutation that refreshes the given settings queries when it succeeds. */
function useSettingsMutation<A, R>(fn: (arg: A) => Promise<R>, refresh: readonly (readonly string[])[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}

// ---------------------------------------------------------------- workflows
export function useWorkflows() {
  return useQuery({ queryKey: sk.workflows, queryFn: () => request<Out<typeof WorkflowListResponse>>('/v1/workflows') });
}

export const previewWorkflow = (id: string, body: WorkflowDraft) => request<WorkflowPreview>(`/v1/workflows/${id}/preview`, { method: 'POST', body });

export function useSaveWorkflow() {
  return useSettingsMutation(
    ({ id, version, body }: { id: string; version: number; body: WorkflowDraft }) => request<Workflow>(`/v1/workflows/${id}`, { method: 'PUT', body, ifMatch: version }),
    [sk.workflows, ['tasks'], ['records'], ['pipelines']],
  );
}

export function useCreateWorkflow() {
  return useSettingsMutation((body: In<typeof WorkflowCreate>) => request<Workflow>('/v1/workflows', { method: 'POST', body }), [sk.workflows]);
}

// ---------------------------------------------------------------- custom fields
export function useCustomFields(resource: Resource) {
  return useQuery({ queryKey: sk.fields(resource), queryFn: () => request<Out<typeof CustomFieldListResponse>>(`/v1/custom-fields?resourceType=${resource}`) });
}

export function useFieldMutations(resource: Resource) {
  const refresh = [sk.fields(resource), ['rql-fields', resource]] as const;
  return {
    create: useSettingsMutation((body: CustomFieldInput) => request<CustomField>('/v1/custom-fields', { method: 'POST', body }), refresh),
    patch: useSettingsMutation(({ field, body }: { field: CustomField; body: CustomFieldChange }) => request<CustomField>(`/v1/custom-fields/${field.id}`, { method: 'PATCH', body, ifMatch: field.version }), refresh),
    archive: useSettingsMutation((field: CustomField) => request(`/v1/custom-fields/${field.id}/archive`, { method: 'POST' }), refresh),
    restore: useSettingsMutation((field: CustomField) => request<CustomField>(`/v1/custom-fields/${field.id}/restore`, { method: 'POST' }), refresh),
  };
}

// ---------------------------------------------------------------- permission matrix
export function useMatrix() {
  return useQuery({ queryKey: sk.matrix, queryFn: () => request<Matrix>('/v1/authz/matrix') });
}

export function useMatrixVersions() {
  return useQuery({ queryKey: sk.matrixVersions, queryFn: () => request<Out<typeof MatrixVersionListResponse>>('/v1/authz/matrix/versions') });
}

export const previewMatrix = (body: MatrixChanges) => request<MatrixPreview>('/v1/authz/matrix/preview', { method: 'POST', body });

export function useMatrixMutations() {
  const refresh = [sk.matrix, sk.matrixVersions, ['navigation']] as const;
  return {
    apply: useSettingsMutation((body: MatrixChanges) => request<Matrix>('/v1/authz/matrix', { method: 'PUT', body }), refresh),
    restore: useSettingsMutation((version: number) => request<Matrix>(`/v1/authz/matrix/versions/${String(version)}/restore`, { method: 'POST' }), refresh),
  };
}

// ---------------------------------------------------------------- automation
export function useRules() {
  return useQuery({ queryKey: sk.rules, queryFn: () => request<Out<typeof AutomationRuleListResponse>>('/v1/automations/rules') });
}

export function useRule(id: string | null) {
  return useQuery({ queryKey: sk.rule(id ?? 'new'), queryFn: () => request<Rule>(`/v1/automations/rules/${id ?? ''}`), enabled: id !== null });
}

export function useRuleRuns(ruleId: string | null) {
  return useQuery({
    queryKey: sk.runs(ruleId ?? 'none'),
    queryFn: () => request<Out<typeof AutomationRunListResponse>>(`/v1/automations/runs?ruleId=${ruleId ?? ''}&limit=20`),
    enabled: ruleId !== null,
  });
}

export function useAssignmentPolicies(enabled = true) {
  return useQuery({ queryKey: sk.policies, queryFn: () => request<Out<typeof AssignmentPolicyListResponse>>('/v1/automations/assignment-policies'), enabled });
}

export function useRuleMutations() {
  return {
    create: useSettingsMutation((body: RuleInput) => request<Rule>('/v1/automations/rules', { method: 'POST', body }), [sk.rules]),
    patch: useSettingsMutation(({ id, body }: { id: string; body: RulePatch }) => request<Rule>(`/v1/automations/rules/${id}`, { method: 'PATCH', body }), [sk.rules, ['settings', 'rules']]),
    remove: useSettingsMutation((id: string) => request(`/v1/automations/rules/${id}`, { method: 'DELETE' }), [sk.rules]),
  };
}

// ---------------------------------------------------------------- webhooks and API keys
export function useWebhooks(enabled = true) {
  return useQuery({ queryKey: sk.webhooks, queryFn: () => request<Out<typeof WebhookListResponse>>('/v1/webhooks'), enabled });
}

export function useDeliveries(id: string | null) {
  return useQuery({
    queryKey: sk.deliveries(id ?? 'none'),
    queryFn: () => request<Out<typeof WebhookDeliveryListResponse>>(`/v1/webhooks/${id ?? ''}/deliveries`),
    enabled: id !== null,
  });
}

export function useWebhookMutations() {
  const refresh = [sk.webhooks] as const;
  return {
    create: useSettingsMutation((body: WebhookInput) => request<Webhook>('/v1/webhooks', { method: 'POST', body }), refresh),
    patch: useSettingsMutation(({ id, body }: { id: string; body: WebhookChange }) => request<Webhook>(`/v1/webhooks/${id}`, { method: 'PATCH', body }), refresh),
    remove: useSettingsMutation((id: string) => request(`/v1/webhooks/${id}`, { method: 'DELETE' }), refresh),
    rotate: useSettingsMutation((id: string) => request<Webhook>(`/v1/webhooks/${id}/rotate-secret`, { method: 'POST' }), refresh),
    redeliver: useSettingsMutation(({ deliveryId }: { webhookId: string; deliveryId: string }) => request(`/v1/webhooks/deliveries/${deliveryId}/redeliver`, { method: 'POST' }), [['settings', 'webhooks']]),
  };
}

export function useApiKeys() {
  return useQuery({ queryKey: sk.apiKeys, queryFn: () => request<Out<typeof ApiKeyListResponse>>('/v1/api-keys') });
}

export function useApiKeyMutations() {
  return {
    create: useSettingsMutation((body: ApiKeyInput) => request<ApiKey>('/v1/api-keys', { method: 'POST', body }), [sk.apiKeys]),
    revoke: useSettingsMutation((id: string) => request<ApiKey>(`/v1/api-keys/${id}/revoke`, { method: 'POST' }), [sk.apiKeys]),
  };
}

// ---------------------------------------------------------------- SLA
export function useCalendars(enabled = true) {
  return useQuery({ queryKey: sk.calendars, queryFn: () => request<Out<typeof BusinessCalendarListResponse>>('/v1/calendars'), enabled });
}

export function useSlaPolicies() {
  return useQuery({ queryKey: sk.slaPolicies, queryFn: () => request<Out<typeof SlaPolicyListResponse>>('/v1/sla/policies') });
}

export function useSlaMutations() {
  return {
    saveCalendar: useSettingsMutation(
      ({ id, body }: { id: string | null; body: CalendarInput }) => request<Calendar>(id ? `/v1/calendars/${id}` : '/v1/calendars', { method: id ? 'PUT' : 'POST', body }),
      [sk.calendars],
    ),
    createPolicy: useSettingsMutation((body: SlaPolicyInput) => request<SlaPolicy>('/v1/sla/policies', { method: 'POST', body }), [sk.slaPolicies]),
    patchPolicy: useSettingsMutation(({ policy, body }: { policy: SlaPolicy; body: SlaPolicyChange }) => request<SlaPolicy>(`/v1/sla/policies/${policy.id}`, { method: 'PATCH', body, ifMatch: policy.version }), [sk.slaPolicies]),
  };
}

/** Label of an i18n map in the UI language (Turkish first, then English, then any). */
export function labelOf(label: Record<string, string> | undefined, fallback = ''): string {
  if (!label) return fallback;
  return label.tr ?? label.en ?? Object.values(label)[0] ?? fallback;
}

/** Turns free text into a key matching `^[a-z][a-z0-9_]{1,47}$` (Turkish letters folded). */
export function toKey(text: string, prefix = ''): string {
  const folded = text
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i').replaceAll('ğ', 'g').replaceAll('ü', 'u').replaceAll('ş', 's').replaceAll('ö', 'o').replaceAll('ç', 'c')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const body = /^[a-z]/.test(folded) ? folded : `k_${folded}`;
  return `${prefix}${body}`.slice(0, 48).replace(/_+$/, '');
}

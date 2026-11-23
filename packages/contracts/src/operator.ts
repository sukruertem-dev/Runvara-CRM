import { z } from 'zod';
import { Uuid } from './schemas';
import { UsageDimension } from './bundle';

// P7c: platform operator console, support access, tenant lifecycle, export and deletion (ADR-0014 §5–6,
// docs/p7-plan.md §13–15).

export const TenantStatus = z.enum(['trial', 'active', 'suspended', 'pending_deletion', 'deleted']);
const PlanIdSchema = z.enum(['trial', 'starter', 'growth', 'enterprise']);
const ModuleIdName = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

// ------------------------------------------------------------------ operator: tenants
export const OperatorTenant = z
  .object({
    id: Uuid,
    slug: z.string(),
    name: z.string(),
    status: TenantStatus,
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']),
    createdAt: z.iso.datetime(),
    statusChangedAt: z.iso.datetime(),
    deletionScheduledAt: z.iso.datetime().nullable(),
    plan: z.object({ id: z.string(), addOns: z.array(z.string()), limitOverrides: z.record(z.string(), z.number()), trialEndsAt: z.iso.datetime().nullable() }).nullable(),
    members: z.number().int(),
  })
  .openapi('OperatorTenant');
export const OperatorTenantList = z.object({ data: z.array(OperatorTenant) }).openapi('OperatorTenantList');

export const OperatorTenantCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
    adminEmail: z.email().max(254),
    plan: PlanIdSchema.default('trial'),
    locale: z.enum(['tr-TR', 'en-US']).default('tr-TR'),
  })
  .strict()
  .openapi('OperatorTenantCreate');

export const OperatorPlanUpdate = z
  .object({
    plan: PlanIdSchema,
    addOns: z.array(ModuleIdName).max(16).default([]),
    /** Per-dimension limits that replace the plan's. */
    limitOverrides: z.partialRecord(z.enum(['users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens', 'api_rpm', 'api_rpm_per_user']), z.number().int().min(0)).default({}),
    /** Only for the trial plan; defaults to 14 days from now. */
    trialEndsAt: z.iso.datetime().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .openapi('OperatorPlanUpdate');

export const TenantTransition = z
  .object({ to: z.enum(['active', 'suspended', 'pending_deletion']), reason: z.string().trim().min(3).max(500) })
  .strict()
  .openapi('TenantTransition');

// ------------------------------------------------------------------ support access
export const SupportGrantStatus = z.enum(['pending', 'approved', 'denied', 'revoked', 'cancelled', 'expired']);
export const SupportGrant = z
  .object({
    id: Uuid,
    tenantId: Uuid,
    operator: z.object({ id: Uuid, name: z.string() }),
    reason: z.string(),
    modules: z.array(z.string()),
    durationMinutes: z.number().int(),
    status: SupportGrantStatus,
    requestedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
    validUntil: z.iso.datetime().nullable(),
  })
  .openapi('SupportGrant');
export const SupportGrantList = z.object({ data: z.array(SupportGrant) }).openapi('SupportGrantList');

export const SupportRequestCreate = z
  .object({
    reason: z.string().trim().min(10).max(500),
    modules: z.array(ModuleIdName).max(16).default([]),
    /** B12: at most 8 hours, 4 hours by default. */
    durationMinutes: z.number().int().min(15).max(480).default(240),
  })
  .strict()
  .openapi('SupportRequestCreate');

export const SupportDecision = z.object({ note: z.string().trim().max(500).optional() }).strict().openapi('SupportDecision');

// ------------------------------------------------------------------ exports and deletion
export const TenantExport = z
  .object({
    id: Uuid,
    status: z.enum(['pending', 'running', 'ready', 'failed', 'expired']),
    requestedAs: z.enum(['admin', 'operator']),
    sizeBytes: z.number().int().nullable(),
    rowCount: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .openapi('TenantExport');
export const TenantExportList = z.object({ data: z.array(TenantExport) }).openapi('TenantExportList');
export const TenantExportDownload = z.object({ url: z.url(), expiresIn: z.number().int() }).openapi('TenantExportDownload');

export const TenantDeletionRequest = z
  .object({ confirmSlug: z.string().min(3).max(40), reason: z.string().trim().max(500).optional() })
  .strict()
  .openapi('TenantDeletionRequest');
export const TenantDeletionState = z
  .object({ status: TenantStatus, deletionScheduledAt: z.iso.datetime().nullable(), graceDays: z.number().int() })
  .openapi('TenantDeletionState');

// Defined after SupportGrant, which it embeds.
export const OperatorTenantDetail = OperatorTenant.extend({
  modules: z.array(z.string()),
  usage: z.array(UsageDimension),
  support: z.array(SupportGrant),
  actions: z.array(z.object({ action: z.string(), at: z.iso.datetime(), operator: z.string().nullable(), details: z.record(z.string(), z.unknown()) })),
}).openapi('OperatorTenantDetail');

import { z } from 'zod';
import { PatchOp } from './config';
import { BusinessCalendarInput } from './integrations';
import { CustomFieldCreate, WorkflowCreate } from './tasks';

// P7b: configuration bundles (ADR-0011 §3, docs/p7-plan.md §7). One format carries blueprints and tenant
// exports. Definitions are matched by natural key (key, name), never by UUID, so a bundle moves between
// tenants (tenant → sandbox → tenant). Importing is additive: nothing absent from the bundle is removed.

export const BUNDLE_FORMAT = 'flexa.config/1';

const Name = z.string().trim().min(1).max(120);
const StatusKey = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const ModuleIdName = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

export const BundleSlaPolicy = z
  .object({
    name: Name,
    resourceType: z.enum(['case', 'task', 'lead']),
    criteria: z.string().max(2000).default(''),
    position: z.number().int().min(0).max(10_000).default(0),
    /** Name of a calendar in the same bundle or already in the tenant. */
    calendar: Name,
    firstResponseMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    resolutionMinutes: z.number().int().min(1).max(525_600).nullable().default(null),
    warnPercent: z.number().int().min(1).max(99).default(80),
    pauseStatuses: z.array(StatusKey).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .openapi('BundleSlaPolicy');

export const BundleTag = z
  .object({ name: z.string().trim().min(1).max(60), colorToken: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).default('text-secondary') })
  .strict()
  .openapi('BundleTag');

export const BundleQueue = z
  .object({ kind: z.enum(['work', 'call']), name: Name, segment: z.enum(['b2b', 'b2c']).nullable().default(null) })
  .strict()
  .openapi('BundleQueue');

export const BundleMeta = z
  .object({
    kind: z.enum(['export', 'blueprint']),
    /** Blueprint id, or the slug of the exporting tenant. */
    id: z.string().max(64),
    version: z.number().int().min(1).optional(),
    exportedAt: z.iso.datetime().optional(),
  })
  .strict()
  .openapi('BundleMeta');

export const ConfigBundle = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    meta: BundleMeta.optional(),
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']).optional(),
    /** Modules to enable (dependencies included). Modules not listed are left as they are. */
    modules: z.array(ModuleIdName).max(32).default([]),
    /** Tenant-layer values of portable configuration keys (P7a registry). */
    settings: z.record(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(64), z.record(z.string(), z.unknown())).default({}),
    customFields: z.array(CustomFieldCreate).max(500).default([]),
    taskWorkflows: z.array(WorkflowCreate).max(50).default([]),
    calendars: z.array(BusinessCalendarInput).max(50).default([]),
    slaPolicies: z.array(BundleSlaPolicy).max(200).default([]),
    tags: z.array(BundleTag).max(500).default([]),
    queues: z.array(BundleQueue).max(200).default([]),
  })
  .strict()
  .openapi('ConfigBundle');
export type ConfigBundleInput = z.input<typeof ConfigBundle>;
export type ConfigBundleValue = z.output<typeof ConfigBundle>;

export const BundleSection = z.enum(['salesMode', 'modules', 'settings', 'customFields', 'taskWorkflows', 'calendars', 'slaPolicies', 'tags', 'queues']);
export const BundleAction = z.enum(['create', 'update', 'unchanged', 'conflict']);
/**
 * Why an item conflicts. `definition_differs` can be resolved by keeping the tenant's definition; the others
 * block the import: a module whose dependencies are not in the bundle or the tenant, a module outside the
 * plan, an SLA policy whose calendar does not exist, or an item the target refuses (with `detail`).
 */
export const BundleConflictReason = z.enum(['definition_differs', 'module_dependency', 'module_not_in_plan', 'calendar_missing', 'invalid']);

export const BundleOperation = z
  .object({
    section: BundleSection,
    key: z.string(),
    action: BundleAction,
    reason: BundleConflictReason.optional(),
    detail: z.string().optional(),
    /** For `update` and `definition_differs`: the change from the tenant's value to the bundle's (RFC 6902). */
    patch: z.array(PatchOp).optional(),
  })
  .openapi('BundleOperation');

export const BundlePlan = z
  .object({
    operations: z.array(BundleOperation),
    summary: z.object({ create: z.number().int(), update: z.number().int(), unchanged: z.number().int(), conflict: z.number().int() }),
    /** Conflicts that keeping the tenant's definition cannot resolve. */
    blocking: z.number().int(),
    /** Whether the import can be applied with `onConflict: keep` (no blocking conflict). */
    applicable: z.boolean(),
  })
  .openapi('BundlePlan');

export const ConflictPolicy = z.enum(['fail', 'keep']);

export const ConfigImportRequest = z
  .object({ bundle: ConfigBundle, onConflict: ConflictPolicy.default('fail'), note: z.string().trim().max(500).optional() })
  .strict()
  .openapi('ConfigImportRequest');
export const ConfigImportPreviewRequest = z.object({ bundle: ConfigBundle }).strict().openapi('ConfigImportPreviewRequest');
export const ConfigImportResponse = z.object({ plan: BundlePlan, applied: z.boolean() }).openapi('ConfigImportResponse');

export const BlueprintSummary = z
  .object({
    id: z.string(),
    version: z.number().int(),
    nameKey: z.string(),
    descriptionKey: z.string(),
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']),
    modules: z.array(z.string()),
    counts: z.object({ customFields: z.number().int(), taskWorkflows: z.number().int(), slaPolicies: z.number().int(), tags: z.number().int(), queues: z.number().int() }),
  })
  .openapi('BlueprintSummary');
export const BlueprintListResponse = z.object({ data: z.array(BlueprintSummary) }).openapi('BlueprintListResponse');
export const BlueprintApplyRequest = z.object({ onConflict: ConflictPolicy.default('fail') }).strict().openapi('BlueprintApplyRequest');

// ------------------------------------------------------------------ onboarding
export const OnboardingChoice = z
  .object({
    /** null = start empty. */
    blueprint: z.string().max(64).nullable(),
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']),
    modules: z.array(ModuleIdName).max(32),
  })
  .strict()
  .openapi('OnboardingChoice');
export const OnboardingState = z
  .object({ status: z.enum(['pending', 'completed', 'skipped']), blueprint: z.string().nullable() })
  .openapi('OnboardingState');

// ------------------------------------------------------------------ plan, quota, usage
export const UsageDimension = z
  .object({
    dimension: z.enum(['users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens']),
    used: z.number().int(),
    limit: z.number().int(),
    level: z.enum(['ok', 'warning', 'soft', 'hard']),
  })
  .openapi('UsageDimension');
export const UsageResponse = z
  .object({
    plan: z.object({
      id: z.string(),
      displayNameKey: z.string(),
      tier: z.enum(['starter', 'growth', 'enterprise']),
      addOns: z.array(z.string()),
      trialEndsAt: z.iso.datetime().nullable(),
    }),
    dimensions: z.array(UsageDimension),
    rates: z.object({ apiRpm: z.number().int(), apiRpmPerUser: z.number().int() }),
    /** API requests per day for the last 30 days (oldest first; days without traffic are 0). */
    apiRequests: z.array(z.object({ day: z.iso.date(), count: z.number().int() })),
  })
  .openapi('UsageResponse');

export const SalesModeUpdate = z.object({ salesMode: z.enum(['b2b_only', 'b2c_only', 'both']) }).strict().openapi('SalesModeUpdate');

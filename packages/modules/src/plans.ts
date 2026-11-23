import plansJson from './plans.json';
import { getModule, isModuleId, MODULES, type ModuleId } from './index';

// Plans, entitlements and quota dimensions (TEN-09, MOD-04, ADR-0014 §3). Plans are code, like the module
// catalogue: a tenant row only names its plan, its add-on modules and any negotiated limit overrides.

export type Tier = 'starter' | 'growth' | 'enterprise';
export type PlanId = 'trial' | 'starter' | 'growth' | 'enterprise';

/** Quota dimensions that are measured against a limit. */
export const QUOTA_DIMENSIONS = ['users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens'] as const;
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];
/** Rate dimensions: requests per minute, enforced by token buckets rather than counted. */
export const RATE_DIMENSIONS = ['api_rpm', 'api_rpm_per_user'] as const;
export type RateDimension = (typeof RATE_DIMENSIONS)[number];
export type LimitDimension = QuotaDimension | RateDimension;
export type PlanLimits = Record<LimitDimension, number>;

export interface PlanDef {
  id: PlanId;
  displayNameKey: string;
  tier: Tier;
  trialDays?: number;
  limits: PlanLimits;
}

export const PLANS: readonly PlanDef[] = plansJson.plans as PlanDef[];
const PLAN_BY_ID = new Map<string, PlanDef>(PLANS.map((p) => [p.id, p]));

export function isPlanId(id: string): id is PlanId {
  return PLAN_BY_ID.has(id);
}

export function getPlan(id: string): PlanDef {
  const p = PLAN_BY_ID.get(id);
  if (!p) throw new Error(`unknown plan ${id}`);
  return p;
}

/** Plan limits with the tenant's overrides applied (unknown keys and non-integers are ignored). */
export function effectiveLimits(planId: string, overrides: Readonly<Record<string, unknown>> = {}): PlanLimits {
  const limits = { ...getPlan(planId).limits };
  for (const key of [...QUOTA_DIMENSIONS, ...RATE_DIMENSIONS]) {
    const v = overrides[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) limits[key] = v;
  }
  return limits;
}

export type Entitlement = 'included' | 'add_on' | 'available_add_on' | 'not_in_plan';

/** How a module relates to a tenant's plan: in its tier, bought as an add-on, purchasable, or unavailable. */
export function entitlement(planId: string, addOns: readonly string[], moduleId: ModuleId): Entitlement {
  const m = getModule(moduleId);
  if (m.alwaysOn || m.planEntitlement.includedIn.includes(getPlan(planId).tier)) return 'included';
  if (m.planEntitlement.addOn) return addOns.includes(moduleId) ? 'add_on' : 'available_add_on';
  return 'not_in_plan';
}

export function entitled(planId: string, addOns: readonly string[], moduleId: string): boolean {
  if (!isModuleId(moduleId)) return false;
  const e = entitlement(planId, addOns, moduleId);
  return e === 'included' || e === 'add_on';
}

/** Modules of the catalogue the plan allows. */
export function entitledModules(planId: string, addOns: readonly string[]): ModuleId[] {
  return MODULES.filter((m) => entitled(planId, addOns, m.id)).map((m) => m.id);
}

export type QuotaLevel = 'ok' | 'warning' | 'soft' | 'hard';
/** ADR-0014 §3: 80 % warns, 100 % blocks new invitations and uploads, 120 % blocks the related writes. */
export const QUOTA_THRESHOLDS: Readonly<Record<Exclude<QuotaLevel, 'ok'>, number>> = { warning: 0.8, soft: 1, hard: 1.2 };

export function quotaLevel(used: number, limit: number): QuotaLevel {
  if (limit <= 0) return used > 0 ? 'hard' : 'ok';
  const r = used / limit;
  if (r >= QUOTA_THRESHOLDS.hard) return 'hard';
  if (r >= QUOTA_THRESHOLDS.soft) return 'soft';
  if (r >= QUOTA_THRESHOLDS.warning) return 'warning';
  return 'ok';
}

/** Whether adding `increment` keeps usage within the level a write of this kind tolerates. A `soft` check
 *  (invitations, uploads) refuses once the limit would be passed; a `hard` check (record creation) refuses
 *  only past 120 %. A zero limit with a soft check refuses everything (the dimension is not in the plan). */
export function quotaAllows(used: number, limit: number, increment: number, check: 'soft' | 'hard'): boolean {
  const after = used + increment;
  return check === 'soft' ? after <= limit : after <= Math.floor(limit * QUOTA_THRESHOLDS.hard);
}

function assertPlansValid(): void {
  for (const p of PLANS) {
    for (const k of [...QUOTA_DIMENSIONS, ...RATE_DIMENSIONS]) {
      if (!Number.isInteger(p.limits[k]) || p.limits[k] < 0) throw new Error(`plan ${p.id}: limit ${k} must be a non-negative integer`);
    }
    if (p.limits.api_rpm_per_user > p.limits.api_rpm) throw new Error(`plan ${p.id}: per-user rate above tenant rate`);
  }
}
assertPlansValid();

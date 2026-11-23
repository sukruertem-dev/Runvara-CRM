import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthzContext } from '@flexa/authz';
import type { PlanId, PlanLimits } from '@flexa/modules';
import type { FastifyRequest } from 'fastify';
import type { AccessInfo } from './record-access';

export interface Principal {
  userId: string;
  sessionId: string;
  /** From the signed access token only (ADR-0003 §4) — never from the body, query or headers. */
  tenantId: string | null;
  amr: string[];
  /** Set when the caller authenticated with an API key (acts as its creator, narrowed to its scopes). */
  apiKey?: { id: string; scopes: ('read' | 'write')[]; rateLimitPerMinute: number };
}

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  salesMode: 'b2b_only' | 'b2c_only' | 'both';
  locale: string;
  timezone: string;
  currency: string;
}

export type Segment = 'b2b' | 'b2c';

/** The tenant's plan with overrides applied (TEN-09, MOD-04). */
export interface TenantPlanInfo {
  id: PlanId;
  addOns: readonly string[];
  limits: PlanLimits;
  trialEndsAt: Date | null;
}

export interface TenantRequestContext {
  principal: Principal & { tenantId: string };
  tenant: TenantInfo;
  plan: TenantPlanInfo;
  authz: AuthzContext;
  /** Segments this request may see (ADR-0010 §6): the user's active grants ∩ the tenant's sales mode,
   *  optionally narrowed by the `X-Segment` header (the segment switcher only narrows). */
  segments: readonly Segment[];
  /** The same before the switcher narrows it: what the segment switcher may offer. */
  availableSegments: readonly Segment[];
  /** Teams, queues, hierarchy, sharing and field policies of the caller (record-access.ts). */
  access: AccessInfo;
  /** Set when an automation rule acts: events it causes continue the chain (ADR-0006 §3). */
  automation?: { ruleId: string; correlationId: string; causationId: string; depth: number };
}

export function segmentsForSalesMode(mode: TenantInfo['salesMode']): readonly Segment[] {
  return mode === 'b2b_only' ? ['b2b'] : mode === 'b2c_only' ? ['b2c'] : ['b2b', 'b2c'];
}

/** The only way request handlers open a tenant transaction: tenant, user and segments from the verified context. */
export function dbCtx(t: TenantRequestContext): { tenantId: string; userId: string; segments: readonly Segment[] } {
  return { tenantId: t.tenant.id, userId: t.principal.userId, segments: t.segments };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    tenantCtx?: TenantRequestContext;
  }
}

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<FastifyRequest>().principal;
  if (!p) throw new Error('AccessGuard missing on route');
  return p;
});

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantRequestContext => {
  const t = ctx.switchToHttp().getRequest<FastifyRequest>().tenantCtx;
  if (!t) throw new Error('TenantGuard missing on route');
  return t;
});

export interface ClientInfo {
  ip: string;
  userAgent: string | null;
}

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 400) : null };
});

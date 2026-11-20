import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthzContext } from '@runvara/authz';
import type { FastifyRequest } from 'fastify';

export interface Principal {
  userId: string;
  sessionId: string;
  /** From the signed access token only (ADR-0003 §4) — never from the body, query or headers. */
  tenantId: string | null;
  amr: string[];
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

export interface TenantRequestContext {
  principal: Principal & { tenantId: string };
  tenant: TenantInfo;
  authz: AuthzContext;
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

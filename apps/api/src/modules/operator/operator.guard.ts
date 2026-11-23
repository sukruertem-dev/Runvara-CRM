import { createParamDecorator, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { sql, type DbHandle } from '@flexa/db';
import type { TokenSigner } from '@flexa/security';
import type { FastifyRequest } from 'fastify';
import { authenticate } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import type { Principal } from '../../common/request-context';
import { DB, SIGNER } from '../../infra/tokens';

// Platform operator endpoints (TEN-08, docs/p7-plan.md §13): a user marked in platform_operators whose
// session was opened with a second factor. API keys never qualify. A session inside a support grant may only
// leave it (`allowSupport`).

export interface OperatorPrincipal extends Principal {
  operator: true;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: OperatorPrincipal;
  }
}

const SECOND_FACTORS = ['otp', 'recovery'];

async function operatorFrom(req: FastifyRequest, signer: TokenSigner, db: DbHandle, allowSupport: boolean): Promise<OperatorPrincipal> {
  const principal = await authenticate(req, signer, db, { allowEndedSupport: allowSupport });
  if (principal.apiKey) throw new ProblemError('API_KEY_SCOPE', 'operator endpoints are not available to API keys');
  if (principal.support && !allowSupport) throw new ProblemError('FORBIDDEN', 'leave the support session first');
  const isOperator = await db.withUser(principal.userId, async (tx) => (await tx.execute<{ ok: boolean }>(sql`SELECT app.is_operator() AS ok`)).rows[0]?.ok === true);
  if (!isOperator) throw new ProblemError('OPERATOR_REQUIRED');
  if (!principal.amr.some((a) => SECOND_FACTORS.includes(a))) throw new ProblemError('OPERATOR_MFA_REQUIRED');
  return { ...principal, operator: true };
}

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    req.operator = await operatorFrom(req, this.signer, this.db, false);
    return true;
  }
}

/** For leaving a support session: the same checks, but the session may be bound to a tenant. */
@Injectable()
export class OperatorExitGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    req.operator = await operatorFrom(req, this.signer, this.db, true);
    return true;
  }
}

export const CurrentOperator = createParamDecorator((_: unknown, ctx: ExecutionContext): OperatorPrincipal => {
  const o = ctx.switchToHttp().getRequest<FastifyRequest>().operator;
  if (!o) throw new Error('OperatorGuard missing on route');
  return o;
});

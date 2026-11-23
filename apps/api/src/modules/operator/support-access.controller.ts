import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { SupportDecision, type z } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { grantView, type GrantRow } from './operator.service';

/** The workspace side of support access (TEN-08): only its Admins decide, and they can end it at any time. */
@Controller('v1/support-access')
@UseGuards(TenantGuard)
export class SupportAccessController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get()
  list(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => ({
      data: (await tx.execute<GrantRow>(sql`SELECT * FROM support_access_grants ORDER BY requested_at DESC LIMIT 100`)).rows.map(grantView),
    }));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(SupportDecision)) body: z.infer<typeof SupportDecision>, @Client() c: ClientInfo) {
    return this.decide(t, id, 'pending', 'approved', body.note ?? null, c.ip);
  }

  @Post(':id/deny')
  @HttpCode(200)
  deny(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(SupportDecision)) body: z.infer<typeof SupportDecision>, @Client() c: ClientInfo) {
    return this.decide(t, id, 'pending', 'denied', body.note ?? null, c.ip);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo) {
    return this.decide(t, id, 'approved', 'revoked', null, c.ip);
  }

  private decide(t: TenantRequestContext, id: string, from: 'pending' | 'approved', to: 'approved' | 'denied' | 'revoked', note: string | null, ip: string) {
    authorize(t, 'tenant.config.manage');
    // An operator in a support session never decides about support access, not even read-only.
    if (t.principal.support) throw new ProblemError('SUPPORT_READ_ONLY');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = (await tx.execute<GrantRow>(sql`SELECT * FROM support_access_grants WHERE id = ${id} FOR UPDATE`)).rows[0];
      if (!cur) throw new ProblemError('NOT_FOUND');
      const view = grantView(cur);
      if (view.status !== from) throw new ProblemError('CONFLICT', `the request is ${view.status}`);
      const me = t.principal.userId;
      const row = (await tx.execute<GrantRow>(to === 'revoked'
        ? sql`UPDATE support_access_grants SET status = 'revoked', revoked_by = ${me}, revoked_at = now() WHERE id = ${id} RETURNING *`
        : sql`UPDATE support_access_grants SET status = ${to}, decided_by = ${me}, decided_at = now(), decision_note = ${note},
            valid_until = ${to === 'approved' ? sql`now() + make_interval(mins => ${cur.duration_minutes})` : null} WHERE id = ${id} RETURNING *`)).rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      await audit(tx, t.tenant.id, { action: `support.${to}`, actorId: me, targetType: 'support_grant', targetId: id, ip, details: { note, operator: cur.operator_name } });
      return grantView(row);
    });
  }
}

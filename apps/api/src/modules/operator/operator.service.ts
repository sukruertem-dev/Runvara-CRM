import { Inject, Injectable } from '@nestjs/common';
import type { OperatorPlanUpdate, OperatorTenantCreate, SupportRequestCreate, TenantTransition, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { effectiveLimits, getModule, isModuleId, isPlanId, QUOTA_DIMENSIONS, quotaLevel } from '@flexa/modules';
import type { FastifyRequest } from 'fastify';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import { DB, ENV, MAILER, REDIS, type ApiEnv, type Mailer, type Redis } from '../../infra/tokens';
import { SessionService } from '../auth/session.service';
import { exportView, ExportsService } from '../privacy/exports.service';
import { transitionTx, type TenantStatus } from '../tenancy/lifecycle';
import { enabledModules } from '../tenancy/modules';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { measureAll } from '../usage/measure';
import type { OperatorPrincipal } from './operator.guard';

// Platform operator console (TEN-01/02/08/09, docs/p7-plan.md §13–14). The operator sees tenant metadata
// only; record content is reachable solely through support access the tenant approved.

type TenantRow = {
  id: string; slug: string; name: string; status: TenantStatus; sales_mode: 'b2b_only' | 'b2c_only' | 'both'; created_at: Date | string;
  status_changed_at: Date | string; deletion_scheduled_at: Date | string | null; plan_id: string | null; add_ons: string[] | null;
  limit_overrides: Record<string, number> | null; trial_ends_at: Date | string | null; members: number;
};

export type GrantRow = {
  id: string; tenant_id: string; operator_user_id: string; operator_name: string; reason: string; modules: string[]; duration_minutes: number;
  status: 'pending' | 'approved' | 'denied' | 'revoked' | 'cancelled'; requested_at: Date | string; decided_at: Date | string | null;
  decision_note: string | null; valid_until: Date | string | null;
};

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

const tenantView = (r: TenantRow) => ({
  id: r.id, slug: r.slug, name: r.name, status: r.status, salesMode: r.sales_mode, createdAt: new Date(r.created_at).toISOString(),
  statusChangedAt: new Date(r.status_changed_at).toISOString(), deletionScheduledAt: iso(r.deletion_scheduled_at),
  plan: r.plan_id ? { id: r.plan_id, addOns: r.add_ons ?? [], limitOverrides: r.limit_overrides ?? {}, trialEndsAt: iso(r.trial_ends_at) } : null,
  members: r.members,
});

/** Approved grants show as expired once their time is over. */
export const grantView = (g: GrantRow) => ({
  id: g.id, tenantId: g.tenant_id, operator: { id: g.operator_user_id, name: g.operator_name }, reason: g.reason, modules: g.modules,
  durationMinutes: g.duration_minutes,
  status: g.status === 'approved' && g.valid_until !== null && new Date(g.valid_until).getTime() <= Date.now() ? ('expired' as const) : g.status,
  requestedAt: new Date(g.requested_at).toISOString(), decidedAt: iso(g.decided_at), decisionNote: g.decision_note, validUntil: iso(g.valid_until),
});

@Injectable()
export class OperatorService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly sessions: SessionService,
    private readonly provisioning: ProvisioningService,
    private readonly exports: ExportsService,
  ) {}

  private ctx(op: OperatorPrincipal, tenantId: string) {
    return { tenantId, userId: op.userId, segments: ['b2b', 'b2c'] as const };
  }

  /** Global evidence of every operator action (kept after a tenant is deleted). */
  private async log(op: OperatorPrincipal, tenantId: string | null, action: string, details: Record<string, unknown>, ip: string | null): Promise<void> {
    const name = (await this.sessions.userSummary(op.userId)).displayName;
    await this.db.withUser(op.userId, (tx) => tx.execute(sql`INSERT INTO operator_actions (operator_user_id, operator_name, tenant_id, action, details, ip)
      VALUES (${op.userId}, ${name}, ${tenantId}, ${action}, ${JSON.stringify(details)}::jsonb, ${ip}::inet)`));
  }

  private async rows(op: OperatorPrincipal): Promise<TenantRow[]> {
    return this.db.withUser(op.userId, async (tx) => (await tx.execute<TenantRow>(sql`SELECT * FROM app.operator_tenants()`)).rows);
  }

  private async row(op: OperatorPrincipal, id: string): Promise<TenantRow> {
    const r = (await this.rows(op)).find((x) => x.id === id);
    if (!r) throw new ProblemError('NOT_FOUND');
    return r;
  }

  async list(op: OperatorPrincipal) {
    return { data: (await this.rows(op)).map(tenantView) };
  }

  async detail(op: OperatorPrincipal, id: string) {
    const base = await this.row(op, id);
    if (base.status === 'deleted') {
      return { ...tenantView(base), modules: [], usage: [], support: [], actions: await this.actions(op, id) };
    }
    return this.db.withTenant(this.ctx(op, id), async (tx) => {
      const modules = [...(await enabledModules(tx))].sort();
      const usage = await measureAll(tx, this.redis, id);
      const limits = effectiveLimits(base.plan_id && isPlanId(base.plan_id) ? base.plan_id : 'trial', base.limit_overrides ?? {});
      const grants = (await tx.execute<GrantRow>(sql`SELECT * FROM support_access_grants ORDER BY requested_at DESC LIMIT 50`)).rows;
      return {
        ...tenantView(base),
        modules,
        usage: QUOTA_DIMENSIONS.map((d) => ({ dimension: d, used: usage[d], limit: limits[d], level: quotaLevel(usage[d], limits[d]) })),
        support: grants.map(grantView),
        actions: await this.actionsTx(tx, id),
      };
    });
  }

  private async actions(op: OperatorPrincipal, id: string) {
    return this.db.withUser(op.userId, (tx) => this.actionsTx(tx, id));
  }

  private async actionsTx(tx: Db, id: string) {
    const r = await tx.execute<{ action: string; at: Date | string; operator_name: string | null; details: Record<string, unknown> }>(sql`
      SELECT action, at, operator_name, details FROM operator_actions WHERE tenant_id = ${id} ORDER BY at DESC LIMIT 50`);
    return r.rows.map((a) => ({ action: a.action, at: new Date(a.at).toISOString(), operator: a.operator_name, details: a.details }));
  }

  async create(op: OperatorPrincipal, body: z.infer<typeof OperatorTenantCreate>, ip: string) {
    const { tenantId, invitationToken } = await this.provisioning.createTenantForOperator(body, op.userId, ip);
    await this.mailer.send({
      template: 'invitation', to: body.adminEmail, locale: body.locale,
      vars: { tenantName: body.name, inviterName: 'Flexa', url: new URL(`/invite?token=${invitationToken}`, this.env.WEB_BASE_URL).toString() },
    });
    await this.log(op, tenantId, 'tenant.created', { slug: body.slug, plan: body.plan }, ip);
    return tenantView(await this.row(op, tenantId));
  }

  async setPlan(op: OperatorPrincipal, id: string, body: z.infer<typeof OperatorPlanUpdate>, ip: string) {
    const before = await this.row(op, id);
    if (before.status === 'deleted') throw new ProblemError('NOT_FOUND');
    for (const m of body.addOns) {
      if (!isModuleId(m) || !getModule(m).planEntitlement.addOn) throw new ProblemError('VALIDATION_FAILED', `${m} is not an add-on module`);
    }
    const trialEndsAt = body.plan === 'trial' ? new Date(body.trialEndsAt ?? Date.now() + 14 * 86_400_000) : null;
    await this.db.withTenant(this.ctx(op, id), async (tx) => {
      await tx.execute(sql`UPDATE tenant_plans SET plan_id = ${body.plan}, add_ons = ${`{${body.addOns.join(',')}}`}::text[],
        limit_overrides = ${JSON.stringify(body.limitOverrides)}::jsonb, trial_ends_at = ${trialEndsAt} WHERE tenant_id = ${id}`);
      // Rate limits, quotas and entitlement are read per request; the epoch makes cached views refresh.
      await tx.execute(sql`UPDATE tenants SET authz_epoch = authz_epoch + 1 WHERE id = ${id}`);
      await audit(tx, id, { action: 'tenant.plan_changed', actorType: 'operator', actorId: op.userId, targetType: 'tenant', targetId: id, ip,
        details: { from: before.plan_id, to: body.plan, addOns: body.addOns, limitOverrides: body.limitOverrides, reason: body.reason } });
    });
    await this.log(op, id, 'tenant.plan_changed', { from: before.plan_id, to: body.plan, addOns: body.addOns, limitOverrides: body.limitOverrides, reason: body.reason }, ip);
    return tenantView(await this.row(op, id));
  }

  async transition(op: OperatorPrincipal, id: string, body: z.infer<typeof TenantTransition>, ip: string) {
    const before = await this.row(op, id);
    if (before.status === 'deleted') throw new ProblemError('NOT_FOUND');
    const r = await this.db.withTenant(this.ctx(op, id), (tx) => transitionTx(tx, id, body.to, { actorId: op.userId, actorType: 'operator', ip }, body.reason));
    await this.log(op, id, 'tenant.status_changed', { from: r.from, to: r.to, reason: body.reason }, ip);
    return tenantView(await this.row(op, id));
  }

  async requestSupport(op: OperatorPrincipal, id: string, body: z.infer<typeof SupportRequestCreate>, ip: string) {
    const t = await this.row(op, id);
    if (t.status !== 'trial' && t.status !== 'active') throw new ProblemError('TENANT_TRANSITION_INVALID', 'support access needs an active workspace');
    for (const m of body.modules) if (!isModuleId(m)) throw new ProblemError('VALIDATION_FAILED', `unknown module ${m}`);
    const name = (await this.sessions.userSummary(op.userId)).displayName;
    const grant = await this.db.withTenant(this.ctx(op, id), async (tx) => {
      const g = (await tx.execute<GrantRow>(sql`INSERT INTO support_access_grants (tenant_id, operator_user_id, operator_name, reason, modules, duration_minutes)
        VALUES (${id}, ${op.userId}, ${name}, ${body.reason}, ${`{${body.modules.join(',')}}`}::text[], ${body.durationMinutes}) RETURNING *`)).rows[0];
      if (!g) throw new ProblemError('INTERNAL');
      await audit(tx, id, { action: 'support.requested', actorType: 'operator', actorId: op.userId, targetType: 'support_grant', targetId: g.id, ip,
        details: { reason: body.reason, modules: body.modules, durationMinutes: body.durationMinutes } });
      const admins = (await tx.execute<{ email: string; locale: string }>(sql`SELECT DISTINCT u.email::text AS email, u.locale FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id AND r.key = 'admin'
        JOIN memberships m ON m.user_id = ur.user_id AND m.status = 'active'
        JOIN users u ON u.id = ur.user_id
        WHERE ur.valid_until IS NULL OR ur.valid_until > now()`)).rows;
      return { g, admins };
    });
    const url = new URL('/settings/support', this.env.WEB_BASE_URL).toString();
    for (const a of grant.admins) {
      await this.mailer.send({
        template: 'support_request', to: a.email, locale: a.locale === 'en-US' ? 'en-US' : 'tr-TR',
        vars: { tenantName: t.name, operatorName: name, reason: body.reason, minutes: body.durationMinutes, url },
      }, { jobId: `support:${grant.g.id}:${a.email}` });
    }
    await this.log(op, id, 'support.requested', { grantId: grant.g.id, durationMinutes: body.durationMinutes }, ip);
    return grantView(grant.g);
  }

  async grants(op: OperatorPrincipal) {
    const rows = await this.db.withUser(op.userId, async (tx) => (await tx.execute<GrantRow & { tenant_name: string }>(sql`SELECT * FROM app.operator_grants()`)).rows);
    return { data: rows.map(grantView) };
  }

  private async ownGrant(op: OperatorPrincipal, grantId: string): Promise<GrantRow> {
    const g = (await this.db.withUser(op.userId, async (tx) => (await tx.execute<GrantRow>(sql`SELECT * FROM app.operator_grants() WHERE id = ${grantId}`)).rows))[0];
    if (!g) throw new ProblemError('NOT_FOUND');
    return g;
  }

  /** Withdraws a pending request or ends approved access early. */
  async cancel(op: OperatorPrincipal, grantId: string, ip: string) {
    const g = await this.ownGrant(op, grantId);
    const to = g.status === 'pending' ? 'cancelled' : g.status === 'approved' ? 'revoked' : null;
    if (!to) throw new ProblemError('CONFLICT', `the request is ${g.status}`);
    const row = await this.db.withTenant(this.ctx(op, g.tenant_id), async (tx) => {
      const r = (await tx.execute<GrantRow>(sql`UPDATE support_access_grants SET status = ${to},
        revoked_by = ${to === 'revoked' ? op.userId : null}, revoked_at = ${to === 'revoked' ? new Date() : null}
        WHERE id = ${grantId} AND status = ${g.status} RETURNING *`)).rows[0];
      if (!r) throw new ProblemError('CONFLICT', 'the request changed meanwhile');
      await audit(tx, g.tenant_id, { action: `support.${to}`, actorType: 'operator', actorId: op.userId, targetType: 'support_grant', targetId: grantId, ip });
      return r;
    });
    await this.log(op, g.tenant_id, `support.${to}`, { grantId }, ip);
    return grantView(row);
  }

  async enter(op: OperatorPrincipal, grantId: string, req: FastifyRequest) {
    const g = await this.ownGrant(op, grantId);
    const view = grantView(g);
    if (view.status !== 'approved') throw new ProblemError('SUPPORT_ACCESS_ENDED', `the request is ${view.status}`);
    const session = await this.sessions.enterSupport(op.userId, op.sessionId, op.amr, grantId, req);
    await this.db.withTenant(this.ctx(op, g.tenant_id), (tx) => audit(tx, g.tenant_id, {
      action: 'support.entered', actorType: 'operator', actorId: op.userId, targetType: 'support_grant', targetId: grantId, ip: req.ip,
    }));
    await this.log(op, g.tenant_id, 'support.entered', { grantId }, req.ip);
    return session;
  }

  async exit(op: OperatorPrincipal, req: FastifyRequest) {
    return this.sessions.exitSupport(op.userId, op.sessionId, op.amr, req);
  }

  async requestExport(op: OperatorPrincipal, id: string, ip: string) {
    const t = await this.row(op, id);
    if (t.status === 'deleted') throw new ProblemError('NOT_FOUND');
    const row = await this.db.withTenant(this.ctx(op, id), (tx) => this.exports.requestTx(tx, id, op.userId, 'operator', ip));
    await this.exports.enqueue(id, row.id);
    await this.log(op, id, 'tenant.export_requested', { exportId: row.id }, ip);
    return exportView(row);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { can } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import type { ApprovalCreate, ApprovalListQuery, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { contextForUser } from '../../common/access-loader';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { buildTenantContext } from '../../common/guards';
import { mapDbError } from '../../common/http-helpers';
import { notify } from '../../common/notify';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { assertCan, hiddenFields, recordPredicate } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, readCrmRow } from '../crm/crm-objects';

// Approval engine (docs/p8-plan.md §7–9, ADR-0021). A request goes to the lowest manager above the requester
// whose limit covers it and who can see the subject; nobody who may not decide it is ever assigned, and the
// decision checks the same again. Past the deadline it moves up; with the Admins it expires (fails closed).

const PERMISSION = { discount: 'sales_b2b.discount.approve' } as const;
type Kind = keyof typeof PERMISSION;
interface DiscountPolicy { freePercent: number; managerPercent: number; timeoutHours: number }

type Row = {
  id: string; kind: Kind; subject_type: 'opportunity'; subject_id: string; segment: Segment; requested_by: string; percent: string; reason: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'; automatic: boolean; level: number; assigned_to: string | null; level_team_id: string | null;
  due_at: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null; created_at: string;
  quote_id: string | null; quote_version: number | null; quote_number: string | null;
  requester_name: string; assignee_name: string | null; decider_name: string | null; title: string | null;
  steps: { action: string; actorId: string | null; actor: string | null; assignedToId: string | null; assignedTo: string | null; at: string }[] | null;
};
interface Route { assignedTo: string | null; teamId: string | null }

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
const person = (id: string | null, name: string | null) => (id ? { id, displayName: name ?? '' } : null);

export async function readApprovalPolicy(tx: Db, tenantId: string): Promise<DiscountPolicy> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT s.value FROM tenant_settings_head h JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = 'approvals'`);
  const def = configKey('approvals');
  if (!def) throw new Error('approvals config key is not registered');
  return (mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as { discount: DiscountPolicy }).discount;
}

@Injectable()
export class ApprovalsService {
  private readonly log = new Logger('approvals');

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  // ------------------------------------------------------------------ authority
  /** The percentage a person may approve: unlimited for a full grant, their own or the default limit when the
   *  grant carries `approve_within_limit`, null without the right to approve. */
  private async limitOf(tx: Db, t: TenantRequestContext, kind: Kind, policy: DiscountPolicy): Promise<number | null> {
    if (this.isFull(t, kind)) return 100;
    const d = can(t.authz, PERMISSION[kind], 'approve');
    if (!d.allow) return null;
    if (!d.grant.constraints?.includes('approve_within_limit')) return 100;
    const r = await tx.execute<{ max_percent: string }>(sql`SELECT max_percent FROM approval_limits WHERE user_id = ${t.principal.userId} AND kind = ${kind}`);
    return r.rows[0] ? Number(r.rows[0].max_percent) : policy.managerPercent;
  }

  /** Decides for everyone, at every level (Admin). */
  private isFull(t: TenantRequestContext, kind: Kind): boolean {
    const d = can(t.authz, PERMISSION[kind], 'full');
    return d.allow && d.grant.scope === 'all';
  }

  private async seesSubject(tx: Db, t: TenantRequestContext, subjectId: string, segment: Segment): Promise<boolean> {
    if (!t.segments.includes(segment)) return false;
    const r = await tx.execute(sql`SELECT 1 FROM ${CRM.opportunity.from} WHERE t.id = ${subjectId} AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')}`);
    return (r.rowCount ?? 0) > 0;
  }

  /** The next approver from team `from` upwards (itself included). Several eligible managers of one team share
   *  the work: the one with the fewest pending requests. Nobody → any Admin. */
  private async route(tx: Db, t: TenantRequestContext, req: { kind: Kind; requester: string; percent: number; subjectId: string; segment: Segment }, from: string | null, policy: DiscountPolicy): Promise<Route> {
    if (from) {
      const teams = await tx.execute<{ id: string; managers: string[] | null }>(sql`
        WITH RECURSIVE up(id, parent, n) AS (
          SELECT id, parent_team_id, 0 FROM teams WHERE id = ${from}
          UNION ALL SELECT t.id, t.parent_team_id, up.n + 1 FROM teams t JOIN up ON t.id = up.parent
        )
        SELECT up.id, (SELECT array_agg(m.user_id::text ORDER BY
            (SELECT count(*) FROM approval_requests r WHERE r.assigned_to = m.user_id AND r.state = 'pending'), m.user_id)
          FROM team_members m WHERE m.team_id = up.id AND m.role = 'manager' AND m.user_id <> ${req.requester}) AS managers
        FROM up ORDER BY up.n`);
      for (const team of teams.rows) {
        for (const userId of team.managers ?? []) {
          const ctx = await contextForUser(tx, t, userId);
          if (!ctx) continue;
          const limit = await this.limitOf(tx, ctx, req.kind, policy);
          if (limit === null || limit < req.percent) continue;
          if (await this.seesSubject(tx, ctx, req.subjectId, req.segment)) return { assignedTo: userId, teamId: team.id };
        }
      }
    }
    return { assignedTo: null, teamId: null };
  }

  private async adminIds(tx: Db): Promise<string[]> {
    const r = await tx.execute<{ u: string }>(sql`
      SELECT DISTINCT ur.user_id::text AS u FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN memberships m ON m.user_id = ur.user_id
      WHERE r.key = 'admin' AND m.status = 'active' AND (ur.valid_until IS NULL OR ur.valid_until > now())`);
    return r.rows.map((x) => x.u);
  }

  // ------------------------------------------------------------------ rows and views
  private async rows(tx: Db, where: SQL, limit = 200): Promise<Row[]> {
    return (await tx.execute<Row>(sql`
      SELECT a.*, a.percent::text AS percent, qt.number AS quote_number, ru.display_name AS requester_name, au.display_name AS assignee_name, du.display_name AS decider_name,
        (SELECT jsonb_agg(jsonb_build_object('action', s.action, 'actorId', s.actor_id, 'actor', su.display_name, 'assignedToId', s.assigned_to, 'assignedTo', tu.display_name, 'at', s.at) ORDER BY s.id)
           FROM approval_steps s LEFT JOIN users su ON su.id = s.actor_id LEFT JOIN users tu ON tu.id = s.assigned_to WHERE s.request_id = a.id) AS steps
      FROM approval_requests a JOIN users ru ON ru.id = a.requested_by LEFT JOIN quotes qt ON qt.tenant_id = a.tenant_id AND qt.id = a.quote_id LEFT JOIN users au ON au.id = a.assigned_to LEFT JOIN users du ON du.id = a.decided_by
      WHERE ${where} ORDER BY (a.state = 'pending') DESC, a.created_at DESC, a.id DESC LIMIT ${limit}`)).rows;
  }

  private async views(tx: Db, t: TenantRequestContext, rows: readonly Row[]) {
    // The subject's name only for those who can read it now.
    const ids = [...new Set(rows.map((r) => r.subject_id))];
    const titles = ids.length
      ? new Map((await tx.execute<{ id: string; name: string }>(sql`SELECT t.id, t.name FROM ${CRM.opportunity.from}
          WHERE t.id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')}`)).rows.map((r) => [r.id, r.name]))
      : new Map<string, string>();
    const policy = await readApprovalPolicy(tx, t.tenant.id);
    const limits = new Map<Kind, number | null>();
    for (const r of rows) if (!limits.has(r.kind)) limits.set(r.kind, await this.limitOf(tx, t, r.kind, policy));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, subject: { type: r.subject_type, id: r.subject_id, title: titles.get(r.subject_id) ?? null }, segment: r.segment,
      quote: r.quote_id && titles.has(r.subject_id) && !hiddenFields(t, 'opportunity').has('amount') ? { id: r.quote_id, number: r.quote_number ?? '', version: r.quote_version ?? 0 } : null,
      requestedBy: { id: r.requested_by, displayName: r.requester_name }, percent: r.percent, reason: r.reason, state: r.state, automatic: r.automatic, level: r.level,
      assignedTo: person(r.assigned_to, r.assignee_name), dueAt: iso(r.due_at), decidedBy: person(r.decided_by, r.decider_name), decidedAt: iso(r.decided_at),
      decisionNote: r.decision_note, createdAt: new Date(r.created_at).toISOString(),
      canDecide: r.state === 'pending' && r.requested_by !== t.principal.userId && titles.has(r.subject_id)
        && (r.assigned_to === t.principal.userId || this.isFull(t, r.kind)) && (limits.get(r.kind) ?? -1) >= Number(r.percent),
      steps: (r.steps ?? []).map((s) => ({ action: s.action, actor: person(s.actorId, s.actor), assignedTo: person(s.assignedToId, s.assignedTo), at: new Date(s.at).toISOString() })),
    }));
  }

  /** Requests the caller takes part in; an Admin sees every request (segments are RLS's job). */
  private visible(t: TenantRequestContext): SQL {
    if (this.isFull(t, 'discount')) return sql`TRUE`;
    const me = t.principal.userId;
    return sql`(a.requested_by = ${me} OR a.assigned_to = ${me} OR a.decided_by = ${me})`;
  }

  async list(t: TenantRequestContext, q: z.infer<typeof ApprovalListQuery>) {
    const me = t.principal.userId;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      let where: SQL;
      if (q.box === 'subject') {
        await readCrmRow(tx, t, CRM.opportunity, q.subjectId ?? '');
        where = sql`a.subject_type = 'opportunity' AND a.subject_id = ${q.subjectId}`;
      } else if (q.box === 'mine') where = sql`a.requested_by = ${me}`;
      else if (q.box === 'inbox') where = sql`a.state = 'pending' AND a.requested_by <> ${me} AND (a.assigned_to = ${me} ${this.isFull(t, 'discount') ? sql`OR a.assigned_to IS NULL` : sql``})`;
      else where = this.visible(t);
      return { data: await this.views(tx, t, await this.rows(tx, where)) };
    });
  }

  async get(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => this.one(tx, t, id));
  }

  private async one(tx: Db, t: TenantRequestContext, id: string) {
    const [view] = await this.views(tx, t, await this.rows(tx, sql`a.id = ${id} AND ${this.visible(t)}`));
    if (!view) throw new ProblemError('NOT_FOUND');
    return view;
  }

  // ------------------------------------------------------------------ writing helpers
  private async step(tx: Db, t: TenantRequestContext, requestId: string, action: string, actorId: string | null, assignedTo: string | null = null): Promise<void> {
    await tx.execute(sql`INSERT INTO approval_steps (tenant_id, request_id, action, actor_id, assigned_to) VALUES (${t.tenant.id}, ${requestId}, ${action}, ${actorId}, ${assignedTo})`);
  }

  /** Domain event on the subject (who may see the subject sees the event); no amounts or reasons inside. */
  private async event(tx: Db, t: TenantRequestContext, type: string, r: { id: string; kind: string; subject_id: string; segment: Segment; level: number }, actorId: string | null, extra: Record<string, unknown> = {}): Promise<void> {
    await tx.execute(sql`
      INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
      VALUES (${t.tenant.id}, ${type}, 'opportunity', ${r.subject_id}, ${r.segment}::segment, ${JSON.stringify({ type: actorId ? 'user' : 'system', id: actorId })}::jsonb,
        ${JSON.stringify({ requestId: r.id, kind: r.kind, level: r.level, ...extra })}::jsonb, gen_random_uuid())`);
  }

  private async tellApprovers(tx: Db, t: TenantRequestContext, id: string, subjectId: string, requester: string, route: Route): Promise<void> {
    const users = (route.assignedTo ? [route.assignedTo] : await this.adminIds(tx)).filter((u) => u !== requester);
    await notify(tx, t, { users, kind: 'approval', sourceType: 'approval_request', sourceId: id, recordType: 'opportunity', recordId: subjectId, includeActor: true });
  }

  // ------------------------------------------------------------------ request, decide, cancel
  request(t: TenantRequestContext, body: z.infer<typeof ApprovalCreate>, ip: string) {
    return this.db.withTenant(dbCtx(t), (tx) => this.requestTx(tx, t, { percent: body.percent, reason: body.reason, opportunityId: body.subject.id }, ip));
  }

  /** Asks for a discount of an opportunity, or of one of its quotes, in the caller's transaction. The reason may be
   *  left out only when nobody has to decide. */
  async requestTx(tx: Db, t: TenantRequestContext, ask: { percent: string; reason?: string | undefined; opportunityId: string; quote?: { id: string; version: number } }, ip: string) {
    const body = { kind: 'discount' as const, percent: ask.percent, subject: { id: ask.opportunityId } };
    authorize(t, PERMISSION[body.kind], 'request');
    const me = t.principal.userId;
    const percent = Number(body.percent);
    const subject = await readCrmRow(tx, t, CRM.opportunity, body.subject.id);
    await assertCan(tx, t, CRM.opportunity.shape, body.subject.id, 'update');
    const segment = subject.segment as Segment;
    if (segment !== 'b2b') throw new ProblemError('SEGMENT_NOT_ALLOWED', 'discounts are approved for B2B opportunities');
    const policy = await readApprovalPolicy(tx, t.tenant.id);
    const own = Math.max(policy.freePercent, (await this.limitOf(tx, t, body.kind, policy)) ?? 0);
    const automatic = percent <= own;
    if (!automatic && !ask.reason) throw new ProblemError('VALIDATION_FAILED', 'reason: the discount needs approval; say why', { reason: 'approval_reason_required', percent: ask.percent });
    const primary = await tx.execute<{ id: string | null }>(sql`SELECT primary_team_id AS id FROM memberships WHERE user_id = ${me}`);
    const route: Route = automatic
      ? { assignedTo: null, teamId: null }
      : await this.route(tx, t, { kind: body.kind, requester: me, percent, subjectId: body.subject.id, segment }, primary.rows[0]?.id ?? null, policy);
    let id: string;
    try {
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO approval_requests (tenant_id, kind, subject_type, subject_id, segment, requested_by, percent, reason, state, automatic, assigned_to, level_team_id, due_at, decided_at, quote_id, quote_version)
        VALUES (${t.tenant.id}, ${body.kind}, 'opportunity', ${body.subject.id}, ${segment}::segment, ${me}, ${body.percent}::numeric, ${ask.reason ?? 'Yetki içinde'},
          ${automatic ? 'approved' : 'pending'}, ${automatic}, ${route.assignedTo}, ${route.teamId},
          ${automatic ? null : sql`now() + make_interval(hours => ${policy.timeoutHours}::int)`}, ${automatic ? sql`now()` : null}, ${ask.quote?.id ?? null}, ${ask.quote?.version ?? null}) RETURNING id`);
      id = r.rows[0]?.id ?? '';
    } catch (e) {
      if (isUniqueViolation(e, 'approval_requests_one_pending')) throw new ProblemError('CONFLICT', 'a request for this record is pending');
      return mapDbError(e);
    }
    const ref = { id, kind: body.kind, subject_id: body.subject.id, segment, level: 1 };
    await this.step(tx, t, id, 'requested', me);
    if (automatic) await this.step(tx, t, id, 'auto_approved', null);
    else {
      await this.step(tx, t, id, 'assigned', null, route.assignedTo);
      await this.tellApprovers(tx, t, id, body.subject.id, me, route);
    }
    await this.event(tx, t, 'approval.requested', ref, me);
    await this.event(tx, t, 'discount.approval_requested', ref, me);
    if (automatic) await this.event(tx, t, 'approval.decided', ref, null, { decision: 'approved' });
    await audit(tx, t.tenant.id, { action: 'approval.requested', actorId: me, targetType: 'approval_request', targetId: id, ip, details: { kind: body.kind, subjectId: body.subject.id, percent: body.percent, automatic, assignedTo: route.assignedTo, ...(ask.quote ? { quoteId: ask.quote.id, quoteVersion: ask.quote.version } : {}) } });
    return this.one(tx, t, id);
  }

  async decide(t: TenantRequestContext, id: string, decision: 'approve' | 'reject', note: string | undefined, ip: string) {
    const me = t.principal.userId;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM approval_requests WHERE id = ${id} FOR UPDATE`);
      const [r] = await this.rows(tx, sql`a.id = ${id} AND ${this.visible(t)}`);
      if (!r) throw new ProblemError('NOT_FOUND');
      if (r.requested_by === me) throw new ProblemError('MANAGER_LIMIT', 'you cannot decide your own request', { reason: 'not_self' });
      if (r.state !== 'pending') throw new ProblemError('REQUEST_CLOSED');
      if (r.assigned_to !== me && !this.isFull(t, r.kind)) throw new ProblemError('FORBIDDEN');
      authorize(t, PERMISSION[r.kind], 'approve');
      if (!(await this.seesSubject(tx, t, r.subject_id, r.segment))) throw new ProblemError('NOT_FOUND');
      const limit = (await this.limitOf(tx, t, r.kind, await readApprovalPolicy(tx, t.tenant.id))) ?? -1;
      // Turning a request down needs no limit; granting it does.
      if (decision === 'approve' && limit < Number(r.percent)) throw new ProblemError('MANAGER_LIMIT', 'the request exceeds your limit', { reason: 'approve_within_limit', limit });
      const state = decision === 'approve' ? 'approved' : 'rejected';
      await tx.execute(sql`UPDATE approval_requests SET state = ${state}, decided_by = ${me}, decided_at = now(), decision_note = ${note || null}, due_at = NULL WHERE id = ${id}`);
      await this.close(tx, t, r, state, me);
      await audit(tx, t.tenant.id, { action: `approval.${state}`, actorId: me, targetType: 'approval_request', targetId: id, ip, details: { kind: r.kind, subjectId: r.subject_id, percent: r.percent, level: r.level } });
      return this.one(tx, t, id);
    });
  }

  /** History, event and notices of a decision; approvers who no longer need to act lose the unread notice. */
  private async close(tx: Db, t: TenantRequestContext, r: Row, state: 'approved' | 'rejected' | 'cancelled' | 'expired', actorId: string | null): Promise<void> {
    await this.step(tx, t, r.id, state, actorId);
    if (r.quote_id) {
      // Approved: the quote may be sent. Otherwise its version opens for editing again (ADR-0021).
      const moved = await tx.execute(sql`UPDATE quotes SET status = ${state === 'approved' ? 'approved' : 'draft'}, version = version + 1
        WHERE id = ${r.quote_id} AND status = 'pending_approval' AND current_version = ${r.quote_version}`);
      if ((moved.rowCount ?? 0) > 0 && state !== 'approved') await tx.execute(sql`UPDATE quote_versions SET locked_at = NULL WHERE quote_id = ${r.quote_id} AND version = ${r.quote_version}`);
    }
    await this.event(tx, t, 'approval.decided', r, actorId, { decision: state });
    const waiting = [...new Set([...(r.steps ?? []).map((s) => s.assignedToId).filter((x): x is string => x !== null), ...(await this.adminIds(tx))])];
    await tx.execute(sql`SELECT app.retract_notifications('approval_request', ${r.id}::uuid, ${`{${waiting.join(',')}}`}::uuid[])`);
    if (state !== 'cancelled') {
      await notify(tx, t, { users: [r.requested_by], kind: 'approval', sourceType: 'approval_decision', sourceId: r.id, recordType: 'opportunity', recordId: r.subject_id, includeActor: true });
    }
  }

  async cancel(t: TenantRequestContext, id: string, ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM approval_requests WHERE id = ${id} FOR UPDATE`);
      const [r] = await this.rows(tx, sql`a.id = ${id} AND ${this.visible(t)}`);
      if (!r) throw new ProblemError('NOT_FOUND');
      if (r.requested_by !== t.principal.userId) throw new ProblemError('FORBIDDEN');
      if (r.state !== 'pending') throw new ProblemError('REQUEST_CLOSED');
      await tx.execute(sql`UPDATE approval_requests SET state = 'cancelled', decided_at = now(), due_at = NULL WHERE id = ${id}`);
      await this.close(tx, t, r, 'cancelled', t.principal.userId);
      await audit(tx, t.tenant.id, { action: 'approval.cancelled', actorId: t.principal.userId, targetType: 'approval_request', targetId: id, ip });
      return this.one(tx, t, id);
    });
  }

  async decideMany(t: TenantRequestContext, ids: readonly string[], decision: 'approve' | 'reject', note: string | undefined, ip: string) {
    const data: { id: string; ok: boolean; code: string | null }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.decide(t, id, decision, note, ip);
        data.push({ id, ok: true, code: null });
      } catch (e) {
        if (!(e instanceof ProblemError)) throw e;
        data.push({ id, ok: false, code: e.code });
      }
    }
    return { data };
  }

  // ------------------------------------------------------------------ deadlines (background)
  /** Requests past their deadline move one level up; with the Admins they expire. */
  async runDue(limit = 200): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; id: string }>(sql`SELECT tenant_id, id FROM app.due_approvals(${limit})`)).rows);
    let handled = 0;
    for (const d of due) {
      try {
        if (await this.escalate(d.tenant_id, d.id)) handled += 1;
      } catch (e) {
        this.log.warn(`approval ${d.id} could not be escalated: ${(e as Error).message}`);
      }
    }
    return handled;
  }

  private async escalate(tenantId: string, id: string): Promise<boolean> {
    const both: Segment[] = ['b2b', 'b2c'];
    const requester = await this.db.withTenant({ tenantId, userId: null, segments: both }, async (tx) =>
      (await tx.execute<{ u: string; active: boolean }>(sql`SELECT a.requested_by AS u, m.status = 'active' AS active FROM approval_requests a JOIN memberships m ON m.user_id = a.requested_by WHERE a.id = ${id}`)).rows[0]);
    if (!requester) return false;
    // Any active member's context carries the tenant, plan and modules the routing needs.
    const actor = requester.active ? requester.u : await this.db.withTenant({ tenantId, userId: null }, async (tx) => (await this.adminIds(tx))[0] ?? null);
    if (!actor) return false;
    const t = await buildTenantContext(this.db, { userId: actor, sessionId: 'approvals', tenantId, amr: [] });
    return this.db.withTenant({ tenantId, userId: null, segments: both }, async (tx) => {
      const locked = await tx.execute(sql`SELECT 1 FROM approval_requests WHERE id = ${id} AND state = 'pending' AND due_at <= now() FOR UPDATE SKIP LOCKED`);
      const [r] = (locked.rowCount ?? 0) > 0 ? await this.rows(tx, sql`a.id = ${id}`) : [];
      if (!r) return false;
      if (!requester.active || r.assigned_to === null) {
        const state = requester.active ? 'expired' : 'cancelled';
        await tx.execute(sql`UPDATE approval_requests SET state = ${state}, decided_at = now(), due_at = NULL WHERE id = ${id}`);
        await this.close(tx, t, r, state, null);
        await audit(tx, tenantId, { action: `approval.${state}`, actorType: 'system', actorId: null, targetType: 'approval_request', targetId: id });
        return true;
      }
      const policy = await readApprovalPolicy(tx, tenantId);
      const parent = r.level_team_id ? (await tx.execute<{ p: string | null }>(sql`SELECT parent_team_id AS p FROM teams WHERE id = ${r.level_team_id}`)).rows[0]?.p ?? null : null;
      const next = await this.route(tx, t, { kind: r.kind, requester: r.requested_by, percent: Number(r.percent), subjectId: r.subject_id, segment: r.segment }, parent, policy);
      await tx.execute(sql`UPDATE approval_requests SET level = level + 1, assigned_to = ${next.assignedTo}, level_team_id = ${next.teamId},
        due_at = now() + make_interval(hours => ${policy.timeoutHours}::int) WHERE id = ${id}`);
      await this.step(tx, t, id, 'escalated', null, next.assignedTo);
      await this.event(tx, t, 'approval.escalated', { ...r, level: r.level + 1 }, null);
      await tx.execute(sql`SELECT app.retract_notifications('approval_request', ${id}::uuid, ${`{${r.assigned_to}}`}::uuid[])`);
      await this.tellApprovers(tx, t, id, r.subject_id, r.requested_by, next);
      await audit(tx, tenantId, { action: 'approval.escalated', actorType: 'system', actorId: null, targetType: 'approval_request', targetId: id, details: { from: r.assigned_to, to: next.assignedTo, level: r.level + 1 } });
      return true;
    });
  }

  // ------------------------------------------------------------------ approver limits
  async limits(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const policy = await readApprovalPolicy(tx, t.tenant.id);
      const people = await tx.execute<{ id: string; name: string; max: string | null }>(sql`
        SELECT DISTINCT u.id, u.display_name AS name, l.max_percent::text AS max FROM team_members m JOIN users u ON u.id = m.user_id
        JOIN memberships ms ON ms.user_id = m.user_id AND ms.status = 'active'
        LEFT JOIN approval_limits l ON l.user_id = m.user_id AND l.kind = 'discount'
        WHERE m.role = 'manager' ORDER BY u.display_name, u.id`);
      return { data: people.rows.map((p) => ({ user: { id: p.id, displayName: p.name }, maxPercent: p.max, effectivePercent: p.max ?? String(policy.managerPercent) })) };
    });
  }

  async setLimit(t: TenantRequestContext, userId: string, maxPercent: string | null, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const member = await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${userId}`);
      if ((member.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      if (maxPercent === null) await tx.execute(sql`DELETE FROM approval_limits WHERE user_id = ${userId} AND kind = 'discount'`);
      else {
        await tx.execute(sql`INSERT INTO approval_limits (tenant_id, user_id, kind, max_percent, updated_by) VALUES (${t.tenant.id}, ${userId}, 'discount', ${maxPercent}::numeric, ${t.principal.userId})
          ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET max_percent = EXCLUDED.max_percent, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      await audit(tx, t.tenant.id, { action: 'approval.limit_set', actorId: t.principal.userId, targetType: 'user', targetId: userId, ip, details: { kind: 'discount', maxPercent } });
    });
  }
}

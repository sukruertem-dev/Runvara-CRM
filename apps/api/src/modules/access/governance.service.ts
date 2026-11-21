import { Inject, Injectable } from '@nestjs/common';
import {
  allPermissions, baseGrantsFor, can, canAssignRole, grantsFor, moduleOfPermission, overrideKey, PROTECTED_PERMISSIONS, SYSTEM_ROLES, validateGrant,
  type Grant,
} from '@flexa/authz';
import type { AccessRequestCreate, AccessRequestDecision, DelegationCreate, MatrixChange, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { ProblemError } from '../../common/problem';
import { uuidArray } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';

const MAX_DELEGATION_DAYS = 90;
const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
const segLiteral = (s: readonly string[]) => sql`${`{${s.join(',')}}`}::segment[]`;
const parseSegs = (v: unknown): Segment[] => (Array.isArray(v) ? (v as Segment[]) : (typeof v === 'string' ? v : '').replace(/[{}]/g, '').split(',').filter(Boolean) as Segment[]);

type DelegationRow = { id: string; delegator_id: string; delegate_id: string; role_key: string | null; segments: unknown; reason: string | null; starts_at: string; ends_at: string; revoked_at: string | null };
type RequestRow = {
  id: string; requester_id: string; role_key: string | null; segments: unknown; reason: string; valid_until: string | null; status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  decided_by: string | null; decided_at: string | null; decision_note: string | null; created_at: string;
};
type AuditRow = { id: string; action: string; actor_type: string; actor_id: string | null; actor_name: string | null; target_type: string | null; target_id: string | null; ip: string | null; details: Record<string, unknown>; at: string };

const delegationView = (d: DelegationRow) => ({
  id: d.id, delegatorId: d.delegator_id, delegateId: d.delegate_id, roleKey: d.role_key, segments: parseSegs(d.segments), reason: d.reason,
  startsAt: new Date(d.starts_at).toISOString(), endsAt: new Date(d.ends_at).toISOString(), revokedAt: iso(d.revoked_at),
  active: d.revoked_at === null && new Date(d.ends_at) > new Date(),
});
const requestView = (r: RequestRow) => ({
  id: r.id, requesterId: r.requester_id, roleKey: r.role_key, segments: parseSegs(r.segments), reason: r.reason, validUntil: iso(r.valid_until),
  status: r.status, decidedBy: r.decided_by, decidedAt: iso(r.decided_at), decisionNote: r.decision_note, createdAt: new Date(r.created_at).toISOString(),
});
const sameGrant = (a: Grant | null | undefined, b: Grant | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Audit reading, delegation, access requests and matrix administration (docs/p4-plan.md §10). */
@Injectable()
export class GovernanceService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  private async bumpUsers(tx: Db, ids: readonly string[]): Promise<void> {
    if (ids.length) await tx.execute(sql`UPDATE memberships SET authz_version = authz_version + 1 WHERE user_id = ANY(${uuidArray(ids)})`);
  }

  // ------------------------------------------------------------------ audit (A23)
  async auditLog(t: TenantRequestContext, q: { action?: string; actorId?: string; targetType?: string; targetId?: string; from?: string; to?: string; before?: string; limit?: string }) {
    const d = authorize(t, 'audit.read', 'read');
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–200');
    const uuid = (v: string | undefined, name: string) => {
      if (v !== undefined && !/^[0-9a-f-]{36}$/i.test(v)) throw new ProblemError('VALIDATION_FAILED', `${name} must be a uuid`);
      return v;
    };
    const date = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const x = new Date(v);
      if (Number.isNaN(x.getTime())) throw new ProblemError('VALIDATION_FAILED', `${name} must be a timestamp`);
      return x;
    };
    const actorId = uuid(q.actorId, 'actorId');
    const targetId = uuid(q.targetId, 'targetId');
    const from = date(q.from, 'from');
    const to = date(q.to, 'to');
    let cursor: { at: string; id: string } | null = null;
    if (q.before) {
      try {
        cursor = JSON.parse(Buffer.from(q.before, 'base64url').toString('utf8')) as { at: string; id: string };
        if (typeof cursor.at !== 'string' || typeof cursor.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(cursor.id) || Number.isNaN(Date.parse(cursor.at))) throw new Error('bad');
      } catch {
        throw new ProblemError('CURSOR_INVALID');
      }
    }
    // Manager: the actions of the members of their teams only (Matrix A A23 "R (ekibin eylemleri)").
    const teamOnly = d.grant.scope !== 'all';
    if (teamOnly && t.access.teamMemberIds.length === 0) return { data: [], page: { nextCursor: null, hasMore: false } };
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<AuditRow>(sql`
        SELECT a.id, a.action, a.actor_type, a.actor_id, u.display_name AS actor_name, a.target_type, a.target_id, host(a.ip) AS ip, a.details, a.at
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE TRUE
          ${teamOnly ? sql`AND a.actor_id = ANY(${uuidArray(t.access.teamMemberIds)})` : sql``}
          ${q.action ? sql`AND a.action LIKE ${`${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}` : sql``}
          ${actorId ? sql`AND a.actor_id = ${actorId}` : sql``}
          ${q.targetType ? sql`AND a.target_type = ${q.targetType}` : sql``}
          ${targetId ? sql`AND a.target_id = ${targetId}` : sql``}
          ${from ? sql`AND a.at >= ${from}` : sql``}
          ${to ? sql`AND a.at < ${to}` : sql``}
          ${cursor ? sql`AND (a.at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        ORDER BY a.at DESC, a.id DESC LIMIT ${limit + 1}`);
      const rows = r.rows.slice(0, limit);
      const last = rows.at(-1);
      const nextCursor = r.rows.length > limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.at).toISOString(), id: last.id })).toString('base64url') : null;
      return {
        data: rows.map((a) => ({
          id: a.id, action: a.action, actorType: a.actor_type, actor: a.actor_id ? { id: a.actor_id, displayName: a.actor_name } : null,
          targetType: a.target_type, targetId: a.target_id, ip: a.ip, details: a.details, at: new Date(a.at).toISOString(),
        })),
        page: { nextCursor, hasMore: nextCursor !== null },
      };
    });
  }

  // ------------------------------------------------------------------ grants shared by delegation and approvals
  private async heldBy(tx: Db, userId: string): Promise<{ roles: Set<string>; segments: Set<Segment> }> {
    const r = await tx.execute<{ roles: string[] | null; segments: string[] | null }>(sql`
      SELECT (SELECT array_agg(r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = ${userId} AND (ur.valid_until IS NULL OR ur.valid_until > now())) AS roles,
             (SELECT array_agg(g.segment::text) FROM user_segment_grants g
               WHERE g.user_id = ${userId} AND (g.valid_until IS NULL OR g.valid_until > now())) AS segments`);
    return { roles: new Set(r.rows[0]?.roles ?? []), segments: new Set((r.rows[0]?.segments ?? []) as Segment[]) };
  }

  /** Grants a role and/or segments until `until` (null = permanent). Existing grants are left alone. */
  private async grant(tx: Db, t: TenantRequestContext, userId: string, roleKey: string | null, segments: Segment[], until: Date | null): Promise<void> {
    if (roleKey) {
      const role = await tx.execute<{ id: string }>(sql`SELECT id FROM roles WHERE key = ${roleKey}`);
      const roleId = role.rows[0]?.id;
      if (!roleId) throw new ProblemError('ROLE_UNKNOWN');
      // An expired earlier grant of the same role may still occupy the key.
      await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${userId} AND role_id = ${roleId} AND valid_until IS NOT NULL AND valid_until <= now()`);
      await tx.execute(sql`INSERT INTO user_roles (tenant_id, user_id, role_id, valid_until, granted_by) VALUES (${t.tenant.id}, ${userId}, ${roleId}, ${until}, ${t.principal.userId})`);
    }
    for (const s of segments) {
      await tx.execute(sql`DELETE FROM user_segment_grants WHERE user_id = ${userId} AND segment = ${s}::segment AND valid_until IS NOT NULL AND valid_until <= now()`);
      await tx.execute(sql`INSERT INTO user_segment_grants (tenant_id, user_id, segment, valid_until, granted_by) VALUES (${t.tenant.id}, ${userId}, ${s}::segment, ${until}, ${t.principal.userId})`);
    }
    await this.bumpUsers(tx, [userId]);
  }

  /** ADR-0004 §7 limits for a non-Admin granter: managed team member, not self, within own role rights and segments. */
  private assertGranterLimits(t: TenantRequestContext, targetUserId: string, roleKey: string | null, segments: Segment[], tenantWide: boolean): void {
    if (targetUserId === t.principal.userId) throw new ProblemError('MANAGER_LIMIT', 'not for yourself', { reason: 'not_self' });
    if (tenantWide) return;
    if (!t.access.managedMemberIds.includes(targetUserId)) throw new ProblemError('MANAGER_LIMIT', 'the user is not in a team you manage', { reason: 'managed_teams_only' });
    if (roleKey && !canAssignRole(t.authz.roleKeys, roleKey, t.authz.overrides)) throw new ProblemError('MANAGER_LIMIT', `you cannot grant the ${roleKey} role`, { reason: 'no_escalation' });
    if (segments.some((s) => !t.segments.includes(s))) throw new ProblemError('MANAGER_LIMIT', 'segments must be among your own', { reason: 'own_segments_only' });
  }

  // ------------------------------------------------------------------ delegation (A07)
  private async delegationRows(tx: Db, where: SQL): Promise<DelegationRow[]> {
    const r = await tx.execute<DelegationRow>(sql`SELECT id, delegator_id, delegate_id, role_key, segments::text AS segments, reason, starts_at, ends_at, revoked_at
      FROM delegations WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 500`);
    return r.rows;
  }

  async listDelegations(t: TenantRequestContext) {
    const me = t.principal.userId;
    const all = can(t.authz, 'authz.delegation.create').allow && can(t.authz, 'users.manage').allow;
    return this.db.withTenant(dbCtx(t), async (tx) => ({
      data: (await this.delegationRows(tx, all ? sql`TRUE` : sql`(delegator_id = ${me} OR delegate_id = ${me})`)).map(delegationView),
    }));
  }

  /** The delegator hands over one of their own roles and/or segments for a limited time. */
  async delegate(t: TenantRequestContext, body: z.infer<typeof DelegationCreate>, ip: string) {
    const d = authorize(t, 'authz.delegation.create');
    const endsAt = new Date(body.endsAt);
    if (endsAt <= new Date()) throw new ProblemError('DELEGATION_INVALID', 'endsAt must be in the future');
    if (endsAt.getTime() - Date.now() > MAX_DELEGATION_DAYS * 86_400_000) throw new ProblemError('DELEGATION_INVALID', `at most ${MAX_DELEGATION_DAYS} days`);
    const tenantWide = d.grant.scope === 'all';
    const segments = [...new Set(body.segments)];
    this.assertGranterLimits(t, body.delegateId, body.roleKey ?? null, segments, tenantWide);
    if (body.roleKey && !t.authz.roleKeys.includes(body.roleKey)) throw new ProblemError('DELEGATION_INVALID', 'you can only delegate a role you hold');
    if (segments.some((s) => !t.segments.includes(s))) throw new ProblemError('DELEGATION_INVALID', 'you can only delegate segments you hold');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const member = await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${body.delegateId} AND status = 'active'`);
      if ((member.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND', 'not a member of this workspace');
      const held = await this.heldBy(tx, body.delegateId);
      const role = body.roleKey && !held.roles.has(body.roleKey) ? body.roleKey : null;
      const segs = segments.filter((s) => !held.segments.has(s));
      if (!role && segs.length === 0) throw new ProblemError('DELEGATION_INVALID', 'the delegate already holds everything delegated');
      await this.grant(tx, t, body.delegateId, role, segs, endsAt);
      const r = await tx.execute<{ id: string }>(sql`INSERT INTO delegations (tenant_id, delegator_id, delegate_id, role_key, segments, reason, ends_at, created_by)
        VALUES (${t.tenant.id}, ${t.principal.userId}, ${body.delegateId}, ${role}, ${segLiteral(segs)}, ${body.reason ?? null}, ${endsAt}, ${t.principal.userId}) RETURNING id`);
      const id = r.rows[0]?.id ?? '';
      await audit(tx, t.tenant.id, { action: 'authz.delegation_created', actorId: t.principal.userId, targetType: 'user', targetId: body.delegateId, ip, details: { delegationId: id, roleKey: role, segments: segs, endsAt: endsAt.toISOString() } });
      const [row] = await this.delegationRows(tx, sql`id = ${id}`);
      if (!row) throw new ProblemError('INTERNAL');
      return delegationView(row);
    });
  }

  async revokeDelegation(t: TenantRequestContext, id: string, ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [d] = await this.delegationRows(tx, sql`id = ${id}`);
      if (!d) throw new ProblemError('NOT_FOUND');
      const isAdmin = can(t.authz, 'users.manage').allow;
      if (d.delegator_id !== t.principal.userId && !isAdmin) throw new ProblemError(d.delegate_id === t.principal.userId ? 'FORBIDDEN' : 'NOT_FOUND');
      if (d.revoked_at === null) {
        if (d.role_key) {
          await tx.execute(sql`DELETE FROM user_roles ur USING roles r WHERE r.id = ur.role_id AND r.key = ${d.role_key}
            AND ur.user_id = ${d.delegate_id} AND ur.valid_until = ${new Date(d.ends_at)}`);
        }
        const segs = parseSegs(d.segments);
        if (segs.length) {
          await tx.execute(sql`DELETE FROM user_segment_grants WHERE user_id = ${d.delegate_id} AND segment = ANY(${segLiteral(segs)}) AND valid_until = ${new Date(d.ends_at)}`);
        }
        await tx.execute(sql`UPDATE delegations SET revoked_at = now() WHERE id = ${id}`);
        await this.bumpUsers(tx, [d.delegate_id]);
        await audit(tx, t.tenant.id, { action: 'authz.delegation_revoked', actorId: t.principal.userId, targetType: 'user', targetId: d.delegate_id, ip, details: { delegationId: id } });
      }
      const [row] = await this.delegationRows(tx, sql`id = ${id}`);
      if (!row) throw new ProblemError('INTERNAL');
      return delegationView(row);
    });
  }

  // ------------------------------------------------------------------ access requests
  private async requestRows(tx: Db, where: SQL): Promise<RequestRow[]> {
    const r = await tx.execute<RequestRow>(sql`SELECT id, requester_id, role_key, segments::text AS segments, reason, valid_until, status, decided_by, decided_at, decision_note, created_at
      FROM access_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT 500`);
    return r.rows;
  }

  /** Approver for a requester: Admin (tenant-wide segment grant / users.manage) or a Manager of their team. */
  private approverScope(t: TenantRequestContext): 'all' | 'team' | null {
    if (can(t.authz, 'users.manage').allow) return 'all';
    const d = can(t.authz, 'authz.segments.grant');
    if (d.allow) return d.grant.scope === 'all' ? 'all' : 'team';
    return null;
  }

  async listRequests(t: TenantRequestContext) {
    const me = t.principal.userId;
    const scope = this.approverScope(t);
    return this.db.withTenant(dbCtx(t), async (tx) => ({
      data: (await this.requestRows(tx, scope === 'all' ? sql`TRUE`
        : scope === 'team' && t.access.managedMemberIds.length ? sql`(requester_id = ${me} OR requester_id = ANY(${uuidArray(t.access.managedMemberIds)}))`
          : sql`requester_id = ${me}`)).map(requestView),
    }));
  }

  async request(t: TenantRequestContext, body: z.infer<typeof AccessRequestCreate>, ip: string) {
    const me = t.principal.userId;
    const validUntil = body.validUntil ? new Date(body.validUntil) : null;
    if (validUntil && validUntil <= new Date()) throw new ProblemError('VALIDATION_FAILED', 'validUntil must be in the future');
    const segments = [...new Set(body.segments)];
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if (body.roleKey) {
        const role = await tx.execute(sql`SELECT 1 FROM roles WHERE key = ${body.roleKey}`);
        if ((role.rowCount ?? 0) === 0) throw new ProblemError('ROLE_UNKNOWN');
      }
      const held = await this.heldBy(tx, me);
      if ((!body.roleKey || held.roles.has(body.roleKey)) && segments.every((s) => held.segments.has(s))) throw new ProblemError('CONFLICT', 'you already have this access');
      const dup = await tx.execute(sql`SELECT 1 FROM access_requests WHERE requester_id = ${me} AND status = 'pending'
        AND role_key IS NOT DISTINCT FROM ${body.roleKey ?? null} AND segments = ${segLiteral([...segments].sort())}`);
      if ((dup.rowCount ?? 0) > 0) throw new ProblemError('CONFLICT', 'an identical request is pending');
      const r = await tx.execute<{ id: string }>(sql`INSERT INTO access_requests (tenant_id, requester_id, role_key, segments, reason, valid_until)
        VALUES (${t.tenant.id}, ${me}, ${body.roleKey ?? null}, ${segLiteral([...segments].sort())}, ${body.reason}, ${validUntil}) RETURNING id`);
      const id = r.rows[0]?.id ?? '';
      await audit(tx, t.tenant.id, { action: 'authz.access_requested', actorId: me, targetType: 'access_request', targetId: id, ip, details: { roleKey: body.roleKey ?? null, segments } });
      const [row] = await this.requestRows(tx, sql`id = ${id}`);
      if (!row) throw new ProblemError('INTERNAL');
      return requestView(row);
    });
  }

  async decide(t: TenantRequestContext, id: string, body: z.infer<typeof AccessRequestDecision>, ip: string) {
    const scope = this.approverScope(t);
    if (!scope) throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM access_requests WHERE id = ${id} FOR UPDATE`);
      const [req] = await this.requestRows(tx, sql`id = ${id}`);
      if (!req || (scope === 'team' && !t.access.managedMemberIds.includes(req.requester_id) && req.requester_id !== t.principal.userId)) throw new ProblemError('NOT_FOUND');
      if (req.status !== 'pending') throw new ProblemError('REQUEST_CLOSED');
      const segs = parseSegs(req.segments);
      this.assertGranterLimits(t, req.requester_id, req.role_key, segs, scope === 'all');
      // A role grant (users.manage) is Admin's; a Manager decides segment requests and roles within limits.
      if (req.role_key && scope !== 'all' && !canAssignRole(t.authz.roleKeys, req.role_key, t.authz.overrides)) throw new ProblemError('MANAGER_LIMIT');
      if (body.decision === 'approve') {
        const held = await this.heldBy(tx, req.requester_id);
        await this.grant(tx, t, req.requester_id, req.role_key && !held.roles.has(req.role_key) ? req.role_key : null, segs.filter((s) => !held.segments.has(s)), req.valid_until ? new Date(req.valid_until) : null);
      }
      await tx.execute(sql`UPDATE access_requests SET status = ${body.decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${t.principal.userId},
        decided_at = now(), decision_note = ${body.note ?? null} WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: `authz.access_request_${body.decision === 'approve' ? 'approved' : 'rejected'}`, actorId: t.principal.userId, targetType: 'user', targetId: req.requester_id, ip, details: { requestId: id } });
      const [row] = await this.requestRows(tx, sql`id = ${id}`);
      if (!row) throw new ProblemError('INTERNAL');
      return requestView(row);
    });
  }

  async withdraw(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [req] = await this.requestRows(tx, sql`id = ${id} AND requester_id = ${t.principal.userId}`);
      if (!req) throw new ProblemError('NOT_FOUND');
      if (req.status !== 'pending') throw new ProblemError('REQUEST_CLOSED');
      await tx.execute(sql`UPDATE access_requests SET status = 'withdrawn', decided_at = now() WHERE id = ${id}`);
      const [row] = await this.requestRows(tx, sql`id = ${id}`);
      if (!row) throw new ProblemError('INTERNAL');
      return requestView(row);
    });
  }

  // ------------------------------------------------------------------ matrix administration (A03, AUTH-11)
  private async currentVersion(tx: Db): Promise<number> {
    const r = await tx.execute<{ v: number | null }>(sql`SELECT max(version) AS v FROM matrix_versions`);
    return r.rows[0]?.v ?? 0;
  }

  private async loadOverrides(tx: Db): Promise<Map<string, Grant | null>> {
    const r = await tx.execute<{ role_key: string; permission: string; grant_spec: Grant | null }>(sql`SELECT role_key, permission, grant_spec FROM role_grant_overrides`);
    return new Map(r.rows.map((o) => [overrideKey(o.role_key, o.permission), o.grant_spec]));
  }

  async matrix(t: TenantRequestContext) {
    authorize(t, 'authz.matrix.read', 'read');
    return this.db.withTenant(dbCtx(t), (tx) => this.matrixIn(tx, t));
  }

  private async matrixIn(tx: Db, t: TenantRequestContext) {
    const overrides = await this.loadOverrides(tx);
    const cells = [];
    for (const permission of allPermissions()) {
      const module = moduleOfPermission(permission) ?? 'core';
      // AUTH-11: permissions of disabled modules are not part of this tenant's matrix view.
      if (!t.authz.enabledModules.has(module)) continue;
      for (const roleKey of SYSTEM_ROLES) {
        const overridden = overrides.has(overrideKey(roleKey, permission));
        const grants = grantsFor(roleKey, permission, overrides);
        cells.push({ roleKey, permission, module, grant: grants[0] ?? null, overridden });
      }
    }
    return { version: await this.currentVersion(tx), cells };
  }

  private validateChanges(t: TenantRequestContext, body: z.infer<typeof MatrixChange>): void {
    const known = new Set(allPermissions());
    for (const c of body.changes) {
      if (!known.has(c.permission)) throw new ProblemError('MATRIX_INVALID', `unknown permission ${c.permission}`);
      const module = moduleOfPermission(c.permission) ?? 'core';
      if (!t.authz.enabledModules.has(module)) throw new ProblemError('MATRIX_INVALID', `${c.permission} belongs to a disabled module`);
      if (c.grant) {
        const err = validateGrant(c.grant as Grant);
        if (err) throw new ProblemError('MATRIX_INVALID', `${c.roleKey} ${c.permission}: ${err}`);
      }
      // ADR-0004 §8: Admin keeps its protected permissions in full.
      if (c.roleKey === 'admin' && PROTECTED_PERMISSIONS.includes(c.permission) && (!c.grant || c.grant.mode !== 'full' || c.grant.scope !== 'all')) {
        throw new ProblemError('MATRIX_INVALID', `${c.permission} cannot be taken from Admin`);
      }
    }
  }

  async preview(t: TenantRequestContext, body: z.infer<typeof MatrixChange>) {
    authorize(t, 'authz.matrix.edit');
    this.validateChanges(t, body);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const overrides = await this.loadOverrides(tx);
      return {
        changes: body.changes
          .map((c) => ({ roleKey: c.roleKey, permission: c.permission, before: grantsFor(c.roleKey, c.permission, overrides)[0] ?? null, after: (c.grant as Grant | null) }))
          .filter((c) => !sameGrant(c.before, c.after)),
      };
    });
  }

  async applyMatrix(t: TenantRequestContext, body: z.infer<typeof MatrixChange>, ip: string) {
    authorize(t, 'authz.matrix.edit');
    this.validateChanges(t, body);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`matrix:${t.tenant.id}`}, 0))`);
      for (const c of body.changes) {
        const base = baseGrantsFor(c.roleKey, c.permission)[0] ?? null;
        // An edit back to the shipped value removes the override (the matrix stays minimal and diffable).
        if (sameGrant(base, c.grant as Grant | null)) {
          await tx.execute(sql`DELETE FROM role_grant_overrides WHERE role_key = ${c.roleKey} AND permission = ${c.permission}`);
        } else {
          await tx.execute(sql`INSERT INTO role_grant_overrides (tenant_id, role_key, permission, grant_spec)
            VALUES (${t.tenant.id}, ${c.roleKey}, ${c.permission}, ${c.grant ? JSON.stringify(c.grant) : null}::jsonb)
            ON CONFLICT (tenant_id, role_key, permission) DO UPDATE SET grant_spec = EXCLUDED.grant_spec`);
        }
      }
      await this.snapshot(tx, t, body.note ?? null);
      await audit(tx, t.tenant.id, { action: 'authz.matrix_changed', actorId: t.principal.userId, ip, details: { changes: body.changes, note: body.note ?? null } });
      return this.matrixIn(tx, t);
    });
  }

  private async snapshot(tx: Db, t: TenantRequestContext, note: string | null): Promise<void> {
    const all = await tx.execute<{ role_key: string; permission: string; grant_spec: Grant | null }>(sql`SELECT role_key, permission, grant_spec FROM role_grant_overrides ORDER BY role_key, permission`);
    const version = (await this.currentVersion(tx)) + 1;
    await tx.execute(sql`INSERT INTO matrix_versions (tenant_id, version, overrides, note, created_by)
      VALUES (${t.tenant.id}, ${version}, ${JSON.stringify(all.rows.map((o) => ({ roleKey: o.role_key, permission: o.permission, grant: o.grant_spec })))}::jsonb, ${note}, ${t.principal.userId})`);
    // Matrix changes affect everyone holding the roles: tenant-wide epoch.
    await tx.execute(sql`UPDATE tenants SET authz_epoch = authz_epoch + 1 WHERE id = ${t.tenant.id}`);
  }

  async versions(t: TenantRequestContext) {
    authorize(t, 'authz.matrix.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ version: number; note: string | null; created_by: string; created_at: string; n: number }>(sql`
        SELECT version, note, created_by, created_at, jsonb_array_length(overrides) AS n FROM matrix_versions ORDER BY version DESC`);
      return { data: r.rows.map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdAt: new Date(v.created_at).toISOString(), overrideCount: v.n })) };
    });
  }

  /** Rolls back to version `v` by recording its overrides as a new version (history is never rewritten). */
  async restore(t: TenantRequestContext, v: number, ip: string) {
    authorize(t, 'authz.matrix.edit');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`matrix:${t.tenant.id}`}, 0))`);
      const r = await tx.execute<{ overrides: { roleKey: string; permission: string; grant: Grant | null }[] }>(sql`SELECT overrides FROM matrix_versions WHERE version = ${v}`);
      const snap = r.rows[0];
      if (!snap) throw new ProblemError('NOT_FOUND');
      await tx.execute(sql`DELETE FROM role_grant_overrides`);
      for (const o of snap.overrides) {
        await tx.execute(sql`INSERT INTO role_grant_overrides (tenant_id, role_key, permission, grant_spec)
          VALUES (${t.tenant.id}, ${o.roleKey}, ${o.permission}, ${o.grant ? JSON.stringify(o.grant) : null}::jsonb)`);
      }
      await this.snapshot(tx, t, `restored version ${v}`);
      await audit(tx, t.tenant.id, { action: 'authz.matrix_restored', actorId: t.principal.userId, ip, details: { version: v } });
      return this.matrixIn(tx, t);
    });
  }
}

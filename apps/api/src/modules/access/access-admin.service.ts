import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import {
  AccountView, CaseView, ContactView, LeadView, OpportunityView,
  type FieldPolicySet, type QueueCreate, type ShareCreate, type SharingDefaultsSet, type SharingRuleCreate, type TeamCreate, type TeamPatch,
  type UserRolesSet, type UserSegmentsSet, type z,
} from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { compileQuery, RqlError } from '@flexa/query-lang';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { mapDbError } from '../../common/http-helpers';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { assertCan, uuidArray, type RecordShape, type ShareType } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, isCrmType, readCrmRow } from '../crm/crm-objects';
import { loadFieldDefs } from '../tasks/task-fields';
import { TASK_SHAPE, TasksService } from '../tasks/tasks.service';

const SEGMENTS: readonly Segment[] = ['b2b', 'b2c'];
/** Fields that are part of a record's identity and never restricted. */
const UNRESTRICTABLE = new Set(['id', 'version']);
const VIEW_FIELDS: Record<'account' | 'contact' | 'lead' | 'opportunity' | 'case', readonly string[]> = {
  account: Object.keys(AccountView.shape),
  contact: Object.keys(ContactView.shape),
  lead: Object.keys(LeadView.shape),
  opportunity: Object.keys(OpportunityView.shape),
  case: Object.keys(CaseView.shape),
};

type TeamRow = { id: string; name: string; parent_team_id: string | null; members: { userId: string; displayName: string; role: 'member' | 'manager' }[] };
type AccessRow = {
  user_id: string; display_name: string; email: string; status: string; roles: string[] | null;
  segments: { segment: Segment; validUntil: string | null }[] | null; teams: { teamId: string; role: 'member' | 'manager' }[] | null;
};

/** Administration of the authorization engine (docs/p4-plan.md §6). Every change is audited and bumps the
 *  affected members' `authz_version` (or the tenant's `authz_epoch` for tenant-wide policy). */
@Injectable()
export class AccessAdminService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly tasks: TasksService) {}

  private async bumpUsers(tx: Db, userIds: readonly string[]): Promise<void> {
    if (userIds.length) await tx.execute(sql`UPDATE memberships SET authz_version = authz_version + 1 WHERE user_id = ANY(${uuidArray(userIds)})`);
  }

  private async bumpTenant(tx: Db, t: TenantRequestContext): Promise<void> {
    await tx.execute(sql`UPDATE tenants SET authz_epoch = authz_epoch + 1 WHERE id = ${t.tenant.id}`);
  }

  // ------------------------------------------------------------------ teams
  private async teams(tx: Db, id?: string): Promise<TeamRow[]> {
    const r = await tx.execute<TeamRow>(sql`
      SELECT tm.id, tm.name, tm.parent_team_id,
        coalesce((SELECT jsonb_agg(jsonb_build_object('userId', m.user_id, 'displayName', u.display_name, 'role', m.role) ORDER BY m.role DESC, u.display_name)
                  FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = tm.id), '[]'::jsonb) AS members
      FROM teams tm ${id ? sql`WHERE tm.id = ${id}` : sql``} ORDER BY tm.name, tm.id`);
    return r.rows;
  }

  private teamView = (r: TeamRow) => ({ id: r.id, name: r.name, parentTeamId: r.parent_team_id, members: r.members });

  async listTeams(t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.teams(tx)).map(this.teamView) }));
  }

  private async team(tx: Db, id: string) {
    const [row] = await this.teams(tx, id);
    if (!row) throw new ProblemError('NOT_FOUND');
    return this.teamView(row);
  }

  async createTeam(t: TenantRequestContext, body: z.infer<typeof TeamCreate>, ip: string) {
    authorize(t, 'teams.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO teams (tenant_id, name, parent_team_id) VALUES (${t.tenant.id}, ${body.name}, ${body.parentTeamId ?? null}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'team.created', actorId: t.principal.userId, targetType: 'team', targetId: id, ip, details: { name: body.name } });
        return await this.team(tx, id);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `team "${body.name}" already exists`);
        return mapDbError(e);
      }
    });
  }

  async patchTeam(t: TenantRequestContext, id: string, body: z.infer<typeof TeamPatch>, ip: string) {
    authorize(t, 'teams.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.team(tx, id);
      try {
        await tx.execute(sql`UPDATE teams SET
          name = ${body.name !== undefined ? body.name : sql`name`},
          parent_team_id = ${body.parentTeamId !== undefined ? body.parentTeamId : sql`parent_team_id`}
          WHERE id = ${id}`);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a team with that name exists');
        mapDbError(e);
      }
      // Moving a team changes who managers above it can see.
      if (body.parentTeamId !== undefined) await this.bumpTenant(tx, t);
      await audit(tx, t.tenant.id, { action: 'team.updated', actorId: t.principal.userId, targetType: 'team', targetId: id, ip, details: body });
      return this.team(tx, id);
    });
  }

  /** A06: Admin manages any team; a Manager manages members of the teams they manage (`managed_teams_only`),
   *  and only an Admin appoints team managers. */
  private assertTeamMembers(t: TenantRequestContext, teamId: string, role: 'member' | 'manager'): void {
    const d = authorize(t, 'teams.members.manage');
    if (d.grant.scope === 'all') return;
    if (!t.access.managedTeamIds.includes(teamId)) throw new ProblemError('MANAGER_LIMIT', 'you do not manage this team');
    if (role === 'manager') throw new ProblemError('MANAGER_LIMIT', 'only an Admin appoints team managers');
  }

  async setTeamMember(t: TenantRequestContext, teamId: string, userId: string, role: 'member' | 'manager', ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.team(tx, teamId);
      this.assertTeamMembers(t, teamId, role);
      try {
        await tx.execute(sql`INSERT INTO team_members (tenant_id, team_id, user_id, role, added_by) VALUES (${t.tenant.id}, ${teamId}, ${userId}, ${role}, ${t.principal.userId})
          ON CONFLICT (tenant_id, team_id, user_id) DO UPDATE SET role = EXCLUDED.role`);
      } catch (e) {
        if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'not a member of this workspace');
        mapDbError(e);
      }
      await this.bumpTeam(tx, teamId, [userId]);
      await audit(tx, t.tenant.id, { action: 'team.member_set', actorId: t.principal.userId, targetType: 'user', targetId: userId, ip, details: { teamId, role } });
      return this.team(tx, teamId);
    });
  }

  async removeTeamMember(t: TenantRequestContext, teamId: string, userId: string, ip: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.team(tx, teamId);
      const current = await tx.execute<{ role: 'member' | 'manager' }>(sql`SELECT role FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`);
      const role = current.rows[0]?.role;
      if (!role) throw new ProblemError('NOT_FOUND');
      this.assertTeamMembers(t, teamId, role);
      await tx.execute(sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`);
      await this.bumpTeam(tx, teamId, [userId]);
      await audit(tx, t.tenant.id, { action: 'team.member_removed', actorId: t.principal.userId, targetType: 'user', targetId: userId, ip, details: { teamId } });
    });
  }

  /** Membership changes alter what the team's managers (incl. managers of parent teams) and members see. */
  private async bumpTeam(tx: Db, teamId: string, extra: string[]): Promise<void> {
    const r = await tx.execute<{ u: string }>(sql`
      WITH RECURSIVE up(id) AS (SELECT ${teamId}::uuid UNION SELECT t.parent_team_id FROM teams t JOIN up ON t.id = up.id WHERE t.parent_team_id IS NOT NULL)
      SELECT DISTINCT user_id::text AS u FROM team_members WHERE team_id IN (SELECT id FROM up)`);
    await this.bumpUsers(tx, [...new Set([...r.rows.map((x) => x.u), ...extra])]);
  }

  // ------------------------------------------------------------------ queues
  private async queues(tx: Db, id?: string) {
    const r = await tx.execute<{ id: string; name: string; kind: 'work' | 'call'; segment: Segment | null; member_ids: string[] | null }>(sql`
      SELECT q.id, q.name, q.kind, q.segment, (SELECT array_agg(qm.user_id::text ORDER BY qm.user_id) FROM queue_members qm WHERE qm.queue_id = q.id) AS member_ids
      FROM queues q ${id ? sql`WHERE q.id = ${id}` : sql``} ORDER BY q.kind, q.name`);
    return r.rows.map((q) => ({ id: q.id, name: q.name, kind: q.kind, segment: q.segment, memberIds: q.member_ids ?? [] }));
  }

  async listQueues(t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: await this.queues(tx) }));
  }

  async createQueue(t: TenantRequestContext, body: z.infer<typeof QueueCreate>, ip: string) {
    authorize(t, 'teams.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO queues (tenant_id, kind, name, segment) VALUES (${t.tenant.id}, ${body.kind}, ${body.name}, ${body.segment}::segment) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'queue.created', actorId: t.principal.userId, targetType: 'queue', targetId: id, ip, details: body });
        return (await this.queues(tx, id))[0];
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `queue "${body.name}" already exists`);
        return mapDbError(e);
      }
    });
  }

  async setQueueMember(t: TenantRequestContext, queueId: string, userId: string, add: boolean, ip: string) {
    authorize(t, 'teams.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if ((await this.queues(tx, queueId)).length === 0) throw new ProblemError('NOT_FOUND');
      if (add) {
        try {
          await tx.execute(sql`INSERT INTO queue_members (tenant_id, queue_id, user_id) VALUES (${t.tenant.id}, ${queueId}, ${userId}) ON CONFLICT DO NOTHING`);
        } catch (e) {
          if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'not a member of this workspace');
          mapDbError(e);
        }
      } else {
        const r = await tx.execute(sql`DELETE FROM queue_members WHERE queue_id = ${queueId} AND user_id = ${userId}`);
        if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      }
      await this.bumpUsers(tx, [userId]);
      await audit(tx, t.tenant.id, { action: add ? 'queue.member_added' : 'queue.member_removed', actorId: t.principal.userId, targetType: 'user', targetId: userId, ip, details: { queueId } });
      return (await this.queues(tx, queueId))[0];
    });
  }

  // ------------------------------------------------------------------ users: roles and segments
  /** Admin (users.manage) sees every member; a Manager with segment-grant rights sees the members of the
   *  teams they manage; others none. */
  private userScope(t: TenantRequestContext): 'all' | 'managed' {
    if (can(t.authz, 'users.manage').allow) return 'all';
    const d = can(t.authz, 'authz.segments.grant');
    if (d.allow) return d.grant.scope === 'all' ? 'all' : 'managed';
    throw new ProblemError('FORBIDDEN');
  }

  private async access(tx: Db, ids: string[] | null): Promise<AccessRow[]> {
    const r = await tx.execute<AccessRow>(sql`
      SELECT m.user_id, u.display_name, u.email::text AS email, m.status,
        (SELECT array_agg(r.key ORDER BY r.key) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = m.user_id AND (ur.valid_until IS NULL OR ur.valid_until > now())) AS roles,
        (SELECT jsonb_agg(jsonb_build_object('segment', g.segment, 'validUntil', g.valid_until) ORDER BY g.segment) FROM user_segment_grants g
          WHERE g.user_id = m.user_id AND (g.valid_until IS NULL OR g.valid_until > now())) AS segments,
        (SELECT jsonb_agg(jsonb_build_object('teamId', tm.team_id, 'role', tm.role)) FROM team_members tm WHERE tm.user_id = m.user_id) AS teams
      FROM memberships m JOIN users u ON u.id = m.user_id
      ${ids ? sql`WHERE m.user_id = ANY(${uuidArray(ids)})` : sql``}
      ORDER BY u.display_name, m.user_id`);
    return r.rows;
  }

  private accessView = (r: AccessRow) => ({
    userId: r.user_id, displayName: r.display_name, email: r.email, status: r.status, roles: r.roles ?? [],
    segments: (r.segments ?? []).map((s) => ({ segment: s.segment, validUntil: s.validUntil ? new Date(s.validUntil).toISOString() : null })),
    teams: r.teams ?? [],
  });

  async listUsers(t: TenantRequestContext) {
    const scope = this.userScope(t);
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.access(tx, scope === 'all' ? null : t.access.managedMemberIds)).map(this.accessView) }));
  }

  /** Names of active members for people pickers; every member may read it (B48). */
  async directory(t: TenantRequestContext, q: { q?: string | undefined; ids?: string[] | undefined; limit: number }) {
    const term = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ id: string; display_name: string }>(sql`
        SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.status = 'active'
          ${q.ids ? sql`AND u.id = ANY(${uuidArray(q.ids)})` : sql``}
          ${term ? sql`AND u.display_name ILIKE ${term}` : sql``}
        ORDER BY u.display_name, u.id LIMIT ${q.ids ? q.ids.length : q.limit}`);
      return { data: r.rows.map((row) => ({ id: row.id, displayName: row.display_name })) };
    });
  }

  async userAccess(t: TenantRequestContext, userId: string) {
    const scope = this.userScope(t);
    if (scope === 'managed' && !t.access.managedMemberIds.includes(userId) && userId !== t.principal.userId) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant(dbCtx(t), (tx) => this.oneAccess(tx, userId));
  }

  private async oneAccess(tx: Db, userId: string) {
    const [row] = await this.access(tx, [userId]);
    if (!row) throw new ProblemError('NOT_FOUND');
    return this.accessView(row);
  }

  /** A05 / ADR-0004 §7: Admin sets any member's segments; a Manager only for members of managed teams
   *  (`managed_teams_only`), never their own (`not_self`), and only segments they hold (`own_segments_only`);
   *  segments outside the Manager's own set are left untouched. */
  async setSegments(t: TenantRequestContext, userId: string, body: z.infer<typeof UserSegmentsSet>, ip: string) {
    const d = authorize(t, 'authz.segments.grant');
    const me = t.principal.userId;
    const tenantWide = d.grant.scope === 'all';
    if (!tenantWide) {
      if (userId === me) throw new ProblemError('MANAGER_LIMIT', 'you cannot change your own segments', { reason: 'not_self' });
      if (!t.access.managedMemberIds.includes(userId)) throw new ProblemError('MANAGER_LIMIT', 'the user is not in a team you manage', { reason: 'managed_teams_only' });
      const foreign = body.segments.find((s) => !t.segments.includes(s.segment));
      if (foreign) throw new ProblemError('MANAGER_LIMIT', `you cannot grant ${foreign.segment}`, { reason: 'own_segments_only' });
    }
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.oneAccess(tx, userId);
      const managedSegments = tenantWide ? SEGMENTS : SEGMENTS.filter((s) => t.segments.includes(s));
      await tx.execute(sql`DELETE FROM user_segment_grants WHERE user_id = ${userId} AND segment::text = ANY(${`{${managedSegments.join(',')}}`}::text[])`);
      for (const s of body.segments) {
        await tx.execute(sql`INSERT INTO user_segment_grants (tenant_id, user_id, segment, valid_until, granted_by)
          VALUES (${t.tenant.id}, ${userId}, ${s.segment}::segment, ${s.validUntil ? new Date(s.validUntil) : null}, ${me})`);
      }
      await this.bumpUsers(tx, [userId]);
      await audit(tx, t.tenant.id, { action: 'authz.segments_changed', actorId: me, targetType: 'user', targetId: userId, ip, details: { segments: body.segments } });
      return this.oneAccess(tx, userId);
    });
  }

  /** A04 users.manage (Admin): roles of another member; the tenant keeps at least one Admin. */
  async setRoles(t: TenantRequestContext, userId: string, body: z.infer<typeof UserRolesSet>, ip: string) {
    authorize(t, 'users.manage');
    if (userId === t.principal.userId) throw new ProblemError('MANAGER_LIMIT', 'you cannot change your own roles', { reason: 'not_self' });
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.oneAccess(tx, userId);
      const roles = await tx.execute<{ id: string; key: string }>(sql`SELECT id, key FROM roles WHERE key = ANY(${`{${body.roles.join(',')}}`}::text[])`);
      if (roles.rows.length !== new Set(body.roles).size) throw new ProblemError('ROLE_UNKNOWN');
      await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${userId}`);
      for (const r of roles.rows) {
        await tx.execute(sql`INSERT INTO user_roles (tenant_id, user_id, role_id, granted_by) VALUES (${t.tenant.id}, ${userId}, ${r.id}, ${t.principal.userId})`);
      }
      const admins = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        JOIN memberships m ON m.user_id = ur.user_id WHERE r.key = 'admin' AND m.status = 'active'`);
      if ((admins.rows[0]?.n ?? 0) === 0) throw new ProblemError('LAST_ADMIN');
      await this.bumpUsers(tx, [userId]);
      await audit(tx, t.tenant.id, { action: 'authz.roles_changed', actorId: t.principal.userId, targetType: 'user', targetId: userId, ip, details: { roles: body.roles } });
      return this.oneAccess(tx, userId);
    });
  }

  // ------------------------------------------------------------------ role hierarchy
  async listRoles(t: TenantRequestContext) {
    authorize(t, 'authz.matrix.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ id: string; key: string; name: string; is_system: boolean; parent_role_id: string | null }>(sql`
        SELECT id, key, name, is_system, parent_role_id FROM roles ORDER BY is_system DESC, key`);
      return { data: r.rows.map((x) => ({ id: x.id, key: x.key, name: x.name, isSystem: x.is_system, parentRoleId: x.parent_role_id })) };
    });
  }

  async setRoleParent(t: TenantRequestContext, roleId: string, parentRoleId: string | null, ip: string) {
    authorize(t, 'authz.matrix.edit');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string; key: string; name: string; is_system: boolean; parent_role_id: string | null }>(sql`
          UPDATE roles SET parent_role_id = ${parentRoleId}, version = version + 1 WHERE id = ${roleId}
          RETURNING id, key, name, is_system, parent_role_id`);
        const x = r.rows[0];
        if (!x) throw new ProblemError('NOT_FOUND');
        await this.bumpTenant(tx, t);
        await audit(tx, t.tenant.id, { action: 'authz.role_hierarchy_changed', actorId: t.principal.userId, targetType: 'role', targetId: roleId, ip, details: { parentRoleId } });
        return { id: x.id, key: x.key, name: x.name, isSystem: x.is_system, parentRoleId: x.parent_role_id };
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'parent role not found');
        return mapDbError(e);
      }
    });
  }

  // ------------------------------------------------------------------ OWD and sharing rules
  async sharingDefaults(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), (tx) => this.readDefaults(tx));
  }

  private async readDefaults(tx: Db) {
    const r = await tx.execute<{ resource_type: ShareType; access: 'private' | 'read' | 'read_write' }>(sql`SELECT resource_type, access FROM sharing_defaults`);
    const set = new Map(r.rows.map((x) => [x.resource_type, x.access]));
    const types: ShareType[] = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'];
    return { data: types.map((resourceType) => ({ resourceType, access: set.get(resourceType) ?? 'private' })) };
  }

  async setSharingDefaults(t: TenantRequestContext, body: z.infer<typeof SharingDefaultsSet>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      for (const d of body.defaults) {
        await tx.execute(sql`INSERT INTO sharing_defaults (tenant_id, resource_type, access, updated_by) VALUES (${t.tenant.id}, ${d.resourceType}, ${d.access}, ${t.principal.userId})
          ON CONFLICT (tenant_id, resource_type) DO UPDATE SET access = EXCLUDED.access, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      await this.bumpTenant(tx, t);
      await audit(tx, t.tenant.id, { action: 'authz.sharing_defaults_changed', actorId: t.principal.userId, ip, details: { defaults: body.defaults } });
      return this.readDefaults(tx);
    });
  }

  private ruleView = (r: { id: string; resource_type: ShareType; name: string; criteria: string; grantee_team_id: string; access: 'read' | 'edit'; enabled: boolean }) => ({
    id: r.id, resourceType: r.resource_type, name: r.name, criteria: r.criteria, granteeTeamId: r.grantee_team_id, access: r.access, enabled: r.enabled,
  });

  async listRules(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<Parameters<typeof this.ruleView>[0]>(sql`SELECT id, resource_type, name, criteria, grantee_team_id, access, enabled FROM sharing_rules ORDER BY resource_type, name`);
      return { data: r.rows.map(this.ruleView) };
    });
  }

  async createRule(t: TenantRequestContext, body: z.infer<typeof SharingRuleCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // The criteria must compile against the object's fields now (it is compiled again on every request).
      const shape = this.shapeOf(body.resourceType);
      try {
        compileQuery(body.criteria, await shape.registry(tx), { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
      } catch (e) {
        if (e instanceof RqlError) throw new ProblemError('RULE_INVALID', e.message, { rqlCode: e.code, position: e.position });
        throw e;
      }
      try {
        const r = await tx.execute<Parameters<typeof this.ruleView>[0]>(sql`
          INSERT INTO sharing_rules (tenant_id, resource_type, name, criteria, grantee_team_id, access, created_by)
          VALUES (${t.tenant.id}, ${body.resourceType}, ${body.name}, ${body.criteria}, ${body.granteeTeamId}, ${body.access}, ${t.principal.userId})
          RETURNING id, resource_type, name, criteria, grantee_team_id, access, enabled`);
        const row = r.rows[0];
        if (!row) throw new ProblemError('INTERNAL');
        await this.bumpTenant(tx, t);
        await audit(tx, t.tenant.id, { action: 'authz.sharing_rule_created', actorId: t.principal.userId, targetType: 'sharing_rule', targetId: row.id, ip, details: body });
        return this.ruleView(row);
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `rule "${body.name}" already exists`);
        if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'team not found');
        return mapDbError(e);
      }
    });
  }

  async deleteRule(t: TenantRequestContext, id: string, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`DELETE FROM sharing_rules WHERE id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      await this.bumpTenant(tx, t);
      await audit(tx, t.tenant.id, { action: 'authz.sharing_rule_deleted', actorId: t.principal.userId, targetType: 'sharing_rule', targetId: id, ip });
    });
  }

  // ------------------------------------------------------------------ manual record shares
  private shapeOf(type: ShareType): RecordShape {
    return type === 'task' ? TASK_SHAPE : CRM[type].shape;
  }

  /** The record must be visible to the caller (404 otherwise). */
  private async readRecord(tx: Db, t: TenantRequestContext, type: ShareType, id: string): Promise<void> {
    if (type === 'task') await this.tasks.readRow(tx, t, id);
    else if (isCrmType(type)) await readCrmRow(tx, t, CRM[type], id);
  }

  private shareView = (s: { id: string; grantee_type: 'user' | 'team'; grantee_id: string; access: 'read' | 'edit'; source: string; created_at: string }) => ({
    id: s.id, grantee: { type: s.grantee_type, id: s.grantee_id }, access: s.access, source: s.source, createdAt: new Date(s.created_at).toISOString(),
  });

  async listShares(t: TenantRequestContext, type: ShareType, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      const r = await tx.execute<Parameters<typeof this.shareView>[0]>(sql`
        SELECT id, grantee_type, grantee_id, access, source, created_at FROM record_shares WHERE record_type = ${type} AND record_id = ${id} ORDER BY created_at, id`);
      return { data: r.rows.map(this.shareView) };
    });
  }

  /** Sharing is an edit of the record's access list: the caller needs update rights on the record. */
  async share(t: TenantRequestContext, type: ShareType, id: string, body: z.infer<typeof ShareCreate>, ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Visibility first: an invisible record answers 404 whatever the request says.
      await this.readRecord(tx, t, type, id);
      await assertCan(tx, t, this.shapeOf(type), id, 'update');
      if (body.grantee.type === 'user' && body.grantee.id === t.principal.userId) throw new ProblemError('SHARE_INVALID', 'you already have access');
      const exists = body.grantee.type === 'user'
        ? await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${body.grantee.id} AND status = 'active'`)
        : await tx.execute(sql`SELECT 1 FROM teams WHERE id = ${body.grantee.id}`);
      if ((exists.rowCount ?? 0) === 0) throw new ProblemError('SHARE_INVALID', `${body.grantee.type} not found`);
      const r = await tx.execute<Parameters<typeof this.shareView>[0]>(sql`
        INSERT INTO record_shares (tenant_id, record_type, record_id, grantee_type, grantee_id, access, created_by)
        VALUES (${t.tenant.id}, ${type}, ${id}, ${body.grantee.type}, ${body.grantee.id}, ${body.access}, ${t.principal.userId})
        ON CONFLICT (tenant_id, record_type, record_id, grantee_type, grantee_id) DO UPDATE SET access = EXCLUDED.access
        RETURNING id, grantee_type, grantee_id, access, source, created_at`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      await audit(tx, t.tenant.id, { action: 'record.shared', actorId: t.principal.userId, targetType: type, targetId: id, ip, details: { grantee: body.grantee, access: body.access } });
      return this.shareView(row);
    });
  }

  async unshare(t: TenantRequestContext, type: ShareType, id: string, shareId: string, ip: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      await assertCan(tx, t, this.shapeOf(type), id, 'update');
      const r = await tx.execute(sql`DELETE FROM record_shares WHERE id = ${shareId} AND record_type = ${type} AND record_id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'record.unshared', actorId: t.principal.userId, targetType: type, targetId: id, ip, details: { shareId } });
    });
  }

  // ------------------------------------------------------------------ field-level security
  async fieldPolicies(t: TenantRequestContext) {
    authorize(t, 'authz.matrix.read', 'read');
    return this.db.withTenant(dbCtx(t), (tx) => this.readPolicies(tx));
  }

  private async readPolicies(tx: Db) {
    const r = await tx.execute<{ role_id: string; resource_type: 'account' | 'contact' | 'lead' | 'opportunity' | 'case'; field: string; access: 'hidden' | 'read' }>(sql`
      SELECT role_id, resource_type, field, access FROM field_policies ORDER BY resource_type, field, role_id`);
    return { data: r.rows.map((x) => ({ roleId: x.role_id, resourceType: x.resource_type, field: x.field, access: x.access })) };
  }

  async setFieldPolicy(t: TenantRequestContext, body: z.infer<typeof FieldPolicySet>, ip: string) {
    authorize(t, 'authz.matrix.edit');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const role = await tx.execute<{ key: string }>(sql`SELECT key FROM roles WHERE id = ${body.roleId}`);
      const key = role.rows[0]?.key;
      if (!key) throw new ProblemError('NOT_FOUND', 'role not found');
      if (key === 'admin') throw new ProblemError('VALIDATION_FAILED', 'fields cannot be restricted for the Admin role');
      if (UNRESTRICTABLE.has(body.field)) throw new ProblemError('VALIDATION_FAILED', `"${body.field}" cannot be restricted`);
      if (body.field.startsWith('custom.')) {
        const defs = await loadFieldDefs(tx, body.resourceType);
        if (!defs.some((d) => `custom.${d.key}` === body.field)) throw new ProblemError('UNKNOWN_FIELD', `unknown field "${body.field}"`);
      } else if (!VIEW_FIELDS[body.resourceType].includes(body.field)) {
        throw new ProblemError('UNKNOWN_FIELD', `unknown field "${body.field}"`);
      }
      if (body.access === null) {
        await tx.execute(sql`DELETE FROM field_policies WHERE role_id = ${body.roleId} AND resource_type = ${body.resourceType} AND field = ${body.field}`);
      } else {
        await tx.execute(sql`INSERT INTO field_policies (tenant_id, role_id, resource_type, field, access, updated_by)
          VALUES (${t.tenant.id}, ${body.roleId}, ${body.resourceType}, ${body.field}, ${body.access}, ${t.principal.userId})
          ON CONFLICT (tenant_id, role_id, resource_type, field) DO UPDATE SET access = EXCLUDED.access, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      await this.bumpTenant(tx, t);
      await audit(tx, t.tenant.id, { action: 'authz.field_policy_changed', actorId: t.principal.userId, targetType: 'role', targetId: body.roleId, ip, details: body });
      return this.readPolicies(tx);
    });
  }
}

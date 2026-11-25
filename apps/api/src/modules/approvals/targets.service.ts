import { Inject, Injectable, Logger } from '@nestjs/common';
import { can, scopesOf } from '@flexa/authz';
import type { TargetCreate, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { mapDbError } from '../../common/http-helpers';
import { notify } from '../../common/notify';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { uuidArray } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';

// Sales targets and their attainment (TRK-02, docs/p8-plan.md §10). Actuals are computed when read: won
// opportunities by closing date, closed tasks by closing date, in the workspace's time zone. Segments are RLS's
// job for the targets and for what is counted.

/** At risk: behind by more than a quarter of the pace, once a quarter of the period has passed. */
const RISK_AFTER = 25;
const RISK_PACE = 0.75;

type Row = {
  id: string; subject_type: 'user' | 'team' | 'segment'; user_id: string | null; team_id: string | null; segment: Segment | null; name: string | null;
  period: 'month' | 'quarter'; period_start: string; period_end: string; metric: 'won_amount' | 'won_count' | 'tasks_closed'; target_value: string; currency: string | null;
  version: number; created_by: string; actual: string; other_count: number; elapsed: string; progress: string;
};

const risky = (r: Pick<Row, 'elapsed' | 'progress'>): boolean => Number(r.elapsed) >= RISK_AFTER && Number(r.elapsed) < 100 && Number(r.progress) < Number(r.elapsed) * RISK_PACE;

/** Targets the caller may read (alias `g`): own for `own`, managed people and teams for `team`, every one for `all`. */
export function targetPredicate(t: TenantRequestContext): SQL {
  const d = can(t.authz, 'sales_tracking.target.read', 'read');
  if (!d.allow) return sql`FALSE`;
  const scopes = scopesOf(d.grant);
  if (scopes.includes('all') || scopes.includes('segment')) return sql`TRUE`;
  const terms = [sql`g.user_id = ${t.principal.userId}`];
  if (scopes.includes('team')) {
    if (t.access.managedMemberIds.length) terms.push(sql`g.user_id = ANY(${uuidArray(t.access.managedMemberIds)})`);
    if (t.access.managedTeamIds.length) terms.push(sql`g.team_id = ANY(${uuidArray(t.access.managedTeamIds)})`);
  }
  return sql`(${sql.join(terms, sql` OR `)})`;
}

@Injectable()
export class TargetsService {
  private readonly log = new Logger('targets');

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  private async rows(tx: Db, timezone: string, where: SQL): Promise<Row[]> {
    const at = (day: SQL) => sql`(${day})::timestamp AT TIME ZONE ${timezone}`;
    return (await tx.execute<Row>(sql`
      WITH base AS (
        SELECT g.*, (g.period_start + CASE g.period WHEN 'month' THEN interval '1 month' ELSE interval '3 months' END)::date AS next_start,
          (now() AT TIME ZONE ${timezone})::date AS today
        FROM sales_targets g WHERE ${where}
      ), span AS (
        SELECT b.*, ${at(sql`b.period_start`)} AS t0, ${at(sql`b.next_start`)} AS t1,
          -- Whose work counts: the person, or the members of the team and its sub-teams.
          CASE b.subject_type WHEN 'user' THEN ARRAY[b.user_id] WHEN 'team' THEN ARRAY(
            WITH RECURSIVE down(id) AS (SELECT b.team_id UNION SELECT c.id FROM teams c JOIN down ON c.parent_team_id = down.id)
            SELECT DISTINCT tm.user_id FROM team_members tm WHERE tm.team_id IN (SELECT id FROM down)) END AS people
        FROM base b
      ), counted AS (
        SELECT s.*, coalesce(w.actual, k.actual, 0) AS actual, coalesce(w.other_count, 0) AS other_count,
          round(least(100, greatest(0, (s.today - s.period_start) * 100.0 / (s.next_start - s.period_start))), 1) AS elapsed
        FROM span s
        LEFT JOIN LATERAL (
          SELECT CASE s.metric WHEN 'won_count' THEN count(*)::numeric ELSE coalesce(sum(o.amount) FILTER (WHERE o.currency = s.currency), 0) END AS actual,
            count(*) FILTER (WHERE s.metric = 'won_amount' AND o.currency <> s.currency AND o.amount IS NOT NULL)::int AS other_count
          FROM opportunities o JOIN statuses st ON st.id = o.status_id AND st.category = 'closed'
          JOIN pipeline_stages ps ON ps.pipeline_id = o.pipeline_id AND ps.status_id = o.status_id AND ps.probability > 0
          WHERE o.deleted_at IS NULL AND o.closed_at >= s.t0 AND o.closed_at < s.t1 AND (s.segment IS NULL OR o.segment = s.segment)
            AND (s.people IS NULL OR o.owner_user_id = ANY (s.people))) w ON s.metric IN ('won_amount', 'won_count')
        LEFT JOIN LATERAL (
          SELECT count(*)::numeric AS actual FROM tasks tk JOIN statuses st ON st.id = tk.status_id AND st.category = 'closed'
          WHERE tk.deleted_at IS NULL AND tk.closed_at >= s.t0 AND tk.closed_at < s.t1 AND (s.segment IS NULL OR tk.segment = s.segment)
            AND coalesce(tk.assignee_user_id, tk.owner_user_id) = ANY (s.people)) k ON s.metric = 'tasks_closed'
      )
      SELECT c.id, c.subject_type, c.user_id, c.team_id, c.segment, coalesce(u.display_name, tm.name) AS name, c.period, c.period_start::text, (c.next_start - 1)::text AS period_end,
        c.metric, trim_scale(c.target_value)::text AS target_value, c.currency, c.version, c.created_by, trim_scale(c.actual)::text AS actual, c.other_count, c.elapsed::text,
        round(c.actual * 100 / c.target_value, 1)::text AS progress
      FROM counted c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN teams tm ON tm.id = c.team_id
      ORDER BY c.period_start DESC, c.subject_type DESC, name NULLS FIRST, c.metric, c.id LIMIT 500`)).rows;
  }

  private view(t: TenantRequestContext, r: Row) {
    return {
      id: r.id, subject: { type: r.subject_type, id: r.user_id ?? r.team_id, name: r.name ?? r.segment ?? '' }, segment: r.segment, period: r.period, periodStart: r.period_start,
      periodEnd: r.period_end, metric: r.metric, targetValue: r.target_value, currency: r.currency, actual: r.actual, otherCurrencyCount: r.other_count,
      progressPercent: Number(r.progress), elapsedPercent: Number(r.elapsed), atRisk: risky(r), canEdit: this.mayManage(t, r.subject_type, r.user_id ?? r.team_id), version: r.version,
    };
  }

  /** Matrix A19: Admin everyone's; a Manager for the people and teams they manage, never their own. */
  private mayManage(t: TenantRequestContext, type: Row['subject_type'], id: string | null): boolean {
    const d = can(t.authz, 'sales_tracking.target.manage');
    if (!d.allow) return false;
    if (scopesOf(d.grant).includes('all')) return true;
    if (type === 'user') return id !== t.principal.userId && t.access.managedMemberIds.includes(id ?? '');
    return type === 'team' && t.access.managedTeamIds.includes(id ?? '');
  }

  private assertManage(t: TenantRequestContext, type: Row['subject_type'], id: string | null): void {
    authorize(t, 'sales_tracking.target.manage');
    if (!this.mayManage(t, type, id)) throw new ProblemError('MANAGER_LIMIT', 'you may set targets for the people and teams you manage', { reason: id === t.principal.userId ? 'not_self' : 'managed_teams_only' });
  }

  async list(t: TenantRequestContext, on: string | undefined) {
    authorize(t, 'sales_tracking.target.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const day = on ? sql`${on}::date` : sql`(now() AT TIME ZONE ${t.tenant.timezone})::date`;
      const running = sql`g.period_start <= ${day} AND ${day} < (g.period_start + CASE g.period WHEN 'month' THEN interval '1 month' ELSE interval '3 months' END)::date`;
      return { data: (await this.rows(tx, t.tenant.timezone, sql`${targetPredicate(t)} AND ${running}`)).map((r) => this.view(t, r)) };
    });
  }

  private async one(tx: Db, t: TenantRequestContext, id: string): Promise<Row> {
    const [row] = await this.rows(tx, t.tenant.timezone, sql`g.id = ${id} AND ${targetPredicate(t)}`);
    if (!row) throw new ProblemError('NOT_FOUND');
    return row;
  }

  async create(t: TenantRequestContext, body: z.infer<typeof TargetCreate>, ip: string) {
    const subjectId = body.subject.type === 'segment' ? null : body.subject.id;
    this.assertManage(t, body.subject.type, subjectId);
    if (body.segment && !t.segments.includes(body.segment)) throw new ProblemError('SEGMENT_NOT_ALLOWED');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`
          INSERT INTO sales_targets (tenant_id, subject_type, user_id, team_id, segment, period, period_start, metric, target_value, currency, created_by)
          VALUES (${t.tenant.id}, ${body.subject.type}, ${body.subject.type === 'user' ? subjectId : null}, ${body.subject.type === 'team' ? subjectId : null}, ${body.segment}, ${body.period},
            ${body.periodStart}, ${body.metric}, ${body.targetValue}::numeric, ${body.metric === 'won_amount' ? (body.currency ?? t.tenant.currency) : null}, ${t.principal.userId}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'target.created', actorId: t.principal.userId, targetType: 'sales_target', targetId: id, ip, details: { subject: body.subject, period: body.period, periodStart: body.periodStart, metric: body.metric, targetValue: body.targetValue } });
        return this.view(t, await this.one(tx, t, id));
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a target for this subject, period and metric exists');
        return mapDbError(e);
      }
    });
  }

  async patch(t: TenantRequestContext, id: string, version: number, targetValue: string, ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.one(tx, t, id);
      this.assertManage(t, row.subject_type, row.user_id ?? row.team_id);
      // A changed target may be at risk again.
      const r = await tx.execute(sql`UPDATE sales_targets SET target_value = ${targetValue}::numeric, at_risk_at = NULL, version = version + 1 WHERE id = ${id} AND version = ${version}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('PRECONDITION_FAILED');
      await audit(tx, t.tenant.id, { action: 'target.updated', actorId: t.principal.userId, targetType: 'sales_target', targetId: id, ip, details: { from: row.target_value, to: targetValue } });
      return this.view(t, await this.one(tx, t, id));
    });
  }

  async remove(t: TenantRequestContext, id: string, ip: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.one(tx, t, id);
      this.assertManage(t, row.subject_type, row.user_id ?? row.team_id);
      await tx.execute(sql`DELETE FROM sales_targets WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: 'target.deleted', actorId: t.principal.userId, targetType: 'sales_target', targetId: id, ip, details: { metric: row.metric, periodStart: row.period_start, targetValue: row.target_value } });
    });
  }

  /** Background: running targets that fell behind, once each: an event and a notice to the person and their managers. */
  async scanRisk(limit = 1000): Promise<number> {
    const open = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; id: string }>(sql`SELECT tenant_id, id FROM app.open_targets(${limit})`)).rows);
    const byTenant = new Map<string, string[]>();
    for (const o of open) byTenant.set(o.tenant_id, [...(byTenant.get(o.tenant_id) ?? []), o.id]);
    let found = 0;
    for (const [tenantId, ids] of byTenant) {
      try {
        found += await this.scanTenant(tenantId, ids);
      } catch (e) {
        this.log.warn(`target scan failed for a tenant: ${(e as Error).message}`);
      }
    }
    return found;
  }

  private async scanTenant(tenantId: string, ids: readonly string[]): Promise<number> {
    return this.db.withTenant({ tenantId, userId: null, segments: ['b2b', 'b2c'] }, async (tx) => {
      const tz = (await tx.execute<{ timezone: string; on: boolean }>(sql`SELECT timezone, EXISTS (SELECT 1 FROM tenant_modules WHERE module_id = 'sales_tracking' AND enabled) AS on FROM tenants`)).rows[0];
      if (!tz?.on) return 0;
      let found = 0;
      for (const r of (await this.rows(tx, tz.timezone, sql`g.id = ANY(${uuidArray(ids)})`)).filter(risky)) {
        const claimed = await tx.execute(sql`UPDATE sales_targets SET at_risk_at = now() WHERE id = ${r.id} AND at_risk_at IS NULL`);
        if ((claimed.rowCount ?? 0) === 0) continue;
        found += 1;
        await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
          VALUES (${tenantId}, 'target.at_risk', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
            ${JSON.stringify({ targetId: r.id, progress: Number(r.progress), expected: Number(r.elapsed) })}::jsonb, gen_random_uuid())`);
        const people = await tx.execute<{ u: string }>(sql`
          WITH RECURSIVE up(id) AS (
            SELECT ${r.team_id}::uuid WHERE ${r.team_id}::uuid IS NOT NULL
            UNION SELECT m.primary_team_id FROM memberships m WHERE m.user_id = ${r.user_id}::uuid AND m.primary_team_id IS NOT NULL
            UNION SELECT c.parent_team_id FROM teams c JOIN up ON c.id = up.id WHERE c.parent_team_id IS NOT NULL
          )
          SELECT DISTINCT tm.user_id::text AS u FROM team_members tm WHERE tm.role = 'manager' AND tm.team_id IN (SELECT id FROM up)
          UNION SELECT ${r.user_id}::text WHERE ${r.user_id}::uuid IS NOT NULL
          UNION SELECT ${r.created_by}::text WHERE ${r.subject_type} = 'segment'`);
        await notify(tx, { tenant: { id: tenantId }, principal: { userId: '' } }, {
          users: people.rows.map((p) => p.u), kind: 'automation', sourceType: 'target_risk', sourceId: r.id, recordType: 'target', recordId: r.id, includeActor: true,
          message: `${r.name ?? r.segment ?? ''} · %${r.progress} / %${r.elapsed}`,
        });
      }
      return found;
    });
  }
}

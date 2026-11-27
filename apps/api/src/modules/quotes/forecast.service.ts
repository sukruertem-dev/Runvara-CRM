import { Inject, Injectable, Logger } from '@nestjs/common';
import { can, scopesOf } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import type { ForecastAdjust, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { notify } from '../../common/notify';
import { ProblemError } from '../../common/problem';
import { hiddenFields, recordPredicate, uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, readCrmRow } from '../crm/crm-objects';

// P9c (docs/p9-plan.md §15–20): weighted forecast with the Manager's call and snapshots; untouched opportunities and
// the next step. Only B2B opportunities count; a person sees the forecast of the opportunities they may read and
// whose owner is within their forecast scope (own, the team's, all).

export interface ActivityRules { staleDays: number; requireNextStep: boolean }

/** The tenant's B2B activity rules (`sales_b2b.activity_rules`, defaults when unset). */
export async function activityRules(tx: Db, tenantId: string): Promise<ActivityRules> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT v.value FROM tenant_settings_head h JOIN tenant_settings v USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = 'sales_b2b.activity_rules'`);
  const def = configKey('sales_b2b.activity_rules');
  if (!def) throw new Error('activity rules config key is not registered');
  return mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as ActivityRules;
}

/** Does the B2B opportunity have an open task (its next step)? */
export async function hasNextStep(tx: Db, opportunityId: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT 1 FROM tasks WHERE related_type = 'opportunity' AND related_id = ${opportunityId} AND closed_at IS NULL AND deleted_at IS NULL LIMIT 1`);
  return (r.rowCount ?? 0) > 0;
}

/** First day and the day after the last of a month (`2026-11`) or a quarter (`2026-Q4`). */
export function periodBounds(period: string): { from: string; until: string; last: string } {
  const m = /^(\d{4})-(?:(0[1-9]|1[0-2])|Q([1-4]))$/.exec(period);
  if (!m) throw new ProblemError('FORECAST_PERIOD_INVALID');
  const year = Number(m[1]);
  const first = m[2] ? Number(m[2]) : (Number(m[3]) - 1) * 3 + 1;
  const months = m[2] ? 1 : 3;
  const day = (y: number, mo: number): string => `${String(y)}-${String(mo).padStart(2, '0')}-01`;
  const endMonth = first + months;
  const until = endMonth > 12 ? day(year + 1, endMonth - 12) : day(year, endMonth);
  const lastDate = new Date(`${until}T00:00:00Z`);
  lastDate.setUTCDate(lastDate.getUTCDate() - 1);
  return { from: day(year, first), until, last: lastDate.toISOString().slice(0, 10) };
}

/** The current month and quarter in a time zone (scheduled snapshots). */
export function currentPeriods(timezone: string, now = new Date()): string[] {
  const [y = '1970', mo = '01'] = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).format(now).split('-');
  return [`${y}-${mo}`, `${y}-Q${String(Math.floor((Number(mo) - 1) / 3) + 1)}`];
}

/** Money with exactly two decimals from a numeric string. */
const money = (v: string | null | undefined): string => {
  const [i = '0', f = ''] = (v ?? '0').split('.');
  return `${i}.${f.padEnd(2, '0').slice(0, 2)}`;
};
const add = (a: string, b: string): string => (BigInt(a.replace('.', '')) + BigInt(b.replace('.', ''))).toString().padStart(3, '0').replace(/(\d{2})$/, '.$1');

type OppRow = {
  id: string; name: string; owner_user_id: string; owner_name: string; currency: string; amount: string; probability: string; weighted: string;
  expected_close: string | null; closed: boolean; stage: string;
};
type AdjRow = { owner_user_id: string; currency: string; amount: string; note: string; updated_by: string; updater_name: string; updated_at: string };
type Person = { id: string; displayName: string };
export type OwnerRow = {
  owner: Person; currency: string; count: number; pipeline: string; weighted: string; won: string;
  adjustment: { amount: string; note: string; updatedBy: Person; updatedAt: string } | null; forecast: string;
};
type Total = { currency: string; count: number; pipeline: string; weighted: string; won: string; forecast: string };
type SnapshotRow = { id: string; period: string; kind: 'manual' | 'scheduled'; taken_at: string; taken_by: string | null; taker_name: string | null; rows: OwnerRow[] };

function totalsOf(owners: readonly OwnerRow[]): Total[] {
  const by = new Map<string, Total>();
  for (const o of owners) {
    const t = by.get(o.currency) ?? { currency: o.currency, count: 0, pipeline: '0.00', weighted: '0.00', won: '0.00', forecast: '0.00' };
    by.set(o.currency, {
      currency: o.currency, count: t.count + o.count, pipeline: add(t.pipeline, o.pipeline), weighted: add(t.weighted, o.weighted), won: add(t.won, o.won), forecast: add(t.forecast, o.forecast),
    });
  }
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

@Injectable()
export class ForecastService {
  private readonly log = new Logger('forecast');

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  // ------------------------------------------------------------------ scope
  /** B2B data is not there for whoever has no B2B segment (404), nor amounts for whoever may not see them. */
  private assertReadable(t: TenantRequestContext): ReturnType<typeof authorize> {
    if (!t.segments.includes('b2b')) throw new ProblemError('NOT_FOUND');
    const d = authorize(t, 'sales_b2b.forecast.read', 'read');
    if (hiddenFields(t, 'opportunity').has('amount')) throw new ProblemError('NOT_FOUND');
    return d;
  }

  /** People whose numbers the caller sees: null = everyone. */
  private ownersInScope(t: TenantRequestContext, d: ReturnType<typeof authorize>): Set<string> | null {
    const scopes = scopesOf(d.grant);
    if (scopes.includes('all') || scopes.includes('segment')) return null;
    const ids = new Set([t.principal.userId]);
    if (scopes.includes('team')) for (const u of [...t.access.teamMemberIds, ...t.access.managedMemberIds]) ids.add(u);
    return ids;
  }

  /** Whose forecast may the caller call: Admin anyone, a Manager the members of teams they manage, never themselves. */
  private mayAdjust(t: TenantRequestContext, ownerId: string): boolean {
    const d = can(t.authz, 'sales_b2b.forecast.adjust', 'approve');
    if (!d.allow) return false;
    const scopes = scopesOf(d.grant);
    if (scopes.includes('all')) return true;
    return scopes.includes('team') && ownerId !== t.principal.userId && t.access.managedMemberIds.includes(ownerId);
  }

  // ------------------------------------------------------------------ computing
  private visible(tx: Db, t: TenantRequestContext): Promise<SQL> {
    return recordPredicate(tx, t, CRM.opportunity.shape, 'read');
  }

  /** `visible` narrows opportunities (alias `t`) to what the caller may read; the weekly job passes TRUE. */
  private async compute(tx: Db, timezone: string, period: string, owners: Set<string> | null, visible: SQL): Promise<{ owners: OwnerRow[]; opportunities: OppRow[] }> {
    const b = periodBounds(period);
    const scope: SQL = owners ? sql`t.owner_user_id = ANY(${uuidArray([...owners])})` : sql`TRUE`;
    const opps = (await tx.execute<OppRow>(sql`
      SELECT t.id, t.name, t.owner_user_id, u.display_name AS owner_name, t.currency, COALESCE(t.amount, 0)::text AS amount, t.probability::text AS probability,
        round(COALESCE(t.amount, 0) * t.probability / 100, 2)::text AS weighted, t.expected_close::text AS expected_close, s.category = 'closed' AS closed,
        COALESCE(s.label_i18n ->> 'tr', s.label_i18n ->> 'en', s.key) AS stage
      FROM ${CRM.opportunity.from} JOIN users u ON u.id = t.owner_user_id
      WHERE t.deleted_at IS NULL AND t.segment = 'b2b' AND ${scope} AND ${visible}
        AND ((s.category <> 'closed' AND t.expected_close >= ${b.from}::date AND t.expected_close < ${b.until}::date)
          OR (s.category = 'closed' AND t.probability > 0 AND (t.closed_at AT TIME ZONE ${timezone})::date >= ${b.from}::date
              AND (t.closed_at AT TIME ZONE ${timezone})::date < ${b.until}::date))
      ORDER BY t.expected_close NULLS LAST, t.id LIMIT 5000`)).rows;
    const adjustments = (await tx.execute<AdjRow>(sql`
      SELECT a.owner_user_id, a.currency, a.amount::text AS amount, a.note, a.updated_by, u.display_name AS updater_name, a.updated_at
      FROM forecast_adjustments a JOIN users u ON u.id = a.updated_by
      WHERE a.period = ${period} AND ${owners ? sql`a.owner_user_id = ANY(${uuidArray([...owners])})` : sql`TRUE`}`)).rows;
    const names = new Map<string, string>();
    const rows = new Map<string, Omit<OwnerRow, 'adjustment' | 'forecast'>>();
    const key = (owner: string, currency: string): string => `${owner}|${currency}`;
    for (const o of opps) {
      names.set(o.owner_user_id, o.owner_name);
      const k = key(o.owner_user_id, o.currency);
      const r = rows.get(k) ?? { owner: { id: o.owner_user_id, displayName: o.owner_name }, currency: o.currency, count: 0, pipeline: '0.00', weighted: '0.00', won: '0.00' };
      rows.set(k, o.closed
        ? { ...r, won: add(r.won, money(o.amount)) }
        : { ...r, count: r.count + 1, pipeline: add(r.pipeline, money(o.amount)), weighted: add(r.weighted, money(o.weighted)) });
    }
    // A call for someone without open numbers still shows (the Manager may expect business not yet in the pipeline).
    const adjOf = new Map(adjustments.map((a) => [key(a.owner_user_id, a.currency), a]));
    if (adjustments.some((a) => !rows.has(key(a.owner_user_id, a.currency)))) {
      const missing = adjustments.filter((a) => !names.has(a.owner_user_id)).map((a) => a.owner_user_id);
      if (missing.length) {
        for (const u of (await tx.execute<{ id: string; display_name: string }>(sql`SELECT id, display_name FROM users WHERE id = ANY(${uuidArray(missing)})`)).rows) names.set(u.id, u.display_name);
      }
      for (const a of adjustments) {
        const k = key(a.owner_user_id, a.currency);
        if (!rows.has(k)) rows.set(k, { owner: { id: a.owner_user_id, displayName: names.get(a.owner_user_id) ?? '' }, currency: a.currency, count: 0, pipeline: '0.00', weighted: '0.00', won: '0.00' });
      }
    }
    const out: OwnerRow[] = [...rows.entries()].map(([k, r]) => {
      const a = adjOf.get(k);
      const adjustment = a ? { amount: money(a.amount), note: a.note, updatedBy: { id: a.updated_by, displayName: a.updater_name }, updatedAt: new Date(a.updated_at).toISOString() } : null;
      return { ...r, adjustment, forecast: adjustment ? adjustment.amount : add(r.won, r.weighted) };
    });
    out.sort((a, b) => a.owner.displayName.localeCompare(b.owner.displayName, 'tr') || a.currency.localeCompare(b.currency));
    return { owners: out, opportunities: opps.filter((o) => !o.closed) };
  }

  private async view(tx: Db, t: TenantRequestContext, period: string, d: ReturnType<typeof authorize>) {
    const b = periodBounds(period);
    const r = await this.compute(tx, t.tenant.timezone, period, this.ownersInScope(t, d), await this.visible(tx, t));
    return {
      period, from: b.from, to: b.last,
      totals: totalsOf(r.owners),
      owners: r.owners.map((o) => ({ ...o, canAdjust: this.mayAdjust(t, o.owner.id) })),
      opportunities: r.opportunities.slice(0, 500).map((o) => ({
        id: o.id, name: o.name, owner: { id: o.owner_user_id, displayName: o.owner_name }, stage: o.stage, currency: o.currency, amount: money(o.amount),
        probability: Number(o.probability), weighted: money(o.weighted), expectedClose: o.expected_close ?? '',
      })),
      canSnapshot: can(t.authz, 'sales_b2b.forecast.adjust', 'approve').allow,
    };
  }

  async get(t: TenantRequestContext, period: string) {
    const d = this.assertReadable(t);
    periodBounds(period);
    return this.db.withTenant(dbCtx(t), (tx) => this.view(tx, t, period, d));
  }

  async adjust(t: TenantRequestContext, body: z.infer<typeof ForecastAdjust>) {
    const d = this.assertReadable(t);
    periodBounds(body.period);
    authorize(t, 'sales_b2b.forecast.adjust', 'approve');
    if (!this.mayAdjust(t, body.ownerId)) throw new ProblemError('FORBIDDEN', 'only for people of teams you manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const member = await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${body.ownerId} AND status = 'active'`);
      if ((member.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      if (body.amount === null) {
        await tx.execute(sql`DELETE FROM forecast_adjustments WHERE period = ${body.period} AND owner_user_id = ${body.ownerId} AND currency = ${body.currency}`);
      } else {
        await tx.execute(sql`
          INSERT INTO forecast_adjustments (tenant_id, period, owner_user_id, currency, amount, note, updated_by)
          VALUES (${t.tenant.id}, ${body.period}, ${body.ownerId}, ${body.currency}, ${body.amount}, ${body.note}, ${t.principal.userId})
          ON CONFLICT (tenant_id, period, owner_user_id, currency) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`);
      }
      await audit(tx, t.tenant.id, {
        action: body.amount === null ? 'forecast.adjustment_cleared' : 'forecast.adjusted', actorType: 'user', actorId: t.principal.userId, targetType: 'user', targetId: body.ownerId,
        details: { period: body.period, currency: body.currency, amount: body.amount },
      });
      return this.view(tx, t, body.period, d);
    });
  }

  // ------------------------------------------------------------------ snapshots
  private snapshotView(s: SnapshotRow, owners: Set<string> | null) {
    const rows = owners ? s.rows.filter((r) => owners.has(r.owner.id)) : s.rows;
    return {
      id: s.id, period: s.period, kind: s.kind, takenAt: new Date(s.taken_at).toISOString(),
      takenBy: s.taken_by ? { id: s.taken_by, displayName: s.taker_name ?? '' } : null, totals: totalsOf(rows), owners: rows,
    };
  }

  private async insertSnapshot(tx: Db, tenantId: string, period: string, kind: 'manual' | 'scheduled', by: string | null, rows: OwnerRow[]): Promise<string> {
    const [s] = (await tx.execute<{ id: string }>(sql`
      INSERT INTO forecast_snapshots (tenant_id, period, kind, taken_by, rows) VALUES (${tenantId}, ${period}, ${kind}, ${by}, ${JSON.stringify(rows)}::jsonb) RETURNING id`)).rows;
    if (!s) throw new Error('snapshot not written');
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, segment, actor, payload, correlation_id)
      VALUES (${tenantId}, 'forecast.snapshot_taken', 'b2b', ${JSON.stringify(by ? { type: 'user', id: by } : { type: 'system', id: null })}::jsonb,
        ${JSON.stringify({ snapshotId: s.id, period, kind })}::jsonb, gen_random_uuid())`);
    return s.id;
  }

  private async snapshotRows(tx: Db, where: SQL): Promise<SnapshotRow[]> {
    return (await tx.execute<SnapshotRow>(sql`
      SELECT f.id, f.period, f.kind, f.taken_at, f.taken_by, u.display_name AS taker_name, f.rows
      FROM forecast_snapshots f LEFT JOIN users u ON u.id = f.taken_by WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC LIMIT 50`)).rows;
  }

  /** A Manager (or Admin) records the forecast as their scope shows it. */
  async takeSnapshot(t: TenantRequestContext, period: string) {
    const d = this.assertReadable(t);
    authorize(t, 'sales_b2b.forecast.adjust', 'approve');
    periodBounds(period);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const owners = this.ownersInScope(t, d);
      const r = await this.compute(tx, t.tenant.timezone, period, owners, await this.visible(tx, t));
      const id = await this.insertSnapshot(tx, t.tenant.id, period, 'manual', t.principal.userId, r.owners);
      const [s] = await this.snapshotRows(tx, sql`f.id = ${id}`);
      if (!s) throw new ProblemError('NOT_FOUND');
      return this.snapshotView(s, owners);
    });
  }

  /** Snapshots of a period; each shows only the people within the caller's scope. */
  async listSnapshots(t: TenantRequestContext, period: string) {
    const d = this.assertReadable(t);
    periodBounds(period);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const owners = this.ownersInScope(t, d);
      return { data: (await this.snapshotRows(tx, sql`f.period = ${period}`)).map((s) => this.snapshotView(s, owners)) };
    });
  }

  /** Weekly (catalogue job `sales_b2b.forecast.snapshot`): the whole workspace's current month and quarter. */
  async snapshotAll(): Promise<number> {
    const tenants = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM app.b2b_tenants()`)).rows);
    let n = 0;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        n += await this.db.withTenant({ tenantId, userId: null, segments: ['b2b'] }, async (tx) => {
          const tz = (await tx.execute<{ timezone: string }>(sql`SELECT timezone FROM tenants`)).rows[0]?.timezone ?? 'UTC';
          let made = 0;
          for (const period of currentPeriods(tz)) {
            const r = await this.compute(tx, tz, period, null, sql`TRUE`);
            await this.insertSnapshot(tx, tenantId, period, 'scheduled', null, r.owners);
            made += 1;
          }
          return made;
        });
      } catch (e) {
        this.log.warn(`forecast snapshot failed for a tenant: ${(e as Error).message}`);
      }
    }
    return n;
  }

  // ------------------------------------------------------------------ activity rules
  private touchedSql(): SQL {
    return sql`GREATEST(t.created_at,
      COALESCE((SELECT max(ae.occurred_at) FROM activity_events ae WHERE ae.record_type = 'opportunity' AND ae.record_id = t.id), t.created_at),
      COALESCE((SELECT max(k.updated_at) FROM tasks k WHERE k.related_type = 'opportunity' AND k.related_id = t.id AND k.deleted_at IS NULL), t.created_at))`;
  }

  private nextStepSql(): SQL {
    return sql`(SELECT json_build_object('id', k.id, 'title', k.title, 'dueAt', k.due_at) FROM tasks k
      WHERE k.related_type = 'opportunity' AND k.related_id = t.id AND k.closed_at IS NULL AND k.deleted_at IS NULL ORDER BY k.due_at NULLS LAST, k.id LIMIT 1)`;
  }

  async pulse(t: TenantRequestContext, id: string) {
    if (!t.segments.includes('b2b')) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, CRM.opportunity, id);
      if (row.segment !== 'b2b') throw new ProblemError('NOT_FOUND');
      const rules = await activityRules(tx, t.tenant.id);
      const [r] = (await tx.execute<{ touched: string; idle: number; next: { id: string; title: string; dueAt: string | null } | null; open: boolean }>(sql`
        SELECT ${this.touchedSql()} AS touched, floor(extract(epoch FROM now() - ${this.touchedSql()}) / 86400)::int AS idle, ${this.nextStepSql()} AS next, s.category <> 'closed' AS open
        FROM ${CRM.opportunity.from} WHERE t.id = ${id}`)).rows;
      if (!r) throw new ProblemError('NOT_FOUND');
      return {
        lastTouchedAt: new Date(r.touched).toISOString(), idleDays: r.idle, stale: r.open && r.idle >= rules.staleDays, staleDays: rules.staleDays, requireNextStep: rules.requireNextStep,
        nextStep: r.next ? { id: r.next.id, title: r.next.title, dueAt: r.next.dueAt ? new Date(r.next.dueAt).toISOString() : null } : null,
      };
    });
  }

  /** Open B2B opportunities the caller may read, untouched for the configured days, the longest idle first. */
  async stale(t: TenantRequestContext) {
    if (!t.segments.includes('b2b')) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const rules = await activityRules(tx, t.tenant.id);
      const rows = (await tx.execute<{ id: string; name: string; owner_user_id: string; owner_name: string; stage: string; touched: string; idle: number; next: { id: string; title: string; dueAt: string | null } | null }>(sql`
        SELECT * FROM (
          SELECT t.id, t.name, t.owner_user_id, u.display_name AS owner_name, COALESCE(s.label_i18n ->> 'tr', s.label_i18n ->> 'en', s.key) AS stage,
            ${this.touchedSql()} AS touched, ${this.nextStepSql()} AS next
          FROM ${CRM.opportunity.from} JOIN users u ON u.id = t.owner_user_id
          WHERE t.deleted_at IS NULL AND t.segment = 'b2b' AND s.category <> 'closed' AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')}
        ) x CROSS JOIN LATERAL (SELECT floor(extract(epoch FROM now() - x.touched) / 86400)::int AS idle) i
        WHERE i.idle >= ${rules.staleDays} ORDER BY x.touched, x.id LIMIT 200`)).rows;
      return {
        staleDays: rules.staleDays,
        data: rows.map((r) => ({
          id: r.id, name: r.name, owner: { id: r.owner_user_id, displayName: r.owner_name }, stage: r.stage, lastTouchedAt: new Date(r.touched).toISOString(), idleDays: r.idle,
          nextStep: r.next ? { id: r.next.id, title: r.next.title, dueAt: r.next.dueAt ? new Date(r.next.dueAt).toISOString() : null } : null,
        })),
      };
    });
  }

  /** Daily: an alert for the owner and their team Managers once per opportunity and last touch (TRK-05). */
  async scanStale(): Promise<number> {
    const tenants = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM app.b2b_tenants()`)).rows);
    let n = 0;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        n += await this.scanTenant(tenantId);
      } catch (e) {
        this.log.warn(`stale scan failed for a tenant: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async scanTenant(tenantId: string): Promise<number> {
    return this.db.withTenant({ tenantId, userId: null, segments: ['b2b'] }, async (tx) => {
      const rules = await activityRules(tx, tenantId);
      const due = (await tx.execute<{ id: string; name: string; owner: string; touched: string; idle: number }>(sql`
        SELECT x.id, x.name, x.owner, x.touched::text AS touched, floor(extract(epoch FROM now() - x.touched) / 86400)::int AS idle FROM (
          SELECT t.id, t.name, t.owner_user_id AS owner, ${this.touchedSql()} AS touched
          FROM ${CRM.opportunity.from} WHERE t.deleted_at IS NULL AND t.segment = 'b2b' AND s.category <> 'closed'
        ) x WHERE x.touched <= now() - make_interval(days => ${rules.staleDays}) ORDER BY x.touched LIMIT 500`)).rows;
      let made = 0;
      for (const o of due) {
        const claimed = (await tx.execute<{ id: string }>(sql`
          INSERT INTO opportunity_stale_alerts (tenant_id, opportunity_id, touched_at) VALUES (${tenantId}, ${o.id}, ${o.touched}::timestamptz)
          ON CONFLICT (tenant_id, opportunity_id, touched_at) DO NOTHING RETURNING id`)).rows[0];
        if (!claimed) continue;
        made += 1;
        const people = await tx.execute<{ u: string }>(sql`
          WITH RECURSIVE up(id) AS (
            SELECT m.primary_team_id FROM memberships m WHERE m.user_id = ${o.owner}::uuid AND m.primary_team_id IS NOT NULL
            UNION SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${o.owner}::uuid
            UNION SELECT c.parent_team_id FROM teams c JOIN up ON c.id = up.id WHERE c.parent_team_id IS NOT NULL
          )
          SELECT DISTINCT tm.user_id::text AS u FROM team_members tm JOIN memberships m ON m.user_id = tm.user_id AND m.status = 'active'
          WHERE tm.role = 'manager' AND tm.team_id IN (SELECT id FROM up)
          UNION SELECT ${o.owner}::text`);
        await notify(tx, { tenant: { id: tenantId }, principal: { userId: '' } }, {
          users: people.rows.map((p) => p.u), kind: 'automation', sourceType: 'stale_opportunity', sourceId: claimed.id, recordType: 'opportunity', recordId: o.id, includeActor: true,
          message: `${o.name.slice(0, 400)} · ${String(o.idle)} gün`,
        });
        await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
          VALUES (${tenantId}, 'opportunity.stale', 'opportunity', ${o.id}, 'b2b', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
            ${JSON.stringify({ opportunityId: o.id, idleDays: o.idle, staleDays: rules.staleDays })}::jsonb, gen_random_uuid())`);
      }
      return made;
    });
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BusinessCalendarInput, DomainEvent, SlaPolicyCreate, SlaPolicyPatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { compileQuery, RqlError } from '@flexa/query-lang';
import { businessAdd, businessDiff, SlaError, validateCalendar, type BusinessCalendar } from '@flexa/sla';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { mapDbError } from '../../common/http-helpers';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { recordPredicate, type ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { conditionRegistry, shapeOf } from '../automation/rule-support';
import { taskReadPredicate } from '../tasks/tasks.service';

export const SLA_CONSUMER = 'sla';
const SLA_TYPES: ReadonlySet<string> = new Set(['case', 'task', 'lead']);
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

type CalendarRow = { id: string; name: string; timezone: string; weekly_hours: BusinessCalendar['weeklyHours']; holidays: BusinessCalendar['holidays'] };
type PolicyRow = {
  id: string; name: string; resource_type: string; criteria: string; position: number; calendar_id: string; first_response_minutes: number | null;
  resolution_minutes: number | null; warn_percent: number; pause_statuses: string[]; enabled: boolean; version: number;
};
type TimerRow = {
  id: string; record_type: string; record_id: string; policy_id: string; milestone: 'first_response' | 'resolution'; state: 'running' | 'paused' | 'met' | 'breached';
  budget_minutes: number; started_at: string; target_at: string | null; warn_at: string | null; remaining_minutes: string | null;
  warned_at: string | null; breached_at: string | null; met_at: string | null; segment: 'b2b' | 'b2c' | null;
};

const calendarOf = (c: Pick<CalendarRow, 'timezone' | 'weekly_hours' | 'holidays'>): BusinessCalendar => ({ timezone: c.timezone, weeklyHours: c.weekly_hours, holidays: c.holidays });
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
/** System context of a tenant: no user, every segment (the SLA engine is tenant-level machinery). */
const all = (e: { tenantId: string }) => ({ tenantId: e.tenantId, userId: null, segments: ['b2b', 'b2c'] as const });

/** SLA engine (Faz 5, ADR-0020): policies pick a business calendar and budgets; timers live in `sla_timers`
 *  (the source of truth). Events start, pause, resume and meet the clocks; the minute checker raises
 *  `sla.warning` / `sla.breached` events, which automation rules can react to. */
@Injectable()
export class SlaService {
  private readonly log = new Logger('sla');

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  // ------------------------------------------------------------------ administration
  private calendarView = (c: CalendarRow) => ({ id: c.id, name: c.name, timezone: c.timezone, weeklyHours: c.weekly_hours, holidays: c.holidays });

  private validate(body: z.infer<typeof BusinessCalendarInput>): void {
    try {
      validateCalendar({ timezone: body.timezone, weeklyHours: body.weeklyHours as BusinessCalendar['weeklyHours'], holidays: body.holidays as BusinessCalendar['holidays'] });
    } catch (e) {
      if (e instanceof SlaError) throw new ProblemError('SLA_POLICY_INVALID', e.message, { slaCode: e.code });
      throw e;
    }
  }

  async calendars(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<CalendarRow>(sql`SELECT id, name, timezone, weekly_hours, holidays FROM business_calendars ORDER BY name`);
      return { data: r.rows.map(this.calendarView) };
    });
  }

  async saveCalendar(t: TenantRequestContext, id: string | null, body: z.infer<typeof BusinessCalendarInput>, ip: string) {
    authorize(t, 'tenant.config.manage');
    this.validate(body);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = id
          ? await tx.execute<CalendarRow>(sql`UPDATE business_calendars SET name = ${body.name}, timezone = ${body.timezone}, weekly_hours = ${JSON.stringify(body.weeklyHours)}::jsonb,
              holidays = ${JSON.stringify(body.holidays)}::jsonb WHERE id = ${id} RETURNING id, name, timezone, weekly_hours, holidays`)
          : await tx.execute<CalendarRow>(sql`INSERT INTO business_calendars (tenant_id, name, timezone, weekly_hours, holidays)
              VALUES (${t.tenant.id}, ${body.name}, ${body.timezone}, ${JSON.stringify(body.weeklyHours)}::jsonb, ${JSON.stringify(body.holidays)}::jsonb)
              RETURNING id, name, timezone, weekly_hours, holidays`);
        const row = r.rows[0];
        if (!row) throw new ProblemError('NOT_FOUND');
        await audit(tx, t.tenant.id, { action: id ? 'sla.calendar_updated' : 'sla.calendar_created', actorId: t.principal.userId, targetType: 'business_calendar', targetId: row.id, ip });
        return this.calendarView(row);
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `calendar "${body.name}" already exists`);
        return mapDbError(e);
      }
    });
  }

  private policyView = (p: PolicyRow) => ({
    id: p.id, name: p.name, resourceType: p.resource_type, criteria: p.criteria, position: p.position, calendarId: p.calendar_id,
    firstResponseMinutes: p.first_response_minutes, resolutionMinutes: p.resolution_minutes, warnPercent: p.warn_percent, pauseStatuses: p.pause_statuses, enabled: p.enabled, version: p.version,
  });

  async policies(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<PolicyRow>(sql`SELECT * FROM sla_policies ORDER BY resource_type, position, name`);
      return { data: r.rows.map(this.policyView) };
    });
  }

  async createPolicy(t: TenantRequestContext, body: z.infer<typeof SlaPolicyCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), (tx) => this.createPolicyTx(tx, t, body, ip));
  }

  /** New calendar inside the caller's transaction (configuration import). The caller checks permission. */
  async createCalendarTx(tx: Db, t: TenantRequestContext, body: z.infer<typeof BusinessCalendarInput>, ip: string): Promise<string> {
    this.validate(body);
    const r = await tx.execute<{ id: string }>(sql`INSERT INTO business_calendars (tenant_id, name, timezone, weekly_hours, holidays)
      VALUES (${t.tenant.id}, ${body.name}, ${body.timezone}, ${JSON.stringify(body.weeklyHours)}::jsonb, ${JSON.stringify(body.holidays)}::jsonb) RETURNING id`);
    const id = r.rows[0]?.id;
    if (!id) throw new ProblemError('INTERNAL');
    await audit(tx, t.tenant.id, { action: 'sla.calendar_created', actorId: t.principal.userId, targetType: 'business_calendar', targetId: id, ip });
    return id;
  }

  /** New policy inside the caller's transaction (settings screen and configuration import). */
  async createPolicyTx(tx: Db, t: TenantRequestContext, body: z.infer<typeof SlaPolicyCreate>, ip: string) {
    if (body.criteria.trim()) {
      try {
        compileQuery(body.criteria, await conditionRegistry(tx, body.resourceType), { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
      } catch (e) {
        if (e instanceof RqlError) throw new ProblemError('SLA_POLICY_INVALID', `criteria: ${e.message}`, { position: e.position });
        throw e;
      }
    }
    try {
      const r = await tx.execute<PolicyRow>(sql`INSERT INTO sla_policies (tenant_id, name, resource_type, criteria, position, calendar_id, first_response_minutes,
          resolution_minutes, warn_percent, pause_statuses, enabled)
        VALUES (${t.tenant.id}, ${body.name}, ${body.resourceType}, ${body.criteria}, ${body.position}, ${body.calendarId}, ${body.firstResponseMinutes ?? null},
          ${body.resolutionMinutes ?? null}, ${body.warnPercent}, ${`{${body.pauseStatuses.join(',')}}`}::text[], ${body.enabled}) RETURNING *`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      await audit(tx, t.tenant.id, { action: 'sla.policy_created', actorId: t.principal.userId, targetType: 'sla_policy', targetId: row.id, ip, details: { name: body.name } });
      return this.policyView(row);
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `policy "${body.name}" already exists`);
      if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'calendar not found');
      return mapDbError(e);
    }
  }

  /** In-place change (If-Match). Clocks already running keep the budget and calendar they started with. */
  async patchPolicy(t: TenantRequestContext, id: string, version: number, body: z.infer<typeof SlaPolicyPatch>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = (await tx.execute<PolicyRow>(sql`SELECT * FROM sla_policies WHERE id = ${id} FOR UPDATE`)).rows[0];
      if (!cur) throw new ProblemError('NOT_FOUND');
      if (cur.version !== version) throw new ProblemError('PRECONDITION_FAILED', 'the policy was changed by someone else');
      const next = {
        name: body.name ?? cur.name, criteria: body.criteria ?? cur.criteria, position: body.position ?? cur.position, calendarId: body.calendarId ?? cur.calendar_id,
        first: body.firstResponseMinutes === undefined ? cur.first_response_minutes : body.firstResponseMinutes,
        resolution: body.resolutionMinutes === undefined ? cur.resolution_minutes : body.resolutionMinutes,
        warn: body.warnPercent ?? cur.warn_percent, pause: body.pauseStatuses ?? cur.pause_statuses, enabled: body.enabled ?? cur.enabled,
      };
      if (next.first === null && next.resolution === null) throw new ProblemError('VALIDATION_FAILED', 'set first response and/or resolution time');
      if (next.criteria.trim()) {
        try {
          compileQuery(next.criteria, await conditionRegistry(tx, cur.resource_type as 'case' | 'task' | 'lead'), { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
        } catch (e) {
          if (e instanceof RqlError) throw new ProblemError('SLA_POLICY_INVALID', `criteria: ${e.message}`, { position: e.position });
          throw e;
        }
      }
      try {
        const r = await tx.execute<PolicyRow>(sql`UPDATE sla_policies SET name = ${next.name}, criteria = ${next.criteria}, position = ${next.position}, calendar_id = ${next.calendarId},
            first_response_minutes = ${next.first}, resolution_minutes = ${next.resolution}, warn_percent = ${next.warn},
            pause_statuses = ${`{${next.pause.join(',')}}`}::text[], enabled = ${next.enabled}, version = version + 1
          WHERE id = ${id} RETURNING *`);
        const row = r.rows[0];
        if (!row) throw new ProblemError('NOT_FOUND');
        await audit(tx, t.tenant.id, { action: 'sla.policy_updated', actorId: t.principal.userId, targetType: 'sla_policy', targetId: id, ip, details: { changed: Object.keys(body) } });
        return this.policyView(row);
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `policy "${next.name}" already exists`);
        if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'calendar not found');
        return mapDbError(e);
      }
    });
  }

  async disablePolicy(t: TenantRequestContext, id: string, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`UPDATE sla_policies SET enabled = false WHERE id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'sla.policy_disabled', actorId: t.principal.userId, targetType: 'sla_policy', targetId: id, ip });
    });
  }

  /** Clocks of a record the caller can read. */
  async timers(t: TenantRequestContext, recordType: string | undefined, recordId: string | undefined) {
    if (!recordType || !SLA_TYPES.has(recordType) || !recordId || !/^[0-9a-f-]{36}$/i.test(recordId)) throw new ProblemError('VALIDATION_FAILED', 'recordType (case|task|lead) and recordId are required');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const type = recordType as ShareType;
      const pred = type === 'task' ? await taskReadPredicate(tx, t) : await recordPredicate(tx, t, shapeOf(type), 'read');
      const visible = await tx.execute(sql`SELECT 1 FROM ${shapeOf(type).from} WHERE t.id = ${recordId} AND t.deleted_at IS NULL AND ${pred}`);
      if ((visible.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      const r = await tx.execute<TimerRow>(sql`SELECT * FROM sla_timers WHERE record_type = ${type} AND record_id = ${recordId} ORDER BY milestone`);
      return {
        data: r.rows.map((x) => ({
          id: x.id, policyId: x.policy_id, milestone: x.milestone, state: x.state, budgetMinutes: x.budget_minutes, startedAt: new Date(x.started_at).toISOString(),
          targetAt: iso(x.target_at), warnAt: iso(x.warn_at), remainingMinutes: x.remaining_minutes === null ? null : Number(x.remaining_minutes),
          warnedAt: iso(x.warned_at), breachedAt: iso(x.breached_at), metAt: iso(x.met_at),
        })),
      };
    });
  }

  /**
   * Dashboard summary: records of a type with an SLA clock, by worst state (breached > running > paused > met),
   * counting only records the caller may read (P6b dashboard).
   */
  async summary(t: TenantRequestContext, recordType: string | undefined) {
    const type = (recordType ?? 'case') as ShareType;
    if (!SLA_TYPES.has(type)) throw new ProblemError('VALIDATION_FAILED', 'recordType must be case, task or lead');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const pred = type === 'task' ? await taskReadPredicate(tx, t) : await recordPredicate(tx, t, shapeOf(type), 'read');
      const r = await tx.execute<{ state: string; n: number }>(sql`
        WITH worst AS (
          SELECT st.record_id,
                 (array_agg(st.state ORDER BY array_position(ARRAY['breached', 'running', 'paused', 'met'], st.state)))[1] AS state
          FROM sla_timers st
          WHERE st.record_type = ${type}
            AND st.record_id IN (SELECT t.id FROM ${shapeOf(type).from} WHERE t.deleted_at IS NULL AND ${pred})
          GROUP BY st.record_id
        )
        SELECT state, count(*)::int AS n FROM worst GROUP BY state`);
      const counts = { breached: 0, running: 0, paused: 0, met: 0 };
      for (const row of r.rows) if (row.state in counts) counts[row.state as keyof typeof counts] = row.n;
      return { recordType: type, ...counts };
    });
  }

  // ------------------------------------------------------------------ event consumer
  /** Starts, pauses, resumes and meets clocks. Idempotent per event (processed_events). */
  async process(event: DomainEvent): Promise<void> {
    const type = event.resource?.type ?? '';
    const verb = event.type.slice(event.type.indexOf('.') + 1);
    const relevant = event.resource !== null && ((SLA_TYPES.has(type) && ['created', 'status_changed'].includes(verb)) || event.type === 'comment.created' || event.type === 'activity.logged');
    if (!relevant || !event.resource) return;
    const resource = event.resource;
    await this.db.withTenant(all(event), async (tx) => {
      const done = await tx.execute(sql`INSERT INTO processed_events (tenant_id, consumer, event_id) VALUES (${event.tenantId}, ${SLA_CONSUMER}, ${event.id}) ON CONFLICT DO NOTHING RETURNING 1`);
      if ((done.rowCount ?? 0) === 0) return;
      const enabled = await tx.execute(sql`SELECT 1 FROM tenant_modules WHERE module_id = 'automation_sla' AND enabled`);
      if ((enabled.rowCount ?? 0) === 0) return;
      const now = new Date(event.occurredAt);
      if (verb === 'created') await this.start(tx, event, resource.type, resource.id, now);
      else if (verb === 'status_changed') await this.statusChanged(tx, event, resource.type, resource.id, typeof event.payload.to === 'string' ? event.payload.to : '', now);
      else if (event.actor.type === 'user') await this.meet(tx, event, resource.type, resource.id, 'first_response', now); // a human reply on the record
    });
  }

  private async start(tx: Db, event: DomainEvent, type: string, id: string, at: Date): Promise<void> {
    const policies = await tx.execute<PolicyRow & CalendarRow>(sql`SELECT p.*, c.timezone, c.weekly_hours, c.holidays FROM sla_policies p
      JOIN business_calendars c ON c.id = p.calendar_id WHERE p.enabled AND p.resource_type = ${type} ORDER BY p.position, p.name`);
    const shape = shapeOf(type as ShareType);
    for (const p of policies.rows) {
      if (p.criteria.trim()) {
        let where;
        try {
          where = compileQuery(p.criteria, await conditionRegistry(tx, type as ShareType), { userId: SYSTEM_USER, timezone: p.timezone, now: at }).where;
        } catch {
          this.log.warn(`policy ${p.id} criteria no longer compile; skipped`);
          continue;
        }
        const hit = await tx.execute(sql`SELECT 1 FROM ${shape.from} WHERE t.id = ${id} AND ${where ?? sql`TRUE`}`);
        if ((hit.rowCount ?? 0) === 0) continue;
      }
      const cal = calendarOf(p);
      const segment = event.resource?.segment ?? null;
      for (const [milestone, budget] of [['first_response', p.first_response_minutes], ['resolution', p.resolution_minutes]] as const) {
        if (budget === null) continue;
        const target = businessAdd(at, budget, cal);
        const warn = businessAdd(at, (budget * p.warn_percent) / 100, cal);
        await tx.execute(sql`INSERT INTO sla_timers (tenant_id, record_type, record_id, segment, policy_id, milestone, budget_minutes, started_at, target_at, warn_at)
          VALUES (${event.tenantId}, ${type}, ${id}, ${segment}::segment, ${p.id}, ${milestone}, ${budget}, ${at}, ${target}, ${warn})
          ON CONFLICT (tenant_id, record_type, record_id, milestone) DO NOTHING`);
      }
      return; // first matching policy wins
    }
  }

  private async statusChanged(tx: Db, event: DomainEvent, type: string, id: string, to: string, at: Date): Promise<void> {
    // Any move out of the initial status is a first response; reaching a closed status resolves.
    if (event.actor.type === 'user' || event.actor.type === 'automation') await this.meet(tx, event, type, id, 'first_response', at);
    const shape = shapeOf(type as ShareType);
    const cat = await tx.execute<{ category: string }>(sql`SELECT s.category FROM ${shape.from} WHERE t.id = ${id}`);
    if (cat.rows[0]?.category === 'closed') {
      await this.meet(tx, event, type, id, 'resolution', at);
      await this.meet(tx, event, type, id, 'first_response', at);
      return;
    }
    const timers = await tx.execute<TimerRow & { pause_statuses: string[]; timezone: string; weekly_hours: BusinessCalendar['weeklyHours']; holidays: BusinessCalendar['holidays']; warn_percent: number }>(sql`
      SELECT x.*, p.pause_statuses, p.warn_percent, c.timezone, c.weekly_hours, c.holidays FROM sla_timers x
      JOIN sla_policies p ON p.id = x.policy_id JOIN business_calendars c ON c.id = p.calendar_id
      WHERE x.record_type = ${type} AND x.record_id = ${id} AND x.state IN ('running', 'paused') FOR UPDATE OF x`);
    for (const x of timers.rows) {
      const cal = calendarOf(x);
      const pauseNow = x.pause_statuses.includes(to);
      if (pauseNow && x.state === 'running' && x.target_at) {
        // Remaining business time is frozen while waiting (e.g. on the customer).
        const remaining = Math.max(0, businessDiff(at, new Date(x.target_at), cal));
        await tx.execute(sql`UPDATE sla_timers SET state = 'paused', paused_at = ${at}, remaining_minutes = ${remaining}, target_at = NULL, warn_at = NULL WHERE id = ${x.id}`);
      } else if (!pauseNow && x.state === 'paused') {
        const remaining = Number(x.remaining_minutes ?? 0);
        const target = businessAdd(at, remaining, cal);
        const untilWarn = remaining - (x.budget_minutes * (100 - x.warn_percent)) / 100;
        const warn = x.warned_at ? null : businessAdd(at, Math.max(0, untilWarn), cal);
        await tx.execute(sql`UPDATE sla_timers SET state = 'running', paused_at = NULL, remaining_minutes = NULL, target_at = ${target}, warn_at = ${warn} WHERE id = ${x.id}`);
      }
    }
  }

  private async meet(tx: Db, event: DomainEvent, type: string, id: string, milestone: 'first_response' | 'resolution', at: Date): Promise<void> {
    const r = await tx.execute<{ id: string; target_at: string | null }>(sql`UPDATE sla_timers SET state = 'met', met_at = ${at}, paused_at = NULL
      WHERE record_type = ${type} AND record_id = ${id} AND milestone = ${milestone} AND state IN ('running', 'paused') RETURNING id, target_at`);
    for (const t of r.rows) await this.emit(tx, event.tenantId, 'sla.met', type, id, event.resource?.segment ?? null, { milestone, timerId: t.id }, event);
  }

  private async emit(tx: Db, tenantId: string, type: string, recordType: string, recordId: string, segment: string | null, payload: Record<string, unknown>, cause: DomainEvent | null): Promise<void> {
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, causation_id, correlation_id, depth)
      VALUES (${tenantId}, ${type}, ${recordType}, ${recordId}, ${segment}::segment, ${JSON.stringify({ type: 'system', id: null })}::jsonb, ${JSON.stringify(payload)}::jsonb,
              ${cause?.id ?? null}, ${cause?.correlationId ?? sql`gen_random_uuid()`}, ${cause ? cause.depth : 0})`);
  }

  // ------------------------------------------------------------------ minute checker
  /** Raises warnings and breaches for due clocks across all tenants. Safe to run concurrently (SKIP LOCKED). */
  async check(now = new Date(), limit = 500): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; timer_id: string }>(sql`SELECT tenant_id, timer_id FROM app.due_sla_timers(${limit})`)).rows);
    const byTenant = new Map<string, string[]>();
    for (const d of due) byTenant.set(d.tenant_id, [...(byTenant.get(d.tenant_id) ?? []), d.timer_id]);
    let n = 0;
    for (const [tenantId, ids] of byTenant) {
      n += await this.db.withTenant(all({ tenantId }), async (tx) => {
        const rows = await tx.execute<TimerRow>(sql`SELECT * FROM sla_timers WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND state = 'running' FOR UPDATE SKIP LOCKED`);
        let changed = 0;
        for (const x of rows.rows) {
          const payload = { milestone: x.milestone, timerId: x.id, targetAt: iso(x.target_at) };
          if (x.target_at && new Date(x.target_at) <= now) {
            await tx.execute(sql`UPDATE sla_timers SET state = 'breached', breached_at = ${now}, warned_at = coalesce(warned_at, ${now}) WHERE id = ${x.id}`);
            if (!x.warned_at) await this.emit(tx, tenantId, 'sla.warning', x.record_type, x.record_id, x.segment, payload, null);
            await this.emit(tx, tenantId, 'sla.breached', x.record_type, x.record_id, x.segment, payload, null);
            changed++;
          } else if (!x.warned_at && x.warn_at && new Date(x.warn_at) <= now) {
            await tx.execute(sql`UPDATE sla_timers SET warned_at = ${now} WHERE id = ${x.id}`);
            await this.emit(tx, tenantId, 'sla.warning', x.record_type, x.record_id, x.segment, payload, null);
            changed++;
          }
        }
        return changed;
      });
    }
    return n;
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  AccountView, CaseView, ContactView, LeadView, OpportunityView, TaskView,
  type AssignmentPolicyCreate, type AutomationRuleCreate, type AutomationRulePatch, type InboundHookRequest, type z,
} from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { compileQuery, RqlError } from '@flexa/query-lang';
import { randomToken, sha256 } from '@flexa/security';
import { timingSafeEqual } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { mapDbError } from '../../common/http-helpers';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { uuidArray, type ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { attachedSegment } from '../crm/crm-objects';
import { loadFieldDefs } from '../tasks/task-fields';
import { AutomationQueues, EVENT_JOB_OPTIONS } from './queues';
import { conditionRegistry, updateBody, type RuleDefinition } from './rule-support';

type RuleRow = { id: string; name: string; description: string | null; enabled: boolean; definition: RuleDefinition; run_as: string; version: number; created_at: string; updated_at: string };
const VIEW_FIELDS: Record<ShareType, readonly string[]> = {
  task: Object.keys(TaskView.shape), account: Object.keys(AccountView.shape), contact: Object.keys(ContactView.shape),
  lead: Object.keys(LeadView.shape), opportunity: Object.keys(OpportunityView.shape), case: Object.keys(CaseView.shape),
};
const WORKFLOW_TYPES: ReadonlySet<ShareType> = new Set(['task', 'lead', 'opportunity', 'case']);

const view = (r: RuleRow, hookToken?: string) => ({
  id: r.id, name: r.name, description: r.description, enabled: r.enabled, definition: r.definition, runAs: r.run_as, version: r.version,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), ...(hookToken ? { hookToken } : {}),
});

/** Administration of automation rules, their run log, dead letters and assignment policies (docs/p5-plan.md). */
@Injectable()
export class AutomationService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly queues: AutomationQueues) {}

  // ------------------------------------------------------------------ validation
  /** A rule must be valid now: the condition compiles, fields exist and are writable, targets exist. */
  private async validate(tx: Db, t: TenantRequestContext, d: RuleDefinition): Promise<void> {
    const bad = (msg: string, extra: Record<string, unknown> = {}): never => { throw new ProblemError('RULE_DEFINITION_INVALID', msg, extra); };
    if (d.condition.trim()) {
      try {
        compileQuery(d.condition, await conditionRegistry(tx, d.resourceType), { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
      } catch (e) {
        if (e instanceof RqlError) bad(`condition: ${e.message}`, { rqlCode: e.code, position: e.position });
        throw e;
      }
    }
    const defs = await loadFieldDefs(tx, d.resourceType);
    const known = (f: string) => (f.startsWith('custom.') ? defs.some((x) => !x.archivedAt && `custom.${x.key}` === f) : VIEW_FIELDS[d.resourceType].includes(f));
    if (d.trigger.type === 'field_changed') for (const f of d.trigger.fields) if (!known(f)) bad(`trigger: unknown field ${f}`);
    if (d.trigger.type === 'status_changed' && !WORKFLOW_TYPES.has(d.resourceType)) bad(`${d.resourceType} has no statuses`);
    if (d.trigger.type === 'sla' && !['case', 'task', 'lead'].includes(d.resourceType)) bad(`${d.resourceType} has no SLA clocks`);
    const users = new Set<string>();
    const policies = new Set<string>();
    for (const a of d.actions) {
      if (a.type === 'update_field') {
        if (!known(a.field)) bad(`update_field: unknown field ${a.field}`);
        updateBody(d.resourceType, a.field, a.value);
      }
      if (a.type === 'transition' && !WORKFLOW_TYPES.has(d.resourceType)) bad(`${d.resourceType} has no workflow`);
      if (a.type === 'email_customer' && d.resourceType !== 'contact') bad('email_customer is for contact rules');
      if (a.type === 'call_webhook') {
        const w = await tx.execute(sql`SELECT 1 FROM webhook_subscriptions WHERE id = ${a.subscriptionId}`);
        if ((w.rowCount ?? 0) === 0) bad('unknown webhook subscription');
      }
      const to = a.type === 'assign' || a.type === 'notify' || a.type === 'send_email' ? a.to : a.type === 'create_task' ? a.assignTo : null;
      if (to?.kind === 'user') users.add(to.userId);
      if (to?.kind === 'policy') policies.add(to.policyId);
    }
    if (users.size) {
      const r = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM memberships WHERE status = 'active' AND user_id = ANY(${uuidArray([...users])})`);
      if ((r.rows[0]?.n ?? 0) !== users.size) bad('a target user is not an active member');
    }
    if (policies.size) {
      const r = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM assignment_policies WHERE id = ANY(${uuidArray([...policies])})`);
      if ((r.rows[0]?.n ?? 0) !== policies.size) bad('unknown assignment policy');
    }
  }

  private async syncSchedule(t: TenantRequestContext, r: RuleRow): Promise<void> {
    const tr = r.definition.trigger;
    try {
      if (r.enabled && tr.type === 'schedule') await this.queues.upsertSchedule(t.tenant.id, r.id, tr.cron, tr.timezone);
      else await this.queues.removeSchedule(r.id);
    } catch (e) {
      throw new ProblemError('RULE_DEFINITION_INVALID', `schedule: ${(e as Error).message}`);
    }
  }

  // ------------------------------------------------------------------ rules
  private async rows(tx: Db, id?: string): Promise<RuleRow[]> {
    const r = await tx.execute<RuleRow>(sql`SELECT id, name, description, enabled, definition, run_as, version, created_at, updated_at
      FROM automation_rules ${id ? sql`WHERE id = ${id}` : sql``} ORDER BY name, id`);
    return r.rows;
  }

  private async one(tx: Db, id: string): Promise<RuleRow> {
    const [r] = await this.rows(tx, id);
    if (!r) throw new ProblemError('NOT_FOUND');
    return r;
  }

  async list(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.rows(tx)).map((r) => view(r)) }));
  }

  async get(t: TenantRequestContext, id: string) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => view(await this.one(tx, id)));
  }

  async create(t: TenantRequestContext, body: z.infer<typeof AutomationRuleCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    const created = await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.validate(tx, t, body.definition);
      const token = body.definition.trigger.type === 'inbound_webhook' ? randomToken() : null;
      try {
        const r = await tx.execute<{ id: string }>(sql`
          INSERT INTO automation_rules (tenant_id, name, description, enabled, resource_type, trigger_type, definition, hook_token_hash, run_as, created_by)
          VALUES (${t.tenant.id}, ${body.name}, ${body.description ?? null}, ${body.enabled}, ${body.definition.resourceType}, ${body.definition.trigger.type},
                  ${JSON.stringify(body.definition)}::jsonb, ${token ? sha256(token) : null}, ${t.principal.userId}, ${t.principal.userId}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'automation.rule_created', actorId: t.principal.userId, targetType: 'automation_rule', targetId: id, ip, details: { name: body.name, trigger: body.definition.trigger.type } });
        return { row: await this.one(tx, id), token };
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `rule "${body.name}" already exists`);
        return mapDbError(e);
      }
    });
    await this.syncSchedule(t, created.row);
    return view(created.row, created.token ?? undefined);
  }

  /** Every change is a new version and the editing Admin becomes the identity the rule runs as. */
  async patch(t: TenantRequestContext, id: string, body: z.infer<typeof AutomationRulePatch>, ip: string) {
    authorize(t, 'tenant.config.manage');
    const row = await this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = await this.one(tx, id);
      const definition = body.definition ?? cur.definition;
      if (body.definition) {
        await this.validate(tx, t, body.definition);
        if (body.definition.resourceType !== cur.definition.resourceType || (body.definition.trigger.type === 'inbound_webhook') !== (cur.definition.trigger.type === 'inbound_webhook')) {
          throw new ProblemError('RULE_DEFINITION_INVALID', 'resource type and webhook trigger cannot change; create a new rule');
        }
      }
      try {
        await tx.execute(sql`UPDATE automation_rules SET
          name = ${body.name ?? cur.name}, description = ${body.description !== undefined ? body.description : cur.description},
          enabled = ${body.enabled ?? cur.enabled}, trigger_type = ${definition.trigger.type}, definition = ${JSON.stringify(definition)}::jsonb,
          run_as = ${t.principal.userId}, version = version + 1 WHERE id = ${id}`);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a rule with that name exists');
        mapDbError(e);
      }
      await audit(tx, t.tenant.id, { action: 'automation.rule_updated', actorId: t.principal.userId, targetType: 'automation_rule', targetId: id, ip, details: { fields: Object.keys(body) } });
      return this.one(tx, id);
    });
    await this.syncSchedule(t, row);
    return view(row);
  }

  async remove(t: TenantRequestContext, id: string, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.one(tx, id);
      await tx.execute(sql`DELETE FROM automation_rules WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: 'automation.rule_deleted', actorId: t.principal.userId, targetType: 'automation_rule', targetId: id, ip });
    });
    await this.queues.removeSchedule(id);
  }

  async rotateHookToken(t: TenantRequestContext, id: string, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = await this.one(tx, id);
      if (cur.definition.trigger.type !== 'inbound_webhook') throw new ProblemError('RULE_DEFINITION_INVALID', 'not an inbound-webhook rule');
      const token = randomToken();
      await tx.execute(sql`UPDATE automation_rules SET hook_token_hash = ${sha256(token)} WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: 'automation.hook_token_rotated', actorId: t.principal.userId, targetType: 'automation_rule', targetId: id, ip });
      return view(cur, token);
    });
  }

  // ------------------------------------------------------------------ runs and dead letters
  async runs(t: TenantRequestContext, q: { ruleId?: string; status?: string; limit?: string }) {
    authorize(t, 'tenant.config.read', 'read');
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–500');
    if (q.ruleId !== undefined && !/^[0-9a-f-]{36}$/i.test(q.ruleId)) throw new ProblemError('VALIDATION_FAILED', 'ruleId must be a uuid');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{
        id: string; rule_id: string; rule_version: number; event_id: string; correlation_id: string; depth: number; record_type: string; record_id: string;
        status: string; condition_result: boolean | null; actions: unknown[]; error: string | null; attempt: number; duration_ms: number | null; started_at: string;
      }>(sql`SELECT id, rule_id, rule_version, event_id, correlation_id, depth, record_type, record_id, status, condition_result, actions, error, attempt, duration_ms, started_at
        FROM automation_runs WHERE TRUE ${q.ruleId ? sql`AND rule_id = ${q.ruleId}` : sql``} ${q.status ? sql`AND status = ${q.status}` : sql``}
        ORDER BY started_at DESC, id DESC LIMIT ${limit}`);
      return {
        data: r.rows.map((x) => ({
          id: x.id, ruleId: x.rule_id, ruleVersion: x.rule_version, eventId: x.event_id, correlationId: x.correlation_id, depth: x.depth,
          record: { type: x.record_type, id: x.record_id }, status: x.status, conditionResult: x.condition_result,
          // Mail actions keep the recipient id for redelivery; the log shows only the action summary.
          actions: x.actions.map((a) => { const { mail: _m, ...rest } = a as Record<string, unknown>; return rest; }),
          error: x.error, attempt: x.attempt, durationMs: x.duration_ms, startedAt: new Date(x.started_at).toISOString(),
        })),
      };
    });
  }

  private dlView = (d: { id: string; consumer: string; event_id: string; event: { type?: string }; error: string; attempts: number; created_at: string; replayed_at: string | null }) => ({
    id: d.id, consumer: d.consumer, eventId: d.event_id, eventType: d.event.type ?? '', error: d.error, attempts: d.attempts,
    createdAt: new Date(d.created_at).toISOString(), replayedAt: d.replayed_at ? new Date(d.replayed_at).toISOString() : null,
  });

  async deadLetters(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<Parameters<typeof this.dlView>[0]>(sql`SELECT id, consumer, event_id, event, error, attempts, created_at, replayed_at
        FROM dead_letters ORDER BY created_at DESC, id DESC LIMIT 500`);
      return { data: r.rows.map(this.dlView) };
    });
  }

  /** Puts the dead event back on the queue under a new job id (new attempt group). Runs that already
   *  succeeded stay applied (idempotency); failed/dead ones run again. */
  async replay(t: TenantRequestContext, id: string, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<Parameters<typeof this.dlView>[0]>(sql`SELECT id, consumer, event_id, event, error, attempts, created_at, replayed_at FROM dead_letters WHERE id = ${id} FOR UPDATE`);
      const d = r.rows[0];
      if (!d) throw new ProblemError('NOT_FOUND');
      if (d.replayed_at) throw new ProblemError('CONFLICT', 'already replayed');
      await this.queues.queueFor(t.tenant.id).add(d.event.type ?? 'event', d.event, { ...EVENT_JOB_OPTIONS, jobId: `${d.event_id}:replay:${d.id}` });
      const u = await tx.execute<Parameters<typeof this.dlView>[0]>(sql`UPDATE dead_letters SET replayed_at = now(), replayed_by = ${t.principal.userId} WHERE id = ${id}
        RETURNING id, consumer, event_id, event, error, attempts, created_at, replayed_at`);
      await audit(tx, t.tenant.id, { action: 'automation.dead_letter_replayed', actorId: t.principal.userId, targetType: 'dead_letter', targetId: id, ip, details: { eventId: d.event_id } });
      const row = u.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      return this.dlView(row);
    });
  }

  // ------------------------------------------------------------------ assignment policies
  async policies(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ id: string; name: string; strategy: 'round_robin' | 'load_balanced'; team_id: string | null; queue_id: string | null; fallback_user_id: string | null }>(sql`
        SELECT id, name, strategy, team_id, queue_id, fallback_user_id FROM assignment_policies ORDER BY name`);
      return { data: r.rows.map((p) => ({ id: p.id, name: p.name, strategy: p.strategy, teamId: p.team_id, queueId: p.queue_id, fallbackUserId: p.fallback_user_id })) };
    });
  }

  async createPolicy(t: TenantRequestContext, body: z.infer<typeof AssignmentPolicyCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO assignment_policies (tenant_id, name, strategy, team_id, queue_id, fallback_user_id)
          VALUES (${t.tenant.id}, ${body.name}, ${body.strategy}, ${body.teamId ?? null}, ${body.queueId ?? null}, ${body.fallbackUserId ?? null}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'automation.policy_created', actorId: t.principal.userId, targetType: 'assignment_policy', targetId: id, ip, details: body });
        return { id, name: body.name, strategy: body.strategy, teamId: body.teamId ?? null, queueId: body.queueId ?? null, fallbackUserId: body.fallbackUserId ?? null };
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `policy "${body.name}" already exists`);
        if ((e as { cause?: { code?: string } }).cause?.code === '23503') throw new ProblemError('NOT_FOUND', 'team, queue or fallback user not found');
        return mapDbError(e);
      }
    });
  }

  // ------------------------------------------------------------------ inbound webhook trigger
  /** No session: the per-rule token authenticates; tenant and module come from the rule. Unknown rule, wrong
   *  token, disabled rule or module all answer the same 404 (no oracle). */
  async inboundHook(ruleId: string, token: string | undefined, body: z.infer<typeof InboundHookRequest>): Promise<{ eventId: string }> {
    const rule = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; resource_type: ShareType; token_hash: Buffer | null; enabled: boolean; module_enabled: boolean }>(
      sql`SELECT tenant_id, resource_type, token_hash, enabled, module_enabled FROM app.find_hook_rule(${ruleId})`)).rows[0]);
    const given = sha256(token ?? '');
    if (!rule?.token_hash || !rule.enabled || !rule.module_enabled || rule.token_hash.length !== given.length || !timingSafeEqual(rule.token_hash, given)) {
      throw new ProblemError('NOT_FOUND');
    }
    return this.db.withTenant({ tenantId: rule.tenant_id, userId: null, segments: ['b2b', 'b2c'] }, async (tx) => {
      const exists = await tx.execute(sql`SELECT 1 FROM record_registry WHERE record_type = ${rule.resource_type} AND record_id = ${body.recordId} AND deleted_at IS NULL`);
      if ((exists.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      const segment = await attachedSegment(tx, rule.resource_type, body.recordId);
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
        VALUES (${rule.tenant_id}, 'automation.hook_received', ${rule.resource_type}, ${body.recordId}, ${segment}::segment,
                ${JSON.stringify({ type: 'service', id: null })}::jsonb, ${JSON.stringify({ ruleId, dataKeys: Object.keys(body.data).slice(0, 50) })}::jsonb, gen_random_uuid())
        RETURNING id`);
      return { eventId: r.rows[0]?.id ?? '' };
    });
  }
}

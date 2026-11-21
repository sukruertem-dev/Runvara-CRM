import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DomainEvent, MAX_AUTOMATION_DEPTH, type MailJob, type TaskCreate, type z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { compileQuery } from '@flexa/query-lang';
import { buildTenantContext } from '../../common/guards';
import { notify } from '../../common/notify';
import { ProblemError } from '../../common/problem';
import { recordPredicate, type ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV, MAILER, type ApiEnv, type Mailer } from '../../infra/tokens';
import { isCrmType } from '../crm/crm-objects';
import { CrmService } from '../crm/crm.service';
import { taskReadPredicate, TasksService } from '../tasks/tasks.service';
import { WebhooksService } from '../integrations/webhooks.service';
import { pickAssignee } from './assignment';
import { conditionRegistry, shapeOf, updateBody, type RuleAction, type RuleDefinition } from './rule-support';

type RuleRow = { id: string; name: string; resource_type: ShareType; trigger_type: string; definition: RuleDefinition; run_as: string; version: number };
type RunStatus = 'succeeded' | 'skipped' | 'failed' | 'halted_depth' | 'halted_loop' | 'dead';
const TERMINAL: ReadonlySet<RunStatus> = new Set(['succeeded', 'skipped', 'halted_depth', 'halted_loop']);
const SCHEDULE_BATCH = 500;
/** Delivery attempts per event (ADR-0006 §3); the relay sets the same value on every job. */
export const EVENT_ATTEMPTS = 8;

export const AUTOMATION_CONSUMER = 'automation';

/** A UUID (version 8 layout) derived from a key: stable across redeliveries of the same work. */
export function stableUuid(key: string): string {
  const b = createHash('sha256').update(key).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Mail produced by a run is enqueued only after its transaction commits (job id = run + action index, so a
 *  redelivered event re-enqueues the same jobs and the queue drops the duplicates). */
interface PendingMail { jobId: string; userId: string; subject: string; body: string; recordType: string; recordId: string }
interface PendingWebhook { tenantId: string; deliveryId: string; event: DomainEvent }

export interface ProcessResult { rule: string; record: string; status: RunStatus | 'duplicate' }

/** Executes automation rules for domain events (ADR-0006 §2–3, docs/p5-plan.md §2). Each rule × record runs in
 *  one transaction together with its run log row, so an action takes effect exactly once even if the event is
 *  delivered again; chains are cut at depth > MAX_AUTOMATION_DEPTH or when a rule meets the same record again. */
@Injectable()
export class AutomationRunner {
  private readonly log = new Logger('automation');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly crm: CrmService,
    private readonly tasks: TasksService,
    private readonly webhooks: WebhooksService,
  ) {}

  /** Processes one event. `final` = this is the last delivery attempt (failures become dead letters). */
  async process(raw: unknown, final = false): Promise<ProcessResult[]> {
    const event = DomainEvent.parse(raw);
    const done = await this.db.withTenant({ tenantId: event.tenantId, userId: null }, (tx) =>
      tx.execute(sql`SELECT 1 FROM processed_events WHERE consumer = ${AUTOMATION_CONSUMER} AND event_id = ${event.id}`));
    if ((done.rowCount ?? 0) > 0) return [];
    const results: ProcessResult[] = [];
    let firstError: unknown = null;
    for (const { rule, recordIds } of await this.matches(event)) {
      for (const recordId of recordIds) {
        try {
          results.push({ rule: rule.id, record: recordId, status: await this.runRule(event, rule, recordId, final) });
        } catch (e) {
          firstError ??= e;
          results.push({ rule: rule.id, record: recordId, status: final ? 'dead' : 'failed' });
        }
      }
    }
    if (firstError !== null) {
      if (final) await this.deadLetter(event, firstError);
      throw firstError instanceof Error ? firstError : new Error('automation run failed');
    }
    await this.db.withTenant({ tenantId: event.tenantId, userId: null }, (tx) =>
      tx.execute(sql`INSERT INTO processed_events (tenant_id, consumer, event_id) VALUES (${event.tenantId}, ${AUTOMATION_CONSUMER}, ${event.id}) ON CONFLICT DO NOTHING`));
    return results;
  }

  /** Rules triggered by the event and the records each applies to. */
  private async matches(event: DomainEvent): Promise<{ rule: RuleRow; recordIds: string[] }[]> {
    const [resourceType, verb] = event.type.split('.') as [string, string | undefined];
    return this.db.withTenant({ tenantId: event.tenantId, userId: null, segments: ['b2b', 'b2c'] }, async (tx) => {
      const enabled = await tx.execute<{ id: string }>(sql`SELECT 1 AS id FROM tenant_modules WHERE module_id = 'automation_sla' AND enabled`);
      if ((enabled.rowCount ?? 0) === 0) return [];
      if (event.type === 'automation.schedule_tick' || event.type === 'automation.hook_received') {
        const ruleId = typeof event.payload.ruleId === 'string' ? event.payload.ruleId : '';
        const r = await tx.execute<RuleRow>(sql`SELECT id, name, resource_type, trigger_type, definition, run_as, version FROM automation_rules
          WHERE id = ${ruleId} AND enabled AND trigger_type = ${event.type === 'automation.schedule_tick' ? 'schedule' : 'inbound_webhook'}`);
        const rule = r.rows[0];
        if (!rule) return [];
        if (event.type === 'automation.hook_received') return event.resource ? [{ rule, recordIds: [event.resource.id] }] : [];
        // Schedule: the condition selects the records (run as the owner, bounded per tick).
        const ctx = await this.contextFor(event, rule);
        const ids = await this.db.withTenant(dbCtx(ctx), async (t2) => {
          const shape = shapeOf(rule.resource_type);
          const read = rule.resource_type === 'task' ? await taskReadPredicate(t2, ctx) : await recordPredicate(t2, ctx, shape, 'read');
          const cond = await this.compileCondition(t2, ctx, rule);
          const rows = await t2.execute<{ id: string }>(sql`SELECT t.id FROM ${shape.from} WHERE t.deleted_at IS NULL AND ${read} ${cond ? sql`AND (${cond})` : sql``}
            ORDER BY t.id LIMIT ${SCHEDULE_BATCH}`);
          return rows.rows.map((x) => x.id);
        });
        return [{ rule, recordIds: ids }];
      }
      if (event.type.startsWith('sla.') && event.resource) {
        const kind = event.type.slice('sla.'.length);
        const r = await tx.execute<RuleRow>(sql`SELECT id, name, resource_type, trigger_type, definition, run_as, version FROM automation_rules
          WHERE enabled AND trigger_type = 'sla' AND resource_type = ${event.resource.type} ORDER BY created_at, id`);
        return r.rows
          .filter((rule) => {
            const tr = rule.definition.trigger;
            return tr.type === 'sla' && tr.event === kind && (tr.milestone === undefined || tr.milestone === event.payload.milestone);
          })
          .map((rule) => ({ rule, recordIds: [event.resource?.id ?? ''] }));
      }
      if (!event.resource || event.resource.type !== resourceType || !verb) return [];
      const triggers = verb === 'created' ? ['record.created'] : verb === 'updated' ? ['record.updated', 'field_changed'] : verb === 'status_changed' ? ['status_changed'] : [];
      if (triggers.length === 0) return [];
      const r = await tx.execute<RuleRow>(sql`SELECT id, name, resource_type, trigger_type, definition, run_as, version FROM automation_rules
        WHERE enabled AND resource_type = ${resourceType} AND trigger_type = ANY(${`{${triggers.join(',')}}`}::text[]) ORDER BY created_at, id`);
      const changed = Array.isArray(event.payload.changedFields) ? (event.payload.changedFields as string[]) : [];
      return r.rows
        .filter((rule) => {
          const tr = rule.definition.trigger;
          if (tr.type === 'field_changed') return tr.fields.some((f) => changed.includes(f));
          if (tr.type === 'status_changed') return tr.toStatus === undefined || tr.toStatus === event.payload.to;
          return true;
        })
        .map((rule) => ({ rule, recordIds: [event.resource?.id ?? ''] }));
    });
  }

  /** The rule runs with its owner's current rights (a demoted owner makes the run fail, visibly). */
  private async contextFor(event: DomainEvent, rule: RuleRow): Promise<TenantRequestContext> {
    const ctx = await buildTenantContext(this.db, { userId: rule.run_as, sessionId: 'automation', tenantId: event.tenantId, amr: [] });
    return { ...ctx, automation: { ruleId: rule.id, correlationId: event.correlationId, causationId: event.id, depth: event.depth } };
  }

  private async compileCondition(tx: Db, ctx: TenantRequestContext, rule: RuleRow) {
    const src = rule.definition.condition.trim();
    if (!src) return null;
    return compileQuery(src, await conditionRegistry(tx, rule.resource_type), { userId: ctx.principal.userId, timezone: ctx.tenant.timezone, now: new Date() }).where;
  }

  private async runRule(event: DomainEvent, rule: RuleRow, recordId: string, final: boolean): Promise<RunStatus | 'duplicate'> {
    const started = Date.now();
    const ctx = await this.contextFor(event, rule);
    const mails: PendingMail[] = [];
    const hooks: PendingWebhook[] = [];
    let status: RunStatus | 'duplicate';
    try {
      status = await this.db.withTenant(dbCtx(ctx), async (tx) => {
        const prior = await tx.execute<{ status: RunStatus; attempt: number; actions: { mail?: PendingMail; deliveryId?: string }[] }>(sql`
          SELECT status, attempt, actions FROM automation_runs WHERE rule_id = ${rule.id} AND event_id = ${event.id} AND record_id = ${recordId} FOR UPDATE`);
        const p = prior.rows[0];
        if (p && TERMINAL.has(p.status)) {
          // Already applied: only re-enqueue its mails (the queue de-duplicates by job id).
          for (const a of p.actions) {
            if (a.mail) mails.push(a.mail);
            if (a.deliveryId) hooks.push({ tenantId: event.tenantId, deliveryId: a.deliveryId, event });
          }
          return 'duplicate';
        }
        const attempt = (p?.attempt ?? 0) + 1;
        const base = { rule, event, recordId, attempt, started };
        if (event.depth > MAX_AUTOMATION_DEPTH) return this.finish(tx, ctx, base, 'halted_depth', null, [], `chain depth ${event.depth} > ${MAX_AUTOMATION_DEPTH}`);
        const loop = await tx.execute(sql`SELECT 1 FROM automation_runs WHERE correlation_id = ${event.correlationId} AND rule_id = ${rule.id}
          AND record_id = ${recordId} AND event_id <> ${event.id} AND status = 'succeeded' LIMIT 1`);
        if ((loop.rowCount ?? 0) > 0) return this.finish(tx, ctx, base, 'halted_loop', null, [], 'the rule already acted on this record in this chain');

        const shape = shapeOf(rule.resource_type);
        const read = rule.resource_type === 'task' ? await taskReadPredicate(tx, ctx) : await recordPredicate(tx, ctx, shape, 'read');
        const cond = await this.compileCondition(tx, ctx, rule);
        const hit = await tx.execute(sql`SELECT 1 FROM ${shape.from} WHERE t.id = ${recordId} AND t.deleted_at IS NULL AND ${read} ${cond ? sql`AND (${cond})` : sql``}`);
        if ((hit.rowCount ?? 0) === 0) return this.finish(tx, ctx, base, 'skipped', false, [], null);

        const results: Record<string, unknown>[] = [];
        for (const [i, action] of rule.definition.actions.entries()) {
          results.push(await this.act(tx, ctx, rule, recordId, action, `run:${rule.id}:${event.id}:${recordId}:${i}`, mails, hooks, event));
        }
        return this.finish(tx, ctx, base, 'succeeded', true, results, null);
      });
    } catch (e) {
      const message = e instanceof ProblemError ? `${e.code}${e.message ? `: ${e.message}` : ''}` : (e as Error).message;
      await this.db.withTenant(dbCtx(ctx), async (tx) => {
        await this.finish(tx, ctx, { rule, event, recordId, attempt: await this.attemptOf(tx, rule.id, event.id, recordId), started }, final ? 'dead' : 'failed', null, [], message.slice(0, 2000));
      });
      this.log.warn(`rule ${rule.id} on ${rule.resource_type} ${recordId} failed (${final ? 'dead' : 'will retry'}): ${message}`);
      throw e;
    }
    for (const m of mails) await this.sendMail(ctx, m);
    for (const h of hooks) await this.webhooks.enqueue(h);
    return status;
  }

  private async attemptOf(tx: Db, ruleId: string, eventId: string, recordId: string): Promise<number> {
    const r = await tx.execute<{ attempt: number }>(sql`SELECT attempt FROM automation_runs WHERE rule_id = ${ruleId} AND event_id = ${eventId} AND record_id = ${recordId}`);
    return (r.rows[0]?.attempt ?? 0) + 1;
  }

  private async finish(
    tx: Db, ctx: TenantRequestContext,
    b: { rule: RuleRow; event: DomainEvent; recordId: string; attempt: number; started: number },
    status: RunStatus, conditionResult: boolean | null, actions: Record<string, unknown>[], error: string | null,
  ): Promise<RunStatus> {
    await tx.execute(sql`
      INSERT INTO automation_runs (tenant_id, rule_id, rule_version, event_id, correlation_id, depth, record_type, record_id, status, condition_result,
                                   input, actions, error, attempt, duration_ms)
      VALUES (${ctx.tenant.id}, ${b.rule.id}, ${b.rule.version}, ${b.event.id}, ${b.event.correlationId}, ${b.event.depth}, ${b.rule.resource_type}, ${b.recordId},
              ${status}, ${conditionResult}, ${JSON.stringify({ eventType: b.event.type, payload: b.event.payload })}::jsonb, ${JSON.stringify(actions)}::jsonb,
              ${error}, ${b.attempt}, ${Date.now() - b.started})
      ON CONFLICT (tenant_id, rule_id, event_id, record_id) DO UPDATE SET status = EXCLUDED.status, condition_result = EXCLUDED.condition_result,
        actions = EXCLUDED.actions, error = EXCLUDED.error, attempt = EXCLUDED.attempt, duration_ms = EXCLUDED.duration_ms, started_at = now()`);
    if (status === 'halted_depth' || status === 'halted_loop') {
      // Visible on the bus for alerting (ADR-0006 §3); depth is not increased further (it is a terminal notice).
      await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, actor, payload, causation_id, correlation_id, depth)
        VALUES (${ctx.tenant.id}, 'automation.run.halted', ${b.rule.resource_type}, ${b.recordId}, ${JSON.stringify({ type: 'system', id: null })}::jsonb,
                ${JSON.stringify({ ruleId: b.rule.id, reason: status })}::jsonb, ${b.event.id}, ${b.event.correlationId}, ${b.event.depth})`);
    }
    return status;
  }

  private async target(tx: Db, rule: RuleRow, recordId: string, to: Extract<RuleAction, { type: 'assign' }>['to']): Promise<string> {
    if (to.kind === 'user') return to.userId;
    if (to.kind === 'policy') return pickAssignee(tx, to.policyId);
    const table = rule.resource_type === 'task' ? 'tasks' : rule.resource_type === 'opportunity' ? 'opportunities' : `${rule.resource_type}s`;
    const r = await tx.execute<{ owner: string | null }>(sql`SELECT owner_user_id::text AS owner FROM ${sql.raw(table)} WHERE id = ${recordId}`);
    const owner = r.rows[0]?.owner;
    if (!owner) throw new ProblemError('ASSIGNMENT_NO_CANDIDATE', 'the record has no owning user');
    return owner;
  }

  private async act(
    tx: Db, ctx: TenantRequestContext, rule: RuleRow, recordId: string, action: RuleAction, jobId: string, mails: PendingMail[], hooks: PendingWebhook[], event: DomainEvent,
  ): Promise<Record<string, unknown>> {
    const type = rule.resource_type;
    switch (action.type) {
      case 'update_field': {
        const body = updateBody(type, action.field, action.value);
        if (type === 'task') await this.tasks.patchIn(tx, ctx, recordId, body);
        else await this.crm.patchIn(tx, ctx, type, recordId, body);
        return { type: action.type, field: action.field };
      }
      case 'assign': {
        const userId = await this.target(tx, rule, recordId, action.to);
        if (type === 'task') await this.tasks.patchIn(tx, ctx, recordId, { owner: { type: 'user', id: userId } });
        else await this.crm.patchIn(tx, ctx, type, recordId, { ownerUserId: userId });
        return { type: action.type, userId };
      }
      case 'create_task': {
        const owner = await this.target(tx, rule, recordId, action.assignTo);
        const body: z.infer<typeof TaskCreate> = {
          title: action.title, priority: action.priority, owner: { type: 'user', id: owner },
          ...(action.dueInDays !== undefined ? { dueAt: new Date(Date.now() + action.dueInDays * 86_400_000).toISOString() } : {}),
          // A follow-up task is linked to the triggering record (for a task: as related, not as a sub-task).
          related: { type, id: recordId },
        };
        const taskId = await this.tasks.insertTask(tx, ctx, body, {});
        return { type: action.type, taskId };
      }
      case 'notify': {
        const userId = await this.target(tx, rule, recordId, action.to);
        // One notification per rule × event × record × action, and the same one on redelivery.
        await notify(tx, ctx, { users: [userId], kind: 'automation', sourceType: 'automation_rule', sourceId: stableUuid(jobId), recordType: type, recordId, message: action.message, includeActor: true });
        return { type: action.type, userId };
      }
      case 'send_email': {
        const userId = await this.target(tx, rule, recordId, action.to);
        // BullMQ custom ids may not contain ':' (beyond its own three-part form): a stable uuid of the run key.
        const mail: PendingMail = { jobId: `mail-${stableUuid(jobId)}`, userId, subject: action.subject, body: action.body, recordType: type, recordId };
        mails.push(mail);
        return { type: action.type, userId, mail };
      }
      case 'transition': {
        if (type === 'task') await this.tasks.transitionByKeyIn(tx, ctx, recordId, action.transitionKey);
        else if (isCrmType(type) && type !== 'account' && type !== 'contact') await this.crm.transitionIn(tx, ctx, type, recordId, { transitionKey: action.transitionKey });
        else throw new ProblemError('RULE_DEFINITION_INVALID', `${type} has no workflow`);
        return { type: action.type, transitionKey: action.transitionKey };
      }
      case 'call_webhook': {
        const sub = await tx.execute(sql`SELECT 1 FROM webhook_subscriptions WHERE id = ${action.subscriptionId} AND enabled`);
        if ((sub.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND', 'webhook subscription not found or disabled');
        const job = await this.webhooks.createDelivery(tx, event, action.subscriptionId);
        hooks.push(job);
        return { type: action.type, subscriptionId: action.subscriptionId, deliveryId: job.deliveryId };
      }
    }
  }

  private async sendMail(ctx: TenantRequestContext, m: PendingMail): Promise<void> {
    const r = await this.db.withTenant(dbCtx(ctx), (tx) => tx.execute<{ email: string; locale: string }>(sql`
      SELECT u.email::text AS email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = ${m.userId} AND m.status = 'active'`));
    const u = r.rows[0];
    if (!u) return;
    const job: MailJob = {
      template: 'automation_notice', to: u.email, locale: u.locale === 'en-US' ? 'en-US' : 'tr-TR',
      vars: { tenantName: ctx.tenant.name, subject: m.subject, body: m.body, url: new URL(`/r/${m.recordType}/${m.recordId}`, this.env.WEB_BASE_URL).toString() },
    };
    await this.mailer.send(job, { jobId: m.jobId });
  }

  private async deadLetter(event: DomainEvent, error: unknown): Promise<void> {
    const message = error instanceof ProblemError ? `${error.code}${error.message ? `: ${error.message}` : ''}` : (error as Error).message;
    await this.db.withTenant({ tenantId: event.tenantId, userId: null }, (tx) => tx.execute(sql`
      INSERT INTO dead_letters (tenant_id, consumer, event_id, event, error, attempts) VALUES
      (${event.tenantId}, ${AUTOMATION_CONSUMER}, ${event.id}, ${JSON.stringify(event)}::jsonb, ${message.slice(0, 2000)}, ${EVENT_ATTEMPTS})`));
  }
}

import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DomainEvent, eventQueueFor, EVENTS_QUEUE, eventShardQueue } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import { Queue, Worker, type Job } from 'bullmq';
import { DB, ENV, REDIS, type ApiEnv, type Redis } from '../../infra/tokens';
import { SlaService } from '../integrations/sla.service';
import { WebhooksService } from '../integrations/webhooks.service';
import { DigestService } from '../records/digest.service';
import { StreamService } from '../records/stream.service';
import { QuotaService } from '../usage/quota.service';
import { UsageService } from '../usage/usage.service';
import { eventBackoff } from './backoff';
import { fairProcessor, TenantSemaphore } from './fairness';
import { AutomationRunner, EVENT_ATTEMPTS } from './runner.service';

export const SCHEDULE_QUEUE = 'automation-schedule';
export const SLA_CHECK_QUEUE = 'sla-check';

export { eventBackoff };

export const EVENT_JOB_OPTIONS = {
  attempts: EVENT_ATTEMPTS,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 3600, count: 100_000 },
  removeOnFail: { age: 14 * 24 * 3600 },
} as const;

/** Queues of the automation engine. Consumers run only where EVENT_CONSUMERS=true (the `automation` service). */
@Injectable()
export class AutomationQueues implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('automation-queues');
  /** Legacy single event queue, still consumed so that events relayed before sharding drain. */
  readonly events: Queue;
  /** Event shards (ADR-0014 §4): a tenant's events always go to the same shard. */
  readonly shards: Queue[];
  readonly schedule: Queue;
  private readonly fair: TenantSemaphore;
  private readonly slaCheckQueue: Queue;
  private workers: Worker[] = [];

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    private readonly runner: AutomationRunner,
    private readonly sla: SlaService,
    private readonly webhooks: WebhooksService,
    private readonly stream: StreamService,
    private readonly digest: DigestService,
    private readonly usage: UsageService,
    private readonly quota: QuotaService,
  ) {
    this.events = new Queue(EVENTS_QUEUE, { connection: redis, defaultJobOptions: EVENT_JOB_OPTIONS });
    this.shards = Array.from({ length: env.EVENT_SHARDS }, (_, i) => new Queue(eventShardQueue(i), { connection: redis, defaultJobOptions: EVENT_JOB_OPTIONS }));
    this.fair = new TenantSemaphore(redis, EVENTS_QUEUE, env.EVENT_TENANT_CONCURRENCY);
    this.schedule = new Queue(SCHEDULE_QUEUE, { connection: redis, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 } });
    this.slaCheckQueue = new Queue(SLA_CHECK_QUEUE, { connection: redis, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 1000 } });
  }

  async onModuleInit(): Promise<void> {
    if (!this.env.EVENT_CONSUMERS) return;
    this.startConsumers();
    await this.syncAllSchedules();
  }

  /** Registers the schedulers of every enabled schedule rule (idempotent; rules edited elsewhere stay in sync). */
  async syncAllSchedules(): Promise<void> {
    const rows = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; rule_id: string; definition: { trigger: { type: string; cron?: string; timezone?: string } } }>(
      sql`SELECT tenant_id, rule_id, definition FROM app.list_schedule_rules()`)).rows);
    for (const r of rows) {
      const tr = r.definition.trigger;
      if (tr.type === 'schedule' && tr.cron) {
        await this.upsertSchedule(r.tenant_id, r.rule_id, tr.cron, tr.timezone ?? 'Europe/Istanbul').catch((e: unknown) => {
          this.log.warn(`schedule for rule ${r.rule_id} not registered: ${(e as Error).message}`);
        });
      }
    }
  }

  /** Starts the event and schedule consumers in this process (also used by tests). */
  startConsumers(): void {
    if (this.workers.length) return;
    const eventWorkers = [EVENTS_QUEUE, ...this.shards.map((q) => q.name)].map((name) => {
      const processor = fairProcessor<{ tenantId?: unknown }>(this.fair, (d) => (typeof d.tenantId === 'string' ? d.tenantId : null), async (job) => {
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? EVENT_ATTEMPTS);
        await this.dispatch(job.data, final);
      });
      const w = new Worker(name, processor, { connection: this.redis.duplicate(), concurrency: 8, settings: { backoffStrategy: eventBackoff } });
      w.on('failed', (job, err) => { this.log.warn(`event ${String(job?.id)} attempt ${String(job?.attemptsMade)} failed: ${err.message}`); });
      return w;
    });
    // A tick writes an `automation.schedule_tick` event to the outbox; the rule then runs like any other.
    const ticks = new Worker(SCHEDULE_QUEUE, async (job: Job<{ tenantId: string; ruleId: string }>) => {
      await this.db.withTenant({ tenantId: job.data.tenantId, userId: null }, (tx) => tx.execute(sql`
        INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
        VALUES (${job.data.tenantId}, 'automation.schedule_tick', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
                ${JSON.stringify({ ruleId: job.data.ruleId, tick: job.id ?? null })}::jsonb, gen_random_uuid())`));
    }, { connection: this.redis.duplicate(), concurrency: 2 });
    // SLA clocks are checked every minute (the table is the source of truth; ADR-0020).
    // SLA clocks every minute (ADR-0020); notification e-mail digests every five minutes (ADR-0017 §3).
    const slaCheck = new Worker(SLA_CHECK_QUEUE, async (job: Job) => {
      if (job.name === 'digest') await this.digest.run();
      else if (job.name === 'usage-flush') await this.usage.flushCounters();
      else if (job.name === 'usage-snapshot') await this.usage.snapshotAll();
      else await this.sla.check();
    }, { connection: this.redis.duplicate(), concurrency: 1 });
    void this.slaCheckQueue.upsertJobScheduler('sla-check', { every: 60_000 }, { name: 'check' });
    void this.slaCheckQueue.upsertJobScheduler('notification-digest', { every: 300_000 }, { name: 'digest' });
    // Usage (TEN-09): Redis counters into the daily table every minute; gauges and quota alerts hourly.
    void this.slaCheckQueue.upsertJobScheduler('usage-flush', { every: 60_000 }, { name: 'usage-flush' });
    void this.slaCheckQueue.upsertJobScheduler('usage-snapshot', { every: 3_600_000 }, { name: 'usage-snapshot' });
    this.webhooks.startWorker();
    this.workers = [...eventWorkers, ticks, slaCheck];
  }

  /** The queue a tenant's events belong to (replays go there too). */
  queueFor(tenantId: string): Queue {
    const name = eventQueueFor(tenantId, this.shards.length);
    return this.shards.find((q) => q.name === name) ?? this.events;
  }

  /** One delivery of an event to every consumer. Each consumer is idempotent on its own (processed_events),
   *  so a retry after one consumer failed does not repeat what the others already did. */
  async dispatch(raw: unknown, final = false): Promise<void> {
    const event = DomainEvent.parse(raw);
    const errors: unknown[] = [];
    await this.runner.process(event, final).catch((e: unknown) => { errors.push(e); });
    await this.sla.process(event).catch((e: unknown) => { errors.push(e); });
    await this.webhooks.process(event).catch((e: unknown) => { errors.push(e); });
    await this.quota.process(event).catch((e: unknown) => { errors.push(e); });
    // Realtime fan-out is best effort (at least once): clients refetch through REST.
    await this.stream.publish(event).catch((e: unknown) => { this.log.warn(`realtime publish failed: ${(e as Error).message}`); });
    const first = errors[0];
    if (first !== undefined) throw first instanceof Error ? first : new Error('event consumer failed');
  }

  async upsertSchedule(tenantId: string, ruleId: string, cron: string, timezone: string): Promise<void> {
    await this.schedule.upsertJobScheduler(`rule:${ruleId}`, { pattern: cron, tz: timezone }, { name: 'tick', data: { tenantId, ruleId } });
  }

  async removeSchedule(ruleId: string): Promise<void> {
    await this.schedule.removeJobScheduler(`rule:${ruleId}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([this.events.close(), ...this.shards.map((q) => q.close()), this.schedule.close(), this.slaCheckQueue.close()]);
  }
}

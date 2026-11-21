import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { EVENTS_QUEUE } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import { Queue, Worker, type Job } from 'bullmq';
import { DB, ENV, REDIS, type ApiEnv, type Redis } from '../../infra/tokens';
import { AutomationRunner, EVENT_ATTEMPTS } from './runner.service';

export const SCHEDULE_QUEUE = 'automation-schedule';

/** ADR-0006 §3: exponential backoff (2^n s) with full jitter, capped at 15 minutes. */
export function eventBackoff(attemptsMade: number): number {
  const ceiling = Math.min(2 ** attemptsMade * 1000, 15 * 60 * 1000);
  return Math.floor(Math.random() * ceiling);
}

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
  readonly events: Queue;
  readonly schedule: Queue;
  private workers: Worker[] = [];

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    private readonly runner: AutomationRunner,
  ) {
    this.events = new Queue(EVENTS_QUEUE, { connection: redis, defaultJobOptions: EVENT_JOB_OPTIONS });
    this.schedule = new Queue(SCHEDULE_QUEUE, { connection: redis, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 } });
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
    const events = new Worker(EVENTS_QUEUE, async (job: Job) => {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? EVENT_ATTEMPTS);
      return this.runner.process(job.data, final);
    }, { connection: this.redis.duplicate(), concurrency: 8, settings: { backoffStrategy: eventBackoff } });
    events.on('failed', (job, err) => { this.log.warn(`event ${String(job?.id)} attempt ${String(job?.attemptsMade)} failed: ${err.message}`); });
    // A tick writes an `automation.schedule_tick` event to the outbox; the rule then runs like any other.
    const ticks = new Worker(SCHEDULE_QUEUE, async (job: Job<{ tenantId: string; ruleId: string }>) => {
      await this.db.withTenant({ tenantId: job.data.tenantId, userId: null }, (tx) => tx.execute(sql`
        INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
        VALUES (${job.data.tenantId}, 'automation.schedule_tick', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
                ${JSON.stringify({ ruleId: job.data.ruleId, tick: job.id ?? null })}::jsonb, gen_random_uuid())`));
    }, { connection: this.redis.duplicate(), concurrency: 2 });
    this.workers = [events, ticks];
  }

  async upsertSchedule(tenantId: string, ruleId: string, cron: string, timezone: string): Promise<void> {
    await this.schedule.upsertJobScheduler(`rule:${ruleId}`, { pattern: cron, tz: timezone }, { name: 'tick', data: { tenantId, ruleId } });
  }

  async removeSchedule(ruleId: string): Promise<void> {
    await this.schedule.removeJobScheduler(`rule:${ruleId}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([this.events.close(), this.schedule.close()]);
  }
}

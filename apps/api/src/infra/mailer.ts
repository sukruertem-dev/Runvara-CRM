import { MAIL_QUEUE, MailJob } from '@runvara/contracts';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Mailer } from './tokens';

/** Enqueues mail for apps/worker. Jobs are validated here so the worker never receives malformed input. */
export class QueueMailer implements Mailer {
  private readonly queue: Queue;

  constructor(redis: Redis) {
    this.queue = new Queue(MAIL_QUEUE, {
      connection: redis,
      defaultJobOptions: { attempts: 8, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 },
    });
  }

  async send(job: MailJob): Promise<void> {
    await this.queue.add(job.template, MailJob.parse(job));
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

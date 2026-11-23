import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

// Queue fairness (TEN-10, ADR-0014 §4). Within a shard, a tenant holds at most `limit` processing slots at a
// time. A slot is a member of a sorted set scored by its expiry, so a consumer that dies without releasing
// it frees the slot when the lease runs out instead of blocking the tenant for good.

const ACQUIRE = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), ARGV[3])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[4]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]) * 2)
return 1`;

export class TenantSemaphore {
  constructor(
    private readonly redis: Redis,
    private readonly queue: string,
    private readonly limit: number,
    private readonly leaseMs = 120_000,
  ) {}

  private key(tenantId: string): string {
    return `tenant:${tenantId}:concurrency:${this.queue}`;
  }

  /** Takes a slot for `holder` (a job id); true when the tenant had one free. Re-acquiring renews the lease. */
  async acquire(tenantId: string, holder: string): Promise<boolean> {
    const r = await this.redis.eval(ACQUIRE, 1, this.key(tenantId), Date.now(), this.limit, holder, this.leaseMs);
    return r === 1;
  }

  async release(tenantId: string, holder: string): Promise<void> {
    await this.redis.zrem(this.key(tenantId), holder);
  }

  async held(tenantId: string): Promise<number> {
    await this.redis.zremrangebyscore(this.key(tenantId), '-inf', Date.now());
    return this.redis.zcard(this.key(tenantId));
  }
}

/** Delay before a job that found its tenant's slots full is tried again (small, jittered). */
export const fairnessDelay = (): number => 200 + Math.floor(Math.random() * 300);

/** Wraps a BullMQ processor with the tenant limit: a job whose tenant holds every slot goes back to the
 *  queue after a short delay without counting as an attempt (DelayedError); the slot is always released. */
export function fairProcessor<T>(fair: TenantSemaphore, tenantOf: (data: T) => string | null, handler: (job: Job<T>) => Promise<void>) {
  return async (job: Job<T>, token?: string): Promise<void> => {
    const tenantId = tenantOf(job.data);
    const holder = job.id ?? null;
    if (tenantId && holder && !(await fair.acquire(tenantId, holder))) {
      await job.moveToDelayed(Date.now() + fairnessDelay(), token);
      throw new DelayedError();
    }
    try {
      await handler(job);
    } finally {
      if (tenantId && holder) await fair.release(tenantId, holder);
    }
  };
}

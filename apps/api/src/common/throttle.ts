import type { Redis } from 'ioredis';
import { sha256 } from '@runvara/security';
import { ProblemError } from './problem';

/** Sliding counter with lockout (ADR-0009: 10 failures → 15 min lock). Unknown accounts are counted the
 *  same way as real ones, so lockout behaviour does not reveal whether an account exists. */
export class FailureThrottle {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly limit: number,
    private readonly windowSeconds: number,
  ) {}

  private key(subject: string): string {
    return `throttle:${this.name}:${sha256(subject).toString('hex').slice(0, 32)}`;
  }

  async assertAllowed(subject: string): Promise<void> {
    const key = this.key(subject);
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count >= this.limit) {
      const ttl = await this.redis.ttl(key);
      throw new ProblemError('RATE_LIMITED', 'too many failed attempts', {}, { 'retry-after': String(Math.max(ttl, 1)) });
    }
  }

  async fail(subject: string): Promise<void> {
    const key = this.key(subject);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, this.windowSeconds);
  }

  async reset(subject: string): Promise<void> {
    await this.redis.del(this.key(subject));
  }
}

import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { DbHandle } from '@runvara/db';
import type { FastifyReply } from 'fastify';
import { DB, REDIS, type Redis } from '../../infra/tokens';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(REDIS) private readonly redis: Redis) {}

  /** Liveness: the process is up. */
  @Get('healthz')
  live() {
    return { status: 'ok', checks: {} };
  }

  /** Readiness: dependencies reachable (load balancers stop routing on 503). */
  @Get('readyz')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => { rej(new Error('timeout')); }, 2_000))]);
    const [db, redis] = await Promise.all([
      timeout(this.db.ping()).then(() => 'ok' as const, () => 'fail' as const),
      timeout(this.redis.ping()).then(() => 'ok' as const, () => 'fail' as const),
    ]);
    const ok = db === 'ok' && redis === 'ok';
    void reply.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks: { db, redis } };
  }
}

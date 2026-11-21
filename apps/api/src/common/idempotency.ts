import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { REDIS, type Redis } from '../infra/tokens';
import { ProblemError } from './problem';

const TTL_SECONDS = 24 * 3600;
const KEY = /^[A-Za-z0-9._:-]{8,200}$/;
type Stored = { hash: string; state: 'pending' } | { hash: string; state: 'done'; status: number; body: unknown };

/** `Idempotency-Key` for unsafe methods (Faz 5, ADR-0012): the first request with a key runs and its response is
 *  kept for 24 h; a retry with the same key and the same request gets that response again (header
 *  `Idempotent-Replayed: true`) without running twice. The same key with a different request → 422; a retry
 *  while the first is still running → 409. Failed requests do not keep the key (the client may retry). Keys
 *  are scoped to tenant + caller. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis, private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const header = req.headers['idempotency-key'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.principal) return next.handle();
    if (!KEY.test(raw)) throw new ProblemError('VALIDATION_FAILED', 'Idempotency-Key must be 8–200 characters of [A-Za-z0-9._:-]');
    const scope = `${req.principal.tenantId ?? '-'}:${req.principal.apiKey ? `k:${req.principal.apiKey.id}` : `u:${req.principal.userId}`}`;
    const redisKey = `idem:${scope}:${raw}`;
    const hash = createHash('sha256').update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
    const status = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? 201 : 200);
    return from(this.run(redisKey, hash, status, reply, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }

  private async run(redisKey: string, hash: string, status: number, reply: FastifyReply, handler: () => Promise<unknown>): Promise<unknown> {
    const claimed = await this.redis.set(redisKey, JSON.stringify({ hash, state: 'pending' } satisfies Stored), 'EX', TTL_SECONDS, 'NX');
    if (claimed !== 'OK') {
      const prev = JSON.parse((await this.redis.get(redisKey)) ?? 'null') as Stored | null;
      if (!prev) return this.run(redisKey, hash, status, reply, handler); // expired between the two calls
      if (prev.hash !== hash) throw new ProblemError('IDEMPOTENCY_KEY_REUSED', 'this Idempotency-Key was used for a different request');
      if (prev.state === 'pending') throw new ProblemError('IDEMPOTENCY_IN_PROGRESS', 'the original request is still being processed');
      void reply.header('idempotent-replayed', 'true');
      void reply.status(prev.status);
      return prev.body;
    }
    try {
      const body = await handler();
      await this.redis.set(redisKey, JSON.stringify({ hash, state: 'done', status, body: body ?? null } satisfies Stored), 'EX', TTL_SECONDS);
      return body;
    } catch (e) {
      await this.redis.del(redisKey);
      throw e;
    }
  }
}

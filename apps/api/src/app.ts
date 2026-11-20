import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildOpenApiDocument } from '@runvara/contracts';
import scalar from '@scalar/fastify-api-reference';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module';
import { toProblem } from './common/problem.filter';
import type { ApiDeps } from './infra/tokens';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
export const API_VERSION = '0.1.0';

export async function createApp(deps: ApiDeps): Promise<NestFastifyApplication> {
  const { env } = deps;
  const adapter = new FastifyAdapter({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576,
    genReqId: (req: IncomingMessage) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]', '*.password', '*.token', '*.mfaToken', '*.recoveryCode'],
        censor: '[redacted]',
      },
    },
  });
  // Records every registered route; a test checks it against the published contract (ENDPOINTS).
  const routes: string[] = [];
  adapter.getInstance().decorate('runvaraRoutes', routes);
  adapter.getInstance().addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD') routes.push(`${m} ${r.url}`);
    const config = r.config as { authRateLimit?: boolean; rateLimit?: unknown } | undefined;
    if (config?.authRateLimit) config.rateLimit = { max: env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(deps), adapter, { logger: env.LOG_LEVEL === 'silent' ? false : ['error', 'warn'] });
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await fastify.register(cors, { origin: env.CORS_ORIGINS, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['authorization', 'content-type', 'x-csrf-token', 'idempotency-key', 'if-match', 'x-request-id'], exposedHeaders: ['x-request-id', 'etag', 'retry-after'] });
  await fastify.register(cookie);
  await fastify.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: deps.redis,
    nameSpace: 'rl:',
    skipOnError: false,
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
    errorResponseBuilder: (req, ctx) => {
      const { problem } = toProblem({ statusCode: 429, headers: { 'retry-after': String(Math.ceil(ctx.ttl / 1000)) } }, req);
      return { ...problem, statusCode: 429 };
    },
  });

  const document = buildOpenApiDocument({ version: API_VERSION, serverUrl: env.API_PUBLIC_URL });
  fastify.get('/openapi.json', { config: { rateLimit: false } }, async () => document);
  await fastify.register(scalar, { routePrefix: '/docs', configuration: { url: '/openapi.json', withDefaultFonts: false } });
  // The docs page is the only HTML the API serves; relax CSP for it alone (scripts are served by the plugin itself).
  fastify.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/docs')) {
      void reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'");
    }
  });

  // Unknown routes: Nest raises NotFoundException through ProblemFilter → problem+json NOT_FOUND.
  app.enableShutdownHooks();
  await app.init();
  return app;
}

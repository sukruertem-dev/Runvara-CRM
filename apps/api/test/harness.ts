import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiEnvSchema, loadEnv } from '@flexa/config';
import type { MailJob } from '@flexa/contracts';
import { createDb, type DbHandle } from '@flexa/db';
import { generateTotpCode, TokenSigner } from '@flexa/security';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { createApp } from '../src/app';
import type { Mailer } from '../src/infra/tokens';

/** Test double for the mail queue: records jobs so tests can read the links a user would receive. */
export class CapturingMailer implements Mailer {
  readonly jobs: MailJob[] = [];
  send(job: MailJob): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }
  last(template: MailJob['template'], to: string): MailJob {
    const j = [...this.jobs].reverse().find((x) => x.template === template && x.to === to);
    if (!j) throw new Error(`no ${template} mail to ${to}`);
    return j;
  }
  tokenFrom(template: MailJob['template'], to: string): string {
    const job = this.last(template, to);
    const url = 'url' in job.vars ? job.vars.url : '';
    const token = new URL(url).searchParams.get('token');
    if (!token) throw new Error('mail has no token');
    return token;
  }
}

export interface Harness {
  app: NestFastifyApplication;
  db: DbHandle;
  redis: Redis;
  mailer: CapturingMailer;
  close(): Promise<void>;
}

export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const env = loadEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    FLEXA_MASTER_KEY: randomBytes(32).toString('base64'),
    API_PUBLIC_URL: 'http://api.flexa.test',
    WEB_BASE_URL: 'http://app.flexa.test',
    CORS_ORIGINS: 'http://app.flexa.test',
    JWT_PRIVATE_KEY_B64: Buffer.from(TokenSigner.generatePem()).toString('base64'),
    CSRF_SECRET: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    RATE_LIMIT_PER_MINUTE: '10000',
    AUTH_RATE_LIMIT_PER_MINUTE: '10000',
    OIDC_ALLOW_INSECURE_LOCALHOST: 'true',
    ...overrides,
  });
  const db = createDb(env.DATABASE_URL, { max: 5 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushall();
  const mailer = new CapturingMailer();
  const app = await createApp({ env, db, redis, mailer });
  return {
    app, db, redis, mailer,
    close: async () => {
      await app.close();
      await db.close();
      redis.disconnect();
    },
  };
}

export interface Res {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string | number | string[] | undefined>;
  cookies: { name: string; value: string }[];
}

export class Client {
  cookies = new Map<string, string>();
  accessToken: string | null = null;
  csrf: string | null = null;

  constructor(private readonly app: NestFastifyApplication) {}

  async req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const headers: Record<string, string> = { ...extra };
    if (this.accessToken && !('authorization' in extra)) headers.authorization = `Bearer ${this.accessToken}`;
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await this.app.getHttpAdapter().getInstance().inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const c of r.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const parsed = r.body ? (r.headers['content-type']?.toString().includes('json') ? (JSON.parse(r.body) as Record<string, unknown>) : { raw: r.body }) : {};
    if (typeof parsed.accessToken === 'string') this.accessToken = parsed.accessToken;
    if (typeof parsed.csrfToken === 'string') this.csrf = parsed.csrfToken;
    return { status: r.statusCode, body: parsed, headers: r.headers, cookies: r.cookies.map((c) => ({ name: c.name, value: c.value })) };
  }

  get = (url: string, extra?: Record<string, string>) => this.req('GET', url, undefined, extra);
  post = (url: string, body?: unknown, extra?: Record<string, string>) => this.req('POST', url, body, extra);
  del = (url: string, body?: unknown) => this.req('DELETE', url, body);
  withCsrf = (): Record<string, string> => ({ 'x-csrf-token': this.csrf ?? '' });
  patchJson = (url: string, body: unknown, ifMatch?: string) => this.req('PATCH', url, body, ifMatch ? { 'if-match': ifMatch } : {});
  deleteWithIfMatch = (url: string, ifMatch: string) => this.req('DELETE', url, undefined, { 'if-match': ifMatch });
}

let seq = 0;
export function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
}

export const PASSWORD = 'Tuzlu-Kahve-Sabahi-42';

/** Signs up, verifies e-mail and logs in; returns a client holding a tenant-bound session. */
export async function signupAndLogin(h: Harness, opts: { slug?: string; email?: string } = {}) {
  const c = new Client(h.app);
  const slug = opts.slug ?? uniq('t-');
  const email = opts.email ?? `${uniq('admin')}@firma.test`;
  const s = await c.post('/v1/auth/signup', { email, password: PASSWORD, displayName: 'Ayşe Yılmaz', tenantName: `Firma ${slug}`, tenantSlug: slug });
  if (s.status !== 202) throw new Error(`signup failed ${s.status} ${JSON.stringify(s.body)}`);
  const v = await c.post('/v1/auth/email/verify', { token: h.mailer.tokenFrom('verify_email', email) });
  if (v.status !== 204) throw new Error(`verify failed ${v.status}`);
  const l = await c.post('/v1/auth/login', { email, password: PASSWORD });
  if (l.status !== 200) throw new Error(`login failed ${l.status} ${JSON.stringify(l.body)}`);
  const tenant = l.body.tenant as { id: string };
  return { c, email, slug, tenantId: tenant.id };
}

export { generateTotpCode };

import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded');

export const commonEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  FLEXA_MASTER_KEY: base64Key32,
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
});

export const apiEnvSchema = commonEnvSchema.extend({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.url(),
  WEB_BASE_URL: z.url(),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  /** Ed25519 private key, PKCS#8 PEM, base64 encoded (single line for .env files). */
  JWT_PRIVATE_KEY_B64: z.string().min(40),
  JWT_ISSUER: z.string().min(1).default('flexa'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CSRF_SECRET: z.string().min(32),
  COOKIE_SECURE: bool.default(true),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600),
  /** Per-IP limit for unauthenticated auth endpoints (sign-up, login, MFA, reset). */
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  TRUST_PROXY: bool.default(false),
  /** Development/test only: lets OIDC discovery reach http://localhost identity providers. */
  OIDC_ALLOW_INSECURE_LOCALHOST: bool.default(false),
  /** S3-compatible object storage for attachments (ADR-0013 §2). Without a bucket, attachment endpoints answer 503. */
  S3_ENDPOINT: z.url().optional(),
  /** Endpoint the browser uses for signed URLs when it differs from the internal one (e.g. Docker network). */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
  /** clamd for the attachment scanning hook; without it files are marked `unscanned`, never `clean`. */
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** Run the domain-event consumers (automation rules, schedules) in this process (ADR-0006). */
  EVENT_CONSUMERS: bool.default(false),
}).refine((e) => !(e.NODE_ENV === 'production' && e.OIDC_ALLOW_INSECURE_LOCALHOST), {
  message: 'OIDC_ALLOW_INSECURE_LOCALHOST must be false in production',
  path: ['OIDC_ALLOW_INSECURE_LOCALHOST'],
});

export const workerEnvSchema = commonEnvSchema.extend({
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  MAIL_FROM: z.string().min(3).default('Flexa <no-reply@flexa.local>'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  /** flexa_relay connection for the outbox relay (BYPASSRLS, outbox only). Without it the relay is off. */
  RELAY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
});

export const migrateEnvSchema = z.object({
  DATABASE_OWNER_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type CommonEnv = z.infer<typeof commonEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Parses process.env (or a given record) with the schema; throws with every problem listed, never echoing values. */
export function loadEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined> = process.env): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}

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
  RUNVARA_MASTER_KEY: base64Key32,
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
  JWT_ISSUER: z.string().min(1).default('runvara'),
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
}).refine((e) => !(e.NODE_ENV === 'production' && e.OIDC_ALLOW_INSECURE_LOCALHOST), {
  message: 'OIDC_ALLOW_INSECURE_LOCALHOST must be false in production',
  path: ['OIDC_ALLOW_INSECURE_LOCALHOST'],
});

export const workerEnvSchema = commonEnvSchema.extend({
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  MAIL_FROM: z.string().min(3).default('Runvara <no-reply@runvara.local>'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
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

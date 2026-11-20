// pnpm --filter @flexa/api seed:demo   (DATABASE_URL / REDIS_URL from .env)
// Seeds the demo workspace (src/seed/demo.ts); prints the sign-in addresses and a freshly generated password once.
import { apiEnvSchema, loadEnv } from '@flexa/config';
import { createDb } from '@flexa/db';
import { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { createApp } from './app';
import { MemoryMailer, seedDemo } from './seed/demo';

async function main(): Promise<void> {
  const env = loadEnv(apiEnvSchema);
  const db = createDb(env.DATABASE_URL, { applicationName: 'flexa-seed', max: 4 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const mailer = new MemoryMailer();
  const app = await createApp({ env: { ...env, AUTH_RATE_LIMIT_PER_MINUTE: 10_000 }, db, redis, mailer });
  const password = `Demo-${randomBytes(9).toString('base64url')}`;
  try {
    const r = await seedDemo(app, mailer, password);
    process.stdout.write(r.created
      ? `Seeded workspace "${r.slug}".
Sign in as ${r.emails.join(', ')}
Password for all demo users: ${password}
`
      : `Workspace "${r.slug}" already exists; nothing to do.
`);
  } finally {
    await app.close();
    await db.close();
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

// Must stay the first import: instrumentation has to patch modules before they are required.
import { telemetry } from './telemetry';
import { apiEnvSchema, loadEnv } from '@runvara/config';
import { createDb } from '@runvara/db';
import { Redis } from 'ioredis';
import { createApp } from './app';
import { QueueMailer } from './infra/mailer';

async function main(): Promise<void> {
  const env = loadEnv(apiEnvSchema);
  const db = createDb(env.DATABASE_URL, { applicationName: 'runvara-api', max: 20 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const mailer = new QueueMailer(redis);
  const app = await createApp({ env, db, redis, mailer });

  const shutdown = async (signal: string) => {
    app.getHttpAdapter().getInstance().log.info({ signal }, 'shutting down');
    await app.close();
    await mailer.close();
    await db.close();
    redis.disconnect();
    await telemetry?.shutdown();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

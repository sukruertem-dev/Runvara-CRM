import { createServer } from 'node:http';
import { loadEnv, workerEnvSchema } from '@flexa/config';
import { eventShardQueue, eventShard, MAIL_QUEUE, MailJob } from '@flexa/contracts';
import { createRelay, startRelayLoop, toEnvelope } from '@flexa/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import nodemailer from 'nodemailer';
import pino from 'pino';
import { render } from './templates';

const env = loadEnv(workerEnvSchema);
const log = pino({ level: env.LOG_LEVEL, base: { service: 'flexa-worker' }, redact: ['job.to', 'to'] });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const transport = nodemailer.createTransport(env.SMTP_URL);

const mailWorker = new Worker(
  MAIL_QUEUE,
  async (job) => {
    const mail = MailJob.parse(job.data);
    const { subject, text, html } = render(mail);
    const info = await transport.sendMail({ from: env.MAIL_FROM, to: mail.to, subject, text, html });
    log.info({ jobId: job.id, template: mail.template, messageId: info.messageId }, 'mail sent');
  },
  { connection, concurrency: 5 },
);
mailWorker.on('failed', (job, err) => {
  log.warn({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'mail failed');
});

// Outbox relay (ADR-0006): committed domain events → the tenant's shard of the event queue (ADR-0014 §4; job
// id = event id, so a relay that dies between publishing and marking cannot enqueue an event twice). Consumers
// run in the `automation` service.
const relay = env.RELAY_DATABASE_URL ? createRelay(env.RELAY_DATABASE_URL) : null;
const shardQueues = Array.from({ length: env.EVENT_SHARDS }, (_, i) => new Queue(eventShardQueue(i), { connection }));
const relayLoop = relay
  ? startRelayLoop(relay, async (rows) => {
    const byShard = new Map<number, typeof rows>();
    for (const r of rows) {
      const shard = eventShard(r.tenant_id, env.EVENT_SHARDS);
      byShard.set(shard, [...(byShard.get(shard) ?? []), r]);
    }
    for (const [shard, batch] of byShard) {
      await shardQueues[shard]?.addBulk(batch.map((r) => ({
        name: r.type,
        data: toEnvelope(r),
        opts: { jobId: r.id, attempts: 8, backoff: { type: 'custom' }, removeOnComplete: { age: 86_400, count: 100_000 }, removeOnFail: { age: 1_209_600 } },
      })));
    }
  }, { onError: (e) => { log.error({ err: (e as Error).message }, 'relay error (events stay in the outbox)'); } })
  : null;
if (!relay) log.warn('RELAY_DATABASE_URL not set: domain events are not relayed');

// Liveness + readiness for Docker/Kubernetes.
const health = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (req.url === '/readyz') {
    connection.ping().then(
      () => res.writeHead(mailWorker.isRunning() ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: mailWorker.isRunning() ? 'ok' : 'degraded' })),
      () => res.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"degraded"}'),
    );
    return;
  }
  res.writeHead(404).end();
});
health.listen(env.WORKER_HEALTH_PORT, '0.0.0.0', () => { log.info({ port: env.WORKER_HEALTH_PORT }, 'worker ready'); });

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  health.close();
  await relayLoop?.stop();
  await relay?.close();
  await Promise.all(shardQueues.map((q) => q.close()));
  await mailWorker.close();
  transport.close();
  connection.disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

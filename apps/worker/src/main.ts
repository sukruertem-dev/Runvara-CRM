import { createServer } from 'node:http';
import { loadEnv, workerEnvSchema } from '@flexa/config';
import { MAIL_QUEUE, MailJob } from '@flexa/contracts';
import { Worker } from 'bullmq';
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
  await mailWorker.close();
  transport.close();
  connection.disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

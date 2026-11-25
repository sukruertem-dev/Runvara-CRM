#!/usr/bin/env node
// Notification latency, end to end (MEN-06, docs/p8-plan.md §19): from sending the comment that mentions someone
// to the event arriving on that person's open stream, through the web proxy, the API, the outbox relay, the
// queue and the stream. The stack must be running (docker compose up). Prints p50/p95/max; fails above 2 s.
//
//   pnpm --filter @flexa/web notification-latency          LAT_SAMPLES=100 by default
import { writeFileSync, appendFileSync } from 'node:fs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SAMPLES = Math.max(20, Number(process.env.LAT_SAMPLES ?? '100'));
// 30 mentions a minute per author (MEN-11): several authors take turns.
const AUTHORS = Math.ceil(SAMPLES / 25);
const LIMIT_MS = 2_000;
const PASSWORD = 'Kuvvetli-Parola-2026!x';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function api(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.status === 429 && attempt < 4) {
      await sleep((Number(res.headers.get('retry-after') ?? '20') + 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }
}

async function mailToken(email) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const id = s.messages?.[0]?.ID;
    if (id) {
      const token = /[?&]token=([A-Za-z0-9_-]+)/.exec((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()).Text)?.[1];
      if (token) return token;
    }
    await sleep(300);
  }
  throw new Error(`no mail for ${email}`);
}

const login = (email) => api('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });

async function workspace() {
  const email = `lat-${run}@firma.test`;
  await api('POST', '/v1/auth/signup', { body: { email, password: PASSWORD, displayName: 'Deniz Yönetici', tenantName: 'Gecikme', tenantSlug: `lat-${run}` } });
  await api('POST', '/v1/auth/email/verify', { body: { token: await mailToken(email) } });
  const admin = (await login(email)).accessToken;
  await api('POST', '/v1/modules/crm/enable', { token: admin });
  const members = [];
  for (let i = 0; i <= AUTHORS; i += 1) {
    const mail = `lat-${run}-${i}@firma.test`;
    await api('POST', '/v1/invitations', { token: admin, body: { email: mail, roleKey: i === 0 ? 'sales_rep' : 'admin' } });
    await api('POST', '/v1/invitations/accept', { body: { token: await mailToken(mail), password: PASSWORD, displayName: `Kişi ${i}` } });
    const l = await login(mail);
    members.push({ token: l.accessToken, id: l.user.id });
  }
  const [reader, ...authors] = members;
  const acc = await api('POST', '/v1/accounts', { token: admin, body: { name: 'Ölçüm', segments: ['b2b'], ownerUserId: reader.id } });
  return { reader, authors, accountId: acc.id };
}

/** Resolves with the arrival time of each notification event, in order. */
async function openStream(token) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/v1/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
  if (!res.ok || !res.body) throw new Error(`stream → ${res.status}`);
  const waiting = [];
  const arrived = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let sep = buffer.indexOf('\n\n'); sep !== -1; sep = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (!block.includes('event: notification.created')) continue;
          const now = performance.now();
          const next = waiting.shift();
          if (next) next(now);
          else arrived.push(now);
        }
      }
    } catch {
      // closed
    }
  })();
  return {
    next: () => Promise.race([
      arrived.length ? Promise.resolve(arrived.shift()) : new Promise((resolve) => waiting.push(resolve)),
      sleep(15_000).then(() => { throw new Error('a notification did not arrive within 15 s'); }),
    ]),
    close: () => { ctrl.abort(); },
  };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];

const w = await workspace();
const stream = await openStream(w.reader.token);
const times = [];
// The first rounds warm the path up and are not counted.
for (let i = -5; i < SAMPLES; i += 1) {
  const author = w.authors[Math.floor(Math.max(0, i) / 25) % w.authors.length];
  const body = { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { kind: 'user', id: w.reader.id } }] }] } };
  const t0 = performance.now();
  const arrival = stream.next();
  await api('POST', `/v1/accounts/${w.accountId}/comments`, { token: author.token, body });
  const ms = (await arrival) - t0;
  if (i >= 0) times.push(ms);
}
stream.close();

const sorted = [...times].sort((a, b) => a - b);
const out = { samples: sorted.length, p50: Math.round(pct(sorted, 0.5)), p95: Math.round(pct(sorted, 0.95)), max: Math.round(sorted.at(-1)) };
const ok = out.p95 < LIMIT_MS;
const line = `${ok ? 'PASS' : 'FAIL'} notification latency: samples ${out.samples}, p50 ${out.p50} ms, p95 ${out.p95} ms, max ${out.max} ms (limit p95 < ${LIMIT_MS} ms)`;
console.log(line);
writeFileSync('notification-latency.json', `${JSON.stringify(out, null, 2)}\n`);
if (process.env.GITHUB_ACTIONS) console.log(`::${ok ? 'notice' : 'error'} title=Notification latency::${line}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
process.exit(ok ? 0 : 1);

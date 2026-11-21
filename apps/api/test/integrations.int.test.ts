import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, toEnvelope, type OutboxRow, type Relay } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import type { Job } from 'bullmq';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AutomationQueues } from '../src/modules/automation/queues';
import { SlaService } from '../src/modules/integrations/sla.service';
import { signatureHeader, WebhooksService } from '../src/modules/integrations/webhooks.service';
import { DigestService } from '../src/modules/records/digest.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P5b acceptance (docs/p5-plan.md §5): SLA business-time clocks with pause/warn/breach and rule triggers,
// signed outgoing webhooks with retries and auto-disable, API keys with scopes and rate limits,
// Idempotency-Key, authorized server-sent events with replay, notification e-mail digest.

let h: Harness;
let relay: Relay;
let base = '';
beforeAll(async () => {
  h = await startHarness();
  relay = createRelay(process.env.TEST_RELAY_DATABASE_URL!);
  await h.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${String((h.app.getHttpServer().address() as AddressInfo).port)}`;
});
afterAll(async () => { await relay.close(); await h.close(); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Relays and dispatches every pending event to all consumers (rules, SLA, webhooks, realtime). */
async function drain(): Promise<void> {
  const queues = h.app.get(AutomationQueues);
  for (let i = 0; i < 50; i++) {
    const n = await relay.relayOnce(async (rows: OutboxRow[]) => {
      for (const r of rows) await queues.dispatch(toEnvelope(r)).catch(() => undefined);
    });
    if (n === 0) return;
  }
  throw new Error('event chain did not settle');
}

async function workspace(modules: string[] = ['crm', 'automation_sla', 'api_webhooks']) {
  const s = await signupAndLogin(h);
  for (const m of modules) ok(await s.c.post(`/v1/modules/${m}/enable`));
  const me = ok(await s.c.get('/v1/me'));
  return { ...s, adminId: (me.user as { id: string }).id };
}

async function member(admin: Client, role: string): Promise<{ c: Client; userId: string; email: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return { c, userId: (l.user as { id: string }).id, email };
}

const timersOf = async (c: Client, type: string, id: string) =>
  (ok(await c.get(`/v1/sla/timers?recordType=${type}&recordId=${id}`)).data as Json[]).reduce<Record<string, Json>>((m, t) => ({ ...m, [String(t.milestone)]: t }), {});
const minutesBetween = (a: unknown, b: unknown) => (new Date(String(b)).getTime() - new Date(String(a)).getTime()) / 60_000;

describe('SLA (ADR-0020)', () => {
  it('starts clocks from the first matching policy, pauses while waiting, meets on response and resolution', async () => {
    const { c: admin } = await workspace();
    const allWeek = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));
    expect((await admin.post('/v1/calendars', { name: 'Bozuk', timezone: 'Mars/Olympus', weeklyHours: allWeek })).body.code).toBe('SLA_POLICY_INVALID');
    const cal = ok(await admin.post('/v1/calendars', { name: '7/24', timezone: 'Europe/Istanbul', weeklyHours: allWeek }), 201);
    expect((await admin.post('/v1/sla/policies', { name: 'Bozuk', resourceType: 'case', criteria: 'nope = 1', calendarId: cal.id, resolutionMinutes: 60 })).body.code).toBe('SLA_POLICY_INVALID');
    ok(await admin.post('/v1/sla/policies', { name: 'E-posta', resourceType: 'case', criteria: 'channel = "email"', position: 0, calendarId: cal.id, firstResponseMinutes: 60, resolutionMinutes: 240, warnPercent: 50, pauseStatuses: ['waiting'] }), 201);

    const phone = ok(await admin.post('/v1/cases', { subject: 'Telefon', channel: 'phone', segment: 'b2c' }), 201);
    const cs = ok(await admin.post('/v1/cases', { subject: 'Fatura', channel: 'email', segment: 'b2c' }), 201);
    await drain();
    expect(await timersOf(admin, 'case', String(phone.id))).toEqual({});
    const started = await timersOf(admin, 'case', String(cs.id));
    expect(started.first_response).toMatchObject({ state: 'running', budgetMinutes: 60 });
    expect(minutesBetween(started.first_response!.startedAt, started.first_response!.targetAt)).toBeCloseTo(60, 5);
    expect(minutesBetween(started.resolution!.startedAt, started.resolution!.warnAt)).toBeCloseTo(120, 5);

    const url = `/v1/cases/${String(cs.id)}`;
    ok(await admin.post(`${url}/transition`, { transitionKey: 'start' }));
    ok(await admin.post(`${url}/transition`, { transitionKey: 'wait' }));
    await drain();
    const waiting = await timersOf(admin, 'case', String(cs.id));
    expect(waiting.first_response!.state).toBe('met');
    expect(waiting.resolution).toMatchObject({ state: 'paused', targetAt: null });
    expect(Number(waiting.resolution!.remainingMinutes)).toBeGreaterThan(239);
    expect(Number(waiting.resolution!.remainingMinutes)).toBeLessThanOrEqual(240);

    ok(await admin.post(`${url}/transition`, { transitionKey: 'resume' }));
    await drain();
    const resumed = await timersOf(admin, 'case', String(cs.id));
    expect(resumed.resolution).toMatchObject({ state: 'running', remainingMinutes: null });
    expect(minutesBetween(new Date().toISOString(), resumed.resolution!.targetAt)).toBeGreaterThan(238);

    ok(await admin.post(`${url}/transition`, { transitionKey: 'resolve' }));
    await drain();
    expect((await timersOf(admin, 'case', String(cs.id))).resolution!.state).toBe('met');
    const met = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM outbox_events WHERE resource_id = $1 AND type = 'sla.met'`, [cs.id]);
    expect(met[0]!.n).toBe(2);
  });

  it('warns, then breaches once; an SLA rule reacts; the checker is safe to run twice', async () => {
    const { c: admin } = await workspace();
    const allWeek = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));
    const cal = ok(await admin.post('/v1/calendars', { name: '7/24', timezone: 'UTC', weeklyHours: allWeek }), 201);
    ok(await admin.post('/v1/sla/policies', { name: 'Tümü', resourceType: 'case', calendarId: cal.id, resolutionMinutes: 30 }), 201);
    ok(await admin.post('/v1/automations/rules', { name: 'SLA aşımı', definition: { resourceType: 'case', trigger: { type: 'sla', event: 'breached' }, actions: [{ type: 'notify', to: { kind: 'record_owner' }, message: 'SLA aşıldı' }] } }), 201);
    const cs = ok(await admin.post('/v1/cases', { subject: 'Acil', channel: 'email', segment: 'b2c' }), 201);
    await drain();
    const sla = h.app.get(SlaService);

    await superQuery(SUPER(), `UPDATE sla_timers SET warn_at = now() - interval '1 second' WHERE record_id = $1`, [cs.id]);
    await sla.check();
    await sla.check();
    expect((await timersOf(admin, 'case', String(cs.id))).resolution).toMatchObject({ state: 'running' });
    expect((await timersOf(admin, 'case', String(cs.id))).resolution!.warnedAt).not.toBeNull();

    await superQuery(SUPER(), `UPDATE sla_timers SET target_at = now() - interval '1 second' WHERE record_id = $1`, [cs.id]);
    await Promise.all([sla.check(), sla.check()]);
    await drain();
    expect((await timersOf(admin, 'case', String(cs.id))).resolution).toMatchObject({ state: 'breached' });
    const events = await superQuery<{ type: string }>(SUPER(), `SELECT type FROM outbox_events WHERE resource_id = $1 AND type LIKE 'sla.%' ORDER BY id`, [cs.id]);
    expect(events.map((e) => e.type)).toEqual(['sla.warning', 'sla.breached']);
    const notes = (ok(await admin.get('/v1/notifications')).data as Json[]).filter((n) => n.kind === 'automation');
    expect(notes.map((n) => n.message)).toEqual(['SLA aşıldı']);
  });
});

/** A local receiver standing in for a customer endpoint. */
async function receiver() {
  const got: { headers: IncomingHttpHeaders; body: string }[] = [];
  const codes: number[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = codes.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { got, codes, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`, close: () => new Promise<void>((r) => server.close(() => { r(); })) };
}

type DeliveryJobData = { tenantId: string; deliveryId: string; event: Parameters<WebhooksService['createDelivery']>[1] };
async function queuedJob(deliveryId: string): Promise<Job<DeliveryJobData>> {
  const jobs = (await h.app.get(WebhooksService).queue.getJobs(['waiting', 'delayed', 'prioritized'])) as Job<DeliveryJobData>[];
  const j = jobs.filter((x) => x.data.deliveryId === deliveryId).at(-1);
  if (!j) throw new Error(`no queued job for delivery ${deliveryId}`);
  return j;
}
const deliveriesOf = async (c: Client, subId: string) => ok(await c.get(`/v1/webhooks/${subId}/deliveries`)).data as Json[];

describe('outgoing webhooks (ADR-0013 §1)', () => {
  it('signed deliveries, retry until success, rotation signs with both secrets, redelivery', async () => {
    const { c: admin } = await workspace();
    const rx = await receiver();
    try {
      expect((await admin.post('/v1/webhooks', { name: 'İç ağ', url: 'http://10.0.0.5/hook', eventTypes: ['account.*'] })).body.code).toBe('WEBHOOK_URL_INVALID');
      const sub = ok(await admin.post('/v1/webhooks', { name: 'ERP', url: rx.url, eventTypes: ['account.*'] }), 201);
      expect(String(sub.secret)).toMatch(/^whsec_/);
      expect((ok(await admin.get('/v1/webhooks')).data as Json[])[0]).not.toHaveProperty('secret');

      const acc = ok(await admin.post('/v1/accounts', { name: 'Webhook A.Ş.', segments: ['b2b'] }), 201);
      ok(await admin.post('/v1/contacts', { firstName: 'Eşleşmeyen', lastName: 'Kişi', segments: ['b2b'] }), 201);
      await drain();
      const [d] = await deliveriesOf(admin, String(sub.id));
      expect(d).toMatchObject({ eventType: 'account.created', status: 'pending' });
      expect((await deliveriesOf(admin, String(sub.id))).length).toBe(1);

      const svc = h.app.get(WebhooksService);
      const job = await queuedJob(String(d!.id));
      rx.codes.push(500);
      await expect(svc.deliver(job.data, false)).rejects.toThrow(/HTTP 500/);
      expect((await deliveriesOf(admin, String(sub.id)))[0]).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 500 });
      expect(await svc.deliver(job.data, false)).toBe('succeeded');
      expect((await deliveriesOf(admin, String(sub.id)))[0]).toMatchObject({ status: 'succeeded', attempts: 2, responseStatus: 200 });
      expect(await svc.deliver(job.data, false)).toBe('skipped'); // a late retry of a succeeded delivery sends nothing

      const last = rx.got.at(-1)!;
      const body = JSON.parse(last.body) as Json;
      expect(body).toMatchObject({ type: 'account.created', resource: { type: 'account', id: acc.id }, deliveryId: d!.id });
      expect(last.headers['flexa-event']).toBe('account.created');
      const sig = String(last.headers['flexa-signature']);
      const t = Number(/t=(\d+)/.exec(sig)![1]);
      expect(Math.abs(t - Date.now() / 1000)).toBeLessThan(60);
      expect(sig).toBe(signatureHeader([String(sub.secret)], last.body, t));

      // Rotation: the old secret still verifies for 24 h (both signatures are sent).
      const rotated = ok(await admin.post(`/v1/webhooks/${String(sub.id)}/rotate-secret`));
      expect(rotated.secret).not.toBe(sub.secret);
      const re = ok(await admin.post(`/v1/webhooks/deliveries/${String(d!.id)}/redeliver`));
      expect(re.status).toBe('pending');
      expect(await svc.deliver((await queuedJob(String(d!.id))).data, false)).toBe('succeeded');
      const again = rx.got.at(-1)!;
      const t2 = Number(/t=(\d+)/.exec(String(again.headers['flexa-signature']))![1]);
      expect(again.headers['flexa-signature']).toBe(signatureHeader([String(rotated.secret), String(sub.secret)], again.body, t2));
    } finally {
      await rx.close();
    }
  });

  it('24 h of failures disable the subscription and tell the Admins; a rule can call a webhook', async () => {
    const { c: admin, tenantId } = await workspace();
    const rx = await receiver();
    try {
      const sub = ok(await admin.post('/v1/webhooks', { name: 'Kırık', url: rx.url, eventTypes: ['*'] }), 201);
      ok(await admin.post('/v1/accounts', { name: 'Hata', segments: ['b2b'] }), 201);
      await drain();
      const svc = h.app.get(WebhooksService);
      const d = (await deliveriesOf(admin, String(sub.id))).find((x) => x.eventType === 'account.created')!;
      const job = await queuedJob(String(d.id));
      rx.codes.push(503, 503);
      await expect(svc.deliver(job.data, false)).rejects.toThrow();
      await superQuery(SUPER(), `UPDATE webhook_subscriptions SET first_failure_at = now() - interval '25 hours' WHERE id = $1`, [sub.id]);
      await expect(svc.deliver(job.data, true)).rejects.toThrow();
      const view = (ok(await admin.get('/v1/webhooks')).data as Json[]).find((s) => s.id === sub.id)!;
      expect(view).toMatchObject({ enabled: false, disabledReason: 'auto_failures', consecutiveFailures: 2 });
      expect((await deliveriesOf(admin, String(sub.id))).find((x) => x.id === d.id)).toMatchObject({ status: 'dead' });
      const notes = (ok(await admin.get('/v1/notifications')).data as Json[]).filter((n) => n.kind === 'automation');
      expect(String(notes[0]?.message)).toMatch(/Kırık/);
      const disabled = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND type = 'webhook.disabled'`, [tenantId]);
      expect(disabled[0]!.n).toBe(1);
      expect(await svc.deliver(job.data, false)).toBe('skipped'); // nothing is sent while disabled

      // Re-enabling resets the failure count; a rule's call_webhook delivers to a subscription it does not match.
      expect(ok(await admin.req('PATCH', `/v1/webhooks/${String(sub.id)}`, { enabled: true }))).toMatchObject({ enabled: true, consecutiveFailures: 0, disabledReason: null });
      const quiet = ok(await admin.post('/v1/webhooks', { name: 'Kural', url: rx.url, eventTypes: ['case.*'] }), 201);
      ok(await admin.post('/v1/automations/rules', { name: 'Bildir', definition: { resourceType: 'account', trigger: { type: 'record.created' }, actions: [{ type: 'call_webhook', subscriptionId: quiet.id }] } }), 201);
      ok(await admin.post('/v1/accounts', { name: 'Kurallı', segments: ['b2b'] }), 201);
      await drain();
      const [rd] = await deliveriesOf(admin, String(quiet.id));
      expect(rd).toMatchObject({ eventType: 'account.created', status: 'pending' });
      expect(await svc.deliver((await queuedJob(String(rd!.id))).data, false)).toBe('succeeded');
    } finally {
      await rx.close();
    }
  });
});

describe('API keys and Idempotency-Key', () => {
  it('keys act within their scopes and the creator’s rights; revoked keys stop; limits hold', async () => {
    const { c: admin } = await workspace();
    const ro = ok(await admin.post('/v1/api-keys', { name: 'Rapor', scopes: ['read'] }), 201);
    const rw = ok(await admin.post('/v1/api-keys', { name: 'ERP', scopes: ['read', 'write'], rateLimitPerMinute: 4 }), 201);
    expect(String(ro.key)).toMatch(/^fx_[a-z0-9]{8}_/);
    expect((ok(await admin.get('/v1/api-keys')).data as Json[]).every((k) => !('key' in k))).toBe(true);
    const bearer = (k: Json) => ({ authorization: `Bearer ${String(k.key)}` });
    const anon = new Client(h.app);

    ok(await anon.get('/v1/accounts', bearer(ro)));
    expect((await anon.post('/v1/accounts', { name: 'Yazamaz', segments: ['b2b'] }, bearer(ro))).body.code).toBe('API_KEY_SCOPE');
    expect((await anon.get('/v1/api-keys', bearer(rw))).body.code).toBe('API_KEY_SCOPE'); // keys never manage keys
    expect((await anon.get('/v1/authz/matrix', bearer(rw))).body.code).toBe('API_KEY_SCOPE');
    ok(await anon.post('/v1/accounts', { name: 'API ile', segments: ['b2b'] }, bearer(rw)), 201);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await anon.get('/v1/accounts', bearer(rw))).status);
    expect(statuses).toContain(429);

    ok(await admin.post(`/v1/api-keys/${String(ro.id)}/revoke`));
    expect((await anon.get('/v1/accounts', bearer(ro))).status).toBe(401);
    expect((await anon.get('/v1/accounts', { authorization: 'Bearer fx_abcdefgh_wrong' })).status).toBe(401);
  });

  it('a retried POST with the same key runs once; a different body with that key is refused', async () => {
    const { c: admin } = await workspace();
    const key = { 'idempotency-key': `acc-${randomUUID()}` };
    const first = await admin.post('/v1/accounts', { name: 'Tek Sefer', segments: ['b2b'] }, key);
    const second = await admin.post('/v1/accounts', { name: 'Tek Sefer', segments: ['b2b'] }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect((await admin.post('/v1/accounts', { name: 'Başka', segments: ['b2b'] }, key)).body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await admin.post('/v1/accounts', { name: 'x', segments: ['b2b'] }, { 'idempotency-key': 'kısa' })).status).toBe(400);
    const list = ok(await admin.get(`/v1/accounts?q=${encodeURIComponent('name = "Tek Sefer"')}`)).data as Json[];
    expect(list.length).toBe(1);
  });
});

interface SseEvent { id: string; event: string; data: Json }
async function openStream(token: string, lastEventId?: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/stream`, { headers: { authorization: `Bearer ${token}`, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) }, signal: ctrl.signal });
  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value as Uint8Array, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { id: '', event: '', data: {} };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6)) as Json;
          }
          if (ev.event) events.push(ev);
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    events,
    close: () => { ctrl.abort(); },
    async until(pred: (e: SseEvent) => boolean, ms = 5000): Promise<SseEvent> {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no matching event; got ${events.map((e) => e.event).join(', ')}`);
        await sleep(25);
      }
    },
  };
}

describe('server-sent events (ADR-0007)', () => {
  it('only what the user may see, in order; notifications to their recipients; Last-Event-ID replay', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const s = await openStream(rep.c.accessToken!);
    expect(s.status).toBe(200);
    expect(s.contentType).toMatch(/text\/event-stream/);

    const hidden = ok(await admin.post('/v1/accounts', { name: 'Yöneticinin', segments: ['b2b'] }), 201);
    const own = ok(await rep.c.post('/v1/accounts', { name: 'Temsilcinin', segments: ['b2b'] }), 201);
    await drain();
    const seen = await s.until((e) => e.event === 'account.created' && (e.data.resource as Json).id === own.id);
    expect(seen.data).toMatchObject({ type: 'account.created', resource: { type: 'account', id: own.id } });
    expect(s.events.some((e) => JSON.stringify(e.data).includes(String(hidden.id)))).toBe(false);

    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bak ' }, { type: 'mention', attrs: { kind: 'user', id: rep.userId } }] }] };
    ok(await admin.post(`/v1/accounts/${String(own.id)}/comments`, { body: doc }), 201);
    await drain();
    const n = await s.until((e) => e.event === 'notification.created');
    expect(Object.keys(n.data).sort()).toEqual(['notificationIds', 'type']); // no content on the wire
    const lastId = s.events.at(-1)!.id;
    s.close();

    // Missed while offline: replayed from the outbox after Last-Event-ID, filtered the same way.
    ok(await admin.post('/v1/accounts', { name: 'Gizli 2', segments: ['b2b'] }), 201);
    const later = ok(await rep.c.post('/v1/accounts', { name: 'Temsilcinin 2', segments: ['b2b'] }), 201);
    await drain();
    const r = await openStream(rep.c.accessToken!, lastId);
    await r.until((e) => e.event === 'account.created' && (e.data.resource as Json).id === later.id);
    expect(r.events.some((e) => e.event === 'account.created' && (e.data.resource as Json).id === own.id)).toBe(false);
    expect(r.events.some((e) => JSON.stringify(e.data).includes('Gizli'))).toBe(false);
    r.close();

    const stale = await openStream(rep.c.accessToken!, randomUUID());
    await stale.until((e) => e.event === 'resync.required');
    stale.close();
    expect((await fetch(`${base}/v1/stream`)).status).toBe(401);
  });
});

describe('notification e-mail digest (ADR-0017 §3)', () => {
  it('mails unread notifications older than 10 minutes once, to users who chose e-mail', async () => {
    const { c: admin } = await workspace(['crm']);
    const rep = await member(admin, 'sales_rep');
    const quiet = await member(admin, 'sales_rep');
    ok(await rep.c.put('/v1/notifications/preferences', { preferences: [{ kind: 'mention', channels: ['in_app', 'email'] }] }));
    const acc = ok(await rep.c.post('/v1/accounts', { name: 'Özet', segments: ['b2b'] }), 201);
    const quietAcc = ok(await quiet.c.post('/v1/accounts', { name: 'Sessiz', segments: ['b2b'] }), 201);
    const mention = (id: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bakar mısın ' }, { type: 'mention', attrs: { kind: 'user', id } }] }] });
    ok(await admin.post(`/v1/accounts/${String(acc.id)}/comments`, { body: mention(rep.userId) }), 201);
    ok(await admin.post(`/v1/accounts/${String(quietAcc.id)}/comments`, { body: mention(quiet.userId) }), 201);
    const digest = h.app.get(DigestService);
    const mails = () => h.mailer.jobs.filter((j) => j.template === 'notification_digest');

    await digest.run();
    expect(mails().length).toBe(0); // too fresh
    await superQuery(SUPER(), `UPDATE notifications SET created_at = now() - interval '11 minutes' WHERE user_id = ANY($1)`, [[rep.userId, quiet.userId]]);
    await digest.run();
    expect(mails().map((m) => m.to)).toEqual([rep.email]);
    const m = mails()[0]!;
    expect(m.vars.items.length).toBe(1);
    expect(m.vars.items[0]!.url).toMatch(/^http:\/\/app\.flexa\.test\//);
    await digest.run();
    expect(mails().length).toBe(1); // each notification is mailed at most once
  });
});

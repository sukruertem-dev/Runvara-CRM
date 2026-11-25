import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { DeliveryService } from '../src/modules/records/delivery.service';
import { DigestService } from '../src/modules/records/digest.service';
import { PushService } from '../src/modules/records/push.service';
import { presenceKey } from '../src/modules/records/stream.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P8d (docs/p8-plan.md §17–20, MEN-06/07/09/13): web push, quiet hours, channel choices, e-mail only when away,
// links, delivery measurements.

// The receiving half of the push encryption (RFC 8291), from the library web-push itself encrypts with.
const ece = createRequire(require.resolve('web-push'))('http_ece') as { decrypt: (b: Buffer, o: Record<string, unknown>) => Buffer };

let h: Harness;
let server: Server;
let base: string;
let answer = 201;
const received: { path: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
beforeAll(async () => {
  h = await startHarness();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await h.close();
  server.close();
});

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(SUPER(), text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
interface Member { c: Client; userId: string; email: string }

async function workspace() {
  const s = await signupAndLogin(h);
  ok(await s.c.post('/v1/modules/crm/enable'));
  return { ...s, adminId: String((ok(await s.c.get('/v1/me')).user as Json).id) };
}
async function member(admin: Client, role = 'sales_rep'): Promise<Member> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  return { c, userId, email };
}
const mention = (id: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { kind: 'user', id } }] }] });
const prefer = async (m: Member, channels: string[]) => ok(await m.c.put('/v1/notifications/preferences', { preferences: [{ kind: 'mention', channels }] }));
const quiet = async (m: Member, enabled: boolean) => {
  const version = ok(await m.c.get('/v1/config/notifications.quiet?scope=user')).version;
  // The whole day but one minute, so the time of the run does not matter.
  const now = new Date(Date.now() - 60_000);
  const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  ok(await m.c.req('PUT', '/v1/config/notifications.quiet?scope=user', { value: { enabled, from: hm(now), to: hm(new Date(now.getTime() - 60_000)) } }, { 'if-match': `"${String(version)}"` }));
};

/** A browser: its keys, and its registration. */
function browser(path = `/${randomUUID()}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    path,
    body: { endpoint: `${base}${path}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    messages: () => received.filter((r) => r.path === path).map((r) => JSON.parse(ece.decrypt(r.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth.toString('base64url') }).toString('utf8')) as Json),
  };
}

/** The account owner is mentioned; returns the comment and delivers the push job the event would make. */
async function mentionOwner(admin: Client, m: Member, accId: string, tenantId: string): Promise<string> {
  const cm = ok(await admin.post(`/v1/accounts/${accId}/comments`, { body: mention(m.userId) }), 201);
  await h.app.get(PushService).deliver({ tenantId, userId: m.userId, kind: 'mention', sourceType: 'comment', sourceId: String(cm.id), occurredAt: new Date().toISOString() });
  return String(cm.id);
}
const accountOf = async (admin: Client, m: Member, name = 'Çok Gizli Müşteri') => String(ok(await admin.post('/v1/accounts', { name, segments: ['b2b'], ownerUserId: m.userId }), 201).id);
const deliveries = async (userId: string, channel: string) => (await sql('SELECT status FROM notification_deliveries WHERE user_id = $1 AND channel = $2 ORDER BY id', [userId, channel])).map((r) => r.status);

describe('web push', () => {
  it('reaches the person’s browsers, encrypted, with no content of the record; only for the kinds they chose', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const [one, two] = [browser(), browser()];
    expect(typeof ok(await rep.c.get('/v1/push/config')).publicKey).toBe('string');
    for (const b of [one, two]) ok(await rep.c.post('/v1/push/subscriptions', b.body), 204);
    const acc = await accountOf(w.c, rep);
    await mentionOwner(w.c, rep, acc, w.tenantId);
    expect(one.messages()).toEqual([]); // in-app only by default
    await prefer(rep, ['in_app', 'push']);
    await mentionOwner(w.c, rep, acc, w.tenantId);
    const note = (ok(await rep.c.get('/v1/notifications')).data as Json[])[0]!;
    expect(one.messages()).toEqual([{ title: 'Ayşe Yılmaz sizi bir kayıtta andı', body: expect.stringContaining('Firma'), url: `/n/${String(note.id)}`, tag: note.id }]);
    expect(two.messages()).toHaveLength(1);
    const raw = received.find((r) => r.path === one.path)!;
    expect(raw.headers.authorization).toMatch(/^vapid t=/);
    expect(raw.body.toString('latin1')).not.toContain('sizi bir');
    expect(JSON.stringify(one.messages())).not.toContain('Gizli');
    expect(await deliveries(rep.userId, 'push')).toEqual(['delivered', 'delivered']);

    ok(await rep.c.post('/v1/push/unsubscribe', { endpoint: two.body.endpoint }), 204);
    await mentionOwner(w.c, rep, acc, w.tenantId);
    expect([one.messages().length, two.messages().length]).toEqual([2, 1]);
  });

  it('the event makes one job per recipient, however often it is repeated', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    await prefer(rep, ['push']);
    const acc = await accountOf(w.c, rep);
    ok(await w.c.post(`/v1/accounts/${acc}/comments`, { body: mention(rep.userId) }), 201);
    const [e] = await sql(`SELECT id, payload FROM outbox_events WHERE tenant_id = $1 AND type = 'notification.created' AND payload ->> 'kind' = 'mention'`, [w.tenantId]);
    expect(e!.payload).toMatchObject({ userIds: [], silentUserIds: [rep.userId] });
    const event = { id: String(e!.id), type: 'notification.created', version: 1, tenantId: w.tenantId, occurredAt: new Date().toISOString(), actor: { type: 'system' as const, id: null }, resource: null, causationId: null, correlationId: randomUUID(), depth: 0, payload: e!.payload as Json };
    const push = h.app.get(PushService);
    await push.process(event);
    await push.process(event);
    const keys = await h.redis.keys(`bull:push:push-${String(e!.id)}-*`);
    expect(keys).toHaveLength(1);
  });

  it('lost access, a withdrawn or read notice and quiet hours send nothing', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const b = browser();
    ok(await rep.c.post('/v1/push/subscriptions', b.body), 204);
    await prefer(rep, ['in_app', 'push']);
    const acc = await accountOf(w.c, rep);
    const url = `/v1/accounts/${acc}`;
    const push = h.app.get(PushService);
    const job = (sourceId: string) => ({ tenantId: w.tenantId, userId: rep.userId, kind: 'mention', sourceType: 'comment', sourceId, occurredAt: new Date().toISOString() });
    const post = async () => String(ok(await w.c.post(`${url}/comments`, { body: mention(rep.userId) }), 201).id);

    await quiet(rep, true);
    await push.deliver(job(await post()));
    expect(await deliveries(rep.userId, 'push')).toEqual(['quiet']);
    await quiet(rep, false);
    const withdrawn = await post();
    ok(await w.c.del(`/v1/comments/${withdrawn}`), 204);
    await push.deliver(job(withdrawn));
    const read = await post();
    ok(await rep.c.post('/v1/notifications/read-all'));
    await push.deliver(job(read));
    const lost = await post();
    ok(await w.c.patchJson(url, { ownerUserId: w.adminId }, '"1"'));
    await push.deliver(job(lost));
    expect(await deliveries(rep.userId, 'push')).toEqual(['quiet', 'no_access']);
    expect(b.messages()).toEqual([]);
  });

  it('a browser that is gone is forgotten; a failing one is retried and counted', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const b = browser();
    ok(await rep.c.post('/v1/push/subscriptions', b.body), 204);
    await prefer(rep, ['in_app', 'push']);
    const acc = await accountOf(w.c, rep);
    try {
      answer = 500;
      await expect(mentionOwner(w.c, rep, acc, w.tenantId)).rejects.toThrow('push delivery failed');
      answer = 410;
      await mentionOwner(w.c, rep, acc, w.tenantId);
    } finally {
      answer = 201;
    }
    expect(await deliveries(rep.userId, 'push')).toEqual(['failed', 'gone']);
    expect(await sql('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [rep.userId])).toEqual([]);
  });

  it('a browser belongs to whoever registered it last; one person keeps it in several workspaces; private networks are refused', async () => {
    const w = await workspace();
    const [a, b] = [await member(w.c), await member(w.c)];
    const shared = browser();
    ok(await a.c.post('/v1/push/subscriptions', shared.body), 204);
    ok(await b.c.post('/v1/push/subscriptions', shared.body), 204);
    expect((await sql('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [shared.body.endpoint])).map((r) => r.user_id)).toEqual([b.userId]);
    // Someone else's browser cannot be removed by knowing its address.
    ok(await a.c.post('/v1/push/unsubscribe', { endpoint: shared.body.endpoint }), 204);
    expect(await sql('SELECT 1 FROM push_subscriptions WHERE endpoint = $1', [shared.body.endpoint])).toHaveLength(1);
    for (const endpoint of ['https://10.0.0.1/x-endpoint', 'http://push.example.test/x', 'https://169.254.169.254/latest']) {
      expect((await a.c.post('/v1/push/subscriptions', { ...shared.body, endpoint })).status).toBe(400);
    }
    expect((await a.c.post('/v1/push/subscriptions', { ...shared.body, keys: { p256dh: 'x', auth: 'y' } })).status).toBe(400);
    for (let i = 0; i < 12; i += 1) ok(await a.c.post('/v1/push/subscriptions', browser().body), 204);
    expect(await sql('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [a.userId])).toHaveLength(10);
    // MEN-13: nothing of a person stays behind their membership.
    await accountOf(w.c, b);
    await sql('DELETE FROM user_segment_grants WHERE user_id = $1', [b.userId]);
    expect(await sql(`SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'memberships'::regclass AND confdeltype = 'c'
      AND conrelid::regclass::text IN ('notifications', 'push_subscriptions', 'notification_deliveries', 'mentions', 'notification_preferences')`)).toHaveLength(5);
  });
});

describe('channels and quiet hours', () => {
  it('in-app off with e-mail on: kept out of the centre, still mailed; no channel at all makes nothing', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const none = await member(w.c);
    await prefer(rep, ['email']);
    await prefer(none, []);
    for (const m of [rep, none]) {
      const acc = await accountOf(w.c, m);
      ok(await w.c.post(`/v1/accounts/${acc}/comments`, { body: mention(m.userId) }), 201);
    }
    expect((ok(await rep.c.get('/v1/notifications')).data as Json[]).map((n) => n.kind)).toEqual(['assigned']);
    expect(ok(await rep.c.get('/v1/notifications')).unreadCount).toBe(1);
    expect(await sql(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'mention'`, [none.userId])).toEqual([]);
    await sql(`UPDATE notifications SET created_at = now() - interval '11 minutes' WHERE user_id = $1`, [rep.userId]);
    await h.app.get(DigestService).run();
    const mail = h.mailer.jobs.filter((j) => j.template === 'notification_digest' && j.to === rep.email);
    expect(mail).toHaveLength(1);
    expect(await deliveries(rep.userId, 'email')).toEqual(['delivered']);
  });

  it('e-mail waits while the person has the app open and during quiet hours, then goes', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    await prefer(rep, ['in_app', 'email']);
    const acc = await accountOf(w.c, rep);
    ok(await w.c.post(`/v1/accounts/${acc}/comments`, { body: mention(rep.userId) }), 201);
    await sql(`UPDATE notifications SET created_at = now() - interval '11 minutes' WHERE user_id = $1`, [rep.userId]);
    const digest = h.app.get(DigestService);
    const sent = () => h.mailer.jobs.filter((j) => j.template === 'notification_digest' && j.to === rep.email).length;
    await h.redis.set(presenceKey(w.tenantId, rep.userId), '1');
    await digest.run();
    expect(sent()).toBe(0);
    await h.redis.del(presenceKey(w.tenantId, rep.userId));
    await quiet(rep, true);
    await digest.run();
    expect(sent()).toBe(0);
    await quiet(rep, false);
    await digest.run();
    expect(sent()).toBe(1);
  });

  it('quiet hours are validated, personal, and a tenant default may be set', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const bad = await rep.c.req('PUT', '/v1/config/notifications.quiet?scope=user', { value: { from: '25:00' } }, { 'if-match': '0' });
    expect(bad.body.code).toBe('CONFIG_INVALID');
    ok(await w.c.req('PUT', '/v1/config/notifications.quiet?scope=tenant', { value: { enabled: true, from: '20:00', to: '08:00' } }, { 'if-match': '0' }));
    expect(ok(await rep.c.get('/v1/config/notifications.quiet?scope=user')).effective).toMatchObject({ enabled: true, from: '20:00' });
    expect((await rep.c.req('PUT', '/v1/config/notifications.quiet?scope=tenant', { value: { enabled: false } }, { 'if-match': '1' })).status).toBe(403);
  });
});

describe('links, acknowledgements and measurements', () => {
  it('one notice by id: own only, re-authorized; links lead to the record or the screen', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const acc = await accountOf(w.c, rep);
    const cm = ok(await w.c.post(`/v1/accounts/${acc}/comments`, { body: mention(rep.userId) }), 201);
    const n = (ok(await rep.c.get('/v1/notifications')).data as Json[]).find((x) => x.kind === 'mention')!;
    expect(ok(await rep.c.get(`/v1/notifications/${String(n.id)}`))).toMatchObject({ id: n.id, link: `/r/account/${acc}#comment-${String(cm.id)}` });
    expect((await w.c.get(`/v1/notifications/${String(n.id)}`)).status).toBe(404);
    const other = await workspace();
    expect((await other.c.get(`/v1/notifications/${String(n.id)}`)).status).toBe(404);
    ok(await w.c.patchJson(`/v1/accounts/${acc}`, { ownerUserId: w.adminId }, '"1"'));
    expect(ok(await rep.c.get(`/v1/notifications/${String(n.id)}`))).toMatchObject({ accessible: false, link: null, title: null });
  });

  it('acknowledges only own, recent events; the figures and alarms follow', async () => {
    const w = await workspace();
    const rep = await member(w.c);
    const acc = await accountOf(w.c, rep);
    ok(await w.c.post(`/v1/accounts/${acc}/comments`, { body: mention(rep.userId) }), 201);
    const [e] = await sql(`SELECT id FROM outbox_events WHERE tenant_id = $1 AND type = 'notification.created' AND payload ->> 'kind' = 'mention'`, [w.tenantId]);
    ok(await rep.c.post('/v1/stream/ack', { eventId: e!.id }), 204);
    ok(await w.c.post('/v1/stream/ack', { eventId: e!.id }), 204); // not a recipient: ignored
    ok(await rep.c.post('/v1/stream/ack', { eventId: randomUUID() }), 204);
    const other = await workspace();
    ok(await other.c.post('/v1/stream/ack', { eventId: e!.id }), 204);
    expect(await sql(`SELECT user_id FROM notification_deliveries WHERE channel = 'client' AND tenant_id = ANY($1)`, [[w.tenantId, other.tenantId]])).toEqual([{ user_id: rep.userId }]);
    expect((await rep.c.get('/v1/operator/delivery')).status).toBe(403);

    const delivery = h.app.get(DeliveryService);
    await sql('DELETE FROM notification_deliveries');
    const add = (channel: string, status: string, ms: number | null, n: number) => sql(`INSERT INTO notification_deliveries (tenant_id, user_id, channel, status, latency_ms)
      SELECT $1, $2, $3, $4, $5 FROM generate_series(1, ${String(n)})`, [w.tenantId, rep.userId, channel, status, ms]);
    await add('stream', 'delivered', 120, 19);
    await add('stream', 'delivered', 900, 1);
    expect((await delivery.stats(60)).find((s) => s.channel === 'stream')).toMatchObject({ delivered: 20, failed: 0, p50Ms: 120 });
    expect(await delivery.watch()).toEqual([]);
    await add('stream', 'delivered', 3000, 5);
    await add('push', 'failed', null, 6);
    expect(await delivery.watch()).toEqual([expect.stringContaining('ALERT notification_failures channel=push'), expect.stringContaining('ALERT notification_latency channel=stream')]);
    await sql(`UPDATE notification_deliveries SET at = now() - interval '31 days'`);
    await delivery.watch();
    expect(await sql('SELECT 1 FROM notification_deliveries')).toEqual([]);
  });
});

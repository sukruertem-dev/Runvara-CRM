import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainEvent } from '@flexa/contracts';
import { toEnvelope, type OutboxRow } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { buildTenantContext } from '../src/common/guards';
import { AutomationQueues } from '../src/modules/automation/queues';
import { StreamService } from '../src/modules/records/stream.service';
import { DB } from '../src/infra/tokens';
import type { DbHandle } from '@flexa/db';
import { signupAndLogin, startHarness, type Harness, type Res } from './harness';

// Tenant leak suite, wider (P7c, docs/p7-plan.md §16): live stream, files, search and lists, the event queue
// and its consumers, Redis-backed counters, configuration and plan data. Every check uses two workspaces and
// asks whether anything of A ever reaches B.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
type Json = Record<string, unknown>;
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

/** A stand-in for the SSE response: collects what the stream writes. */
class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  writableEnded = false;
  writeHead(): this { return this; }
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  end(): void { this.writableEnded = true; this.emit('close'); }
  get text(): string { return this.chunks.join(''); }
}

async function pair() {
  const a = await signupAndLogin(h);
  const b = await signupAndLogin(h);
  for (const w of [a, b]) {
    ok(await w.c.post('/v1/modules/crm/enable'));
    ok(await w.c.post('/v1/modules/api_webhooks/enable'));
  }
  return { a, b };
}

const userOf = async (email: string) => String((await superQuery<{ id: string }>(SUPER(), 'SELECT id FROM users WHERE email = $1', [email]))[0]?.id);

describe('tenant leak suite (P7c)', () => {
  it('live stream: an event of A reaches A’s stream only; B cannot replay A’s events', async () => {
    const { a, b } = await pair();
    const db = h.app.get<DbHandle>(DB);
    const stream = h.app.get(StreamService);
    const ctxA = await buildTenantContext(db, { userId: await userOf(a.email), sessionId: 's', tenantId: a.tenantId, amr: ['pwd'] });
    const ctxB = await buildTenantContext(db, { userId: await userOf(b.email), sessionId: 's', tenantId: b.tenantId, amr: ['pwd'] });
    const resA = new FakeResponse();
    const resB = new FakeResponse();
    await stream.open(ctxA, resA as unknown as ServerResponse, undefined);
    await stream.open(ctxB, resB as unknown as ServerResponse, undefined);
    ok(await a.c.req('PUT', '/v1/config/ui?scope=tenant', { value: { density: 'compact' } }, { 'if-match': '0' }));
    const [row] = await superQuery<OutboxRow>(SUPER(), `SELECT * FROM outbox_events WHERE tenant_id = $1 AND type = 'config.changed' ORDER BY occurred_at DESC LIMIT 1`, [a.tenantId]);
    const event = DomainEvent.parse(toEnvelope(row!));
    await stream.publish(event);
    await expect.poll(() => resA.text, { timeout: 5_000 }).toContain('event: config.changed');
    expect(resB.text).not.toContain('config.changed');
    // B presents A's event id as Last-Event-ID: unknown in B's tenant, so B is told to resync, nothing else.
    const replay = new FakeResponse();
    await stream.open(ctxB, replay as unknown as ServerResponse, event.id);
    await expect.poll(() => replay.text, { timeout: 5_000 }).toContain('resync.required');
    expect(replay.text).not.toContain('config.changed');
    for (const r of [resA, resB, replay]) r.end();
  });

  it('files: B cannot list or download A’s attachments or exports', async () => {
    const { a, b } = await pair();
    const acc = ok(await a.c.post('/v1/accounts', { name: 'Dosyalı A', segments: ['b2b'] }), 201);
    const content = new TextEncoder().encode('%PDF-1.4\n% leak\n%%EOF\n');
    const init = ok(await a.c.post(`/v1/accounts/${String(acc.id)}/attachments`, { fileName: 'a.pdf', mime: 'application/pdf', sizeBytes: content.length }), 201);
    const up = init.upload as { url: string; headers: Record<string, string> };
    expect((await fetch(up.url, { method: 'PUT', headers: up.headers, body: content })).status).toBe(200);
    const id = String((init.attachment as Json).id);
    ok(await a.c.post(`/v1/attachments/${id}/complete`));
    expect((await b.c.get(`/v1/attachments/${id}/download`)).status).toBe(404);
    expect((await b.c.get(`/v1/accounts/${String(acc.id)}/attachments`)).status).toBe(404);
    const [obj] = await superQuery<{ object_key: string }>(SUPER(), 'SELECT object_key FROM attachments WHERE id = $1', [id]);
    expect(obj?.object_key.startsWith(`tenants/${a.tenantId}/`)).toBe(true);
  });

  it('search and lists: A’s records never appear in B’s lists, queries, aggregates or exports', async () => {
    const { a, b } = await pair();
    const acc = ok(await a.c.post('/v1/accounts', { name: 'Gizli Firma Zeta', segments: ['b2b'] }), 201);
    ok(await a.c.post('/v1/tasks', { title: 'Gizli görev Zeta' }), 201);
    ok(await a.c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_zeta', type: 'text', label: { tr: 'Zeta' } }), 201);
    const listB = ok(await b.c.get('/v1/accounts')).data as Json[];
    expect(listB.map((x) => x.id)).not.toContain(acc.id);
    expect((await b.c.get(`/v1/accounts/${String(acc.id)}`)).status).toBe(404);
    const q = ok(await b.c.get(`/v1/tasks?q=${encodeURIComponent('title ~ "Zeta"')}`)).data as Json[];
    expect(q).toEqual([]);
    const agg = ok(await b.c.get('/v1/accounts/aggregate?groupBy=owner'));
    expect(JSON.stringify(agg)).not.toContain(String(acc.id));
    expect(JSON.stringify(ok(await b.c.get('/v1/config/export')))).not.toContain('cf_zeta');
    expect(JSON.stringify(ok(await b.c.get('/v1/custom-fields?resourceType=task')))).not.toContain('cf_zeta');
  });

  it('queue and consumers: dispatching A’s event touches only A’s subscriptions', async () => {
    const { a, b } = await pair();
    const subB = ok(await b.c.post('/v1/webhooks', { name: 'B kancası', url: 'http://127.0.0.1:9/hook', eventTypes: ['*'] }), 201);
    const subA = ok(await a.c.post('/v1/webhooks', { name: 'A kancası', url: 'http://127.0.0.1:9/hook', eventTypes: ['account.*'] }), 201);
    ok(await a.c.post('/v1/accounts', { name: 'Olay A', segments: ['b2b'] }), 201);
    const rows = await superQuery<OutboxRow>(SUPER(), `SELECT * FROM outbox_events WHERE tenant_id = $1 AND type = 'account.created'`, [a.tenantId]);
    expect(rows).toHaveLength(1);
    const queues = h.app.get(AutomationQueues);
    const event = DomainEvent.parse(toEnvelope(rows[0]!));
    expect(event.tenantId).toBe(a.tenantId);
    await queues.dispatch(event);
    expect(ok(await a.c.get(`/v1/webhooks/${String(subA.id)}/deliveries`)).data).toEqual([expect.objectContaining({ eventType: 'account.created' })]);
    expect(ok(await b.c.get(`/v1/webhooks/${String(subB.id)}/deliveries`)).data).toEqual([]);
    // A tenant's events always use its own shard queue.
    expect(queues.queueFor(a.tenantId).name).toBe(queues.queueFor(a.tenantId).name);
  });

  it('counters and plan data: A’s usage, limits and rate buckets are not B’s', async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 3; i += 1) ok(await a.c.post('/v1/tasks', { title: `A ${String(i)}` }), 201);
    await superQuery(SUPER(), `UPDATE tenant_plans SET limit_overrides = '{"records": 7}' WHERE tenant_id = $1`, [a.tenantId]);
    const usageA = ok(await a.c.get('/v1/usage'));
    const usageB = ok(await b.c.get('/v1/usage'));
    const records = (u: Json) => (u.dimensions as Json[]).find((d) => d.dimension === 'records');
    expect(records(usageA)).toMatchObject({ used: 3, limit: 7 });
    expect(records(usageB)).toMatchObject({ used: 0, limit: 10000 });
    const keys = await h.redis.keys(`*${a.tenantId}*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => !k.includes(b.tenantId))).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, toEnvelope, type OutboxRow, type Relay } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { AutomationRunner } from '../src/modules/automation/runner.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9d (docs/p9-plan.md §22–28): B2C customer profile, addresses, channel consent and the consent gate.

let h: Harness;
let relay: Relay;
beforeAll(async () => {
  h = await startHarness();
  relay = createRelay(process.env.TEST_RELAY_DATABASE_URL!);
});
afterAll(async () => {
  await relay.close();
  await h.close();
});

type Json = Record<string, unknown>;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(process.env.TEST_SUPER_DATABASE_URL!, text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const C = '/v1/sales/b2c/customers';

/** Every event relayed so far (a test may hand one to the runner again, as a queue retry would). */
const relayed: OutboxRow[] = [];
async function drain(): Promise<void> {
  const runner = h.app.get(AutomationRunner);
  for (let i = 0; i < 50; i++) {
    const n = await relay.relayOnce(async (rows: OutboxRow[]) => {
      relayed.push(...rows);
      for (const r of rows) await runner.process(toEnvelope(r)).catch(() => undefined);
    });
    if (n === 0) return;
  }
  throw new Error('event chain did not settle');
}

async function member(admin: Client, role: string) {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  return { c, userId };
}

async function setup() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2c']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const rep = await member(admin.c, 'sales_rep');
  const peer = await member(admin.c, 'sales_rep');
  const customer = ok(await rep.c.post('/v1/contacts', {
    firstName: 'Elif', lastName: 'Demir', segments: ['b2c'],
    contactPoints: [{ kind: 'email', value: 'Elif@Ornek.test', isPrimary: true }, { kind: 'phone', value: '0532 111 22 33' }],
  }), 201);
  return { ...admin, rep, peer, id: String(customer.id) };
}
type W = Awaited<ReturnType<typeof setup>>;
const consent = (w: W, channel: string, status: string, extra: Json = {}) => w.rep.c.post(`${C}/${w.id}/consents`, { channel, status, source: 'web_form', evidence: 'Üyelik formu', ...extra });

describe('customer profile (B2C-01)', () => {
  it('preferred channel, tags and addresses; visible to whoever may read the contact, B2C only', async () => {
    const w = await setup();
    const v0 = ok(await w.rep.c.get(`${C}/${w.id}`));
    expect(v0).toMatchObject({ fullName: 'Elif Demir', tags: [], addresses: [], version: 0, canEdit: true, canManageConsent: true });
    expect((v0.consents as Json[]).map((c) => [c.channel, c.consent])).toEqual([['email', null], ['sms', null], ['phone', null], ['whatsapp', null]]);
    expect((await w.rep.c.req('PUT', `${C}/${w.id}/profile`, { preferredChannel: 'sms', language: 'tr', tags: ['VIP'] })).status).toBe(428);
    const p = ok(await w.rep.c.req('PUT', `${C}/${w.id}/profile`, { preferredChannel: 'sms', language: 'tr', tags: ['VIP', 'VIP', 'Sadık'] }, { 'if-match': '"0"' }));
    expect(p).toMatchObject({ preferredChannel: 'sms', language: 'tr', tags: ['VIP', 'Sadık'], version: 1 });
    expect((await w.rep.c.req('PUT', `${C}/${w.id}/profile`, { preferredChannel: null, language: null, tags: [] }, { 'if-match': '"0"' })).status).toBe(412);

    const a1 = ok(await w.rep.c.post(`${C}/${w.id}/addresses`, { label: 'Ev', line1: 'Atatürk Cad. 10', city: 'İzmir', district: 'Karşıyaka' }), 201);
    expect(a1.addresses).toMatchObject([{ label: 'Ev', city: 'İzmir', country: 'TR', isDefault: true }]);
    const a2 = ok(await w.rep.c.post(`${C}/${w.id}/addresses`, { label: 'İş', line1: 'Plaza 3', city: 'İstanbul', isDefault: true }), 201);
    expect((a2.addresses as Json[]).map((a) => [a.label, a.isDefault])).toEqual([['İş', true], ['Ev', false]]);
    const work = (a2.addresses as Json[])[0]!;
    const back = ok(await w.rep.c.req('DELETE', `${C}/${w.id}/addresses/${String(work.id)}`));
    expect((back.addresses as Json[]).map((a) => [a.label, a.isDefault])).toEqual([['Ev', true]]);
    expect(rows(ok(await w.rep.c.get(`${C}?tag=VIP`)))).toEqual([w.id]);
    expect(rows(ok(await w.rep.c.get(`${C}?q=ornek`)))).toEqual([w.id]);

    expect((await w.peer.c.get(`${C}/${w.id}`)).status).toBe(404);
    expect(rows(ok(await w.peer.c.get(C)))).toEqual([]);
    const analyst = await member(w.c, 'analyst');
    expect(ok(await analyst.c.get(`${C}/${w.id}`))).toMatchObject({ canEdit: false, canManageConsent: false });
    expect((await analyst.c.post(`${C}/${w.id}/addresses`, { line1: 'x', city: 'y' })).status).toBe(403);
    const b2bOnly = await member(w.c, 'admin');
    ok(await w.c.put(`/v1/users/${b2bOnly.userId}/segments`, { segments: [{ segment: 'b2b' }] }));
    expect((await b2bOnly.c.get(`${C}/${w.id}`)).status).toBe(404);
    // A B2B contact is not a B2C customer.
    const b2b = ok(await w.rep.c.post('/v1/contacts', { firstName: 'Can', lastName: 'Yıldız', segments: ['b2b'] }), 201);
    expect((await w.rep.c.get(`${C}/${String(b2b.id)}`)).status).toBe(404);
    // Contact field policies apply here too: hidden contact points are neither shown nor searchable.
    const roles = ok(await w.c.get('/v1/roles')).data as Json[];
    const repRole = String(roles.find((r) => r.key === 'sales_rep')?.id);
    ok(await w.c.put('/v1/field-policies', { roleId: repRole, resourceType: 'contact', field: 'contactPoints', access: 'hidden' }));
    expect(rows(ok(await w.rep.c.get(`${C}?q=ornek`)))).toEqual([]);
    expect((ok(await w.rep.c.get(C)).data as Json[])[0]).toMatchObject({ fullName: 'Elif Demir', email: null, phone: null });
    ok(await w.c.put('/v1/field-policies', { roleId: repRole, resourceType: 'contact', field: 'contactPoints', access: null }));
    const timeline = (ok(await w.rep.c.get(`/v1/contacts/${w.id}/timeline`)).data as Json[]).map((e) => e.kind);
    expect(timeline.filter((k) => k === 'customer')).toHaveLength(4);
  });
});
const rows = (b: Json) => (b.data as Json[]).map((r) => r.id);

describe('consent (B2C-06)', () => {
  it('per channel with source and time; withdrawal is kept in an unchangeable history', async () => {
    const w = await setup();
    const given = ok(await consent(w, 'email', 'granted', { occurredAt: '2026-01-15T10:00:00+03:00', externalRef: 'IYS-123' }));
    const email = (given.consents as Json[]).find((c) => c.channel === 'email')?.consent as Json;
    expect(email).toMatchObject({ status: 'granted', source: 'web_form', evidence: 'Üyelik formu', externalRef: 'IYS-123', occurredAt: '2026-01-15T07:00:00.000Z', recordedBy: { id: w.rep.userId } });
    ok(await consent(w, 'email', 'withdrawn', { source: 'phone', evidence: 'Müşteri aradı' }));
    const hist = ok(await w.rep.c.get(`${C}/${w.id}/consents/history`)).data as Json[];
    expect(hist.map((x) => [x.channel, x.status, x.source])).toEqual([['email', 'withdrawn', 'phone'], ['email', 'granted', 'web_form']]);
    expect((await consent(w, 'sms', 'granted', { occurredAt: '2099-01-01T00:00:00Z' })).body.code).toBe('VALIDATION_FAILED');
    expect((await w.peer.c.post(`${C}/${w.id}/consents`, { channel: 'sms', status: 'granted', source: 'store' })).status).toBe(404);
    const analyst = await member(w.c, 'analyst');
    expect(ok(await analyst.c.get(`${C}/${w.id}/consents/history`)).data).toHaveLength(2);
    expect((await analyst.c.post(`${C}/${w.id}/consents`, { channel: 'sms', status: 'granted', source: 'store' })).status).toBe(403);

    const audits = await sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'consent.%' ORDER BY at`, [w.tenantId]);
    expect(audits.map((a) => a.action)).toEqual(['consent.granted', 'consent.withdrawn']);
    const events = await sql(`SELECT payload, segment FROM outbox_events WHERE tenant_id = $1 AND type = 'consent.changed' ORDER BY id`, [w.tenantId]);
    expect(events.map((e) => [(e.payload as Json).status, e.segment])).toEqual([['granted', 'b2c'], ['withdrawn', 'b2c']]);
    const run = (text: string) => h.db.withTenant({ tenantId: w.tenantId, userId: w.rep.userId, segments: ['b2c'] }, (tx) => tx.execute(text)).then(() => 'changed', (e: unknown) => String((e as { cause?: Error }).cause?.message ?? e));
    expect(await run(`UPDATE consent_events SET status = 'granted' WHERE contact_id = '${w.id}'`)).toMatch(/permission denied|append-only/);

    // A channel the workspace turned off takes no consent and reaches no one.
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.consent_channels?scope=tenant', { value: { channels: ['email', 'sms'] } }, { 'if-match': '0' }));
    expect((await consent(w, 'phone', 'granted')).body.code).toBe('VALIDATION_FAILED');
    expect((ok(await w.rep.c.get(`${C}/${w.id}`)).consents as Json[]).map((c) => c.channel)).toEqual(['email', 'sms']);
  });

  it('reachability: the one answer for campaigns, automations and outbound calls', async () => {
    const w = await setup();
    const reach = async (channel: string, id = w.id) => ok(await w.rep.c.get(`${C}/${id}/reachability?channel=${channel}`));
    expect(await reach('phone')).toMatchObject({ allowed: false, reason: 'no_consent', consent: null });
    ok(await consent(w, 'phone', 'granted'));
    expect(await reach('phone')).toMatchObject({ allowed: true, reason: null, consent: { status: 'granted' } });
    ok(await consent(w, 'phone', 'withdrawn'));
    expect(await reach('phone')).toMatchObject({ allowed: false, reason: 'withdrawn' });
    ok(await consent(w, 'whatsapp', 'granted'));
    const bare = ok(await w.rep.c.post('/v1/contacts', { firstName: 'Ali', lastName: 'Kaya', segments: ['b2c'] }), 201);
    ok(await w.rep.c.post(`${C}/${String(bare.id)}/consents`, { channel: 'email', status: 'granted', source: 'store' }));
    expect(await reach('email', String(bare.id))).toMatchObject({ allowed: false, reason: 'no_contact_point' });
    const b2b = ok(await w.rep.c.post('/v1/contacts', { firstName: 'Can', lastName: 'Yıldız', segments: ['b2b'] }), 201);
    expect(await reach('email', String(b2b.id))).toMatchObject({ allowed: false, reason: 'not_b2c' });
    expect(rows(ok(await w.rep.c.get(`${C}?reachable=whatsapp`)))).toEqual([w.id]);
    expect(rows(ok(await w.rep.c.get(`${C}?reachable=phone`)))).toEqual([]);
  });

  it('an automation e-mails only customers with e-mail consent; the others are recorded as blocked (AC-G5-2)', async () => {
    const w = await setup();
    ok(await w.c.post('/v1/modules/automation_sla/enable'));
    const other = ok(await w.rep.c.post('/v1/contacts', { firstName: 'Mert', lastName: 'Can', segments: ['b2c'], contactPoints: [{ kind: 'email', value: 'mert@ornek.test' }] }), 201);
    ok(await consent(w, 'email', 'granted'));
    const bad = await w.c.post('/v1/automations/rules', { name: 'Yanlış', definition: { resourceType: 'opportunity', trigger: { type: 'record.updated' }, actions: [{ type: 'email_customer', subject: 'x', body: 'y' }] } });
    expect(bad.body.code).toBe('RULE_DEFINITION_INVALID');
    ok(await w.c.post('/v1/automations/rules', {
      name: 'Hoş geldin', definition: { resourceType: 'contact', trigger: { type: 'record.updated' }, actions: [{ type: 'email_customer', subject: 'Hoş geldiniz', body: 'Aramıza katıldığınız için teşekkürler.' }] },
    }), 201);
    for (const id of [w.id, String(other.id)]) {
      const c = ok(await w.rep.c.get(`/v1/contacts/${id}`));
      ok(await w.rep.c.req('PATCH', `/v1/contacts/${id}`, { title: 'Müşteri' }, { 'if-match': `"${String(c.version)}"` }));
    }
    await drain();
    const sent = h.mailer.jobs.filter((j) => j.template === 'customer_message' && j.vars.subject === 'Hoş geldiniz');
    expect(sent.map((j) => j.to)).toEqual(['elif@ornek.test']);
    const runs = await sql(`SELECT record_id::text AS id, status, actions FROM automation_runs WHERE tenant_id = $1 ORDER BY started_at`, [w.tenantId]);
    expect(runs.map((r) => [r.id, r.status, (r.actions as Json[])[0]?.blocked ?? null])).toEqual([[w.id, 'succeeded', null], [String(other.id), 'succeeded', 'no_consent']]);

    // Withdrawn: the next run sends nothing.
    ok(await consent(w, 'email', 'withdrawn'));
    const c = ok(await w.rep.c.get(`/v1/contacts/${w.id}`));
    ok(await w.rep.c.req('PATCH', `/v1/contacts/${w.id}`, { title: 'Eski müşteri' }, { 'if-match': `"${String(c.version)}"` }));
    await drain();
    expect(h.mailer.jobs.filter((j) => j.template === 'customer_message' && j.vars.subject === 'Hoş geldiniz')).toHaveLength(1);
  });

  it('a customer mail retried after the run is checked again: consent withdrawn meanwhile, nothing goes out', async () => {
    const w = await setup();
    ok(await w.c.post('/v1/modules/automation_sla/enable'));
    ok(await consent(w, 'email', 'granted'));
    ok(await w.c.post('/v1/automations/rules', {
      name: 'Kampanya', definition: { resourceType: 'contact', trigger: { type: 'record.updated' }, actions: [{ type: 'email_customer', subject: 'Yeni sezon', body: 'İndirimler başladı.' }] },
    }), 201);
    // The queue is down when the run ends: the run is saved with its mail, the enqueue fails.
    const send = h.mailer.send.bind(h.mailer);
    let failing = true;
    h.mailer.send = (job, opts) => (failing && job.template === 'customer_message' ? Promise.reject(new Error('queue down')) : send(job, opts));
    try {
      const c = ok(await w.rep.c.get(`/v1/contacts/${w.id}`));
      ok(await w.rep.c.req('PATCH', `/v1/contacts/${w.id}`, { title: 'Müşteri' }, { 'if-match': `"${String(c.version)}"` }));
      await drain();
      ok(await consent(w, 'email', 'withdrawn'));
      failing = false;
      const event = relayed.find((e) => e.tenant_id === w.tenantId && e.type === 'contact.updated' && e.resource_id === w.id);
      if (!event) throw new Error('no contact.updated event');
      await h.app.get(AutomationRunner).process(toEnvelope(event));
    } finally {
      h.mailer.send = send;
    }
    expect(h.mailer.jobs.filter((j) => j.template === 'customer_message' && j.vars.subject === 'Yeni sezon')).toEqual([]);
  });
});

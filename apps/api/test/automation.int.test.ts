import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRelay, startRelayLoop, toEnvelope, type OutboxRow, type Relay } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { AutomationQueues } from '../src/modules/automation/queues';
import { AutomationRunner } from '../src/modules/automation/runner.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P5a acceptance (docs/p5-plan.md §4): loop protection, exactly-once effect, retries + DLQ + replay,
// no event loss when relay/consumer crash, inbound webhook and schedule triggers, assignment policies.

let h: Harness;
let relay: Relay;
beforeAll(async () => {
  h = await startHarness();
  relay = createRelay(process.env.TEST_RELAY_DATABASE_URL!);
});
afterAll(async () => { await relay.close(); await h.close(); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const runner = () => h.app.get(AutomationRunner);

/** Relays and processes every pending event (synchronously, including the chains rules cause). */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const n = await relay.relayOnce(async (rows: OutboxRow[]) => {
      for (const r of rows) await runner().process(toEnvelope(r)).catch(() => undefined);
    });
    if (n === 0) return;
  }
  throw new Error('event chain did not settle');
}

async function workspace() {
  const s = await signupAndLogin(h);
  ok(await s.c.post('/v1/modules/crm/enable'));
  ok(await s.c.post('/v1/modules/automation_sla/enable'));
  const me = ok(await s.c.get('/v1/me'));
  return { ...s, adminId: (me.user as { id: string }).id };
}

async function member(admin: Client, role: string): Promise<{ c: Client; userId: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return { c, userId: (l.user as { id: string }).id };
}

const rule = (admin: Client, name: string, definition: Json) => admin.post('/v1/automations/rules', { name, definition });
const runsOf = async (admin: Client, ruleId: string) => (ok(await admin.get(`/v1/automations/runs?ruleId=${ruleId}`)).data as Json[]);

describe('rule definitions', () => {
  it('validates conditions, fields and targets; only Admin manages rules; the module gate applies', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const bad = await rule(admin, 'Bozuk', { resourceType: 'account', trigger: { type: 'record.created' }, condition: 'industry = = 1', actions: [{ type: 'update_field', field: 'website', value: 'https://x.example' }] });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'RULE_DEFINITION_INVALID', rqlCode: 'RQL_SYNTAX' });
    expect((await rule(admin, 'Alan', { resourceType: 'account', trigger: { type: 'field_changed', fields: ['nope'] }, actions: [{ type: 'notify', to: { kind: 'record_owner' }, message: 'x' }] })).body.code).toBe('RULE_DEFINITION_INVALID');
    expect((await rule(admin, 'Değer', { resourceType: 'opportunity', trigger: { type: 'record.created' }, actions: [{ type: 'update_field', field: 'probability', value: 250 }] })).body.code).toBe('RULE_DEFINITION_INVALID');
    expect((await rule(admin, 'Akış', { resourceType: 'account', trigger: { type: 'record.created' }, actions: [{ type: 'transition', transitionKey: 'start' }] })).body.code).toBe('RULE_DEFINITION_INVALID');
    expect((await rep.c.post('/v1/automations/rules', { name: 'x', definition: { resourceType: 'account', trigger: { type: 'record.created' }, actions: [{ type: 'notify', to: { kind: 'record_owner' }, message: 'x' }] } })).status).toBe(403);
    const { c: other } = await signupAndLogin(h);
    expect((await other.get('/v1/automations/rules')).body.code).toBe('MODULE_DISABLED');
  });
});

describe('rules act on events (Faz 5)', () => {
  it('conditions on own and related fields; update, task with round-robin, notification and e-mail; exactly once', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Kurumsal ') }), 201).id);
    const r1 = await member(admin, 'sales_rep');
    const r2 = await member(admin, 'sales_rep');
    for (const u of [r1, r2]) ok(await admin.put(`/v1/teams/${team}/members/${u.userId}`, { role: 'member' }));
    const policy = ok(await admin.post('/v1/automations/assignment-policies', { name: uniq('Sıra '), strategy: 'round_robin', teamId: team }), 201);
    const created = ok(await rule(admin, 'Enerji fırsatı', {
      resourceType: 'opportunity', trigger: { type: 'record.created' }, condition: 'account.industry = "Enerji" AND probability < 50',
      actions: [
        { type: 'update_field', field: 'competitor', value: 'İzleniyor' },
        { type: 'create_task', title: 'Enerji fırsatını ara', priority: 3, dueInDays: 2, assignTo: { kind: 'policy', policyId: policy.id } },
        { type: 'notify', to: { kind: 'record_owner' }, message: 'Yeni enerji fırsatı' },
        { type: 'send_email', to: { kind: 'user', userId: r1.userId }, subject: 'Enerji fırsatı', body: 'Kontrol edin.' },
      ],
    }), 201);
    const energy = ok(await admin.post('/v1/accounts', { name: 'Güneş Enerji', segments: ['b2b'], industry: 'Enerji' }), 201);
    const textile = ok(await admin.post('/v1/accounts', { name: 'Tekstil', segments: ['b2b'], industry: 'Tekstil' }), 201);
    const o1 = ok(await admin.post('/v1/opportunities', { name: 'Panel', accountId: energy.id }), 201);
    const o2 = ok(await admin.post('/v1/opportunities', { name: 'Kumaş', accountId: textile.id }), 201);
    const o3 = ok(await admin.post('/v1/opportunities', { name: 'Türbin', accountId: energy.id }), 201);
    await drain();

    expect(ok(await admin.get(`/v1/opportunities/${String(o1.id)}`)).competitor).toBe('İzleniyor');
    expect(ok(await admin.get(`/v1/opportunities/${String(o2.id)}`)).competitor).toBeNull();
    const t1 = (ok(await admin.get(`/v1/opportunities/${String(o1.id)}/tasks`)).data as Json[]);
    const t3 = (ok(await admin.get(`/v1/opportunities/${String(o3.id)}/tasks`)).data as Json[]);
    expect(t1.length).toBe(1);
    expect(t1[0]).toMatchObject({ title: 'Enerji fırsatını ara', priority: 3 });
    // Round-robin: the two matching opportunities went to different team members.
    expect(new Set([(t1[0]!.owner as Json).id, (t3[0]!.owner as Json).id])).toEqual(new Set([r1.userId, r2.userId]));
    const adminN = ok(await admin.get('/v1/notifications')).data as Json[];
    expect(adminN.filter((n) => n.kind === 'automation').map((n) => n.message)).toEqual(['Yeni enerji fırsatı', 'Yeni enerji fırsatı']);
    expect(h.mailer.jobs.filter((j) => j.template === 'automation_notice' && j.vars.subject === 'Enerji fırsatı').length).toBe(2);
    // The timeline shows the automation as the actor's change, and the run log records it.
    const runs = await runsOf(admin, String(created.id));
    expect(runs.map((r) => r.status).sort()).toEqual(['skipped', 'succeeded', 'succeeded']);

    // Exactly once: the same events delivered again change nothing.
    const events = await superQuery<OutboxRow>(SUPER(), `SELECT * FROM outbox_events WHERE resource_id = ANY($1) AND type = 'opportunity.created'`, [[o1.id, o3.id]]);
    for (const e of events) {
      expect(await runner().process(toEnvelope(e))).toEqual([]); // already marked processed
      await superQuery(SUPER(), `DELETE FROM processed_events WHERE event_id = $1`, [e.id]); // even past the consumer marker…
      const again = await runner().process(toEnvelope(e));
      expect(again.map((x) => x.status)).toEqual(['duplicate']); // …the rule run is not repeated
    }
    expect((ok(await admin.get(`/v1/opportunities/${String(o1.id)}/tasks`)).data as Json[]).length).toBe(1);
    expect(h.mailer.jobs.filter((j) => j.template === 'automation_notice' && j.vars.subject === 'Enerji fırsatı').length).toBe(2);
  });

  it('a ping-pong of two rules stops at the loop guard, a growing chain at the depth limit; both are logged', async () => {
    const { c: admin, tenantId } = await workspace();
    const a = ok(await rule(admin, 'A', { resourceType: 'account', trigger: { type: 'record.updated' }, actions: [{ type: 'update_field', field: 'website', value: 'https://a.example' }] }), 201);
    const b = ok(await rule(admin, 'B', { resourceType: 'account', trigger: { type: 'record.updated' }, actions: [{ type: 'update_field', field: 'website', value: 'https://b.example' }] }), 201);
    const acc = ok(await admin.post('/v1/accounts', { name: 'Döngü', segments: ['b2b'] }), 201);
    ok(await admin.patchJson(`/v1/accounts/${String(acc.id)}`, { industry: 'Tetik' }, '"1"'));
    await drain();
    const statuses = [...(await runsOf(admin, String(a.id))), ...(await runsOf(admin, String(b.id)))].map((r) => r.status);
    expect(statuses.filter((s) => s === 'succeeded').length).toBe(2);
    expect(statuses).toContain('halted_loop');
    const halted = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND type = 'automation.run.halted'`, [tenantId]);
    expect(halted[0]!.n).toBeGreaterThan(0);

    // Depth: every new task creates a follow-up task (a new record each time, so only the depth limit stops it).
    const chain = ok(await rule(admin, 'Zincir', { resourceType: 'task', trigger: { type: 'record.created' }, actions: [{ type: 'create_task', title: 'Takip', assignTo: { kind: 'record_owner' } }] }), 201);
    ok(await admin.post('/v1/tasks', { title: 'Başlangıç' }), 201);
    await drain();
    const chainRuns = await runsOf(admin, String(chain.id));
    expect(chainRuns.filter((r) => r.status === 'succeeded').length).toBe(6); // depths 0…5
    expect(chainRuns.filter((r) => r.status === 'halted_depth').length).toBe(1);
    const tasks = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND title = 'Takip'`, [tenantId]);
    expect(tasks[0]!.n).toBe(6);
  });

  it('retries, then dead-letters; after the cause is fixed a replay applies it once', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Boş ') }), 201).id);
    const policy = ok(await admin.post('/v1/automations/assignment-policies', { name: uniq('Yük '), strategy: 'load_balanced', teamId: team }), 201);
    const r = ok(await rule(admin, 'Ata', { resourceType: 'case', trigger: { type: 'record.created' }, actions: [{ type: 'assign', to: { kind: 'policy', policyId: policy.id } }] }), 201);
    const cs = ok(await admin.post('/v1/cases', { subject: 'Atanacak', segment: 'b2c' }), 201);
    const [ev] = await superQuery<OutboxRow>(SUPER(), `SELECT * FROM outbox_events WHERE resource_id = $1 AND type = 'case.created'`, [cs.id]);
    await superQuery(SUPER(), `UPDATE outbox_events SET published_at = now() WHERE id = $1`, [ev!.id]); // this test delivers it by hand
    await expect(runner().process(toEnvelope(ev!), false)).rejects.toMatchObject({ code: 'ASSIGNMENT_NO_CANDIDATE' });
    expect((await runsOf(admin, String(r.id)))[0]).toMatchObject({ status: 'failed', attempt: 1 });
    await expect(runner().process(toEnvelope(ev!), true)).rejects.toThrow();
    expect((await runsOf(admin, String(r.id)))[0]).toMatchObject({ status: 'dead', attempt: 2 });
    const dl = (ok(await admin.get('/v1/automations/dead-letters')).data as Json[])[0]!;
    expect(dl).toMatchObject({ eventId: ev!.id, eventType: 'case.created', replayedAt: null });

    // Fix: a member joins the team; replay through the real queue and consumer.
    const rep = await member(admin, 'sales_rep');
    ok(await admin.put(`/v1/teams/${team}/members/${rep.userId}`, { role: 'member' }));
    h.app.get(AutomationQueues).startConsumers();
    ok(await admin.post(`/v1/automations/dead-letters/${String(dl.id)}/replay`));
    expect((await admin.post(`/v1/automations/dead-letters/${String(dl.id)}/replay`)).status).toBe(409);
    await expect.poll(async () => (await runsOf(admin, String(r.id)))[0]?.status, { timeout: 20_000 }).toBe('succeeded');
    expect(ok(await admin.get(`/v1/cases/${String(cs.id)}`)).ownerUserId).toBe(rep.userId);
  });

  it('chaos: a relay that dies before marking and a consumer that stops mid-stream lose nothing and double nothing', async () => {
    const { c: admin, tenantId } = await workspace();
    ok(await rule(admin, 'Takip görevi', { resourceType: 'account', trigger: { type: 'record.created' }, actions: [{ type: 'create_task', title: 'Hoş geldin araması', assignTo: { kind: 'record_owner' } }] }), 201);
    const queues = h.app.get(AutomationQueues);
    queues.startConsumers();
    let crashes = 1;
    const loop = startRelayLoop(relay, async (rows) => {
      // Publish, then "crash" before the outbox is marked: the batch is relayed again and the queue de-duplicates by id.
      await queues.events.addBulk(rows.map((r) => ({ name: r.type, data: toEnvelope(r), opts: { jobId: r.id, attempts: 8, backoff: { type: 'custom' } } })));
      if (crashes-- > 0) throw new Error('relay crashed');
    }, { pollMs: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(String(ok(await admin.post('/v1/accounts', { name: `Kaos ${i}`, segments: ['b2b'] }), 201).id));
    await expect.poll(async () => (await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND title = 'Hoş geldin araması'`, [tenantId]))[0]!.n, { timeout: 30_000 }).toBe(12);
    await loop.stop();
    const perAccount = await superQuery<{ related_id: string; n: number }>(SUPER(), `SELECT related_id, count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND title = 'Hoş geldin araması' GROUP BY related_id`, [tenantId]);
    expect(perAccount.length).toBe(12);
    expect(perAccount.every((p) => p.n === 1)).toBe(true);
    const pending = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id = $1 AND published_at IS NULL AND type = 'account.created'`, [tenantId]);
    expect(pending[0]!.n).toBe(0);
  });
});

describe('inbound webhook and schedule triggers, load balancing', () => {
  it('a webhook with the rule token triggers it; anything else is an indistinguishable 404', async () => {
    const { c: admin } = await workspace();
    const lead = ok(await admin.post('/v1/leads', { company: 'Web formu', segment: 'b2b' }), 201);
    const r = ok(await rule(admin, 'Web kancası', { resourceType: 'lead', trigger: { type: 'inbound_webhook' }, actions: [{ type: 'update_field', field: 'score', value: 80 }] }), 201);
    expect(typeof r.hookToken).toBe('string');
    expect((ok(await admin.get(`/v1/automations/rules/${String(r.id)}`))).hookToken).toBeUndefined();
    const anon = new Client(h.app);
    const url = `/v1/automations/hooks/${String(r.id)}`;
    expect((await anon.post(url, { recordId: lead.id }, { 'x-flexa-hook-token': 'yanlis' })).status).toBe(404);
    expect((await anon.post(url, { recordId: '01900000-0000-7000-8000-000000000000' }, { 'x-flexa-hook-token': String(r.hookToken) })).status).toBe(404);
    ok(await anon.post(url, { recordId: lead.id, data: { source: 'site' } }, { 'x-flexa-hook-token': String(r.hookToken) }), 202);
    await drain();
    expect(ok(await admin.get(`/v1/leads/${String(lead.id)}`)).score).toBe(80);
    const rotated = ok(await admin.post(`/v1/automations/rules/${String(r.id)}/rotate-hook-token`));
    expect((await anon.post(url, { recordId: lead.id }, { 'x-flexa-hook-token': String(r.hookToken) })).status).toBe(404);
    ok(await anon.post(url, { recordId: lead.id }, { 'x-flexa-hook-token': String(rotated.hookToken) }), 202);
  });

  it('a schedule tick applies the rule to every matching record; load-balanced assignment picks the least busy', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Destek ') }), 201).id);
    const busy = await member(admin, 'sales_rep');
    const free = await member(admin, 'sales_rep');
    for (const u of [busy, free]) ok(await admin.put(`/v1/teams/${team}/members/${u.userId}`, { role: 'member' }));
    for (let i = 0; i < 3; i++) ok(await admin.post('/v1/tasks', { title: `Yük ${i}`, owner: { type: 'user', id: busy.userId } }), 201);
    const policy = ok(await admin.post('/v1/automations/assignment-policies', { name: uniq('Denge '), strategy: 'load_balanced', teamId: team }), 201);
    const old = ok(await admin.post('/v1/cases', { subject: 'Bekleyen', segment: 'b2c', priority: 4 }), 201);
    ok(await admin.post('/v1/cases', { subject: 'Düşük', segment: 'b2c', priority: 1 }), 201);
    await drain();
    const r = ok(await rule(admin, 'Gece taraması', {
      resourceType: 'case', trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'Europe/Istanbul' }, condition: 'priority >= 4',
      actions: [{ type: 'assign', to: { kind: 'policy', policyId: policy.id } }],
    }), 201);
    const schedulers = await h.app.get(AutomationQueues).schedule.getJobSchedulers();
    expect(schedulers.some((s) => s.key === `rule:${String(r.id)}`)).toBe(true);
    // Fire one tick by hand (the scheduler would do this at 02:00 Istanbul time).
    const { tenantId } = await (async () => ({ tenantId: String((ok(await admin.get('/v1/tenant'))).id) }))();
    await superQuery(SUPER(), `INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id) VALUES ($1, 'automation.schedule_tick', '{"type":"system","id":null}', $2, gen_random_uuid())`, [tenantId, JSON.stringify({ ruleId: r.id })]);
    await drain();
    expect(ok(await admin.get(`/v1/cases/${String(old.id)}`)).ownerUserId).toBe(free.userId);
    expect((await runsOf(admin, String(r.id))).map((x) => x.status)).toEqual(['succeeded']);
    ok(await admin.req('PATCH', `/v1/automations/rules/${String(r.id)}`, { enabled: false }));
    expect((await h.app.get(AutomationQueues).schedule.getJobSchedulers()).some((s) => s.key === `rule:${String(r.id)}`)).toBe(false);
  });
});

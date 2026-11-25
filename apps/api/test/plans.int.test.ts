import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toEnvelope, type OutboxRow } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { DomainEvent } from '@flexa/contracts';
import { Queue, Worker } from 'bullmq';
import { fairProcessor, TenantSemaphore } from '../src/modules/automation/fairness';
import { AutomationQueues } from '../src/modules/automation/queues';
import { QuotaService } from '../src/modules/usage/quota.service';
import { UsageService } from '../src/modules/usage/usage.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P7b (docs/p7-plan.md §7–12): blueprints, export/import with dry run and conflicts, onboarding, plan
// entitlement (MOD-04), quota (TEN-09) and noisy-neighbour protection (TEN-10).

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
type Json = Record<string, unknown>;
type Op = { section: string; key: string; action: string; reason?: string };

const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(SUPER(), text, values);
const setPlan = (tenantId: string, plan: string, addOns: string[] = [], overrides: Json = {}) =>
  sql(`UPDATE tenant_plans SET plan_id = $2, add_ons = $3, limit_overrides = $4::jsonb, trial_ends_at = CASE WHEN $2 = 'trial' THEN now() + interval '14 days' END WHERE tenant_id = $1`,
    [tenantId, plan, addOns, JSON.stringify(overrides)]);

async function member(admin: Client, role: string): Promise<Client> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return c;
}

const opsOf = (plan: Json) => plan.operations as Op[];
const stripMeta = (b: Json) => {
  const { meta: _meta, ...rest } = b;
  return rest;
};

describe('blueprints and onboarding', () => {
  it('lists three blueprints and applies each one to a new workspace; a second dry run is unchanged', async () => {
    for (const id of ['enterprise-b2b', 'retail-b2c', 'telesales-callcenter']) {
      const { c } = await signupAndLogin(h);
      const list = ok(await c.get('/v1/blueprints')).data as Json[];
      expect(list.map((b) => b.id)).toEqual(['enterprise-b2b', 'retail-b2c', 'telesales-callcenter']);
      const plan = ok(await c.post(`/v1/blueprints/${id}/preview`));
      expect(plan, id).toMatchObject({ blocking: 0, applicable: true, summary: { conflict: 0 } });
      const applied = ok(await c.post(`/v1/blueprints/${id}/apply`, {}));
      expect(applied.applied).toBe(true);
      const again = ok(await c.post(`/v1/blueprints/${id}/preview`));
      expect(opsOf(again).filter((o) => o.action !== 'unchanged'), id).toEqual([]);
    }
    const { c } = await signupAndLogin(h);
    expect((await c.post('/v1/blueprints/nope/preview')).body.code).toBe('BLUEPRINT_UNKNOWN');
  });

  it('runs the onboarding once: blueprint, sales mode and modules in one transaction', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    expect(ok(await c.get('/v1/onboarding'))).toEqual({ status: 'pending', blueprint: null });
    const choice = { blueprint: 'retail-b2c', salesMode: 'b2c_only', modules: ['crm', 'sales_b2c', 'automation_sla'] };
    const preview = ok(await c.post('/v1/onboarding/preview', choice));
    expect(opsOf(preview).filter((o) => o.section === 'modules').map((o) => `${o.key}:${o.action}`)).toEqual(['crm:create', 'sales_b2c:create', 'automation_sla:create']);
    ok(await c.post('/v1/onboarding/complete', choice));
    expect(ok(await c.get('/v1/onboarding'))).toEqual({ status: 'completed', blueprint: 'retail-b2c' });
    expect(ok(await c.get('/v1/tenant')).salesMode).toBe('b2c_only');
    const modules = ok(await c.get('/v1/modules')).data as Json[];
    expect(modules.filter((m) => m.enabled).map((m) => m.id).sort()).toEqual(['automation_sla', 'core', 'crm', 'sales_b2c']);
    const fields = ok(await c.get('/v1/custom-fields?resourceType=contact')).data as Json[];
    expect(fields.map((f) => f.key)).toContain('cf_loyalty_tier');
    // Once only; the audit shows the import as one entry.
    expect((await c.post('/v1/onboarding/complete', choice)).status).toBe(409);
    const audits = await sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'config.imported'`, [tenantId]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ source: 'onboarding', sourceId: 'retail-b2c', onConflict: 'keep' });

    const other = await signupAndLogin(h);
    expect(ok(await other.c.post('/v1/onboarding/skip'))).toEqual({ status: 'skipped', blueprint: null });
    expect((await other.c.post('/v1/onboarding/skip')).status).toBe(409);
  });
});

describe('export and import (CFG-05)', () => {
  it('moves a configuration to another workspace by natural key, reports conflicts and can keep them', async () => {
    const a = await signupAndLogin(h);
    ok(await a.c.post('/v1/blueprints/enterprise-b2b/apply', {}));
    ok(await a.c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_effort', type: 'number', label: { tr: 'Efor' } }), 201);
    ok(await a.c.req('PUT', '/v1/config/ui?scope=tenant', { value: { density: 'compact' } }, { 'if-match': '0' }));
    const exported = ok(await a.c.get('/v1/config/export'));
    expect(exported).toMatchObject({ format: 'flexa.config/1', meta: { kind: 'export', id: a.slug }, salesMode: 'b2b_only', settings: { ui: { density: 'compact' } } });
    expect(JSON.stringify(exported)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    const b = await signupAndLogin(h);
    // B already has a field with the same key but another label: a conflict.
    ok(await b.c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_effort', type: 'number', label: { tr: 'Süre' } }), 201);
    const plan = ok(await b.c.post('/v1/config/import/preview', { bundle: exported }));
    expect(opsOf(plan).find((o) => o.key === 'task.cf_effort')).toMatchObject({ action: 'conflict', reason: 'definition_differs' });
    expect(plan).toMatchObject({ blocking: 0, applicable: true });
    const refused = await b.c.post('/v1/config/import', { bundle: exported });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'IMPORT_CONFLICTS', plan: { summary: { conflict: 1 } } });
    // Nothing was written by the refused import.
    expect((ok(await b.c.get('/v1/custom-fields?resourceType=account')).data as Json[])).toEqual([]);

    ok(await b.c.post('/v1/config/import', { bundle: exported, onConflict: 'keep', note: 'sandbox → canlı' }));
    const effort = (ok(await b.c.get('/v1/custom-fields?resourceType=task')).data as Json[]).find((f) => f.key === 'cf_effort');
    expect(effort?.label).toEqual({ tr: 'Süre' });
    const bExport = ok(await b.c.get('/v1/config/export'));
    const norm = (x: Json) => ({ ...stripMeta(x), customFields: (x.customFields as Json[]).filter((f) => f.key !== 'cf_effort') });
    expect(norm(bExport)).toEqual(norm(exported));
    // The settings write went through the configuration engine: versioned, with the note.
    const hist = ok(await b.c.get('/v1/config/ui/history?scope=tenant')).data as Json[];
    expect(hist[0]).toMatchObject({ version: 1, note: 'sandbox → canlı' });
  });

  it('refuses blocking conflicts even when keeping, and an unknown key or a logo id', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    await setPlan(tenantId, 'starter');
    const bundle = {
      format: 'flexa.config/1', modules: ['crm', 'sales_b2b'],
      settings: { brand: { logoAssetId: '0190a6f2-7f3c-7d8e-9a1b-2c3d4e5f6a7b' }, 'no.such': { a: 1 } },
      slaPolicies: [{ name: 'P', resourceType: 'case', calendar: 'Yok', firstResponseMinutes: 30 }],
    };
    const plan = ok(await c.post('/v1/config/import/preview', { bundle }));
    expect(opsOf(plan).filter((o) => o.action === 'conflict').map((o) => `${o.key}:${o.reason ?? ''}`).sort()).toEqual([
      'P:calendar_missing', 'brand:invalid', 'no.such:invalid', 'sales_b2b:module_not_in_plan',
    ]);
    const r = await c.post('/v1/config/import', { bundle, onConflict: 'keep' });
    expect(r.status).toBe(409);
    expect(ok(await c.get('/v1/modules')).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'crm', enabled: false })]));
    expect((await c.post('/v1/config/import/preview', { bundle: { format: 'other/1' } })).status).toBe(400);
  });

  it('lets a Manager export but not import, and a Sales rep do neither', async () => {
    const { c } = await signupAndLogin(h);
    const manager = await member(c, 'manager');
    const rep = await member(c, 'sales_rep');
    ok(await manager.get('/v1/config/export'));
    expect((await manager.post('/v1/config/import/preview', { bundle: { format: 'flexa.config/1' } })).status).toBe(403);
    expect((await manager.post('/v1/onboarding/skip')).status).toBe(403);
    expect((await rep.get('/v1/config/export')).status).toBe(403);
    expect((await rep.get('/v1/usage')).status).toBe(403);
    expect((await manager.req('PUT', '/v1/tenant/sales-mode', { salesMode: 'b2c_only' })).status).toBe(403);
  });
});

describe('plan entitlement (MOD-04)', () => {
  it('refuses modules outside the plan and allows bought add-ons', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    await setPlan(tenantId, 'starter');
    ok(await c.post('/v1/modules/crm/enable'));
    const r = await c.post('/v1/modules/sales_b2b/enable');
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'MODULE_NOT_IN_PLAN', moduleId: 'sales_b2b', plan: 'starter', entitlement: 'not_in_plan' });
    const states = ok(await c.get('/v1/modules')).data as Json[];
    expect(states.find((m) => m.id === 'sales_b2b')?.entitlement).toBe('not_in_plan');

    await setPlan(tenantId, 'growth');
    ok(await c.post('/v1/modules/sales_b2c/enable'));
    ok(await c.post('/v1/modules/call_center/enable'));
    expect((await c.post('/v1/modules/dialer/enable')).body).toMatchObject({ code: 'MODULE_NOT_IN_PLAN', entitlement: 'available_add_on' });
    await setPlan(tenantId, 'growth', ['dialer']);
    ok(await c.post('/v1/modules/dialer/enable'));
    expect((ok(await c.get('/v1/modules')).data as Json[]).find((m) => m.id === 'dialer')).toMatchObject({ enabled: true, entitlement: 'add_on' });
    // Downgrading never disables or deletes anything by itself (MOD-03); it only stops new enables.
    await setPlan(tenantId, 'starter');
    expect((ok(await c.get('/v1/modules')).data as Json[]).find((m) => m.id === 'dialer')).toMatchObject({ enabled: true, entitlement: 'available_add_on' });
  });

  it('changes the sales mode', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    expect(ok(await c.req('PUT', '/v1/tenant/sales-mode', { salesMode: 'b2b_only' })).salesMode).toBe('b2b_only');
    const [row] = await sql(`SELECT sales_mode FROM tenants WHERE id = $1`, [tenantId]);
    expect(row?.sales_mode).toBe('b2b_only');
  });
});

describe('quota (TEN-09)', () => {
  it('stops invitations at 100 %, records at 120 %, never reads or exports, and announces each level once', async () => {
    const { c, tenantId, slug } = await signupAndLogin(h);
    await setPlan(tenantId, 'trial', [], { users: 2, records: 5 });
    ok(await c.post('/v1/invitations', { email: `${uniq('q')}@firma.test`, roleKey: 'sales_rep' }), 201);
    const over = await c.post('/v1/invitations', { email: `${uniq('q')}@firma.test`, roleKey: 'sales_rep' });
    expect(over.status).toBe(402);
    expect(over.body).toMatchObject({ code: 'QUOTA_EXCEEDED', dimension: 'users', used: 2, limit: 2 });

    // Records: 5 is the limit, 6 (120 %) is the last one accepted.
    for (let i = 0; i < 6; i += 1) ok(await c.post('/v1/tasks', { title: `Görev ${String(i)}` }), 201);
    const r7 = await c.post('/v1/tasks', { title: 'Fazla' });
    expect(r7.status).toBe(402);
    expect(r7.body).toMatchObject({ code: 'QUOTA_EXCEEDED', dimension: 'records' });
    ok(await c.get('/v1/tasks'));
    ok(await c.get('/v1/config/export'));

    const alerts = await sql(`SELECT dimension, level FROM tenant_quota_alerts WHERE tenant_id = $1 ORDER BY dimension, level`, [tenantId]);
    expect(alerts.map((a) => `${String(a.dimension)}:${String(a.level)}`)).toEqual(['records:hard', 'records:soft', 'records:warning', 'users:soft', 'users:warning']);
    const events = await sql(`SELECT * FROM outbox_events WHERE tenant_id = $1 AND type = 'quota.threshold' ORDER BY occurred_at`, [tenantId]);
    expect(events.map((e) => (e.payload as Json).level)).toEqual(['soft', 'warning', 'soft', 'hard']);
    const audits = await sql(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'quota.threshold'`, [tenantId]);
    expect(audits[0]?.n).toBe(events.length);

    // The consumer e-mails the Admins once per event.
    const quota = h.app.get(QuotaService);
    const last = DomainEvent.parse(toEnvelope(events.at(-1) as unknown as OutboxRow));
    await quota.process(last);
    await quota.process(last);
    const mails = h.mailer.jobs.filter((j) => j.template === 'quota_warning' && j.vars.tenantName === `Firma ${slug}`);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.vars).toMatchObject({ dimension: 'records', level: 'hard', used: '6', limit: '5' });

    const usage = ok(await c.get('/v1/usage'));
    expect(usage).toMatchObject({ plan: { id: 'trial', tier: 'enterprise' }, rates: { apiRpm: 1200, apiRpmPerUser: 600 } });
    expect((usage.dimensions as Json[]).find((d) => d.dimension === 'records')).toEqual({ dimension: 'records', used: 6, limit: 5, level: 'hard' });
    expect((usage.dimensions as Json[]).find((d) => d.dimension === 'users')).toMatchObject({ used: 2, limit: 2, level: 'soft' });
  });

  it('meters API requests and flushes them into the daily table; snapshots gauges', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    for (let i = 0; i < 3; i += 1) ok(await c.get('/v1/tenant'));
    const before = ok(await c.get('/v1/usage'));
    const today = (before.apiRequests as Json[]).at(-1);
    expect(Number(today?.count)).toBeGreaterThanOrEqual(3);
    expect(before.apiRequests).toHaveLength(30);
    const usage = h.app.get(UsageService);
    await usage.flushCounters();
    const rows = await sql(`SELECT value FROM tenant_usage_counters WHERE tenant_id = $1 AND dimension = 'api_requests'`, [tenantId]);
    expect(Number(rows[0]?.value)).toBeGreaterThanOrEqual(4);
    await usage.snapshot(tenantId);
    const gauges = await sql(`SELECT dimension, value FROM tenant_usage_counters WHERE tenant_id = $1 AND dimension <> 'api_requests' ORDER BY dimension`, [tenantId]);
    expect(gauges.map((g) => `${String(g.dimension)}=${String(g.value)}`)).toEqual(['records=0', 'storage_bytes=0', 'users=1']);
  });
});

describe('noisy neighbour (TEN-10)', () => {
  it('limits a tenant and a user with token buckets; another tenant is unaffected', async () => {
    const limited = await startHarness({ TENANT_RATE_LIMIT_MULTIPLIER: '1' });
    try {
      const a = await signupAndLogin(limited);
      const manager = await (async () => {
        const email = `${uniq('m')}@firma.test`;
        expect((await a.c.post('/v1/invitations', { email, roleKey: 'manager' })).status).toBe(201);
        const m = new Client(limited.app);
        await m.post('/v1/invitations/accept', { token: limited.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: 'M' });
        await m.post('/v1/auth/login', { email, password: PASSWORD });
        return m;
      })();
      await superQuery(SUPER(), `UPDATE tenant_plans SET limit_overrides = '{"api_rpm": 5, "api_rpm_per_user": 3}' WHERE tenant_id = $1`, [a.tenantId]);
      await limited.redis.del(`rl:tenant:${a.tenantId}`);
      const statuses = async (c: Client, n: number) => {
        const out: number[] = [];
        for (let i = 0; i < n; i += 1) out.push((await c.get('/v1/tenant')).status);
        return out;
      };
      // The admin's own bucket holds 3 requests; the tenant's 5.
      expect(await statuses(a.c, 4)).toEqual([200, 200, 200, 429]);
      const r = await a.c.get('/v1/tenant');
      expect(r.body.code).toBe('RATE_LIMITED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(await statuses(manager, 3)).toEqual([200, 200, 429]);
      const b = await signupAndLogin(limited);
      expect(await statuses(b.c, 3)).toEqual([200, 200, 200]);
    } finally {
      await limited.close();
    }
  });

  it('bounds the slots a tenant holds; an expired lease frees its slot', async () => {
    const fair = new TenantSemaphore(h.redis, uniq('q'), 2, 2_000); // long enough that a slow machine does not expire it between calls
    expect(await fair.acquire('A', 'j1')).toBe(true);
    expect(await fair.acquire('A', 'j2')).toBe(true);
    expect(await fair.acquire('A', 'j3')).toBe(false);
    expect(await fair.acquire('B', 'k1')).toBe(true);
    expect(await fair.acquire('A', 'j1')).toBe(true); // renewing its own slot
    await fair.release('A', 'j1');
    expect(await fair.acquire('A', 'j3')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(await fair.held('A')).toBe(0);
  });

  it('does not make another tenant wait behind a heavy tenant in the same shard', async () => {
    const name = uniq('fair-');
    const queue = new Queue(name, { connection: h.redis });
    const fair = new TenantSemaphore(h.redis, name, 1);
    const finished: string[] = [];
    const worker = new Worker<{ tenantId: string; n: number }>(name, fairProcessor<{ tenantId: string; n: number }>(fair, (d) => d.tenantId, async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      finished.push(`${job.data.tenantId}${String(job.data.n)}`);
    }), { connection: h.redis.duplicate(), concurrency: 4 });
    try {
      await queue.addBulk(Array.from({ length: 10 }, (_, n) => ({ name: 'e', data: { tenantId: 'heavy', n } })));
      await queue.add('e', { tenantId: 'light', n: 0 });
      const deadline = Date.now() + 15_000;
      while (finished.length < 11 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toHaveLength(11);
      // The heavy tenant runs one job at a time; the light tenant's job does not wait for all ten.
      expect(finished.indexOf('light0')).toBeLessThan(4);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('routes a tenant to one shard queue', () => {
    const queues = h.app.get(AutomationQueues);
    const id = '0190a6f2-7f3c-7d8e-9a1b-2c3d4e5f6a7b';
    expect(queues.queueFor(id).name).toMatch(/^events-\d$/);
    expect(queues.queueFor(id).name).toBe(queues.queueFor(id).name);
  });
});

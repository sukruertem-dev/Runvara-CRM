import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { currentPeriods, ForecastService, periodBounds } from '../src/modules/quotes/forecast.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9c (docs/p9-plan.md §15–20): weighted forecast, the Manager's call, snapshots, untouched opportunities, next step.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(process.env.TEST_SUPER_DATABASE_URL!, text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const F = '/v1/sales/b2b/forecast';

async function member(admin: Client, role: string, teamId?: string, teamRole: 'member' | 'manager' = 'member') {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  if (teamId) ok(await admin.put(`/v1/teams/${teamId}/members/${userId}`, { role: teamRole }));
  return { c, userId };
}

/** A Manager with one rep in their team and one rep outside; the period is this month in the tenant's zone. */
async function setup() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2b']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const team = String(ok(await admin.c.post('/v1/teams', { name: uniq('Kurumsal ') }), 201).id);
  const mgr = await member(admin.c, 'manager', team, 'manager');
  const rep = await member(admin.c, 'sales_rep', team);
  const other = await member(admin.c, 'sales_rep');
  const tz = String((await sql('SELECT timezone FROM tenants WHERE id = $1', [admin.tenantId]))[0]?.timezone);
  const [month = '', quarter = ''] = currentPeriods(tz);
  const day = `${periodBounds(month).from.slice(0, 8)}15`;
  return { ...admin, mgr, rep, other, month, quarter, day };
}
const opp = async (c: Client, body: Json) => ok(await c.post('/v1/opportunities', { segment: 'b2b', currency: 'TRY', ...body }), 201);
const owners = (b: Json) => (b.owners as Json[]).map((o) => [(o.owner as Json).id, o.currency, o.pipeline, o.weighted, o.won, o.forecast]);

describe('forecast (B2B-07)', () => {
  it('weighted by stage probability; each sees their own scope; B2C and other periods do not count', async () => {
    const w = await setup();
    const a = await opp(w.rep.c, { name: 'Bakım', amount: '1000', expectedClose: w.day });
    await opp(w.rep.c, { name: 'Gelecek yıl', amount: '700', expectedClose: '2099-01-10' });
    await opp(w.other.c, { name: 'Başka ekip', amount: '2000', expectedClose: w.day });
    const b2c = await w.rep.c.post('/v1/opportunities', { name: 'Bireysel', segment: 'b2c', amount: '5000', currency: 'TRY', expectedClose: w.day });
    expect([201, 403, 404, 422]).toContain(b2c.status);
    const p = Number(a.probability);
    const weighted = (1000 * p / 100).toFixed(2);

    const m = ok(await w.mgr.c.get(`${F}?period=${w.month}`));
    expect(owners(m)).toEqual([[w.rep.userId, 'TRY', '1000.00', weighted, '0.00', weighted]]);
    expect(m.totals).toEqual([{ currency: 'TRY', count: 1, pipeline: '1000.00', weighted, won: '0.00', forecast: weighted }]);
    expect((m.opportunities as Json[]).map((o) => o.name)).toEqual(['Bakım']);
    expect(m).toMatchObject({ period: w.month, canSnapshot: true });
    expect(owners(ok(await w.other.c.get(`${F}?period=${w.month}`)))).toEqual([[w.other.userId, 'TRY', '2000.00', (2000 * p / 100).toFixed(2), '0.00', (2000 * p / 100).toFixed(2)]]);
    const own = ok(await w.rep.c.get(`${F}?period=${w.month}`));
    expect(own).toMatchObject({ canSnapshot: false, owners: [{ canAdjust: false }] });
    expect((ok(await w.c.get(`${F}?period=${w.quarter}`)).totals as Json[])[0]).toMatchObject({ count: 2, pipeline: '3000.00' });

    expect((await w.c.get(`${F}?period=2026-13`)).status).toBe(400);
    const analyst = await member(w.c, 'analyst');
    expect((await analyst.c.get(`${F}?period=${w.month}`)).status).toBe(403);
    const b2cOnly = await member(w.c, 'admin');
    ok(await w.c.put(`/v1/users/${b2cOnly.userId}/segments`, { segments: [{ segment: 'b2c' }] }));
    expect((await b2cOnly.c.get(`${F}?period=${w.month}`)).status).toBe(404);

    // Won in the period counts as won; the forecast is won + weighted.
    ok(await w.rep.c.post(`/v1/opportunities/${String(a.id)}/transition`, { transitionKey: 'win' }));
    expect(owners(ok(await w.mgr.c.get(`${F}?period=${w.month}`)))).toEqual([[w.rep.userId, 'TRY', '0.00', '0.00', '1000.00', '1000.00']]);
    // A lost one keeps a hand-set probability, yet it is not won (the stage decides).
    const lost = await opp(w.rep.c, { name: 'Kaybedilen', amount: '300', expectedClose: w.day });
    ok(await w.rep.c.patchJson(`/v1/opportunities/${String(lost.id)}`, { probability: 40 }, `"${String(lost.version)}"`));
    ok(await w.rep.c.post(`/v1/opportunities/${String(lost.id)}/transition`, { transitionKey: 'lose', fields: { wonLostReason: 'Fiyat' } }));
    expect(ok(await w.rep.c.get(`/v1/opportunities/${String(lost.id)}`))).toMatchObject({ probability: 40, status: { category: 'closed' } });
    expect(owners(ok(await w.mgr.c.get(`${F}?period=${w.month}`)))).toEqual([[w.rep.userId, 'TRY', '0.00', '0.00', '1000.00', '1000.00']]);
  });

  it('the Manager calls the forecast of their people; a reassigned opportunity moves to the new owner', async () => {
    const w = await setup();
    await opp(w.rep.c, { name: 'Bakım', amount: '1000', expectedClose: w.day });
    const moved = await opp(w.other.c, { name: 'Devredilecek', amount: '400', expectedClose: w.day });
    const body = { period: w.month, ownerId: w.rep.userId, currency: 'TRY', amount: '900', note: 'Müşteri bütçesi onaylandı' };
    expect((await w.rep.c.req('PUT', `${F}/adjustments`, body)).status).toBe(403);
    expect((await w.mgr.c.req('PUT', `${F}/adjustments`, { ...body, ownerId: w.mgr.userId })).status).toBe(403);
    expect((await w.mgr.c.req('PUT', `${F}/adjustments`, { ...body, ownerId: w.other.userId })).status).toBe(403);
    const adjusted = ok(await w.mgr.c.req('PUT', `${F}/adjustments`, body));
    expect((adjusted.owners as Json[])[0]).toMatchObject({ forecast: '900.00', canAdjust: true, adjustment: { amount: '900.00', note: 'Müşteri bütçesi onaylandı', updatedBy: { id: w.mgr.userId } } });
    expect((ok(await w.rep.c.get(`${F}?period=${w.month}`)).owners as Json[])[0]).toMatchObject({ forecast: '900.00' });

    // Reassigned to the Manager's rep: now in their forecast, out of the old owner's.
    ok(await w.c.req('PATCH', `/v1/opportunities/${String(moved.id)}`, { ownerUserId: w.rep.userId }, { 'if-match': `"${String(moved.version)}"` }));
    const after = ok(await w.mgr.c.get(`${F}?period=${w.month}`));
    expect((after.owners as Json[])[0]).toMatchObject({ pipeline: '1400.00', forecast: '900.00' });
    expect(ok(await w.other.c.get(`${F}?period=${w.month}`)).owners).toEqual([]);

    // Clearing the call returns to the computed figure.
    const cleared = ok(await w.mgr.c.req('PUT', `${F}/adjustments`, { ...body, amount: null }));
    expect((cleared.owners as Json[])[0]).toMatchObject({ adjustment: null });
    const audits = await sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'forecast.%' ORDER BY at`, [w.tenantId]);
    expect(audits.map((x) => x.action)).toEqual(['forecast.adjusted', 'forecast.adjustment_cleared']);
  });

  it('snapshots keep the figures of the moment; each viewer sees only their scope in them', async () => {
    const w = await setup();
    await opp(w.rep.c, { name: 'Bakım', amount: '1000', expectedClose: w.day });
    await opp(w.other.c, { name: 'Başka', amount: '2000', expectedClose: w.day });
    expect((await w.rep.c.post(`${F}/snapshots`, { period: w.month })).status).toBe(403);
    const s = ok(await w.c.post(`${F}/snapshots`, { period: w.month }), 201);
    expect(s).toMatchObject({ kind: 'manual', takenBy: { id: expect.any(String) }, totals: [{ pipeline: '3000.00' }] });
    await opp(w.rep.c, { name: 'Sonradan', amount: '500', expectedClose: w.day });
    expect(ok(await w.c.get(`${F}/snapshots?period=${w.month}`)).data).toMatchObject([{ id: s.id, totals: [{ pipeline: '3000.00' }] }]);
    const mine = ok(await w.rep.c.get(`${F}/snapshots?period=${w.month}`)).data as Json[];
    expect(mine[0]).toMatchObject({ totals: [{ pipeline: '1000.00' }] });
    expect((mine[0]?.owners as Json[]).map((o) => (o.owner as Json).id)).toEqual([w.rep.userId]);

    const made = await h.app.get(ForecastService).snapshotAll();
    expect(made).toBeGreaterThanOrEqual(2);
    const all = ok(await w.c.get(`${F}/snapshots?period=${w.month}`)).data as Json[];
    expect(all[0]).toMatchObject({ kind: 'scheduled', takenBy: null, totals: [{ pipeline: '3500.00' }] });
    const events = await sql(`SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'forecast.snapshot_taken'`, [w.tenantId]);
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Snapshots never change.
    const run = (text: string) => h.db.withTenant({ tenantId: w.tenantId, userId: w.rep.userId, segments: ['b2b'] }, (tx) => tx.execute(text)).then(() => 'changed', (e: unknown) => String((e as { cause?: Error }).cause?.message ?? e));
    expect(await run(`UPDATE forecast_snapshots SET period = '2020-01' WHERE id = '${String(s.id)}'`)).toMatch(/permission denied|append-only/);
  });
});

describe('activity rules (TRK-05)', () => {
  const backdate = (tenantId: string, id: string, days: number) => sql(`
    SET session_replication_role = replica;
    UPDATE activity_events SET occurred_at = now() - interval '${String(days)} days' WHERE tenant_id = '${tenantId}' AND record_id = '${id}';
    UPDATE opportunities SET created_at = now() - interval '${String(days)} days' WHERE id = '${id}';
    SET session_replication_role = origin;`);

  it('flags an untouched opportunity once per touch and alerts the owner and their Manager', async () => {
    const w = await setup();
    const o = await opp(w.rep.c, { name: 'Unutulan', amount: '100', expectedClose: w.day });
    const fresh = await opp(w.rep.c, { name: 'Taze', amount: '100' });
    await backdate(w.tenantId, String(o.id), 8);
    const pulse = ok(await w.rep.c.get(`/v1/sales/b2b/opportunities/${String(o.id)}/pulse`));
    expect(pulse).toMatchObject({ stale: true, idleDays: 8, staleDays: 7, nextStep: null, requireNextStep: false });
    expect(ok(await w.rep.c.get(`/v1/sales/b2b/opportunities/${String(fresh.id)}/pulse`))).toMatchObject({ stale: false, idleDays: 0 });
    const list = ok(await w.mgr.c.get('/v1/sales/b2b/opportunities/stale'));
    expect((list.data as Json[]).map((x) => x.id)).toEqual([o.id]);
    expect(ok(await w.other.c.get('/v1/sales/b2b/opportunities/stale')).data).toEqual([]);

    const svc = h.app.get(ForecastService);
    expect(await svc.scanStale()).toBeGreaterThanOrEqual(1);
    await svc.scanStale();
    const notes = await sql(`SELECT user_id::text AS u FROM notifications WHERE tenant_id = $1 AND source_type = 'stale_opportunity' ORDER BY user_id`, [w.tenantId]);
    expect(notes.map((n) => n.u).sort()).toEqual([w.mgr.userId, w.rep.userId].sort());
    const events = await sql(`SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'opportunity.stale'`, [w.tenantId]);
    expect(events).toHaveLength(1);

    // A comment is a touch: no longer untouched.
    ok(await w.rep.c.post(`/v1/opportunities/${String(o.id)}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Aradım, haftaya dönüş yapacak.' }] }] } }), 201);
    expect(ok(await w.rep.c.get(`/v1/sales/b2b/opportunities/${String(o.id)}/pulse`))).toMatchObject({ stale: false, idleDays: 0 });
  });

  it('when the tenant asks for it, another open stage needs an open next-step task', async () => {
    const w = await setup();
    const o = await opp(w.rep.c, { name: 'Adımlı', amount: '100' });
    ok(await w.c.req('PUT', '/v1/config/sales_b2b.activity_rules?scope=tenant', { value: { staleDays: 14, requireNextStep: true } }, { 'if-match': '0' }));
    const blocked = await w.rep.c.post(`/v1/opportunities/${String(o.id)}/transition`, { transitionKey: 'to_proposal' });
    expect(blocked.body.code).toBe('NEXT_STEP_REQUIRED');
    expect(blocked.status).toBe(422);
    const task = ok(await w.rep.c.post('/v1/tasks', { title: 'Teklif sunumu', related: { type: 'opportunity', id: o.id }, dueAt: '2099-01-01T09:00:00.000Z' }), 201);
    ok(await w.rep.c.post(`/v1/opportunities/${String(o.id)}/transition`, { transitionKey: 'to_proposal' }));
    expect(ok(await w.rep.c.get(`/v1/sales/b2b/opportunities/${String(o.id)}/pulse`))).toMatchObject({ staleDays: 14, requireNextStep: true, nextStep: { id: task.id, title: 'Teklif sunumu' } });
    // Closing needs no next step.
    ok(await w.rep.c.post(`/v1/opportunities/${String(o.id)}/transition`, { transitionKey: 'win' }));
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { ApprovalsService } from '../src/modules/approvals/approvals.service';
import { TargetsService } from '../src/modules/approvals/targets.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P8b (docs/p8-plan.md §7–10, ADR-0021): approval routing, limits, escalation; sales targets.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(SUPER(), text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const rows = (b: Json): Json[] => b.data as Json[];
interface Member { c: Client; userId: string }

async function workspace() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2b', 'sales_tracking']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const adminId = String((ok(await admin.c.get('/v1/me')).user as Json).id);
  return { ...admin, adminId };
}

async function member(admin: Client, role: string, opts: { segments?: string[]; teamId?: string; teamRole?: string } = {}): Promise<Member> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  if (opts.segments) ok(await admin.put(`/v1/users/${userId}/segments`, { segments: opts.segments.map((segment) => ({ segment })) }));
  if (opts.teamId) ok(await admin.put(`/v1/teams/${opts.teamId}/members/${userId}`, { role: opts.teamRole ?? 'member' }));
  return { c, userId };
}

const team = async (c: Client, name: string, parentTeamId?: string) => String(ok(await c.post('/v1/teams', { name, ...(parentTeamId ? { parentTeamId } : {}) }), 201).id);
const opportunity = async (c: Client, extra: Json = {}) => String(ok(await c.post('/v1/opportunities', { name: 'Filo anlaşması', segment: 'b2b', amount: '1000', currency: 'TRY', ...extra }), 201).id);
const ask = (c: Client, id: string, percent: string) => c.post('/v1/approvals', { kind: 'discount', subject: { type: 'opportunity', id }, percent, reason: 'Rakip teklifi' });
const inbox = async (c: Client) => rows(ok(await c.get('/v1/approvals')));
const notes = async (c: Client) => rows(ok(await c.get('/v1/notifications'))).filter((n) => n.kind === 'approval');
const overdue = (id: string) => sql(`UPDATE approval_requests SET due_at = now() - interval '1 minute' WHERE id = $1`, [id]);

/** Field team (its manager, two reps) under Sales (its own manager). */
async function hierarchy() {
  const w = await workspace();
  const sales = await team(w.c, 'Satış');
  const field = await team(w.c, 'Saha', sales);
  const director = await member(w.c, 'manager', { teamId: sales, teamRole: 'manager' });
  const lead = await member(w.c, 'manager', { teamId: field, teamRole: 'manager' });
  const rep = await member(w.c, 'sales_rep', { teamId: field });
  const peer = await member(w.c, 'sales_rep', { teamId: field });
  return { ...w, sales, field, director, lead, rep, peer };
}

describe('discount approval (G3)', () => {
  it('within the free discount it is approved at once; above it goes to the manager of the primary team', async () => {
    const w = await hierarchy();
    const opp = await opportunity(w.rep.c);
    expect(ok(await ask(w.rep.c, opp, '8'), 201)).toMatchObject({ state: 'approved', automatic: true, decidedBy: null });
    const r = ok(await ask(w.rep.c, opp, '12.5'), 201);
    expect(r).toMatchObject({ state: 'pending', assignedTo: { id: w.lead.userId }, percent: '12.50', canDecide: false });
    expect((await ask(w.rep.c, opp, '13')).status).toBe(409);

    expect(await inbox(w.lead.c)).toEqual([expect.objectContaining({ id: r.id, canDecide: true })]);
    expect(await inbox(w.director.c)).toEqual([]);
    expect((await notes(w.lead.c)).map((n) => (n.source as Json).type)).toEqual(['approval_request']);
    // Others: the peer and the director do not see it; the requester sees it but cannot decide it.
    expect((await w.peer.c.get(`/v1/approvals/${String(r.id)}`)).status).toBe(404);
    expect((await w.director.c.post(`/v1/approvals/${String(r.id)}/decision`, { decision: 'approve' })).status).toBe(404);
    expect((await w.rep.c.post(`/v1/approvals/${String(r.id)}/decision`, { decision: 'approve' })).body).toMatchObject({ code: 'MANAGER_LIMIT', reason: 'not_self' });

    const done = ok(await w.lead.c.post(`/v1/approvals/${String(r.id)}/decision`, { decision: 'approve', note: 'Uygun' }));
    expect(done).toMatchObject({ state: 'approved', decidedBy: { id: w.lead.userId }, decisionNote: 'Uygun' });
    expect((done.steps as Json[]).map((s) => s.action)).toEqual(['requested', 'assigned', 'approved']);
    expect((await notes(w.rep.c)).map((n) => (n.source as Json).type)).toEqual(['approval_decision']);
    expect((await w.lead.c.post(`/v1/approvals/${String(r.id)}/decision`, { decision: 'reject' })).body.code).toBe('REQUEST_CLOSED');
    const events = await sql(`SELECT type, payload FROM outbox_events WHERE tenant_id = $1 AND (type LIKE 'approval.%' OR type LIKE 'discount.%') ORDER BY id`, [w.tenantId]);
    expect(events.map((e) => e.type)).toEqual(['approval.requested', 'discount.approval_requested', 'approval.decided', 'approval.requested', 'discount.approval_requested', 'approval.decided']);
    expect(JSON.stringify(events)).not.toMatch(/12\.5|Rakip/);
    expect(rows(ok(await w.rep.c.get(`/v1/approvals?box=subject&subjectType=opportunity&subjectId=${opp}`)))).toHaveLength(2);
    expect((await w.peer.c.get(`/v1/approvals?box=subject&subjectType=opportunity&subjectId=${opp}`)).status).toBe(404);
  });

  it('a manager whose limit does not cover it is never asked; own limits replace the default; Admin decides the rest', async () => {
    const w = await hierarchy();
    ok(await w.c.put(`/v1/approvals/limits/${w.director.userId}`, { maxPercent: '30' }), 204);
    expect((await w.lead.c.put(`/v1/approvals/limits/${w.lead.userId}`, { maxPercent: '90' })).status).toBe(403);
    const first = ok(await ask(w.rep.c, await opportunity(w.rep.c), '20'), 201);
    expect(first.assignedTo).toMatchObject({ id: w.director.userId });
    const big = ok(await ask(w.rep.c, await opportunity(w.rep.c), '45'), 201);
    expect(big.assignedTo).toBeNull();
    expect((await inbox(w.c)).map((x) => x.id)).toEqual([big.id]);
    // Not assigned, not visible: a manager below the limit cannot decide even with the id.
    expect((await w.lead.c.post(`/v1/approvals/${String(first.id)}/decision`, { decision: 'approve' })).status).toBe(404);
    // The limit is checked again at decision time (lowered meanwhile); rejecting stays possible.
    ok(await w.c.put(`/v1/approvals/limits/${w.director.userId}`, { maxPercent: '10' }), 204);
    expect((await inbox(w.director.c))[0]).toMatchObject({ id: first.id, canDecide: false });
    expect((await w.director.c.post(`/v1/approvals/${String(first.id)}/decision`, { decision: 'approve' })).body).toMatchObject({ code: 'MANAGER_LIMIT', reason: 'approve_within_limit', limit: 10 });
    expect(ok(await w.director.c.post(`/v1/approvals/${String(first.id)}/decision`, { decision: 'reject' })).state).toBe('rejected');
    expect(ok(await w.c.post(`/v1/approvals/${String(big.id)}/decision`, { decision: 'approve' })).state).toBe('approved');
    const limits = rows(ok(await w.c.get('/v1/approvals/limits')));
    expect(limits.find((l) => (l.user as Json).id === w.lead.userId)).toMatchObject({ maxPercent: null, effectivePercent: '15' });
  });

  it('a manager’s own request skips themselves; within their limit it needs no approval; an Admin has no limit', async () => {
    const w = await hierarchy();
    ok(await w.c.put(`/v1/approvals/limits/${w.director.userId}`, { maxPercent: '40' }), 204);
    expect(ok(await ask(w.lead.c, await opportunity(w.lead.c), '15'), 201)).toMatchObject({ automatic: true });
    expect(ok(await ask(w.lead.c, await opportunity(w.lead.c), '25'), 201).assignedTo).toMatchObject({ id: w.director.userId });
    expect(ok(await ask(w.director.c, await opportunity(w.director.c), '41'), 201).assignedTo).toBeNull();
    expect(ok(await ask(w.c, await opportunity(w.c), '99'), 201)).toMatchObject({ automatic: true });
    // Nobody but the requester holds the team: no one to ask there, so the Admins.
    const alone = await member(w.c, 'sales_rep');
    expect(ok(await ask(alone.c, await opportunity(alone.c), '12'), 201).assignedTo).toBeNull();
  });

  it('a manager who cannot see the opportunity is passed over', async () => {
    const w = await hierarchy();
    ok(await w.c.put(`/v1/users/${w.lead.userId}/segments`, { segments: [{ segment: 'b2c' }] }));
    expect(ok(await ask(w.rep.c, await opportunity(w.rep.c), '12'), 201).assignedTo).toMatchObject({ id: w.director.userId });
  });

  it('who may ask: the record must be editable, in B2B, with the module on; the policy values are validated', async () => {
    const w = await hierarchy();
    const opp = await opportunity(w.rep.c);
    expect((await ask(w.peer.c, opp, '10')).status).toBe(404);
    const analyst = await member(w.c, 'analyst');
    expect((await ask(analyst.c, opp, '10')).status).toBe(403);
    expect((await ask(w.c, await opportunity(w.c, { segment: 'b2c' }), '10')).body.code).toBe('SEGMENT_NOT_ALLOWED');
    for (const p of ['0', '100.01', '-1', 'abc']) expect((await ask(w.rep.c, opp, p)).status).toBe(400);
    const bad = await w.c.req('PUT', '/v1/config/approvals?scope=tenant', { value: { discount: { freePercent: 20, managerPercent: 10, timeoutHours: 24 } } }, { 'if-match': '0' });
    expect(bad.body.code).toBe('CONFIG_INVALID');
    ok(await w.c.req('PUT', '/v1/config/approvals?scope=tenant', { value: { discount: { freePercent: 2, managerPercent: 10, timeoutHours: 1 } } }, { 'if-match': '0' }));
    expect(ok(await ask(w.rep.c, opp, '5'), 201)).toMatchObject({ state: 'pending', assignedTo: { id: w.lead.userId } });
    ok(await w.c.post('/v1/modules/sales_tracking/disable'));
    ok(await w.c.post('/v1/modules/sales_b2b/disable'));
    expect((await ask(w.rep.c, opp, '5')).body.code).toBe('MODULE_DISABLED');
  });

  it('withdrawing: only the requester, and the approver’s notice goes away; a new request may follow', async () => {
    const w = await hierarchy();
    const opp = await opportunity(w.rep.c);
    const r = ok(await ask(w.rep.c, opp, '12'), 201);
    expect(await notes(w.lead.c)).toHaveLength(1);
    expect((await w.lead.c.post(`/v1/approvals/${String(r.id)}/cancel`)).status).toBe(403);
    expect(ok(await w.rep.c.post(`/v1/approvals/${String(r.id)}/cancel`)).state).toBe('cancelled');
    expect(await notes(w.lead.c)).toEqual([]);
    expect((await w.rep.c.post(`/v1/approvals/${String(r.id)}/cancel`)).body.code).toBe('REQUEST_CLOSED');
    ok(await ask(w.rep.c, opp, '11'), 201);
  });

  it('past the deadline it moves up the teams, then to the Admins, then expires; running twice changes nothing', async () => {
    const w = await hierarchy();
    const svc = h.app.get(ApprovalsService);
    const r = ok(await ask(w.rep.c, await opportunity(w.rep.c), '12'), 201);
    const id = String(r.id);
    await svc.runDue();
    expect(ok(await w.rep.c.get(`/v1/approvals/${id}`))).toMatchObject({ level: 1, assignedTo: { id: w.lead.userId } });
    await overdue(id);
    await Promise.all([svc.runDue(), svc.runDue()]);
    expect(ok(await w.rep.c.get(`/v1/approvals/${id}`))).toMatchObject({ level: 2, assignedTo: { id: w.director.userId }, state: 'pending' });
    // The lead no longer decides it and lost the unread notice.
    expect(await inbox(w.lead.c)).toEqual([]);
    expect(await notes(w.lead.c)).toEqual([]);
    expect((await w.lead.c.post(`/v1/approvals/${id}/decision`, { decision: 'approve' })).status).toBe(404);
    expect(await notes(w.director.c)).toHaveLength(1);
    await overdue(id);
    await svc.runDue();
    expect(ok(await w.rep.c.get(`/v1/approvals/${id}`))).toMatchObject({ level: 3, assignedTo: null, state: 'pending' });
    expect((await inbox(w.c)).map((x) => x.id)).toEqual([id]);
    await overdue(id);
    await svc.runDue();
    const end = ok(await w.rep.c.get(`/v1/approvals/${id}`));
    expect(end).toMatchObject({ state: 'expired', decidedBy: null });
    expect((end.steps as Json[]).map((s) => s.action)).toEqual(['requested', 'assigned', 'escalated', 'escalated', 'expired']);
    expect((await w.c.post(`/v1/approvals/${id}/decision`, { decision: 'approve' })).body.code).toBe('REQUEST_CLOSED');
    expect((await notes(w.rep.c)).map((n) => (n.source as Json).type)).toEqual(['approval_decision']);
  });

  it('bulk decisions report each result; another workspace reaches nothing', async () => {
    const w = await hierarchy();
    const a = String(ok(await ask(w.rep.c, await opportunity(w.rep.c), '12'), 201).id);
    const b = String(ok(await ask(w.rep.c, await opportunity(w.rep.c), '14'), 201).id);
    const c = String(ok(await ask(w.rep.c, await opportunity(w.rep.c), '60'), 201).id);
    const res = rows(ok(await w.lead.c.post('/v1/approvals/decisions', { ids: [a, b, c], decision: 'approve' })));
    expect(res).toEqual([{ id: a, ok: true, code: null }, { id: b, ok: true, code: null }, { id: c, ok: false, code: 'NOT_FOUND' }]);
    const other = await workspace();
    expect((await other.c.get(`/v1/approvals/${c}`)).status).toBe(404);
    expect(rows(ok(await other.c.get('/v1/approvals?box=all')))).toEqual([]);
    expect((await other.c.post(`/v1/approvals/${c}/decision`, { decision: 'approve' })).status).toBe(404);
    expect((await other.c.put(`/v1/approvals/limits/${w.lead.userId}`, { maxPercent: '50' })).status).toBe(404);
    expect((await ask(other.c, await opportunity(w.rep.c), '5')).status).toBe(404);
  });
});

describe('sales targets (TRK-02)', () => {
  // The period as the workspace (Europe/Istanbul) sees it.
  const monthStart = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)}-01`;
  const target = (subject: Json, extra: Json = {}) => ({ subject, period: 'month', periodStart: monthStart, metric: 'won_amount', targetValue: '1000', ...extra });
  async function win(c: Client, extra: Json = {}): Promise<string> {
    const id = await opportunity(c, extra);
    for (const transitionKey of ['to_qualification', 'to_proposal', 'to_negotiation', 'win']) {
      const r = await c.post(`/v1/opportunities/${id}/transition`, { transitionKey });
      if (r.status === 200 && (r.body.status as Json).category === 'closed') return id;
    }
    ok(await c.post(`/v1/opportunities/${id}/transition`, { transitionKey: 'win' }));
    return id;
  }

  it('counts won opportunities and closed tasks of a person and a team with sub-teams; other currencies are reported, not added', async () => {
    const w = await hierarchy();
    await win(w.rep.c, { amount: '400' });
    await win(w.peer.c, { amount: '250' });
    await win(w.rep.c, { amount: '70', currency: 'USD' });
    await opportunity(w.rep.c, { amount: '9999' }); // still open
    const t1 = ok(await w.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId })), 201);
    expect(t1).toMatchObject({ actual: '400', otherCurrencyCount: 1, progressPercent: 40, currency: 'TRY', canEdit: true });
    expect(ok(await w.c.post('/v1/targets', target({ type: 'team', id: w.sales })), 201)).toMatchObject({ actual: '650', progressPercent: 65 });
    expect(ok(await w.c.post('/v1/targets', target({ type: 'segment' }, { segment: 'b2b', metric: 'won_count', targetValue: '4' })), 201)).toMatchObject({ actual: '3', progressPercent: 75 });
    const task = ok(await w.rep.c.post('/v1/tasks', { title: 'Ara' }), 201);
    const wf = rows(ok(await w.rep.c.get('/v1/workflows'))).find((x) => x.resourceType === 'task' && x.isDefault);
    const closed = (wf?.statuses as Json[]).find((s) => s.category === 'closed');
    ok(await w.rep.c.post(`/v1/tasks/${String(task.id)}/transition`, { toStatusId: closed?.id }));
    expect(ok(await w.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId }, { metric: 'tasks_closed', targetValue: '2' })), 201)).toMatchObject({ actual: '1', progressPercent: 50 });
    expect((await w.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId }))).status).toBe(409);
  });

  it('who sees and sets what: own, managed team, all; a Manager never sets their own; segments hide targets', async () => {
    const w = await hierarchy();
    const analyst = await member(w.c, 'analyst');
    const b2bRep = await member(w.c, 'sales_rep', { segments: ['b2b'], teamId: w.field });
    ok(await w.lead.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId })), 201);
    ok(await w.lead.c.post('/v1/targets', target({ type: 'team', id: w.field })), 201);
    expect((await w.lead.c.post('/v1/targets', target({ type: 'user', id: w.lead.userId }))).body).toMatchObject({ code: 'MANAGER_LIMIT', reason: 'not_self' });
    expect((await w.lead.c.post('/v1/targets', target({ type: 'user', id: w.director.userId }))).body.reason).toBe('managed_teams_only');
    expect((await w.lead.c.post('/v1/targets', target({ type: 'team', id: w.sales }))).status).toBe(403);
    expect((await w.lead.c.post('/v1/targets', target({ type: 'segment' }, { segment: 'b2b' }))).status).toBe(403);
    expect((await w.rep.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId }))).status).toBe(403);
    ok(await w.c.post('/v1/targets', target({ type: 'user', id: b2bRep.userId }, { segment: 'b2c' })), 201);
    const seen = async (c: Client) => rows(ok(await c.get('/v1/targets'))).length;
    expect(await seen(w.rep.c)).toBe(1);
    expect(await seen(w.peer.c)).toBe(0);
    expect(await seen(b2bRep.c)).toBe(0); // their target is in a segment they do not have
    expect(await seen(w.lead.c)).toBe(3);
    expect(await seen(w.director.c)).toBe(3);
    expect(await seen(analyst.c)).toBe(3);
    const mine = rows(ok(await w.rep.c.get('/v1/targets')))[0]!;
    expect(mine.canEdit).toBe(false);
    expect((await w.rep.c.patchJson(`/v1/targets/${String(mine.id)}`, { targetValue: '1' }, '"1"')).status).toBe(403);
    expect((await w.peer.c.patchJson(`/v1/targets/${String(mine.id)}`, { targetValue: '1' }, '"1"')).status).toBe(404);
    expect(ok(await w.lead.c.patchJson(`/v1/targets/${String(mine.id)}`, { targetValue: '2000' }, '"1"')).targetValue).toBe('2000');
    expect((await w.lead.c.patchJson(`/v1/targets/${String(mine.id)}`, { targetValue: '3000' }, '"1"')).status).toBe(412);
    const other = await workspace();
    expect((await other.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId }))).status).toBe(400);
    expect((await other.c.del(`/v1/targets/${String(mine.id)}`)).status).toBe(404);
    expect(rows(ok(await other.c.get('/v1/targets')))).toEqual([]);
    ok(await w.lead.c.del(`/v1/targets/${String(mine.id)}`), 204);
    for (const bad of [{ periodStart: monthStart.replace('-01', '-02') }, { period: 'quarter', periodStart: '2026-02-01' }, { metric: 'won_count', currency: 'TRY' }, { targetValue: '0' }]) {
      expect((await w.c.post('/v1/targets', target({ type: 'user', id: w.rep.userId }, bad))).status).toBe(400);
    }
    ok(await w.c.post('/v1/modules/sales_tracking/disable'));
    expect((await w.c.get('/v1/targets')).body.code).toBe('MODULE_DISABLED');
  });

  it('a target far behind its pace is announced once, to the person and their managers', async () => {
    const w = await hierarchy();
    const svc = h.app.get(TargetsService);
    // Nothing sold this quarter: at risk once a quarter of it has passed (earlier runs check the opposite).
    const [s] = await sql(`INSERT INTO sales_targets (tenant_id, subject_type, user_id, period, period_start, metric, target_value, currency, created_by)
      VALUES ($1, 'user', $2, 'quarter', date_trunc('quarter', now() AT TIME ZONE 'Europe/Istanbul')::date, 'won_amount', 1000, 'TRY', $3) RETURNING id`, [w.tenantId, w.rep.userId, w.adminId]);
    const view = rows(ok(await w.c.get('/v1/targets')))[0]!;
    const expected = Number(view.elapsedPercent) >= 25;
    expect(view.atRisk).toBe(expected);
    await svc.scanRisk();
    await svc.scanRisk();
    const events = await sql(`SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'target.at_risk'`, [w.tenantId]);
    expect(events).toHaveLength(expected ? 1 : 0);
    if (!expected) return;
    expect(events[0]).toMatchObject({ payload: { targetId: s?.id, progress: 0 } });
    const got = async (c: Client) => rows(ok(await c.get('/v1/notifications'))).filter((n) => (n.record as Json | null)?.type === 'target').length;
    expect([await got(w.rep.c), await got(w.lead.c), await got(w.director.c), await got(w.peer.c)]).toEqual([1, 1, 1, 0]);
  });
});

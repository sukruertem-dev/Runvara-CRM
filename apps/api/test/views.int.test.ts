import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P6b API (docs/p6-plan.md §7): aggregation with the list's scope and field security, dependency edges for
// Gantt, saved views (private / workspace), personal dashboard layout.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

async function member(admin: Client, role: string): Promise<{ c: Client; userId: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return { c, userId: (l.user as { id: string }).id };
}

const groups = (body: Json) => Object.fromEntries((body.data as { key: string | null; count: number; sum?: string }[]).map((g) => [g.key ?? 'null', g.sum ?? g.count]));

describe('aggregate', () => {
  it('counts and sums exactly what the caller may list, honouring field security', async () => {
    const { c: admin } = await signupAndLogin(h);
    ok(await admin.post('/v1/modules/crm/enable'));
    const rep = await member(admin, 'sales_rep');
    for (const [title, priority, estimate] of [['A', 4, 30], ['B', 4, 60], ['C', 1, 15]] as const) {
      ok(await admin.post('/v1/tasks', { title, priority, estimateMinutes: estimate }), 201);
    }
    ok(await rep.c.post('/v1/tasks', { title: 'Temsilcinin', priority: 2, estimateMinutes: 5 }), 201);

    const byPriority = ok(await admin.get('/v1/tasks/aggregate?groupBy=priority'));
    expect(groups(byPriority)).toEqual({ '4': 2, '1': 1, '2': 1 });
    expect(byPriority.total).toBe(4);
    expect(groups(ok(await admin.get(`/v1/tasks/aggregate?groupBy=priority&metric=sum:estimate&q=${encodeURIComponent('priority >= 2')}`)))).toEqual({ '4': '90', '2': '5' });
    const byDay = ok(await admin.get('/v1/tasks/aggregate?groupBy=created&interval=day')).data as { key: string }[];
    expect(byDay[0]?.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A rep with own scope counts only own tasks.
    expect(ok(await rep.c.get('/v1/tasks/aggregate')).total).toBe(1);

    for (const [q, code] of [['groupBy=nope', 'UNKNOWN_FIELD'], ['metric=sum:title', 'VALIDATION_FAILED'], ['metric=avg:x', 'VALIDATION_FAILED'], ['groupBy=created&interval=year', 'VALIDATION_FAILED'], ['q=' + encodeURIComponent('priority >'), 'RQL_SYNTAX']] as const) {
      expect((await admin.get(`/v1/tasks/aggregate?${q}`)).body.code, q).toBe(code);
    }

    // Opportunities: pipeline totals; a hidden amount cannot be summed or grouped by the rep.
    ok(await rep.c.post('/v1/opportunities', { name: 'Lisans', segment: 'b2b', amount: '1000' }), 201);
    ok(await rep.c.post('/v1/opportunities', { name: 'Destek', segment: 'b2b', amount: '250.50' }), 201);
    const totals = ok(await admin.get('/v1/opportunities/aggregate?groupBy=status&metric=sum:amount')).data as { sum: string; count: number }[];
    expect(totals.reduce((n, g) => n + Number(g.sum), 0)).toBeCloseTo(1250.5);
    const roles = ok(await admin.get('/v1/roles')).data as Json[];
    ok(await admin.put('/v1/field-policies', { roleId: String(roles.find((r) => r.key === 'sales_rep')!.id), resourceType: 'opportunity', field: 'amount', access: 'hidden' }));
    expect((await rep.c.get('/v1/opportunities/aggregate?metric=sum:amount')).body.code).toBe('UNKNOWN_FIELD');
    expect((await rep.c.get('/v1/opportunities/aggregate?groupBy=amount')).body.code).toBe('UNKNOWN_FIELD');
    expect(ok(await rep.c.get('/v1/opportunities/aggregate')).total).toBe(2);
  });
});

describe('dependency edges', () => {
  it('returns only edges whose both ends the caller can read', async () => {
    const { c: admin } = await signupAndLogin(h);
    const rep = await member(admin, 'sales_rep');
    const a = ok(await rep.c.post('/v1/tasks', { title: 'A' }), 201);
    const b = ok(await rep.c.post('/v1/tasks', { title: 'B' }), 201);
    const hidden = ok(await admin.post('/v1/tasks', { title: 'Gizli' }), 201);
    ok(await rep.c.post(`/v1/tasks/${String(b.id)}/dependencies`, { blockerId: a.id }), 201);
    ok(await admin.post(`/v1/tasks/${String(b.id)}/dependencies`, { blockerId: hidden.id }), 201);
    const ids = [a.id, b.id, hidden.id].join(',');
    expect(ok(await admin.get(`/v1/task-dependencies?ids=${ids}`)).data).toHaveLength(2);
    expect(ok(await rep.c.get(`/v1/task-dependencies?ids=${ids}`)).data).toEqual([{ blockerId: a.id, blockedId: b.id }]);
    expect((await rep.c.get('/v1/task-dependencies?ids=x')).status).toBe(400);
  });
});

describe('saved views', () => {
  it('private and workspace views, owner-only writes, validated queries, optimistic concurrency', async () => {
    const { c: admin } = await signupAndLogin(h);
    const rep = await member(admin, 'sales_rep');
    const mine = ok(await admin.post('/v1/views', { resourceType: 'task', name: 'Acil işler', viewType: 'board', query: 'priority >= 3', sort: '-due', config: { swimlane: 'assignee' } }), 201);
    expect(mine).toMatchObject({ visibility: 'private', mine: true, version: 1 });
    const shared = ok(await admin.post('/v1/views', { resourceType: 'task', name: 'Ekip', viewType: 'table', visibility: 'workspace' }), 201);

    expect((await admin.post('/v1/views', { resourceType: 'task', name: 'acil işler', viewType: 'list' })).status).toBe(409);
    expect((await admin.post('/v1/views', { resourceType: 'task', name: 'Bozuk', viewType: 'list', query: 'nope = 1' })).body.code).toBe('UNKNOWN_FIELD');
    expect((await admin.post('/v1/views', { resourceType: 'task', name: 'Bozuk sıralama', viewType: 'list', sort: 'nope' })).body.code).toBe('UNKNOWN_FIELD');
    expect((await rep.c.post('/v1/views', { resourceType: 'task', name: 'Herkese', viewType: 'list', visibility: 'workspace' })).status).toBe(403);
    ok(await rep.c.post('/v1/views', { resourceType: 'task', name: 'Benim', viewType: 'list' }), 201);

    const repSees = (ok(await rep.c.get('/v1/views?resource=task')).data as Json[]).map((v) => v.name).sort();
    expect(repSees).toEqual(['Benim', 'Ekip']);
    expect((await rep.c.req('PATCH', `/v1/views/${String(shared.id)}`, { name: 'Ele geçir' }, { 'if-match': '"1"' })).status).toBe(404);
    expect((await rep.c.del(`/v1/views/${String(shared.id)}`)).status).toBe(404);

    const renamed = ok(await admin.req('PATCH', `/v1/views/${String(mine.id)}`, { name: 'Çok acil', query: 'priority = 4' }, { 'if-match': '"1"' }));
    expect(renamed).toMatchObject({ name: 'Çok acil', query: 'priority = 4', version: 2 });
    expect((await admin.req('PATCH', `/v1/views/${String(mine.id)}`, { name: 'Eski' }, { 'if-match': '"1"' })).status).toBe(412);
    expect((await admin.del(`/v1/views/${String(mine.id)}`)).status).toBe(204);
    expect((await admin.get('/v1/views?resource=nope')).status).toBe(400);
  });
});

describe('personal dashboard', () => {
  it('starts from a default layout, saves per user and hides widgets of disabled modules', async () => {
    const { c: admin } = await signupAndLogin(h);
    const first = ok(await admin.get('/v1/me/dashboard'));
    const kinds = (first.widgets as Json[]).map((w) => w.kind);
    expect(kinds).toContain('tasks_by_status');
    expect(kinds).not.toContain('pipeline_funnel'); // CRM is off
    ok(await admin.post('/v1/modules/crm/enable'));
    expect((ok(await admin.get('/v1/me/dashboard')).widgets as Json[]).map((w) => w.kind)).toContain('pipeline_funnel');

    const saved = ok(await admin.put('/v1/me/dashboard', { widgets: [{ id: 'k', kind: 'kpi_open_tasks', x: 0, y: 0, w: 4, h: 2 }] }));
    expect(saved.version).toBe(1);
    expect((ok(await admin.get('/v1/me/dashboard')).widgets as Json[]).map((w) => w.id)).toEqual(['k']);
    expect((await admin.put('/v1/me/dashboard', { widgets: [{ id: 'k', kind: 'kpi_open_tasks', x: 0, y: 0, w: 4, h: 2 }, { id: 'k', kind: 'burndown', x: 4, y: 0, w: 4, h: 2 }] })).status).toBe(400);
    expect((await admin.put('/v1/me/dashboard', { widgets: [{ id: 'x', kind: 'nope', x: 0, y: 0, w: 1, h: 1 }] })).status).toBe(400);

    const rep = await member(admin, 'sales_rep');
    expect((ok(await rep.c.get('/v1/me/dashboard')).widgets as Json[]).length).toBeGreaterThan(1);
  });
});

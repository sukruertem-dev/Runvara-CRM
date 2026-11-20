import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;

async function member(admin: Client, role: string): Promise<{ c: Client; userId: string }> {
  const email = `${uniq(role)}@firma.test`;
  const inv = await admin.post('/v1/invitations', { email, roleKey: role });
  expect(inv.status).toBe(201);
  const c = new Client(h.app);
  await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role });
  const l = await c.post('/v1/auth/login', { email, password: PASSWORD });
  return { c, userId: (l.body.user as { id: string }).id };
}

async function task(c: Client, body: Json = {}): Promise<Json> {
  const r = await c.post('/v1/tasks', { title: uniq('Görev '), ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe('task CRUD, optimistic locking and the workflow engine (Faz 2 kabul: geçiş reddi/kaydı)', () => {
  it('new tenants get the default workflow; tasks start in its initial status with a position', async () => {
    const { c } = await signupAndLogin(h);
    const wfs = await c.get('/v1/workflows');
    const wf = (wfs.body.data as Json[])[0]!;
    expect((wf.statuses as Json[]).map((s) => s.key)).toEqual(['todo', 'in_progress', 'done', 'canceled']);
    const t = await task(c, { priority: 3 });
    expect(t).toMatchObject({ status: { key: 'todo', category: 'open' }, priority: 3, version: 1, depth: 0 });
    expect(typeof t.position).toBe('string');
    const g = await c.get(`/v1/tasks/${String(t.id)}`);
    expect(g.headers.etag).toBe('"1"');
  });

  it('PATCH needs If-Match (428), rejects stale versions (412) and status changes (409)', async () => {
    const { c } = await signupAndLogin(h);
    const t = await task(c);
    const url = `/v1/tasks/${String(t.id)}`;
    expect((await c.patchJson(url, { title: 'x' })).status).toBe(428);
    expect((await c.patchJson(url, { title: 'x' }, '"7"')).status).toBe(412);
    expect((await c.patchJson(url, { statusId: t.id }, '"1"')).body.code).toBe('USE_TRANSITION_ENDPOINT');
    const ok = await c.patchJson(url, { title: 'Yeni başlık', dueAt: '2026-12-01T09:00:00Z' }, '"1"');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Yeni başlık', version: 2, dueAt: '2026-12-01T09:00:00.000Z' });
    expect(ok.headers.etag).toBe('"2"');
  });

  it('rejects an undefined transition with the allowed list, records a valid one, enforces validators', async () => {
    const { c } = await signupAndLogin(h);
    const parent = await task(c);
    const child = await task(c, { parentId: parent.id });
    const bad = await c.post(`/v1/tasks/${String(parent.id)}/transition`, { transitionKey: 'reopen' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('WORKFLOW_TRANSITION_NOT_ALLOWED');
    expect((bad.body.allowed as string[]).sort()).toEqual(['cancel', 'finish', 'start']);
    const start = await c.post(`/v1/tasks/${String(parent.id)}/transition`, { transitionKey: 'start' });
    expect(start.body).toMatchObject({ status: { key: 'in_progress' }, version: 2, closedAt: null });
    const blocked = await c.post(`/v1/tasks/${String(parent.id)}/transition`, { transitionKey: 'complete' });
    expect(blocked.body.code).toBe('WORKFLOW_VALIDATION_FAILED');
    await c.post(`/v1/tasks/${String(child.id)}/transition`, { transitionKey: 'finish' });
    const done = await c.post(`/v1/tasks/${String(parent.id)}/transition`, { transitionKey: 'complete' });
    expect(done.body).toMatchObject({ status: { key: 'done', category: 'closed' } });
    expect(done.body.closedAt).toEqual(expect.any(String));
    const sub = await c.get(`/v1/tasks/${String(parent.id)}/subtasks`);
    expect(sub.body.progress).toEqual({ total: 1, closed: 1, percent: 100 });
  });

  it('limits sub-task depth to 5 and refuses ancestry cycles', async () => {
    const { c } = await signupAndLogin(h);
    let parent = await task(c);
    const root = parent;
    for (let i = 1; i <= 5; i++) parent = await task(c, { parentId: parent.id });
    expect(parent.depth).toBe(5);
    const tooDeep = await c.post('/v1/tasks', { title: 'çok derin', parentId: parent.id });
    expect(tooDeep.body.code).toBe('SUBTASK_DEPTH_EXCEEDED');
    const leaf = await task(c);
    const rootFresh = await c.get(`/v1/tasks/${String(root.id)}`);
    const move = await c.patchJson(`/v1/tasks/${String(root.id)}`, { parentId: leaf.id }, `"${String(rootFresh.body.version)}"`);
    expect(move.body.code).toBe('SUBTASK_MOVE_WITH_CHILDREN');
  });

  it('soft delete hides the task; restore brings it back', async () => {
    const { c } = await signupAndLogin(h);
    const t = await task(c);
    expect((await c.deleteWithIfMatch(`/v1/tasks/${String(t.id)}`, '"1"')).status).toBe(204);
    expect((await c.get(`/v1/tasks/${String(t.id)}`)).status).toBe(404);
    const r = await c.post(`/v1/tasks/${String(t.id)}/restore`);
    expect(r.body).toMatchObject({ id: t.id, deletedAt: null });
  });
});

describe('dependencies (Faz 2 kabul: döngü engellenir)', () => {
  it('rejects a cycle with its path, and two concurrent opposite edges cannot both succeed', async () => {
    const { c } = await signupAndLogin(h);
    const [a, b, d] = [await task(c), await task(c), await task(c)];
    expect((await c.post(`/v1/tasks/${String(b.id)}/dependencies`, { blockerId: a.id })).status).toBe(201);
    expect((await c.post(`/v1/tasks/${String(d.id)}/dependencies`, { blockerId: b.id })).status).toBe(201);
    const cyc = await c.post(`/v1/tasks/${String(a.id)}/dependencies`, { blockerId: d.id });
    expect(cyc.status).toBe(422);
    expect(cyc.body).toMatchObject({ code: 'DEPENDENCY_CYCLE', cycle: [d.id, a.id, b.id, d.id] });
    expect((await c.post(`/v1/tasks/${String(a.id)}/dependencies`, { blockerId: a.id })).body.code).toBe('DEPENDENCY_CYCLE');
    expect((await c.post(`/v1/tasks/${String(b.id)}/dependencies`, { blockerId: a.id })).status).toBe(409);

    const [x, y] = [await task(c), await task(c)];
    const results = await Promise.all([
      c.post(`/v1/tasks/${String(y.id)}/dependencies`, { blockerId: x.id }),
      c.post(`/v1/tasks/${String(x.id)}/dependencies`, { blockerId: y.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const deps = await c.get(`/v1/tasks/${String(b.id)}/dependencies`);
    expect((deps.body.blockers as Json[]).map((e) => e.blockerId)).toEqual([a.id]);
    expect((deps.body.blocking as Json[]).map((e) => e.blockedId)).toEqual([d.id]);
  });

  it('the database trigger rejects a cycle even when the API layer is bypassed', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    const [a, b] = [await task(c), await task(c)];
    await c.post(`/v1/tasks/${String(b.id)}/dependencies`, { blockerId: a.id });
    await expect(superQuery(SUPER(), 'INSERT INTO task_dependencies (tenant_id, blocker_id, blocked_id) VALUES ($1, $2, $3)', [tenantId, b.id, a.id]))
      .rejects.toThrow(/DEPENDENCY_CYCLE/);
  });
});

describe('recurring tasks (Faz 2 kabul: DST dahil doğru tarihte yeni örnek)', () => {
  it('completing an occurrence creates exactly one next occurrence at 09:00 local across the Berlin DST change', async () => {
    const { c } = await signupAndLogin(h);
    const s = await c.post('/v1/task-series', {
      rrule: 'FREQ=DAILY', dtstartLocal: '2026-03-28T09:00', tzid: 'Europe/Berlin', catchUp: 'create_next', task: { title: 'Günlük kontrol' },
    });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const first = s.body.firstTask as Json;
    expect(first).toMatchObject({ dueAt: '2026-03-28T08:00:00.000Z', occurrenceIndex: 0 });
    await c.post(`/v1/tasks/${String(first.id)}/transition`, { transitionKey: 'finish' });
    await c.post(`/v1/tasks/${String(first.id)}/transition`, { transitionKey: 'reopen' });
    await c.post(`/v1/tasks/${String(first.id)}/transition`, { transitionKey: 'finish' });
    const list = await c.get(`/v1/tasks?q=${encodeURIComponent('title = "Günlük kontrol"')}&sort=due`);
    const dues = (list.body.data as Json[]).map((t) => [t.occurrenceIndex, t.dueAt]);
    expect(dues).toEqual([[0, '2026-03-28T08:00:00.000Z'], [1, '2026-03-29T07:00:00.000Z']]);
  });

  it('rejects unsupported or invalid rules', async () => {
    const { c } = await signupAndLogin(h);
    const base = { dtstartLocal: '2026-01-01T09:00', tzid: 'Europe/Istanbul', task: { title: 'x' } };
    expect((await c.post('/v1/task-series', { ...base, rrule: 'FREQ=HOURLY' })).body.code).toBe('RRULE_UNSUPPORTED');
    expect((await c.post('/v1/task-series', { ...base, rrule: 'FREQ=DAILY', tzid: 'Mars/Olympus' })).body.code).toBe('TZ_INVALID');
  });
});

describe('custom fields and formulas', () => {
  it('validates types and required values, computes formulas and makes fields queryable', async () => {
    const { c } = await signupAndLogin(h);
    expect((await c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_budget', type: 'number', label: { tr: 'Bütçe' }, required: true, indexed: true })).status).toBe(201);
    expect((await c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_double', type: 'formula', label: { tr: 'İki katı' }, formula: '{custom.cf_budget} * 2' })).status).toBe(201);
    expect((await c.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_loop', type: 'formula', label: { tr: 'x' }, formula: '{custom.cf_missing}' })).body.code).toBe('FORMULA_INVALID');
    expect((await c.post('/v1/tasks', { title: 'eksik' })).body.code).toBe('CUSTOM_FIELD_INVALID');
    expect((await c.post('/v1/tasks', { title: 'tip', custom: { cf_budget: '10' } })).body.code).toBe('CUSTOM_FIELD_INVALID');
    expect((await c.post('/v1/tasks', { title: 'bilinmeyen', custom: { cf_budget: 1, cf_nope: 1 } })).body.code).toBe('CUSTOM_FIELD_UNKNOWN');
    expect((await c.post('/v1/tasks', { title: 'formül yazılamaz', custom: { cf_budget: 1, cf_double: 5 } })).body.code).toBe('CUSTOM_FIELD_INVALID');
    const cheap = await task(c, { custom: { cf_budget: 50 } });
    const big = await task(c, { custom: { cf_budget: 250 } });
    expect(big.custom).toEqual({ cf_budget: 250, cf_double: 500 });
    const r = await c.get(`/v1/tasks?q=${encodeURIComponent('custom.cf_budget > 100')}`);
    expect((r.body.data as Json[]).map((t) => t.id)).toEqual([big.id]);
    expect((r.body.data as Json[]).map((t) => t.id)).not.toContain(cheap.id);
  });
});

describe('RQL listing, sorting and cursor pagination', () => {
  it('filters, sorts and pages without duplicates or gaps', async () => {
    const { c } = await signupAndLogin(h);
    for (let i = 0; i < 23; i++) await task(c, { priority: i % 5, dueAt: i % 4 === 0 ? null : new Date(Date.UTC(2026, 11, 1 + i)).toISOString() });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Awaited<ReturnType<Client['get']>> = await c.get(`/v1/tasks?sort=due,-priority&limit=5&count=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.meta).toEqual({ total: 23 });
      for (const t of r.body.data as Json[]) seen.push(String(t.id));
      cursor = (r.body.page as { nextCursor: string | null }).nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(23);
    const all = await c.get('/v1/tasks?sort=due,-priority&limit=200');
    expect((all.body.data as Json[]).map((t) => t.id)).toEqual(seen);
    const dues = (all.body.data as Json[]).map((t) => t.dueAt);
    expect(dues.slice(-6).every((d) => d === null)).toBe(true); // NULLS LAST
    const high = await c.get(`/v1/tasks?q=${encodeURIComponent('priority >= 3 AND statusCategory = open')}&limit=200`);
    expect((high.body.data as Json[]).every((t) => Number(t.priority) >= 3)).toBe(true);
    expect((high.body.data as Json[]).length).toBe(8); // i % 5 in {3,4} for i = 0..22
    const sel = await c.get('/v1/tasks?fields=title,priority&limit=1');
    expect(Object.keys((sel.body.data as Json[])[0]!).sort()).toEqual(['id', 'priority', 'title']);
  });

  it('reports syntax errors with a position, rejects unknown fields and tampered cursors, and is injection-proof', async () => {
    const { c } = await signupAndLogin(h);
    await task(c, { title: 'normal' });
    const syntax = await c.get(`/v1/tasks?q=${encodeURIComponent('priority = = 3')}`);
    expect(syntax.status).toBe(400);
    expect(syntax.body).toMatchObject({ code: 'RQL_SYNTAX', position: expect.any(Number) });
    expect((await c.get(`/v1/tasks?q=${encodeURIComponent('tenant_id = "x"')}`)).body.code).toBe('UNKNOWN_FIELD');
    expect((await c.get('/v1/tasks?sort=nope')).body.code).toBe('UNKNOWN_FIELD');
    expect((await c.get('/v1/tasks?cursor=abc.def')).body.code).toBe('CURSOR_INVALID');
    for (const v of [`' OR 1=1 --`, `"; DROP TABLE tasks; --`, `\\' OR ''='`, `$1`, `%`, `_`]) {
      const r = await c.get(`/v1/tasks?q=${encodeURIComponent(`title ~ ${JSON.stringify(v)}`)}`);
      expect(r.status, v).toBe(200);
      expect(r.body.data, v).toEqual([]);
    }
    const ok = await c.post('/v1/rql/validate', { resource: 'task', q: 'priority > ' });
    expect(ok.body).toMatchObject({ ok: false, error: { code: expect.any(String), position: expect.any(Number) } });
    const fields = await c.get('/v1/rql/fields?resource=task');
    expect((fields.body.data as Json[]).map((f) => f.name)).toContain('due');
    const [row] = await superQuery<{ n: number }>(SUPER(), 'SELECT count(*)::int AS n FROM tasks');
    expect(row?.n).toBeGreaterThan(0); // table still exists
  });
});

describe('authorization and isolation (record scope, Matrix A A08–A13)', () => {
  it('a sales rep sees and changes only own tasks; giving tasks away needs reassign; tenants are isolated', async () => {
    const admin = await signupAndLogin(h);
    const rep = await member(admin.c, 'sales_rep');
    const analyst = await member(admin.c, 'analyst');
    const adminTask = await task(admin.c);
    const repTask = await task(rep.c);
    const listed = await rep.c.get('/v1/tasks?limit=200&count=true');
    expect((listed.body.data as Json[]).map((t) => t.id)).toEqual([repTask.id]);
    expect(listed.body.meta).toEqual({ total: 1 });
    expect((await rep.c.get(`/v1/tasks/${String(adminTask.id)}`)).status).toBe(404);
    expect((await rep.c.post(`/v1/tasks/${String(adminTask.id)}/transition`, { transitionKey: 'start' })).status).toBe(404);
    expect((await rep.c.post('/v1/tasks', { title: 'başkasına', owner: { type: 'user', id: analyst.userId } })).status).toBe(403);
    expect((await rep.c.deleteWithIfMatch(`/v1/tasks/${String(repTask.id)}`, '"1"')).status).toBe(403);

    expect((await analyst.c.get(`/v1/tasks/${String(adminTask.id)}`)).status).toBe(200);
    expect((await analyst.c.patchJson(`/v1/tasks/${String(adminTask.id)}`, { title: 'x' }, '"1"')).status).toBe(403);
    expect((await analyst.c.post('/v1/tasks', { title: 'analist' })).status).toBe(403);

    const assigned = await task(admin.c, { owner: { type: 'user', id: rep.userId } });
    expect((await rep.c.get(`/v1/tasks/${String(assigned.id)}`)).status).toBe(200);

    const bulk = await rep.c.post('/v1/tasks/bulk', { ids: [repTask.id, adminTask.id], patch: { priority: 4 } });
    expect(bulk.body).toMatchObject({ succeeded: 1, failed: 1, results: [{ id: repTask.id, ok: true }, { id: adminTask.id, ok: false, code: 'NOT_FOUND' }] });

    const other = await signupAndLogin(h);
    expect((await other.c.get(`/v1/tasks/${String(adminTask.id)}`)).status).toBe(404);
    expect((await other.c.post(`/v1/tasks/${String(adminTask.id)}/dependencies`, { blockerId: adminTask.id })).status).toBe(404);
    expect((await other.c.post('/v1/tasks', { title: 'x', parentId: adminTask.id })).status).toBe(404);
    expect((await other.c.get('/v1/tasks?limit=200')).body.data).toEqual([]);
  });

  it('reorders within a column using fractional positions', async () => {
    const { c } = await signupAndLogin(h);
    const [a, b, d] = [await task(c), await task(c), await task(c)];
    const moved = await c.post(`/v1/tasks/${String(d.id)}/move`, { beforeId: a.id, afterId: b.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const list = await c.get('/v1/tasks?sort=position&limit=10');
    expect((list.body.data as Json[]).map((t) => t.id)).toEqual([a.id, d.id, b.id]);
  });
});

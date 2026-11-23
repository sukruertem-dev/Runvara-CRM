import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P6c API (docs/p6-plan.md §9): editing workflows (with a mapping for records in removed statuses), custom-field
// definitions and SLA policies from the settings screens.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
interface Status { id: string; key: string; category: string; label: Record<string, string>; colorToken: string; isInitial: boolean; wipLimit: number | null }
interface Transition { key: string; label: Record<string, string>; fromStatusId: string | null; toStatusId: string; conditions: unknown[]; validators: unknown[]; postFunctions: unknown[] }
interface Wf { id: string; key: string; name: string; resourceType: string; isDefault: boolean; version: number; statuses: Status[]; transitions: Transition[] }

const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

async function member(admin: Client, role: string): Promise<Client> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return c;
}

interface StatusIn { id?: string; key: string; label: Record<string, string>; category: string; colorToken: string; isInitial: boolean; wipLimit: number | null; probability?: number }

/** The editor's save shape built from a stored workflow (what the settings screen sends back). */
function toUpdate(wf: Wf) {
  const keyOf = new Map(wf.statuses.map((s) => [s.id, s.key]));
  return {
    name: wf.name,
    statuses: wf.statuses.map((s): StatusIn => ({ id: s.id, key: s.key, label: s.label, category: s.category, colorToken: s.colorToken, isInitial: s.isInitial, wipLimit: s.wipLimit })),
    transitions: wf.transitions.map((x) => ({
      key: x.key, label: x.label, from: x.fromStatusId ? (keyOf.get(x.fromStatusId) ?? null) : null, to: keyOf.get(x.toStatusId) ?? '',
      conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions,
    })),
    statusMap: {} as Record<string, string>,
  };
}

const put = (c: Client, url: string, body: unknown, ifMatch: string) => c.req('PUT', url, body, { 'if-match': ifMatch });

describe('workflow editor API', () => {
  it('adds and removes statuses; records in a removed status need a mapping and then move', async () => {
    const { c: admin } = await signupAndLogin(h);
    const wf = (ok(await admin.get('/v1/workflows')).data as Wf[]).find((w) => w.resourceType === 'task' && w.isDefault);
    if (!wf) throw new Error('default task workflow missing');
    expect(wf.version).toBe(1);
    const doing = wf.statuses.find((s) => s.key === 'in_progress');
    if (!doing) throw new Error('in_progress missing');
    const busy = ok(await admin.post('/v1/tasks', { title: 'Sürüyor' }), 201);
    ok(await admin.post(`/v1/tasks/${String(busy.id)}/transition`, { transitionKey: 'start' }));
    ok(await admin.post('/v1/tasks', { title: 'Bekliyor' }), 201);

    // New "review" status replaces "in_progress": todo → review → done.
    const next = toUpdate(wf);
    next.name = 'Ekip akışı';
    next.statuses = next.statuses.filter((s) => s.key !== 'in_progress');
    next.statuses.splice(1, 0, { key: 'review', label: { tr: 'İncelemede', en: 'In review' }, category: 'in_progress', colorToken: 'warning', isInitial: false, wipLimit: 3 });
    next.transitions = [
      ...next.transitions.filter((x) => x.from !== 'in_progress' && x.to !== 'in_progress'),
      { key: 'review', label: { tr: 'İncelemeye gönder' }, from: 'todo', to: 'review', conditions: [], validators: [], postFunctions: [] },
      { key: 'approve', label: { tr: 'Onayla' }, from: 'review', to: 'done', conditions: [], validators: [], postFunctions: [] },
    ];

    const preview = ok(await admin.post(`/v1/workflows/${wf.id}/preview`, next));
    expect(preview).toEqual({ added: ['review'], removed: [{ statusId: doing.id, key: 'in_progress', records: 1, mappedTo: null }], applicable: false });
    const refused = await put(admin, `/v1/workflows/${wf.id}`, next, '"1"');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WORKFLOW_STATUS_IN_USE');

    next.statusMap = { [doing.id]: 'review' };
    expect(ok(await admin.post(`/v1/workflows/${wf.id}/preview`, next)).applicable).toBe(true);
    expect((await admin.req('PUT', `/v1/workflows/${wf.id}`, next)).status).toBe(428);
    const saved = ok(await put(admin, `/v1/workflows/${wf.id}`, next, '"1"')) as unknown as Wf;
    expect(saved.version).toBe(2);
    expect(saved.name).toBe('Ekip akışı');
    expect(saved.statuses.map((s) => s.key)).toEqual(['todo', 'review', 'done', 'canceled']);
    expect(saved.statuses.find((s) => s.key === 'review')?.wipLimit).toBe(3);
    const moved = ok(await admin.get(`/v1/tasks/${String(busy.id)}`));
    expect((moved.status as { key: string }).key).toBe('review');
    // The new transition works on the moved record.
    const approved = ok(await admin.post(`/v1/tasks/${String(busy.id)}/transition`, { transitionKey: 'approve' }));
    expect((approved.status as { key: string }).key).toBe('done');
    expect(approved.closedAt).not.toBeNull();

    // Stale version, changed key, broken machine, foreign ids.
    expect((await put(admin, `/v1/workflows/${wf.id}`, next, '"1"')).status).toBe(412);
    const again = toUpdate(saved);
    const renamed = { ...again, statuses: again.statuses.map((s) => (s.key === 'todo' ? { ...s, key: 'backlog' } : s)) };
    expect((await put(admin, `/v1/workflows/${wf.id}`, renamed, '"2"')).body.code).toBe('WORKFLOW_INVALID');
    const twoInitial = { ...again, statuses: again.statuses.map((s) => ({ ...s, isInitial: true })) };
    expect((await put(admin, `/v1/workflows/${wf.id}`, twoInitial, '"2"')).body.code).toBe('WORKFLOW_INVALID');
    const badMap = { ...again, statusMap: { [doing.id]: 'todo' } };
    expect((await admin.post(`/v1/workflows/${wf.id}/preview`, badMap)).body.code).toBe('WORKFLOW_INVALID');

    // Only configuration managers edit workflows.
    const rep = await member(admin, 'sales_rep');
    expect((await rep.post(`/v1/workflows/${wf.id}/preview`, again)).status).toBe(403);
    expect((await put(rep, `/v1/workflows/${wf.id}`, again, '"2"')).status).toBe(403);
  });

  it('sets the stage probability of a new opportunity stage in every pipeline on the workflow', async () => {
    const { c: admin } = await signupAndLogin(h);
    ok(await admin.post('/v1/modules/crm/enable'));
    const wf = (ok(await admin.get('/v1/workflows')).data as Wf[]).find((w) => w.resourceType === 'opportunity' && w.isDefault);
    if (!wf) throw new Error('opportunity workflow missing');
    const next = toUpdate(wf);
    const first = next.statuses[0];
    if (!first) throw new Error('no stages');
    next.statuses.splice(1, 0, { key: 'demo', label: { tr: 'Demo' }, category: 'in_progress', colorToken: 'info', isInitial: false, wipLimit: null, probability: 35 });
    next.transitions.push({ key: 'to_demo', label: { tr: 'Demoya geç' }, from: first.key, to: 'demo', conditions: [], validators: [], postFunctions: [] });
    ok(await put(admin, `/v1/workflows/${wf.id}`, next, `"${String(wf.version)}"`));
    const pipelines = ok(await admin.get('/v1/pipelines')).data as { workflowId: string; stages: { key: string; probability: number }[] }[];
    const stages = pipelines.find((p) => p.workflowId === wf.id)?.stages ?? [];
    expect(stages.find((s) => s.key === 'demo')?.probability).toBe(35);
    expect(stages[1]?.key).toBe('demo');

    // Probability belongs to opportunity workflows only.
    const task = (ok(await admin.get('/v1/workflows')).data as Wf[]).find((w) => w.resourceType === 'task' && w.isDefault);
    if (!task) throw new Error('task workflow missing');
    const withProb = toUpdate(task);
    withProb.statuses = withProb.statuses.map((s) => ({ ...s, probability: 10 }));
    expect((await admin.post(`/v1/workflows/${task.id}/preview`, withProb)).body.code).toBe('WORKFLOW_INVALID');
  });
});

describe('custom field manager API', () => {
  it('edits labels and options in place, protects used options, reorders, archives and restores', async () => {
    const { c: admin } = await signupAndLogin(h);
    const kind = ok(await admin.post('/v1/custom-fields', {
      resourceType: 'task', key: 'cf_kind', type: 'select', label: { tr: 'Tür' },
      options: [{ id: 'bug', label: { tr: 'Hata' } }, { id: 'idea', label: { tr: 'Fikir' } }],
    }), 201);
    const size = ok(await admin.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_size', type: 'number', label: { tr: 'Boyut' } }), 201);
    expect(kind.version).toBe(1);
    ok(await admin.post('/v1/tasks', { title: 'Hatalı', custom: { cf_kind: 'bug' } }), 201);

    expect((await admin.patchJson(`/v1/custom-fields/${String(kind.id)}`, { label: { tr: 'Tip' } })).status).toBe(428);
    const removeUsed = await admin.patchJson(`/v1/custom-fields/${String(kind.id)}`, { options: [{ id: 'idea', label: { tr: 'Fikir' } }] }, '"1"');
    expect(removeUsed.status).toBe(409);
    expect(removeUsed.body).toMatchObject({ code: 'CUSTOM_FIELD_OPTION_IN_USE', optionId: 'bug', records: 1 });

    const edited = ok(await admin.patchJson(`/v1/custom-fields/${String(kind.id)}`, {
      label: { tr: 'Tip', en: 'Kind' },
      options: [{ id: 'bug', label: { tr: 'Kusur' } }, { id: 'chore', label: { tr: 'İş' } }],
      required: true,
    }, '"1"'));
    expect(edited).toMatchObject({ label: { tr: 'Tip', en: 'Kind' }, required: true, version: 2, options: [{ id: 'bug', label: { tr: 'Kusur' } }, { id: 'chore', label: { tr: 'İş' } }] });
    expect((await admin.patchJson(`/v1/custom-fields/${String(kind.id)}`, { required: false }, '"1"')).status).toBe(412);
    expect((await admin.patchJson(`/v1/custom-fields/${String(size.id)}`, { options: [{ id: 'x', label: { tr: 'x' } }] }, '"1"')).body.code).toBe('VALIDATION_FAILED');
    expect((await admin.patchJson(`/v1/custom-fields/${String(kind.id)}`, { type: 'text' }, '"2"')).status).toBe(400);

    // Reorder: size first.
    ok(await admin.patchJson(`/v1/custom-fields/${String(size.id)}`, { moveAfter: null }, '"1"'));
    const order = (ok(await admin.get('/v1/custom-fields?resourceType=task')).data as { key: string }[]).map((d) => d.key);
    expect(order).toEqual(['cf_size', 'cf_kind']);

    // Archive and restore.
    expect((await admin.post(`/v1/custom-fields/${String(size.id)}/archive`)).status).toBe(204);
    expect(ok(await admin.post(`/v1/custom-fields/${String(size.id)}/restore`))).toMatchObject({ archived: false });

    // A formula field round-trips through the archive (its formula is checked again on restore).
    const a = ok(await admin.post('/v1/custom-fields', { resourceType: 'task', key: 'cf_a', type: 'formula', label: { tr: 'A' }, formula: '{custom.cf_size} * 2' }), 201);
    expect((await admin.post(`/v1/custom-fields/${String(a.id)}/archive`)).status).toBe(204);
    expect(ok(await admin.post(`/v1/custom-fields/${String(a.id)}/restore`))).toMatchObject({ archived: false, formula: '{custom.cf_size} * 2' });

    const rep = await member(admin, 'sales_rep');
    expect((await rep.patchJson(`/v1/custom-fields/${String(kind.id)}`, { required: false }, '"2"')).status).toBe(403);
  });
});

describe('SLA policy editing', () => {
  it('changes a policy in place with If-Match and validates the criteria', async () => {
    const { c: admin } = await signupAndLogin(h);
    for (const m of ['crm', 'automation_sla']) ok(await admin.post(`/v1/modules/${m}/enable`));
    const allWeek = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));
    const cal = ok(await admin.post('/v1/calendars', { name: '7/24', timezone: 'Europe/Istanbul', weeklyHours: allWeek }), 201);
    const p = ok(await admin.post('/v1/sla/policies', { name: 'Talep', resourceType: 'case', calendarId: cal.id, resolutionMinutes: 240 }), 201);
    expect(p.version).toBe(1);
    const changed = ok(await admin.patchJson(`/v1/sla/policies/${String(p.id)}`, { warnPercent: 60, firstResponseMinutes: 30, criteria: 'priority >= 3' }, '"1"'));
    expect(changed).toMatchObject({ warnPercent: 60, firstResponseMinutes: 30, resolutionMinutes: 240, criteria: 'priority >= 3', version: 2 });
    expect((await admin.patchJson(`/v1/sla/policies/${String(p.id)}`, { enabled: false }, '"1"')).status).toBe(412);
    expect((await admin.patchJson(`/v1/sla/policies/${String(p.id)}`, { criteria: 'nope = 1' }, '"2"')).body.code).toBe('SLA_POLICY_INVALID');
    expect((await admin.patchJson(`/v1/sla/policies/${String(p.id)}`, { firstResponseMinutes: null, resolutionMinutes: null }, '"2"')).body.code).toBe('VALIDATION_FAILED');
    const listed = (ok(await admin.get('/v1/sla/policies')).data as Json[]).find((x) => x.id === p.id);
    expect(listed).toMatchObject({ version: 2, warnPercent: 60 });
  });
});

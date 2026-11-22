import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P6a API support for the UI (docs/p6-plan.md §2, §4): navigation carries roles, segments and capabilities;
// a names-only people directory; Kanban WIP limits on workflow statuses.

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

async function member(admin: Client, role: string, displayName: string): Promise<{ c: Client; userId: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return { c, userId: (l.user as { id: string }).id };
}

describe('navigation for the shell', () => {
  it('returns roles, offerable segments and capabilities decided by the authz engine', async () => {
    const { c: admin } = await signupAndLogin(h);
    const nav = ok(await admin.get('/v1/me/navigation'));
    expect(nav.roles).toEqual(['admin']);
    expect(nav.salesMode).toBe('both');
    expect(nav.segments).toEqual(['b2b', 'b2c']);
    expect(nav.capabilities).toEqual(expect.arrayContaining(['task.create', 'task.update', 'task.delete', 'task.bulk', 'users.manage', 'tenant.modules.manage', 'tenant.config.manage']));
    expect((nav.menu as Json[]).map((m) => m.id)).toContain('tasks');

    // The segment switcher narrows requests, never the list of segments it may offer.
    const narrowed = ok(await admin.req('GET', '/v1/me/navigation', undefined, { 'x-segment': 'b2c' }));
    expect(narrowed.segments).toEqual(['b2b', 'b2c']);

    const rep = await member(admin, 'sales_rep', 'Temsilci');
    const repNav = ok(await rep.c.get('/v1/me/navigation'));
    expect(repNav.roles).toEqual(['sales_rep']);
    expect(repNav.capabilities).toEqual(expect.arrayContaining(['task.create', 'task.update']));
    expect(repNav.capabilities).not.toContain('users.manage');
    expect(repNav.capabilities).not.toContain('tenant.modules.manage');
    expect(repNav.capabilities).not.toContain('tenant.config.manage');
  });
});

describe('people directory', () => {
  it('lists active members by name only, filters by name and by ids, for every member', async () => {
    const { c: admin } = await signupAndLogin(h);
    const ayse = await member(admin, 'sales_rep', 'Ayşe Yıldız'); // the admin is "Ayşe Yılmaz"
    const mert = await member(admin, 'call_agent', 'Mert %_ Kaya');

    const all = ok(await ayse.c.get('/v1/directory/users')).data as Json[];
    expect(all.map((u) => u.displayName)).toEqual(expect.arrayContaining(['Ayşe Yıldız', 'Mert %_ Kaya']));
    for (const u of all) expect(Object.keys(u).sort()).toEqual(['displayName', 'id']);

    expect((ok(await ayse.c.get(`/v1/directory/users?q=${encodeURIComponent('yıldı')}`)).data as Json[]).map((u) => u.id)).toEqual([ayse.userId]);
    expect((ok(await ayse.c.get('/v1/directory/users?q=KAYA')).data as Json[]).map((u) => u.id)).toEqual([mert.userId]);
    // LIKE wildcards in the term are literal.
    expect((ok(await ayse.c.get(`/v1/directory/users?q=${encodeURIComponent('%_')}`)).data as Json[]).map((u) => u.id)).toEqual([mert.userId]);
    expect((ok(await ayse.c.get(`/v1/directory/users?ids=${mert.userId}`)).data as Json[]).map((u) => u.displayName)).toEqual(['Mert %_ Kaya']);
    expect((await ayse.c.get('/v1/directory/users?ids=not-a-uuid')).status).toBe(400);

    // Another tenant's members never appear.
    const other = await signupAndLogin(h);
    const foreign = ok(await other.c.get(`/v1/directory/users?ids=${ayse.userId}`)).data as Json[];
    expect(foreign).toEqual([]);
  });
});

describe('Kanban WIP limit', () => {
  it('is stored per status and returned with the workflow', async () => {
    const { c: admin } = await signupAndLogin(h);
    const def = (ok(await admin.get('/v1/workflows')).data as Json[]).find((w) => w.resourceType === 'task' && w.isDefault)!;
    for (const s of def.statuses as Json[]) expect(s.wipLimit).toBeNull();

    ok(
      await admin.post('/v1/workflows', {
        key: 'destek',
        name: 'Destek',
        statuses: [
          { key: 'yeni', label: { tr: 'Yeni' }, category: 'open', isInitial: true },
          { key: 'is', label: { tr: 'İşlemde' }, category: 'in_progress', wipLimit: 3 },
          { key: 'bitti', label: { tr: 'Bitti' }, category: 'closed' },
        ],
        transitions: [{ key: 'basla', from: 'yeni', to: 'is' }, { key: 'bitir', from: 'is', to: 'bitti' }],
      }),
      201,
    );
    const wf = (ok(await admin.get('/v1/workflows')).data as Json[]).find((w) => w.key === 'destek')!;
    expect((wf.statuses as Json[]).map((s) => [s.key, s.wipLimit])).toEqual([['yeni', null], ['is', 3], ['bitti', null]]);
    const bad = await admin.post('/v1/workflows', {
      key: 'kotu',
      name: 'Kötü',
      statuses: [
        { key: 'a', label: { tr: 'A' }, category: 'open', isInitial: true, wipLimit: 0 },
        { key: 'b', label: { tr: 'B' }, category: 'closed' },
      ],
      transitions: [{ key: 'x', from: 'a', to: 'b' }],
    });
    expect(bad.status).toBe(400);
  });
});

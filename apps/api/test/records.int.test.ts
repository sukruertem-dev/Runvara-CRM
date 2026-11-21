import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import type { AttachmentScanner } from '../src/infra/scanner';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P4b acceptance (docs/p4-plan.md §10): timeline, comments + mentions, notifications, attachments, audit,
// delegation, access requests, matrix administration.

let h: Harness;
let infected: Harness;
beforeAll(async () => {
  h = await startHarness();
  const scanner: AttachmentScanner = { scan: async (body) => { for await (const chunk of body) if (chunk.length < 0) break; return 'infected'; } };
  infected = await startHarness({}, { scanner });
});
afterAll(async () => { await Promise.all([h.close(), infected.close()]); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
interface Member { c: Client; userId: string }

async function workspace(hh: Harness = h) {
  const s = await signupAndLogin(hh);
  ok(await s.c.post('/v1/modules/crm/enable'));
  const me = ok(await s.c.get('/v1/me'));
  return { ...s, adminId: (me.user as { id: string }).id };
}

async function member(admin: Client, role: string, opts: { segments?: string[]; teamId?: string; teamRole?: 'member' | 'manager'; hh?: Harness } = {}): Promise<Member> {
  const hh = opts.hh ?? h;
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role, ...(opts.segments ? { segments: opts.segments } : {}) }), 201);
  const c = new Client(hh.app);
  ok(await c.post('/v1/invitations/accept', { token: hh.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  const userId = (l.user as { id: string }).id;
  if (opts.teamId) ok(await admin.put(`/v1/teams/${opts.teamId}/members/${userId}`, { role: opts.teamRole ?? 'member' }));
  return { c, userId };
}

const doc = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const txt = (t: string) => ({ type: 'text', text: t });
const at = (kind: 'user' | 'team', id: string) => ({ type: 'mention', attrs: { kind, id } });

describe('activity timeline (Faz 4)', () => {
  it('records creation, field diffs, status changes, assignment and deletion; hidden fields stay hidden', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const opp = ok(await admin.post('/v1/opportunities', { name: 'Zaman çizelgesi', segment: 'b2b', amount: '1000' }), 201);
    const url = `/v1/opportunities/${String(opp.id)}`;
    ok(await admin.patchJson(url, { amount: '2000' }, '"1"'));
    ok(await admin.patchJson(url, { name: 'Yeni ad', competitor: 'Rakip' }, '"2"'));
    ok(await admin.post(`${url}/transition`, { transitionKey: 'to_proposal' }));
    ok(await admin.patchJson(url, { ownerUserId: rep.userId }, '"4"'));
    const tl = ok(await admin.get(`${url}/timeline`)).data as Json[];
    expect(tl.map((e) => e.kind)).toEqual(['assigned', 'field_changed', 'status_changed', 'field_changed', 'field_changed', 'created']);
    expect(tl[1]!.diff).toEqual({ ownerUserId: { from: expect.any(String), to: rep.userId } });
    expect(tl[2]!.diff).toEqual({ status: { from: 'prospecting', to: 'proposal' } });
    expect(tl[3]!.diff).toEqual({ name: { from: 'Zaman çizelgesi', to: 'Yeni ad' }, competitor: { from: null, to: 'Rakip' } });
    expect(tl[4]!.diff).toEqual({ amount: { from: '1000.00', to: '2000.00' } });
    expect(tl[0]!.actor).toMatchObject({ displayName: 'Ayşe Yılmaz' });

    // FLS: the rep (now owner) cannot see `amount`, so its diff — and an event that only changed it — vanish.
    const roles = ok(await admin.get('/v1/roles')).data as Json[];
    ok(await admin.put('/v1/field-policies', { roleId: roles.find((r) => r.key === 'sales_rep')!.id, resourceType: 'opportunity', field: 'amount', access: 'hidden' }));
    const repTl = ok(await rep.c.get(`${url}/timeline`)).data as Json[];
    expect(repTl.map((e) => e.kind)).toEqual(['assigned', 'field_changed', 'status_changed', 'field_changed', 'created']);
    expect(JSON.stringify(repTl)).not.toContain('2000');

    // Pagination and deletion.
    const page = ok(await admin.get(`${url}/timeline?limit=2`));
    const more = ok(await admin.get(`${url}/timeline?limit=10&before=${encodeURIComponent(String((page.page as Json).nextCursor))}`));
    expect((more.data as Json[]).length).toBe(4);
    ok(await admin.deleteWithIfMatch(url, '"5"'), 204);
    ok(await admin.post(`${url}/restore`));
    expect(((ok(await admin.get(`${url}/timeline?limit=2`)).data as Json[]).map((e) => e.kind))).toEqual(['restored', 'deleted']);
    // Another tenant cannot read it.
    const other = await workspace();
    expect((await other.c.get(`${url}/timeline`)).status).toBe(404);
  });

  it('e-mail and call logs are added by hand or API; read-only roles cannot add them', async () => {
    const { c: admin } = await workspace();
    const analyst = await member(admin, 'analyst');
    const acc = ok(await admin.post('/v1/accounts', { name: 'Arama günlüğü', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    const log = ok(await admin.post(`${url}/activities`, { kind: 'call_log', direction: 'outbound', subject: 'Yenileme görüşmesi', at: '2026-11-20T10:00:00Z', durationSeconds: 420 }), 201);
    expect(log).toMatchObject({ kind: 'call_log', data: { subject: 'Yenileme görüşmesi', durationSeconds: 420, direction: 'outbound' } });
    expect((await analyst.c.post(`${url}/activities`, { kind: 'email_log', direction: 'inbound', subject: 'x', at: '2026-11-20T10:00:00Z' })).status).toBe(403);
    expect(((ok(await analyst.c.get(`${url}/timeline`)).data as Json[])[0])).toMatchObject({ kind: 'call_log' });
  });
});

describe('comments, mentions and notifications (ADR-0017)', () => {
  it('mention rules: access required, teams expand, edits notify only new people and retract removed ones', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Ekip ') }), 201).id);
    const rep = await member(admin, 'sales_rep', { teamId: team });
    const outsider = await member(admin, 'sales_rep', { teamId: team });
    const acc = ok(await admin.post('/v1/accounts', { name: 'Mention', segments: ['b2b'], ownerUserId: rep.userId }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;

    // The outsider cannot see the account: a direct mention is refused, naming them.
    const denied = await admin.post(`${url}/comments`, { body: doc(txt('Bakın '), at('user', outsider.userId)) });
    expect(denied.status).toBe(422);
    expect(denied.body).toMatchObject({ code: 'MENTION_TARGET_NO_ACCESS', userIds: [outsider.userId] });
    // Team mention: only members with access are notified (the outsider is skipped silently).
    const c1 = ok(await admin.post(`${url}/comments`, { body: doc(txt('Ekip: '), at('team', team), txt(' ve '), at('user', rep.userId)) }), 201);
    expect(c1.bodyHtml).toContain('data-kind="team"');
    const repN = ok(await rep.c.get('/v1/notifications'));
    expect(repN.unreadCount).toBe(2); // assigned (account owner) + mention
    const mention = (repN.data as Json[]).find((n) => n.kind === 'mention')!;
    expect(mention).toMatchObject({ accessible: true, title: 'Mention', record: { type: 'account', id: acc.id }, link: `/r/account/${String(acc.id)}#comment-${String(c1.id)}` });
    expect(ok(await outsider.c.get('/v1/notifications')).data).toEqual([]);

    // Edit: remove the rep → their unread mention is withdrawn; add again → notified again.
    const cUrl = `/v1/comments/${String(c1.id)}`;
    ok(await admin.req('PATCH', cUrl, { body: doc(txt('Düzeltme')), revision: 1 }));
    expect(((ok(await rep.c.get('/v1/notifications')).data as Json[]).map((n) => n.kind))).toEqual(['assigned']);
    expect((await admin.req('PATCH', cUrl, { body: doc(txt('x')), revision: 1 })).status).toBe(412);
    ok(await admin.req('PATCH', cUrl, { body: doc(txt('Tekrar '), at('user', rep.userId)), revision: 2 }));
    expect(((ok(await rep.c.get('/v1/notifications')).data as Json[]).map((n) => n.kind))).toEqual(['mention', 'assigned']);
    expect((ok(await rep.c.get(`${cUrl}/revisions`)).data as Json[]).map((r) => r.revision)).toEqual([1, 2, 3]);
    // Only the author edits; the record owner may not delete someone else's comment.
    expect((await rep.c.req('PATCH', cUrl, { body: doc(txt('x')), revision: 3 })).status).toBe(403);
    expect((await rep.c.del(cUrl)).status).toBe(403);
    // Unsafe content is rejected; html is generated server-side.
    expect((await admin.post(`${url}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } })).status).toBe(400);
    ok(await admin.del(cUrl), 204);
    const list = ok(await rep.c.get(`${url}/comments`)).data as Json[];
    expect(list[0]).toMatchObject({ deleted: true, body: null, bodyText: null });
    expect(((ok(await rep.c.get('/v1/notifications')).data as Json[]).map((n) => n.kind))).toEqual(['assigned']);
  });

  it('SCN-17: a notification hides its content once access is lost; read state and preferences', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const acc = ok(await admin.post('/v1/accounts', { name: 'Gizli müşteri', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    const share = ok(await admin.post(`${url}/shares`, { grantee: { type: 'user', id: rep.userId } }), 201);
    ok(await admin.post(`${url}/comments`, { body: doc(at('user', rep.userId), txt(' bakar mısın?')) }), 201);
    const before = ok(await rep.c.get('/v1/notifications'));
    expect((before.data as Json[])[0]).toMatchObject({ kind: 'mention', accessible: true, title: 'Gizli müşteri' });
    ok(await admin.del(`${url}/shares/${String(share.id)}`), 204);
    const after = (ok(await rep.c.get('/v1/notifications')).data as Json[])[0]!;
    expect(after).toMatchObject({ kind: 'mention', accessible: false, title: null, record: null, source: null, actor: null, link: null });
    // Read state.
    expect(ok(await rep.c.post(`/v1/notifications/${String(after.id)}/read`))).toEqual({ updated: 1 });
    expect(ok(await rep.c.get('/v1/notifications')).unreadCount).toBe(0);
    expect((await admin.post(`/v1/notifications/${String(after.id)}/read`)).status).toBe(404); // not yours
    // Preferences: in-app mentions off → no new notification.
    ok(await rep.c.put('/v1/notifications/preferences', { preferences: [{ kind: 'mention', channels: ['email'] }] }));
    const acc2 = ok(await admin.post('/v1/accounts', { name: 'İkinci', segments: ['b2b'], ownerUserId: rep.userId }), 201);
    ok(await admin.post(`/v1/accounts/${String(acc2.id)}/comments`, { body: doc(at('user', rep.userId)) }), 201);
    expect(((ok(await rep.c.get('/v1/notifications?unread=true')).data as Json[]).map((n) => n.kind))).toEqual(['assigned']);
    ok(await rep.c.post('/v1/notifications/read-all'));
    expect(ok(await rep.c.get('/v1/notifications')).unreadCount).toBe(0);
    // Analysts may not mention (A27).
    const analyst = await member(admin, 'analyst');
    expect((await analyst.c.post(`/v1/accounts/${String(acc2.id)}/comments`, { body: doc(txt('x')) })).status).toBe(403);
  });
});

describe('attachments (ADR-0013 §2)', () => {
  async function upload(c: Client, url: string, fileName: string, mime: string, content: Uint8Array) {
    const init = ok(await c.post(`${url}/attachments`, { fileName, mime, sizeBytes: content.length }), 201);
    const up = init.upload as { url: string; headers: Record<string, string> };
    const put = await fetch(up.url, { method: 'PUT', headers: up.headers, body: content });
    expect(put.status, await put.text()).toBe(200);
    return String((init.attachment as Json).id);
  }

  it('signed upload → verified → signed download; wrong signatures and strangers are refused', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const acc = ok(await admin.post('/v1/accounts', { name: 'Dosyalı', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    const pdf = new TextEncoder().encode('%PDF-1.4\n% Flexa test\n%%EOF\n');
    const id = await upload(admin, url, 'Sözleşme "final".pdf', 'application/pdf', pdf);
    expect((ok(await admin.get(`${url}/attachments`)).data as Json[])).toEqual([]); // pending is not listed
    const done = ok(await admin.post(`/v1/attachments/${id}/complete`));
    expect(done).toMatchObject({ status: 'unscanned', fileName: 'Sözleşme "final".pdf', sizeBytes: pdf.length });
    const dl = ok(await admin.get(`/v1/attachments/${id}/download`));
    const got = await fetch(String(dl.url));
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(pdf);
    expect(got.headers.get('content-disposition')).toContain('attachment;');
    expect(((ok(await admin.get(`${url}/timeline`)).data as Json[])[0])).toMatchObject({ kind: 'attachment', data: { attachmentId: id } });
    // A user who cannot see the record cannot see or download its files.
    expect((await rep.c.get(`/v1/attachments/${id}/download`)).status).toBe(404);
    expect((await rep.c.get(`${url}/attachments`)).status).toBe(404);
    // Declared PNG, uploaded text: rejected and removed.
    const bad = await upload(admin, url, 'resim.png', 'image/png', new TextEncoder().encode('not really a png'));
    const r = await admin.post(`/v1/attachments/${bad}/complete`);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ATTACHMENT_INVALID');
    expect((ok(await admin.get(`${url}/attachments`)).data as Json[]).map((a) => a.id)).toEqual([id]);
    // Disallowed types never get an upload URL.
    expect((await admin.post(`${url}/attachments`, { fileName: 'x.svg', mime: 'image/svg+xml', sizeBytes: 10 })).status).toBe(400);
    expect((await admin.post(`${url}/attachments`, { fileName: 'x.pdf', mime: 'application/pdf', sizeBytes: 26 * 1024 * 1024 })).status).toBe(400);
    ok(await admin.del(`/v1/attachments/${id}`), 204);
    expect((await admin.get(`/v1/attachments/${id}/download`)).status).toBe(404);
  });

  it('an infected file is never downloadable', async () => {
    const { c: admin } = await workspace(infected);
    const acc = ok(await admin.post('/v1/accounts', { name: 'Virüs', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    const init = ok(await admin.post(`${url}/attachments`, { fileName: 'eicar.txt', mime: 'text/plain', sizeBytes: 5 }), 201);
    const up = init.upload as { url: string; headers: Record<string, string> };
    expect((await fetch(up.url, { method: 'PUT', headers: up.headers, body: 'EICAR' })).status).toBe(200);
    const id = String((init.attachment as Json).id);
    expect(ok(await admin.post(`/v1/attachments/${id}/complete`)).status).toBe('infected');
    expect((await admin.get(`/v1/attachments/${id}/download`)).body.code).toBe('ATTACHMENT_NOT_READY');
  });
});

describe('audit, delegation, access requests', () => {
  it('A23: a manager reads only their team members’ actions; reps cannot read the audit log', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Ekip ') }), 201).id);
    const mgr = await member(admin, 'manager', { teamId: team, teamRole: 'manager' });
    const rep = await member(admin, 'sales_rep', { teamId: team });
    const acc = ok(await rep.c.post('/v1/accounts', { name: 'Denetim', segments: ['b2b'] }), 201);
    ok(await rep.c.post(`/v1/accounts/${String(acc.id)}/shares`, { grantee: { type: 'user', id: mgr.userId } }), 201);
    const all = ok(await admin.get('/v1/audit?limit=200')).data as Json[];
    expect(all.some((a) => a.action === 'team.created')).toBe(true);
    const mine = ok(await mgr.c.get('/v1/audit?limit=200')).data as Json[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((a) => [mgr.userId, rep.userId].includes(String((a.actor as Json | null)?.id)))).toBe(true);
    expect(mine.some((a) => a.action === 'record.shared')).toBe(true);
    const filtered = ok(await admin.get(`/v1/audit?action=record.&actorId=${rep.userId}`)).data as Json[];
    expect(filtered.map((a) => a.action)).toEqual(['record.shared']);
    expect((await rep.c.get('/v1/audit')).status).toBe(403);
  });

  it('A07 / SCN-18: delegations grant for a limited time, end on time or on revoke; limits hold', async () => {
    const { c: admin, tenantId } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Ekip ') }), 201).id);
    const mgr = await member(admin, 'manager', { teamId: team, teamRole: 'manager', segments: ['b2b'] });
    const rep = await member(admin, 'sales_rep', { teamId: team, segments: ['b2b'] });
    const stranger = await member(admin, 'sales_rep');
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await rep.c.post('/v1/delegations', { delegateId: stranger.userId, roleKey: 'sales_rep', endsAt })).status).toBe(403); // request-only
    expect((await mgr.c.post('/v1/delegations', { delegateId: stranger.userId, roleKey: 'manager', endsAt })).body).toMatchObject({ reason: 'managed_teams_only' });
    expect((await mgr.c.post('/v1/delegations', { delegateId: rep.userId, segments: ['b2c'], endsAt })).body).toMatchObject({ code: 'MANAGER_LIMIT' });
    const d = ok(await mgr.c.post('/v1/delegations', { delegateId: rep.userId, roleKey: 'manager', endsAt, reason: 'İzin' }), 201);
    expect(d).toMatchObject({ roleKey: 'manager', active: true });
    expect(ok(await admin.get(`/v1/users/${rep.userId}/access`)).roles).toEqual(['manager', 'sales_rep']);
    // Expiry: no job needed for the permission to end — the next request no longer carries it.
    await superQuery(SUPER(), `UPDATE user_roles SET valid_until = now() - interval '1 second' WHERE tenant_id = $1 AND user_id = $2 AND valid_until IS NOT NULL`, [tenantId, rep.userId]);
    expect(ok(await admin.get(`/v1/users/${rep.userId}/access`)).roles).toEqual(['sales_rep']);
    // A fresh delegation, then revoke ends it at once.
    const d2 = ok(await admin.post('/v1/delegations', { delegateId: rep.userId, segments: ['b2c'], endsAt }), 201);
    expect((ok(await admin.get(`/v1/users/${rep.userId}/access`)).segments as Json[]).map((s) => s.segment)).toEqual(['b2b', 'b2c']);
    ok(await admin.post(`/v1/delegations/${String(d2.id)}/revoke`));
    expect((ok(await admin.get(`/v1/users/${rep.userId}/access`)).segments as Json[]).map((s) => s.segment)).toEqual(['b2b']);
    expect((ok(await rep.c.get('/v1/delegations')).data as Json[]).length).toBe(2);
  });

  it('access requests: the manager approves within limits; closed requests cannot be decided again', async () => {
    const { c: admin } = await workspace();
    const team = String(ok(await admin.post('/v1/teams', { name: uniq('Ekip ') }), 201).id);
    const mgr = await member(admin, 'manager', { teamId: team, teamRole: 'manager' });
    const rep = await member(admin, 'sales_rep', { teamId: team, segments: ['b2b'] });
    const r1 = ok(await rep.c.post('/v1/access-requests', { segments: ['b2c'], reason: 'Perakende müşterileri', validUntil: new Date(Date.now() + 86_400_000).toISOString() }), 201);
    expect((await rep.c.post('/v1/access-requests', { segments: ['b2c'], reason: 'tekrar' })).status).toBe(409);
    const r2 = ok(await rep.c.post('/v1/access-requests', { roleKey: 'admin', reason: 'Lütfen' }), 201);
    expect((ok(await mgr.c.get('/v1/access-requests')).data as Json[]).length).toBe(2);
    expect((await mgr.c.post(`/v1/access-requests/${String(r2.id)}/decision`, { decision: 'approve' })).body.code).toBe('MANAGER_LIMIT');
    ok(await mgr.c.post(`/v1/access-requests/${String(r1.id)}/decision`, { decision: 'approve', note: 'Uygun' }));
    expect((ok(await admin.get(`/v1/users/${rep.userId}/access`)).segments as Json[]).map((s) => s.segment)).toEqual(['b2b', 'b2c']);
    expect((await mgr.c.post(`/v1/access-requests/${String(r1.id)}/decision`, { decision: 'reject' })).status).toBe(409);
    ok(await rep.c.post(`/v1/access-requests/${String(r2.id)}/withdraw`));
    expect((await admin.post(`/v1/access-requests/${String(r2.id)}/decision`, { decision: 'approve' })).status).toBe(409);
    expect((await rep.c.post(`/v1/access-requests/${String(r1.id)}/decision`, { decision: 'approve' })).status).toBe(403);
  });
});

describe('matrix administration (A03, AUTH-11)', () => {
  it('previews, applies on the next request, versions, rolls back and protects Admin', async () => {
    const { c: admin } = await signupAndLogin(h); // CRM off at first
    const rep = await member(admin, 'sales_rep');
    const m0 = ok(await admin.get('/v1/authz/matrix'));
    const perms0 = new Set((m0.cells as Json[]).map((c) => c.permission));
    expect(perms0.has('tasks.view') || perms0.has('*record*.read')).toBe(true);
    expect([...perms0].some((p) => String(p).startsWith('sales_b2b.'))).toBe(false); // disabled module hidden
    const change = { changes: [{ roleKey: 'sales_rep', permission: '*record*.create', grant: null }], note: 'Temsilciler görev açamasın' };
    const diff = ok(await admin.post('/v1/authz/matrix/preview', change));
    expect(diff.changes).toEqual([{ roleKey: 'sales_rep', permission: '*record*.create', before: { mode: 'full', scope: 'own' }, after: null }]);
    expect(ok(await rep.c.post('/v1/tasks', { title: 'önce' }), 201)).toBeTruthy();
    const m1 = ok(await admin.put('/v1/authz/matrix', change));
    expect(m1.version).toBe(1);
    expect((await rep.c.post('/v1/tasks', { title: 'sonra' })).status).toBe(403);
    // A second change, then roll back to version 1 (recorded as version 3).
    ok(await admin.put('/v1/authz/matrix', { changes: [{ roleKey: 'analyst', permission: '*record*.read', grant: null }] }));
    const v = ok(await admin.get('/v1/authz/matrix/versions')).data as Json[];
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    const restored = ok(await admin.post('/v1/authz/matrix/versions/1/restore'));
    expect(restored.version).toBe(3);
    const cell = (restored.cells as Json[]).find((c) => c.roleKey === 'analyst' && c.permission === '*record*.read');
    expect(cell).toMatchObject({ overridden: false, grant: { mode: 'read', scope: 'all' } });
    // Setting a grant back to the shipped value removes the override.
    ok(await admin.put('/v1/authz/matrix', { changes: [{ roleKey: 'sales_rep', permission: '*record*.create', grant: { mode: 'full', scope: 'own' } }] }));
    expect(ok(await rep.c.post('/v1/tasks', { title: 'yine' }), 201)).toBeTruthy();
    // Protected permissions stay with Admin; unknown vocabulary is rejected; only Admin edits.
    expect((await admin.put('/v1/authz/matrix', { changes: [{ roleKey: 'admin', permission: 'users.manage', grant: null }] })).body.code).toBe('MATRIX_INVALID');
    expect((await admin.put('/v1/authz/matrix', { changes: [{ roleKey: 'manager', permission: 'nope.perm', grant: null }] })).body.code).toBe('MATRIX_INVALID');
    expect((await admin.put('/v1/authz/matrix', { changes: [{ roleKey: 'manager', permission: 'audit.read', grant: { mode: 'read', scope: 'all', policy: 'made_up' } }] })).body.code).toBe('MATRIX_INVALID');
    expect((await rep.c.put('/v1/authz/matrix', change)).status).toBe(403);
    expect((await rep.c.get('/v1/authz/matrix')).status).toBe(403);
  });
});

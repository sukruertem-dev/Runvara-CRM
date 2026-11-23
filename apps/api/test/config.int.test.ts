import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P7a configuration engine (docs/p7-plan.md §6): schema validation, layers, versions, diff, revert, brand
// contrast, logo sanitizing, authorization and tenant isolation.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
type Json = Record<string, unknown>;

const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const put = (c: Client, url: string, body: unknown, ifMatch: string) => c.req('PUT', url, body, { 'if-match': ifMatch });

async function member(admin: Client, role: string): Promise<Client> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return c;
}

describe('configuration layers', () => {
  it('validates against the schema, versions every write and shows the diff', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    const first = ok(await c.get('/v1/config/locale?scope=tenant'));
    expect(first).toMatchObject({ version: 0, value: {}, effective: { language: 'tr', timezone: 'Europe/Istanbul' } });

    // Out of schema: unknown property, wrong enum, unknown time zone.
    for (const value of [{ colour: 'red' }, { language: 'de' }, { timezone: 'Europe/Ankara' }]) {
      const r = await put(c, '/v1/config/locale?scope=tenant', { value }, '0');
      expect(r.status, JSON.stringify(value)).toBe(422);
      expect(r.body.code).toBe('CONFIG_INVALID');
      expect((r.body.errors as Json[])[0]).toMatchObject({ code: 'CONFIG_INVALID' });
    }
    expect((await c.put('/v1/config/locale?scope=tenant', { value: { language: 'en' } })).status).toBe(428);

    const preview = ok(await c.post('/v1/config/locale/preview?scope=tenant', { value: { timezone: 'America/New_York', dateFormat: 'mdy' } }));
    expect(preview).toMatchObject({ valid: true, patch: [{ op: 'add', path: '/timezone', value: 'America/New_York' }, { op: 'add', path: '/dateFormat', value: 'mdy' }] });

    const v1 = ok(await put(c, '/v1/config/locale?scope=tenant', { value: { timezone: 'America/New_York', dateFormat: 'mdy' }, note: 'Ofis taşındı' }, '0'));
    expect(v1).toMatchObject({ version: 1, effective: { timezone: 'America/New_York', dateFormat: 'mdy', language: 'tr' }, sources: { timezone: 'tenant', language: 'platform' } });
    // Stale writer.
    expect((await put(c, '/v1/config/locale?scope=tenant', { value: { language: 'en' } }, '0')).status).toBe(412);
    ok(await put(c, '/v1/config/locale?scope=tenant', { value: { timezone: 'Europe/Istanbul', language: 'en' } }, '1'));

    // The tenant row follows (SLA calendars and relative dates read it).
    const [tenant] = await superQuery<{ timezone: string; locale: string }>(SUPER(), 'SELECT timezone, locale FROM tenants WHERE id = $1', [tenantId]);
    expect(tenant).toEqual({ timezone: 'Europe/Istanbul', locale: 'en-US' });

    const hist = ok(await c.get('/v1/config/locale/history?scope=tenant'));
    expect(hist.current).toBe(2);
    const versions = hist.data as Json[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    // jsonb does not keep key order, so the patch is compared as a set.
    expect(versions[0]).toMatchObject({ createdBy: { name: 'Ayşe Yılmaz' } });
    expect(versions[0]?.patch).toHaveLength(3);
    expect(versions[0]?.patch).toEqual(expect.arrayContaining([{ op: 'remove', path: '/dateFormat' }, { op: 'replace', path: '/timezone', value: 'Europe/Istanbul' }, { op: 'add', path: '/language', value: 'en' }]));
    expect(versions[1]).toMatchObject({ note: 'Ofis taşındı' });

    // Revert = the old value as a new version; history is kept.
    const reverted = ok(await c.req('POST', '/v1/config/locale/revert?scope=tenant', { version: 1, note: 'Geri' }, { 'if-match': '2' }));
    expect(reverted).toMatchObject({ version: 3, value: { timezone: 'America/New_York', dateFormat: 'mdy' } });
    const after = ok(await c.get('/v1/config/locale/history?scope=tenant'));
    expect((after.data as Json[]).map((v) => [v.version, v.revertedFrom])).toEqual([[3, 1], [2, null], [1, null]]);
    expect((await c.req('POST', '/v1/config/locale/revert?scope=tenant', { version: 9 }, { 'if-match': '3' })).status).toBe(404);

    // Audit and event: which key changed, never the value in the event.
    const audits = await superQuery<{ action: string }>(SUPER(), `SELECT action FROM audit_log WHERE tenant_id = $1 AND target_type = 'config' ORDER BY at, id`, [tenantId]);
    expect(audits.map((a) => a.action)).toEqual(['config.changed', 'config.changed', 'config.reverted']);
    const events = await superQuery<{ payload: Json }>(SUPER(), `SELECT payload FROM outbox_events WHERE tenant_id = $1 AND type = 'config.changed' ORDER BY id`, [tenantId]);
    expect(events.map((e) => e.payload)).toEqual([1, 2, 3].map((version) => ({ key: 'locale', scope: 'tenant', version })));

    // History rows are immutable (trigger), whoever connects.
    await expect(superQuery(SUPER(), `UPDATE tenant_settings SET value = '{}' WHERE tenant_id = '${tenantId}'`)).rejects.toThrow();
  });

  it('merges tenant and user layers and refuses layers a key does not allow', async () => {
    const { c } = await signupAndLogin(h);
    ok(await put(c, '/v1/config/ui?scope=tenant', { value: { density: 'compact' } }, '0'));
    ok(await put(c, '/v1/config/ui?scope=user', { value: { theme: 'dark' } }, '0'));
    const eff = ok(await c.get('/v1/config'));
    expect((eff.data as Json).ui).toEqual({ value: { theme: 'dark', density: 'compact' }, sources: { theme: 'user', density: 'tenant' } });

    // The tenant layer view does not include the caller's own override.
    expect(ok(await c.get('/v1/config/ui?scope=tenant')).effective).toEqual({ theme: 'system', density: 'compact' });

    // Removing the override falls back to the tenant default.
    const removed = ok(await c.req('DELETE', '/v1/config/ui?scope=user', undefined, { 'if-match': '1' }));
    expect(removed).toMatchObject({ version: 2, value: {}, effective: { theme: 'system' } });
    expect((await c.req('DELETE', '/v1/config/ui?scope=tenant', undefined, { 'if-match': '1' })).status).toBe(400);

    const notOverridable = await put(c, '/v1/config/brand?scope=user', { value: { accent: '#1D4ED8' } }, '0');
    expect(notOverridable.status).toBe(422);
    expect(notOverridable.body.code).toBe('CONFIG_KEY_NOT_OVERRIDABLE');
    const unknown = await c.get('/v1/config/telephony.provider?scope=tenant');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('CONFIG_KEY_UNKNOWN');
    expect((await c.get('/v1/config/ui?scope=team')).status).toBe(400);
  });

  it('applies the tenant notification defaults to users without their own choice', async () => {
    const { c } = await signupAndLogin(h);
    ok(await put(c, '/v1/config/notifications.defaults?scope=tenant', { value: { mention: ['in_app', 'email'] } }, '0'));
    const prefs = ok(await c.get('/v1/notifications/preferences')).data as Json[];
    expect(prefs.find((p) => p.kind === 'mention')?.channels).toEqual(['in_app', 'email']);
    expect(prefs.find((p) => p.kind === 'assigned')?.channels).toEqual(['in_app']);
    expect((await put(c, '/v1/config/notifications.defaults?scope=tenant', { value: { mention: ['fax'] } }, '1')).status).toBe(422);
  });
});

describe('brand', () => {
  it('derives accessible accent tokens and rejects a color that cannot be fixed', async () => {
    const { c } = await signupAndLogin(h);
    const preview = ok(await c.post('/v1/config/brand/preview?scope=tenant', { value: { accent: '#10B981' } }));
    const brand = preview.brand as Json;
    expect(brand).toMatchObject({ ok: true, adjusted: true });
    expect((brand.checks as Json[]).every((x) => x.pass === true)).toBe(true);

    const bad = ok(await c.post('/v1/config/brand/preview?scope=tenant', { value: { accent: '#FFFF00' } }));
    expect(bad).toMatchObject({ valid: false, brand: { ok: false, tokens: null } });
    const refused = await put(c, '/v1/config/brand?scope=tenant', { value: { accent: '#FFFF00' } }, '0');
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BRAND_CONTRAST_UNSATISFIABLE');

    ok(await put(c, '/v1/config/brand?scope=tenant', { value: { accent: '#10B981' } }, '0'));
    const eff = ok(await c.get('/v1/config'));
    expect((eff.brand as Json).tokens).toMatchObject({ light: { 'accent-btn': expect.stringMatching(/^#[0-9A-F]{6}$/) }, dark: { accent: expect.any(String) } });
  });

  it('stores a sanitized SVG logo and serves it with a sandboxing policy', async () => {
    const { c } = await signupAndLogin(h);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script>alert(1)</script><rect width="4" height="4" fill="#0F766E" onclick="x()"/></svg>';
    const up = ok(await c.post('/v1/brand/logo', { mime: 'image/svg+xml', dataBase64: Buffer.from(svg).toString('base64') }), 201);
    expect(up).toMatchObject({ mime: 'image/svg+xml', sanitized: true });
    expect((await c.get('/v1/brand/logo')).status).toBe(404);
    ok(await put(c, '/v1/config/brand?scope=tenant', { value: { logoAssetId: up.assetId } }, '0'));
    const logo = await c.get('/v1/brand/logo');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toBe('image/svg+xml');
    expect(String(logo.headers['content-security-policy'])).toContain('sandbox');
    expect(String(logo.body.raw)).not.toMatch(/script|onclick/);

    const fakePng = await c.post('/v1/brand/logo', { mime: 'image/png', dataBase64: Buffer.from('not a png').toString('base64') });
    expect(fakePng.status).toBe(422);
    expect(fakePng.body.code).toBe('ASSET_INVALID');
    const unknownAsset = await put(c, '/v1/config/brand?scope=tenant', { value: { logoAssetId: '0190d0a4-0000-7000-8000-000000000000' } }, '1');
    expect(unknownAsset.status).toBe(422);
  });
});

describe('authorization and isolation', () => {
  it('lets a manager read but not write, keeps sales out, and keeps user layers private', async () => {
    const { c: admin } = await signupAndLogin(h);
    ok(await put(admin, '/v1/config/currency?scope=tenant', { value: { code: 'EUR' } }, '0'));
    const manager = await member(admin, 'manager');
    expect(ok(await manager.get('/v1/config/currency?scope=tenant')).effective).toEqual({ code: 'EUR', decimals: 2 });
    expect(ok(await manager.get('/v1/config/currency/history?scope=tenant')).current).toBe(1);
    expect((await put(manager, '/v1/config/currency?scope=tenant', { value: { code: 'USD' } }, '1')).status).toBe(403);
    expect((await manager.post('/v1/brand/logo', { mime: 'image/svg+xml', dataBase64: Buffer.from('<svg/>').toString('base64') })).status).toBe(403);

    const rep = await member(admin, 'sales_rep');
    expect((await rep.get('/v1/config/currency?scope=tenant')).status).toBe(403);
    expect((await rep.get('/v1/config/keys')).status).toBe(403);
    // Everyone gets the effective configuration and manages their own preferences.
    expect(((ok(await rep.get('/v1/config')).data as Json).currency as Json).value).toEqual({ code: 'EUR', decimals: 2 });
    ok(await put(rep, '/v1/config/locale?scope=user', { value: { language: 'en' } }, '0'));
    // The admin's user layer is the admin's own, not the rep's.
    expect(ok(await admin.get('/v1/config/locale?scope=user'))).toMatchObject({ version: 0, value: {} });
  });

  it('never shows one tenant’s settings or logo to another', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    ok(await put(a.c, '/v1/config/brand?scope=tenant', { value: { accent: '#0F766E' } }, '0'));
    const up = ok(await a.c.post('/v1/brand/logo', { mime: 'image/svg+xml', dataBase64: Buffer.from('<svg><circle r="1"/></svg>').toString('base64') }), 201);
    ok(await put(a.c, '/v1/config/brand?scope=tenant', { value: { accent: '#0F766E', logoAssetId: up.assetId } }, '1'));

    expect(ok(await b.c.get('/v1/config/brand?scope=tenant'))).toMatchObject({ version: 0, effective: { accent: null, logoAssetId: null } });
    expect((ok(await b.c.get('/v1/config')).brand as Json)).toEqual({ tokens: null, logo: null });
    expect((await b.c.get('/v1/brand/logo')).status).toBe(404);
    // B cannot point its brand at A's asset id.
    expect((await put(b.c, '/v1/config/brand?scope=tenant', { value: { logoAssetId: up.assetId } }, '0')).status).toBe(422);
    expect(ok(await b.c.get('/v1/config/brand/history?scope=tenant')).data).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P8a (docs/p8-plan.md): product catalogue, price lists and price resolution, cost visibility, primary teams.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const rows = (b: Json): Json[] => b.data as Json[];

async function workspace() {
  const admin = await signupAndLogin(h);
  ok(await admin.c.post('/v1/modules/crm/enable'));
  return admin;
}

async function member(admin: Client, role: string, segments: string[] = ['b2b', 'b2c']) {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const login = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  const userId = (login.user as { id: string }).id;
  ok(await admin.put(`/v1/users/${userId}/segments`, { segments: segments.map((segment) => ({ segment })) }));
  return { c, userId };
}

const product = async (c: Client, sku: string, extra: Json = {}) => String(ok(await c.post('/v1/products', { sku, name: `Ürün ${sku}`, segments: ['b2b', 'b2c'], ...extra }), 201).id);
const list = async (c: Client, name: string, extra: Json = {}) => String(ok(await c.post('/v1/price-lists', { name, currency: 'TRY', ...extra }), 201).id);
const price = async (c: Client, listId: string, productId: string, breaks: [string, string][]) => {
  ok(await c.put(`/v1/price-lists/${listId}/products/${productId}`, { breaks: breaks.map(([minQty, unitPrice]) => ({ minQty, unitPrice })) }), 204);
};
/** One product's resolved price. */
async function resolve(c: Client, productId: string, body: Json = {}, quantity = '1'): Promise<Json> {
  const r = ok(await c.post('/v1/prices/resolve', { items: [{ productId, quantity }], segment: 'b2b', ...body }));
  return rows(r)[0]!;
}

describe('catalogue', () => {
  it('Admin manages; other roles read only; duplicate SKU, stale versions and unknown tax rates are refused', async () => {
    const { c } = await workspace();
    const rep = await member(c, 'sales_rep');
    const tax = ok(await c.post('/v1/tax-rates', { name: 'KDV %20', rate: '20' }), 201);
    expect((await c.post('/v1/tax-rates', { name: 'kdv %20', rate: '18' })).status).toBe(409);
    const id = await product(c, 'AB-1', { taxRateId: tax.id, category: 'Donanım' });
    expect((await c.post('/v1/products', { sku: 'ab-1', name: 'x', segments: ['b2b'] })).status).toBe(409);
    expect((await c.post('/v1/products', { sku: 'AB-2', name: 'x', segments: ['b2b'], taxRateId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await c.patchJson(`/v1/products/${id}`, { name: 'Yeni' })).status).toBe(428);
    ok(await c.patchJson(`/v1/products/${id}`, { name: 'Yeni ad' }, '"1"'));
    expect((await c.patchJson(`/v1/products/${id}`, { name: 'Eski' }, '"1"')).status).toBe(412);

    expect(ok(await rep.c.get(`/v1/products/${id}`)).name).toBe('Yeni ad');
    expect((await rep.c.post('/v1/products', { sku: 'R-1', name: 'x', segments: ['b2b'] })).status).toBe(403);
    expect((await rep.c.patchJson(`/v1/products/${id}`, { name: 'x' }, '"2"')).status).toBe(403);
    expect((await rep.c.post('/v1/price-lists', { name: 'x', currency: 'TRY' })).status).toBe(403);
    expect((await rep.c.put('/v1/fx-rates', { base: 'USD', quote: 'TRY', validOn: '2026-01-01', rate: '40' })).status).toBe(403);

    ok(await c.patchJson(`/v1/products/${id}`, { active: false }, '"2"'));
    expect(rows(ok(await c.get('/v1/products')))).toEqual([]);
    expect(rows(ok(await c.get('/v1/products?active=all')))).toHaveLength(1);
  });

  it('pages by name with a signed cursor and treats search text literally', async () => {
    const { c } = await workspace();
    for (const s of ['c1', 'a1', 'b1', 'd_1']) await product(c, s);
    const p1 = ok(await c.get('/v1/products?limit=3'));
    const next = (p1.page as { nextCursor: string }).nextCursor;
    const p2 = ok(await c.get(`/v1/products?limit=3&cursor=${encodeURIComponent(next)}`));
    expect([...rows(p1), ...rows(p2)].map((p) => p.sku)).toEqual(['a1', 'b1', 'c1', 'd_1']);
    expect((await c.get(`/v1/products?limit=3&q=a&cursor=${encodeURIComponent(next)}`)).status).toBe(400);
    expect(rows(ok(await c.get('/v1/products?q=_'))).map((p) => p.sku)).toEqual(['d_1']);
  });

  it('cost and margin reach only those who may see them, on every surface', async () => {
    const { c, tenantId } = await workspace();
    const rep = await member(c, 'sales_rep');
    const mgr = await member(c, 'manager');
    const id = await product(c, 'COST-1', { cost: { amount: '61.4321', currency: 'TRY' } });
    const l = await list(c, 'Genel');
    await price(c, l, id, [['1', '100']]);
    expect(ok(await c.get(`/v1/products/${id}`)).cost).toEqual({ amount: '61.4321', currency: 'TRY' });
    expect(JSON.stringify(ok(await c.get(`/v1/price-lists/${l}/items`)))).toContain('"marginPercent":"38.57"');
    // The Manager's grant depends on a tenant policy that is off by default.
    for (const u of [rep, mgr]) {
      for (const url of [`/v1/products/${id}`, '/v1/products', `/v1/price-lists/${l}/items`]) {
        const body = JSON.stringify(ok(await u.c.get(url)));
        expect(body).not.toMatch(/cost|margin|61\.4/);
      }
    }
    ok(await c.patchJson(`/v1/products/${id}`, { cost: { amount: '70.5', currency: 'TRY' } }, '"1"'));
    const log = await superQuery<{ details: Json }>(SUPER(), `SELECT details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'product.%'`, [tenantId]);
    expect(JSON.stringify(log)).not.toContain('70.5');
    // A role that may edit products but not see costs cannot write them either.
    expect(ok(await c.patchJson(`/v1/products/${id}`, { cost: null }, '"2"')).cost).toBeNull();
  });

  it('segments: a product, list or price of the other segment does not exist for the caller', async () => {
    const { c } = await workspace();
    const b2b = await member(c, 'sales_rep', ['b2b']);
    const shop = await product(c, 'SHOP', { segments: ['b2c'] });
    const both = await product(c, 'BOTH');
    const l = await list(c, 'Perakende', { segment: 'b2c' });
    const general = await list(c, 'Genel');
    await price(c, l, both, [['1', '80']]);
    await price(c, general, shop, [['1', '5']]);
    await price(c, general, both, [['1', '100']]);
    expect((await b2b.c.get(`/v1/products/${shop}`)).status).toBe(404);
    expect((await b2b.c.get(`/v1/price-lists/${l}/items`)).status).toBe(404);
    const lists = rows(ok(await b2b.c.get('/v1/price-lists')));
    expect(lists.map((x) => [x.name, x.productCount])).toEqual([['Genel', 1]]);
    expect(rows(ok(await b2b.c.get(`/v1/price-lists/${general}/items`))).map((x) => x.sku)).toEqual(['BOTH']);
    expect((await b2b.c.post('/v1/prices/resolve', { items: [{ productId: both }], segment: 'b2c' })).status).toBe(422);
    expect((await b2b.c.post('/v1/prices/resolve', { items: [{ productId: shop }], segment: 'b2b' })).status).toBe(404);
    // A b2c-only product is not sold in b2b even to someone who sees both.
    expect((await c.post('/v1/prices/resolve', { items: [{ productId: shop }], segment: 'b2b' })).status).toBe(404);
  });

  it('another workspace sees nothing and cannot refer to it; a closed module answers 404', async () => {
    const a = await workspace();
    const b = await workspace();
    const id = await product(a.c, 'A-1');
    const l = await list(a.c, 'A listesi');
    const mine = await list(b.c, 'B listesi');
    expect((await b.c.get(`/v1/products/${id}`)).status).toBe(404);
    expect((await b.c.get(`/v1/price-lists/${l}/items`)).status).toBe(404);
    expect((await b.c.put(`/v1/price-lists/${mine}/products/${id}`, { breaks: [{ minQty: '1', unitPrice: '1' }] })).status).toBe(404);
    expect((await b.c.post('/v1/prices/resolve', { items: [{ productId: id }], segment: 'b2b' })).status).toBe(404);
    expect(rows(ok(await b.c.get('/v1/products')))).toEqual([]);
    const off = await signupAndLogin(h);
    for (const url of ['/v1/products', '/v1/price-lists', '/v1/tax-rates', '/v1/fx-rates']) expect((await off.c.get(url)).body.code).toBe('MODULE_DISABLED');
  });
});

describe('price resolution (G3)', () => {
  it('customer list beats segment list beats general list; a list without the product falls through', async () => {
    const { c } = await workspace();
    const p = await product(c, 'P1');
    const q = await product(c, 'P2');
    const acc = String(ok(await c.post('/v1/accounts', { name: 'Özel Müşteri', segments: ['b2b'] }), 201).id);
    const other = String(ok(await c.post('/v1/accounts', { name: 'Başka Müşteri', segments: ['b2b'] }), 201).id);
    const general = await list(c, 'Genel');
    const seg = await list(c, 'B2B', { segment: 'b2b' });
    const special = await list(c, 'Anlaşma', { accountId: acc });
    expect(await resolve(c, p)).toMatchObject({ price: null, reason: 'no_price' });
    await price(c, general, p, [['1', '100']]);
    await price(c, general, q, [['1', '40']]);
    await price(c, seg, p, [['1', '90']]);
    await price(c, special, p, [['1', '75']]);
    expect((await resolve(c, p)).price).toMatchObject({ unitPrice: '90.0000', source: 'segment' });
    expect((await resolve(c, p, { segment: 'b2c' })).price).toMatchObject({ unitPrice: '100.0000', source: 'general' });
    expect((await resolve(c, p, { accountId: acc })).price).toMatchObject({ unitPrice: '75.0000', source: 'account', priceListName: 'Anlaşma' });
    expect((await resolve(c, p, { accountId: other })).price).toMatchObject({ source: 'segment' });
    expect((await resolve(c, q, { accountId: acc })).price).toMatchObject({ unitPrice: '40.0000', source: 'general' });
  });

  it('quantity breaks, validity dates, deactivation and the newest list within a level', async () => {
    const { c } = await workspace();
    const p = await product(c, 'P1');
    const year = await list(c, '2026', { validFrom: '2026-01-01', validTo: '2026-12-31' });
    const half = await list(c, '2026-2', { validFrom: '2026-07-01' });
    await price(c, year, p, [['1', '100'], ['10', '90'], ['100', '80']]);
    await price(c, half, p, [['5', '70']]);
    const on = (date: string, qty = '1') => resolve(c, p, { date }, qty);
    expect((await on('2026-03-01')).price).toMatchObject({ unitPrice: '100.0000', minQty: '1' });
    expect((await on('2026-03-01', '9.999')).price).toMatchObject({ unitPrice: '100.0000' });
    expect((await on('2026-03-01', '10')).price).toMatchObject({ unitPrice: '90.0000', minQty: '10' });
    expect((await on('2026-03-01', '250')).price).toMatchObject({ unitPrice: '80.0000' });
    // The newer list wins where it has a price for that quantity; below its minimum the older one applies.
    expect((await on('2026-08-01', '5')).price).toMatchObject({ unitPrice: '70.0000' });
    expect((await on('2026-08-01', '1')).price).toMatchObject({ unitPrice: '100.0000' });
    expect((await on('2027-01-01', '1')).reason).toBe('no_price');
    ok(await c.patchJson(`/v1/price-lists/${half}`, { active: false }, '"2"'));
    expect((await on('2026-08-01', '5')).price).toMatchObject({ unitPrice: '100.0000' });
    expect((await c.post('/v1/price-lists', { name: 'x', currency: 'TRY', validFrom: '2026-02-01', validTo: '2026-01-01' })).status).toBe(400);
    expect((await c.put(`/v1/price-lists/${year}/products/${p}`, { breaks: [{ minQty: '1', unitPrice: '1' }, { minQty: '1.0', unitPrice: '2' }] })).status).toBe(400);
    ok(await c.patchJson(`/v1/products/${p}`, { active: false }, '"1"'));
    expect(await on('2026-03-01')).toMatchObject({ price: null, reason: 'inactive' });
  });

  it('currency: the requested currency first, then the latest rate on or before the date, the inverse, or no rate', async () => {
    const { c } = await workspace();
    const p = await product(c, 'P1');
    const usd = await list(c, 'USD listesi', { currency: 'USD' });
    await price(c, usd, p, [['1', '10.1234']]);
    const on = (date: string, currency = 'TRY') => resolve(c, p, { date, currency });
    expect(await on('2026-05-01')).toMatchObject({ price: null, reason: 'no_rate' });
    ok(await c.put('/v1/fx-rates', { base: 'USD', quote: 'TRY', validOn: '2026-04-01', rate: '40' }), 204);
    ok(await c.put('/v1/fx-rates', { base: 'USD', quote: 'TRY', validOn: '2026-05-10', rate: '41.5' }), 204);
    expect(await on('2026-03-31')).toMatchObject({ reason: 'no_rate' });
    expect((await on('2026-05-09')).price).toMatchObject({ unitPrice: '404.9360', currency: 'TRY', listCurrency: 'USD', listUnitPrice: '10.1234', fxRate: '40' });
    expect((await on('2026-05-10')).price).toMatchObject({ unitPrice: '420.1211', fxRate: '41.5' });
    ok(await c.put('/v1/fx-rates', { base: 'EUR', quote: 'USD', validOn: '2026-05-01', rate: '1.25' }), 204);
    expect((await on('2026-05-10', 'EUR')).price).toMatchObject({ unitPrice: '8.0987', fxRate: '0.8' });
    // Same level: a list in the requested currency beats a newer converted one.
    const tl = await list(c, 'TL listesi', { validFrom: '2020-01-01' });
    await price(c, tl, p, [['1', '399']]);
    expect((await on('2026-05-10')).price).toMatchObject({ unitPrice: '399.0000', fxRate: null });
    ok(await c.del('/v1/fx-rates?base=USD&quote=TRY&validOn=2026-05-10'), 204);
    expect((await c.del('/v1/fx-rates?base=USD&quote=TRY&validOn=2026-05-10')).status).toBe(404);
  });

  it('a customer list follows the customer: invisible to those who cannot read the account, moved by a merge', async () => {
    const { c } = await workspace();
    const rep = await member(c, 'sales_rep');
    const p = await product(c, 'P1');
    const acc = String(ok(await c.post('/v1/accounts', { name: 'Gizli Anlaşma', segments: ['b2b'] }), 201).id);
    const general = await list(c, 'Genel');
    const special = await list(c, 'Gizli Anlaşma listesi', { accountId: acc });
    await price(c, general, p, [['1', '100']]);
    await price(c, special, p, [['1', '55']]);
    expect(JSON.stringify(ok(await rep.c.get('/v1/price-lists')))).not.toContain('Gizli');
    expect((await rep.c.get(`/v1/price-lists/${special}/items`)).status).toBe(404);
    expect((await rep.c.post('/v1/prices/resolve', { items: [{ productId: p }], segment: 'b2b', accountId: acc })).status).toBe(404);
    ok(await c.post(`/v1/accounts/${acc}/shares`, { grantee: { type: 'user', id: rep.userId } }), 201);
    expect((await resolve(rep.c, p, { accountId: acc })).price).toMatchObject({ unitPrice: '55.0000', source: 'account' });
    const survivor = String(ok(await c.post('/v1/accounts', { name: 'Asıl Müşteri', segments: ['b2b'] }), 201).id);
    const merged = await c.post('/v1/accounts/merge', { survivorId: survivor, mergedIds: [acc] });
    expect(merged.status, JSON.stringify(merged.body)).toBeLessThan(300);
    expect((await resolve(c, p, { accountId: survivor })).price).toMatchObject({ unitPrice: '55.0000' });
  });
});

describe('primary team', () => {
  it('first team is primary; leaving it picks the next; only managers of the teams involved may change it', async () => {
    const { c } = await workspace();
    const team = async (name: string) => String(ok(await c.post('/v1/teams', { name }), 201).id);
    const [a, b, other] = [await team('A'), await team('B'), await team('C')];
    const rep = await member(c, 'sales_rep');
    const mgr = await member(c, 'manager');
    for (const tm of [a, b]) {
      ok(await c.put(`/v1/teams/${tm}/members/${mgr.userId}`, { role: 'manager' }));
      ok(await c.put(`/v1/teams/${tm}/members/${rep.userId}`, {}));
    }
    const primary = async () => {
      const teams = rows(ok(await c.get('/v1/teams')));
      return teams.filter((x) => (x.members as Json[]).some((m) => m.userId === rep.userId && m.primary === true)).map((x) => x.name);
    };
    expect(await primary()).toEqual(['A']);
    ok(await mgr.c.put(`/v1/users/${rep.userId}/primary-team`, { teamId: b }), 204);
    expect(await primary()).toEqual(['B']);
    expect((await c.put(`/v1/users/${rep.userId}/primary-team`, { teamId: other })).body.code).toBe('OWNER_INVALID');
    expect((await rep.c.put(`/v1/users/${rep.userId}/primary-team`, { teamId: a })).status).toBe(403);
    ok(await c.del(`/v1/teams/${b}/members/${rep.userId}`), 204);
    expect(await primary()).toEqual(['A']);
    // Moving someone out of a team the Manager does not manage is refused.
    ok(await c.put(`/v1/teams/${other}/members/${rep.userId}`, {}));
    ok(await c.put(`/v1/users/${rep.userId}/primary-team`, { teamId: other }), 204);
    expect((await mgr.c.put(`/v1/users/${rep.userId}/primary-team`, { teamId: a })).body.code).toBe('MANAGER_LIMIT');
    ok(await c.del(`/v1/teams/${other}/members/${rep.userId}`), 204);
    ok(await c.del(`/v1/teams/${a}/members/${rep.userId}`), 204);
    expect(await primary()).toEqual([]);
  });
});

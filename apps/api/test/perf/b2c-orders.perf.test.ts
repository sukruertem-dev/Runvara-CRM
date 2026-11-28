import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as dsql } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from '../harness';

// G5 acceptance (AC-G5-4, docs/p9-plan.md §46): the B2C order list answers with p95 < 200 ms with 100 000 orders.
// Measured in-process (Fastify inject: auth, tenant guard, RLS, the customer's record scope) against PostgreSQL 18 in a
// container. Results are written to docs/perf/p9-b2c-orders.md.
const N = 100_000;
const CUSTOMERS = 5_000;
const REQUESTS = 200;
const P95_BUDGET_MS = 200;

let h: Harness;
let admin: Client;
let rep: Client;
let tenantId = '';

function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? 0;
}
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;

beforeAll(async () => {
  h = await startHarness();
  const a = await signupAndLogin(h);
  admin = a.c;
  tenantId = a.tenantId;
  for (const m of ['crm', 'sales_b2c']) await admin.post(`/v1/modules/${m}/enable`);
  const email = `${uniq('rep')}@firma.test`;
  await admin.post('/v1/invitations', { email, roleKey: 'sales_rep' });
  rep = new Client(h.app);
  await rep.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: 'Satış' });
  const repId = ((await rep.post('/v1/auth/login', { email, password: PASSWORD })).body.user as { id: string }).id;
  const [adminRow] = await superQuery<{ id: string }>(SUPER(), `SELECT user_id AS id FROM memberships m JOIN user_roles ur USING (tenant_id, user_id) JOIN roles r ON r.id = ur.role_id WHERE m.tenant_id = $1 AND r.key = 'admin'`, [tenantId]);
  // 5 000 B2C customers, every 10th owned by the sales rep.
  await superQuery(SUPER(), `
    INSERT INTO contacts (tenant_id, first_name, last_name, segments, owner_user_id, created_by)
    SELECT $1, 'Müşteri', g::text, '{b2c}', CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END, CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END
    FROM generate_series(1, ${CUSTOMERS}) g`, [tenantId, adminRow!.id, repId]);
  // 100 000 orders spread over the customers, channels, statuses and payment states.
  await superQuery(SUPER(), `
    INSERT INTO orders (tenant_id, number, segment, customer_id, channel, status, payment_status, currency, totals, created_by, created_at)
    SELECT $1, 'SP-P-' || lpad(g::text, 6, '0'), 'b2c', c.id,
      (ARRAY['web', 'store', 'phone', 'social'])[1 + g % 4], (ARRAY['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled'])[1 + (g / 4) % 8],
      (ARRAY['pending', 'paid', 'paid', 'paid'])[1 + g % 4], 'TRY', jsonb_build_object('net', '200.00', 'tax', '40.00', 'total', '240.00'), $2, now() - g * interval '1 minute'
    FROM generate_series(1, ${N}) g
    JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM contacts WHERE tenant_id = $1) c ON c.n = 1 + g % ${CUSTOMERS}`, [tenantId, adminRow!.id]);
  await superQuery(SUPER(), 'ANALYZE orders; ANALYZE contacts; ANALYZE record_registry');
}, 600_000);

afterAll(async () => {
  await h.close();
});

describe(`B2C order list performance (${N} orders)`, () => {
  it(`p95 < ${P95_BUDGET_MS} ms for the main list shapes`, async () => {
    const someone = (await superQuery<{ id: string }>(SUPER(), `SELECT id FROM contacts WHERE tenant_id = $1 ORDER BY id LIMIT 1 OFFSET 77`, [tenantId]))[0]?.id ?? '';
    const scenarios: { name: string; client: () => Client; url: string }[] = [
      { name: 'Admin, newest first, limit 50', client: () => admin, url: '/v1/sales/b2c/orders?limit=50' },
      { name: 'Admin, status = delivered', client: () => admin, url: '/v1/sales/b2c/orders?status=delivered&limit=50' },
      { name: 'Admin, channel = phone and status = new', client: () => admin, url: '/v1/sales/b2c/orders?channel=phone&status=new&limit=50' },
      { name: 'Admin, one customer (customer 360)', client: () => admin, url: `/v1/sales/b2c/orders?customerId=${someone}&limit=50` },
      { name: 'Admin, page 5 via cursor', client: () => admin, url: '' },
      { name: 'Sales rep (own customers), newest first', client: () => rep, url: '/v1/sales/b2c/orders?limit=50' },
      { name: 'Sales rep, status = new', client: () => rep, url: '/v1/sales/b2c/orders?status=new&limit=50' },
    ];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r: Awaited<ReturnType<Client['get']>> = await admin.get(`/v1/sales/b2c/orders?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      cursor = r.body.nextCursor as string | null;
    }
    scenarios[4]!.url = `/v1/sales/b2c/orders?limit=50&cursor=${cursor ?? ''}`;

    const rows: string[] = [];
    for (const s of scenarios) {
      const client = s.client();
      for (let i = 0; i < 10; i++) await client.get(s.url);
      const times: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const t0 = performance.now();
        const r = await client.get(s.url);
        times.push(performance.now() - t0);
        expect(r.status).toBe(200);
        expect((r.body.data as unknown[]).length).toBeGreaterThan(0);
      }
      times.sort((a, b) => a - b);
      const p95 = pct(times, 95);
      rows.push(`| ${s.name} | ${REQUESTS} | ${pct(times, 50).toFixed(1)} | ${p95.toFixed(1)} | ${pct(times, 99).toFixed(1)} | ${p95 < P95_BUDGET_MS ? '✅' : '❌'} |`);
      expect.soft(p95, s.name).toBeLessThan(P95_BUDGET_MS);
    }
    const plan = await superQuery<{ 'QUERY PLAN': string }>(SUPER(), `
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT o.id FROM orders o JOIN contacts t ON t.tenant_id = o.tenant_id AND t.id = o.customer_id
      WHERE o.tenant_id = $1 AND o.segment = 'b2c' AND t.deleted_at IS NULL ORDER BY o.id DESC LIMIT 51`, [tenantId]);
    const statusPlan = await superQuery<{ 'QUERY PLAN': string }>(SUPER(), `
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT o.id FROM orders o JOIN contacts t ON t.tenant_id = o.tenant_id AND t.id = o.customer_id
      WHERE o.tenant_id = $1 AND o.segment = 'b2c' AND o.status = 'delivered' AND t.deleted_at IS NULL ORDER BY o.id DESC LIMIT 51`, [tenantId]);
    // The same filtered list as the app runs it: app role, RLS, parameters (drizzle).
    const [adminUser] = await superQuery<{ id: string }>(SUPER(), `SELECT created_by AS id FROM orders WHERE tenant_id = $1 LIMIT 1`, [tenantId]);
    const appPlan = (await h.db.withTenant({ tenantId, userId: adminUser!.id, segments: ['b2c'] }, (tx) => tx.execute<{ 'QUERY PLAN': string }>(dsql`
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      WITH page AS MATERIALIZED (
        SELECT o.id FROM orders o WHERE o.segment = 'b2c' AND o.status = ${'delivered'}
          AND EXISTS (SELECT 1 FROM contacts t WHERE t.tenant_id = o.tenant_id AND t.id = o.customer_id AND t.deleted_at IS NULL AND TRUE)
        ORDER BY o.id DESC LIMIT ${51})
      SELECT o.id, o.number, t.full_name, u.display_name FROM page JOIN orders o ON o.id = page.id JOIN contacts t ON t.id = o.customer_id JOIN users u ON u.id = o.created_by
      ORDER BY o.id DESC`))).rows;
    const out = resolve(__dirname, '../../../../docs/perf');
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, 'p9-b2c-orders.md'), [
      '# B2C sipariş listesi performansı (P9f, AC-G5-4)',
      '',
      `> Üretildi: ${new Date().toISOString()} · \`pnpm --filter @flexa/api test:perf\` · ${N} sipariş, ${CUSTOMERS} müşteri, senaryo başına ${REQUESTS} ardışık istek (10 ısınma isteği hariç).`,
      '> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, müşteriden türeyen kayıt kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.',
      '',
      '| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      '## Ana liste sorgusunun planı (EXPLAIN ANALYZE)',
      '',
      '```text',
      ...plan.map((p) => p['QUERY PLAN']),
      '```',
      '',
      '## Durum süzgeçli sorgunun planı',
      '',
      '```text',
      ...statusPlan.map((p) => p['QUERY PLAN']),
      '```',
      '',
      '## Uygulama rolüyle (RLS, parametreli) aynı sorgu',
      '',
      '```text',
      ...appPlan.map((p) => p['QUERY PLAN']),
      '```',
      '',
    ].join('\n'));
  }, 900_000);
});

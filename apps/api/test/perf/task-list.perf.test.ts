import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from '../harness';

// Faz 2 acceptance: list API p95 < 200 ms with 10 000 tasks (ADR-0012 cursor pagination, ADR-0004 scope).
// Measured in-process (Fastify inject: full HTTP pipeline, auth, tenant guard, RLS, RQL) against
// PostgreSQL 18 in a container. Results are written to docs/perf/p2-task-list.md.
const N = 10_000;
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

beforeAll(async () => {
  h = await startHarness();
  const a = await signupAndLogin(h);
  admin = a.c;
  tenantId = a.tenantId;
  const email = `${uniq('rep')}@firma.test`;
  await admin.post('/v1/invitations', { email, roleKey: 'sales_rep' });
  rep = new Client(h.app);
  await rep.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: 'Satış' });
  const login = await rep.post('/v1/auth/login', { email, password: PASSWORD });
  const repId = (login.body.user as { id: string }).id;
  const [adminRow] = await superQuery<{ id: string }>(process.env.TEST_SUPER_DATABASE_URL!, `SELECT user_id AS id FROM memberships m JOIN user_roles ur USING (tenant_id, user_id) JOIN roles r ON r.id = ur.role_id WHERE m.tenant_id = $1 AND r.key = 'admin'`, [tenantId]);
  // 10 000 tasks: 10 % owned by the sales rep, mixed statuses, priorities, due dates and NULLs.
  await superQuery(process.env.TEST_SUPER_DATABASE_URL!, `
    INSERT INTO tasks (tenant_id, title, workflow_id, status_id, priority, owner_type, owner_id, owner_user_id, due_at, position, created_by, created_at)
    SELECT $1, 'Görev ' || g, w.id, (array_agg(s.id ORDER BY s.position))[1 + (g % 4)], g % 5, 'user',
           CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END, CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END,
           CASE WHEN g % 7 = 0 THEN NULL ELSE now() + (g % 90) * interval '1 day' END,
           'a' || lpad(g::text, 6, '0'), CASE WHEN g % 10 = 0 THEN $3::uuid ELSE $2::uuid END, now() - g * interval '1 minute'
    FROM generate_series(1, ${N}) g
    CROSS JOIN LATERAL (SELECT id FROM workflows WHERE tenant_id = $1 AND is_default) w
    JOIN statuses s ON s.workflow_id = w.id
    GROUP BY g, w.id`, [tenantId, adminRow!.id, repId]);
  await superQuery(process.env.TEST_SUPER_DATABASE_URL!, 'ANALYZE tasks');
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe(`task list performance (${N} tasks)`, () => {
  it(`p95 < ${P95_BUDGET_MS} ms for the main list shapes`, async () => {
    const scenarios: { name: string; client: () => Client; url: string }[] = [
      { name: 'Admin, default sort (created desc), limit 50', client: () => admin, url: '/v1/tasks?limit=50' },
      { name: 'Admin, RQL filter + sort by due (NULLS LAST)', client: () => admin, url: `/v1/tasks?q=${encodeURIComponent('priority >= 3 AND statusCategory != closed')}&sort=due&limit=50` },
      { name: 'Admin, page 5 via cursor', client: () => admin, url: '' },
      { name: 'Admin, with total count', client: () => admin, url: '/v1/tasks?limit=50&count=true' },
      { name: 'Sales rep (own scope), default sort', client: () => rep, url: '/v1/tasks?limit=50' },
    ];
    // cursor for page 5
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r: Awaited<ReturnType<Client['get']>> = await admin.get(`/v1/tasks?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      cursor = (r.body.page as { nextCursor: string }).nextCursor;
    }
    scenarios[2]!.url = `/v1/tasks?limit=50&cursor=${encodeURIComponent(cursor ?? '')}`;

    const rows: string[] = [];
    for (const s of scenarios) {
      const client = s.client();
      for (let i = 0; i < 10; i++) await client.get(s.url); // warm-up
      const times: number[] = [];
      for (let i = 0; i < REQUESTS; i++) {
        const t0 = performance.now();
        const r = await client.get(s.url);
        times.push(performance.now() - t0);
        expect(r.status).toBe(200);
      }
      times.sort((a, b) => a - b);
      const p50 = pct(times, 50);
      const p95 = pct(times, 95);
      rows.push(`| ${s.name} | ${REQUESTS} | ${p50.toFixed(1)} | ${p95.toFixed(1)} | ${pct(times, 99).toFixed(1)} | ${p95 < P95_BUDGET_MS ? '✅' : '❌'} |`);
      expect.soft(p95, s.name).toBeLessThan(P95_BUDGET_MS);
    }
    const plan = await superQuery<{ 'QUERY PLAN': string }>(process.env.TEST_SUPER_DATABASE_URL!, `
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT t.id FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id
      WHERE t.tenant_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at DESC, t.id DESC LIMIT 51`, [tenantId]);
    const out = resolve(__dirname, '../../../../docs/perf');
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, 'p2-task-list.md'), [
      '# P2 — Görev listesi performansı',
      '',
      `> Üretildi: ${new Date().toISOString()} · \`pnpm --filter @flexa/api test:perf\` · ${N} görev, senaryo başına ${REQUESTS} ardışık istek (10 ısınma isteği hariç).`,
      '> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.',
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
    ].join('\n'));
  }, 600_000);
});

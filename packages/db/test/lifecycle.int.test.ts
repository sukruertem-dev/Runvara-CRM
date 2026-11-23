import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { copyTenant, createDb, migrate, sql, type DbHandle } from '../src/index';
import { startTestDatabase, superQuery, type TestDatabase } from '../src/testing';

// P7c (docs/p7-plan.md §15): tenant deletion removes exactly one tenant's rows (append-only tables included),
// destroys its data key and anonymises people who belonged nowhere else; a tenant restored from a backup copy
// comes back complete (TEN-05, TEN-11).

let tdb: TestDatabase;
let db: DbHandle;
let restoreUrl = '';
const A = { tenant: randomUUID(), user: randomUUID() };
const B = { tenant: randomUUID(), user: randomUUID() };

async function seed(t: { tenant: string; user: string }, i: number): Promise<void> {
  const q = (text: string, values: unknown[] = []) => superQuery(tdb.superUrl, text, values);
  await q(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [t.tenant, `life-${String(i)}-x`, `Life ${String(i)}`]);
  await q(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [t.user, `life${String(i)}@example.test`, `Kişi ${String(i)}`]);
  await q(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, 'x')`, [t.user]);
  await q(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [t.tenant, t.user]);
  const [role] = await q(`INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'admin', 'Admin', true) RETURNING id`, [t.tenant]);
  await q(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [t.tenant, t.user, role!.id]);
  await q(`INSERT INTO tenant_keys (tenant_id, version, wrapped_dek) VALUES ($1, 1, '\\x0102')`, [t.tenant]);
  await q(`INSERT INTO tenant_plans (tenant_id, plan_id) VALUES ($1, 'starter')`, [t.tenant]);
  await q(`INSERT INTO audit_log (tenant_id, action, actor_type, actor_id) VALUES ($1, 'test.seed', 'system', NULL)`, [t.tenant]);
  await q(`INSERT INTO tenant_settings (tenant_id, scope_type, scope_id, key, version, value, schema_version) VALUES ($1, 'tenant', $1, 'ui', 1, '{"theme":"dark"}', 1)`, [t.tenant]);
  await q(`INSERT INTO tenant_settings_head (tenant_id, scope_type, scope_id, key, version) VALUES ($1, 'tenant', $1, 'ui', 1)`, [t.tenant]);
  await q(`INSERT INTO tenant_assets (tenant_id, kind, mime, bytes, sha256) VALUES ($1, 'logo', 'image/png', '\\x89504e47', decode(repeat('ab', 32), 'hex'))`, [t.tenant]);
  await q(`SELECT app.seed_task_workflow($1)`, [t.tenant]);
  await q(`SELECT app.seed_crm_workflows($1)`, [t.tenant]);
}

async function counts(url: string, tenantId: string): Promise<Record<string, number>> {
  const tables = await superQuery<{ table_name: string }>(url, `SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name NOT IN ('operator_actions', 'auth_events', 'auth_sessions')`);
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [r] = await superQuery<{ n: number }>(url, `SELECT count(*)::int AS n FROM "${table_name}" WHERE tenant_id = $1`, [tenantId]);
    if ((r?.n ?? 0) > 0) out[table_name] = r!.n;
  }
  return out;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  await seed(A, 0);
  await seed(B, 1);
  // A second database on the same server stands in for a restored backup.
  await superQuery(tdb.superUrl, 'CREATE DATABASE flexa_restore OWNER flexa_owner');
  restoreUrl = tdb.superUrl.replace(/\/flexa$/, '/flexa_restore');
  const su = new pg.Client({ connectionString: restoreUrl });
  await su.connect();
  try {
    await su.query('ALTER SCHEMA public OWNER TO flexa_owner; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO flexa_app, flexa_relay; GRANT CONNECT ON DATABASE flexa_restore TO flexa_owner, flexa_app, flexa_relay');
  } finally {
    await su.end();
  }
  await migrate(tdb.ownerUrl.replace(/\/flexa$/, '/flexa_restore'));
}, 240_000);

afterAll(async () => {
  await db.close();
  await tdb.stop();
});

/** The database error behind a failed query (drizzle wraps it in `cause`). */
const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'no error', (e: unknown) => (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message);

describe('tenant deletion and restore', () => {
  it('refuses to purge a tenant that is not due', async () => {
    expect(await failure(db.withAnonymous((tx) => tx.execute(sql`SELECT app.purge_tenant(${A.tenant})`)))).toMatch(/not due/);
    await superQuery(tdb.superUrl, `UPDATE tenants SET status = 'pending_deletion', deletion_scheduled_at = now() + interval '1 day' WHERE id = $1`, [A.tenant]);
    expect(await failure(db.withAnonymous((tx) => tx.execute(sql`SELECT app.purge_tenant(${A.tenant})`)))).toMatch(/not due/);
  });

  it('purges exactly one tenant, shreds its key, anonymises its only member; a backup copy restores it', async () => {
    await superQuery(tdb.superUrl, `UPDATE tenants SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = $1`, [A.tenant]);
    const before = await counts(tdb.superUrl, A.tenant);
    const bBefore = await counts(tdb.superUrl, B.tenant);
    expect(before).toMatchObject({ audit_log: 1, tenant_settings: 1, tenant_keys: 1, memberships: 1 });

    // The backup: a copy taken before the deletion.
    await copyTenant(tdb.superUrl, restoreUrl, A.tenant);
    expect(await counts(restoreUrl, A.tenant)).toEqual(before);

    const r = await db.withAnonymous((tx) => tx.execute<{ c: Record<string, number> }>(sql`SELECT app.purge_tenant(${A.tenant}) AS c`));
    expect(r.rows[0]?.c).toMatchObject({ audit_log: 1, tenant_keys: 1, memberships: 1 });
    expect(await counts(tdb.superUrl, A.tenant)).toEqual({});
    expect(await counts(tdb.superUrl, B.tenant)).toEqual(bBefore);
    const [tenant] = await superQuery<{ status: string; slug: string; name: string }>(tdb.superUrl, 'SELECT status, slug, name FROM tenants WHERE id = $1', [A.tenant]);
    expect(tenant).toMatchObject({ status: 'deleted', name: 'Silinmiş çalışma alanı' });
    expect(tenant?.slug).toMatch(/^deleted-[0-9a-f]{12}$/);
    const [user] = await superQuery<{ email: string; status: string }>(tdb.superUrl, 'SELECT email, status FROM users WHERE id = $1', [A.user]);
    expect(user).toEqual({ email: `deleted+${A.user}@invalid`, status: 'disabled' });
    expect(await superQuery(tdb.superUrl, 'SELECT 1 FROM user_credentials WHERE user_id = $1', [A.user])).toHaveLength(0);
    const evidence = await superQuery<{ action: string; operator_user_id: string | null }>(tdb.superUrl, 'SELECT action, operator_user_id FROM operator_actions WHERE tenant_id = $1', [A.tenant]);
    expect(evidence).toEqual([{ action: 'tenant.purged', operator_user_id: null }]);
    // Append-only tables still refuse deletes outside a purge.
    await expect(superQuery(tdb.superUrl, 'DELETE FROM audit_log WHERE tenant_id = $1', [B.tenant])).rejects.toThrow(/append-only/);

    // TEN-11: restore from the backup copy.
    const restored = await copyTenant(restoreUrl, tdb.superUrl, A.tenant);
    expect(restored.tenants).toBe(1);
    expect(await counts(tdb.superUrl, A.tenant)).toEqual(before);
    const [back] = await superQuery<{ email: string }>(tdb.superUrl, 'SELECT email FROM users WHERE id = $1', [A.user]);
    expect(back?.email).toBe('life0@example.test');
    const [slug] = await superQuery<{ slug: string }>(tdb.superUrl, 'SELECT slug FROM tenants WHERE id = $1', [A.tenant]);
    expect(slug?.slug).toBe('life-0-x');
    // A second restore into a populated tenant is refused.
    await expect(copyTenant(restoreUrl, tdb.superUrl, A.tenant)).rejects.toThrow(/already holds rows/);
  });
});

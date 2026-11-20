import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, GLOBAL_TABLES, schema, eq, sql, type DbHandle } from '../src/index';
import { rawAppClient, startTestDatabase, superQuery, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
let db: DbHandle;
const A = { tenant: randomUUID(), user: randomUUID() };
const B = { tenant: randomUUID(), user: randomUUID() };

/** Inserts one row into every tenant table for both tenants (as superuser, bypassing RLS). */
async function seed(): Promise<void> {
  for (const [i, t] of [A, B].entries()) {
    const q = (text: string, values: unknown[]) => superQuery(tdb.superUrl, text, values);
    await q(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [t.tenant, `tenant-${i}-x`, `Tenant ${i}`]);
    await q(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [t.user, `u${i}@example.test`, `User ${i}`]);
    await q(`INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, 'h')`, [t.user]);
    await q(`INSERT INTO memberships (tenant_id, user_id) VALUES ($1, $2)`, [t.tenant, t.user]);
    const [role] = await q(`INSERT INTO roles (tenant_id, key, name, is_system) VALUES ($1, 'admin', 'Admin', true) RETURNING id`, [t.tenant]);
    await q(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [t.tenant, t.user, role!.id]);
    await q(`INSERT INTO invitations (tenant_id, email, role_key, token_hash, invited_by, expires_at)
             VALUES ($1, $2, 'admin', $3, $4, now() + interval '1 day')`, [t.tenant, `inv${i}@example.test`, Buffer.from(`tok${i}`), t.user]);
    await q(`INSERT INTO tenant_modules (tenant_id, module_id, enabled) VALUES ($1, 'core', true)`, [t.tenant]);
    await q(`INSERT INTO tenant_keys (tenant_id, version, wrapped_dek) VALUES ($1, 1, '\\x00')`, [t.tenant]);
    await q(`INSERT INTO tenant_sso_providers (tenant_id, kind, name, issuer, client_id, client_secret_enc, key_version)
             VALUES ($1, 'oidc', 'IdP', 'https://idp.example.test', 'c', '\\x00', 1)`, [t.tenant]);
    await q(`INSERT INTO audit_log (tenant_id, action, actor_type, actor_id) VALUES ($1, 'test.seed', 'system', NULL)`, [t.tenant]);
    const [sess] = await q(`INSERT INTO auth_sessions (user_id, amr) VALUES ($1, '{pwd}') RETURNING id`, [t.user]);
    await q(`INSERT INTO refresh_tokens (session_id, user_id, family_id, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, now() + interval '1 day')`, [sess!.id, t.user, randomUUID(), Buffer.from(`rt${i}`)]);
    await q(`INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, 'verify_email', $2, now() + interval '1 day')`, [t.user, Buffer.from(`et${i}`)]);
    await q(`INSERT INTO auth_events (user_id, kind) VALUES ($1, 'test.seed')`, [t.user]);
  }
}

/** Drizzle wraps driver errors ("Failed query: …"); the PostgreSQL message is on `cause`. */
async function expectDbError(p: Promise<unknown>, re: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e as Error & { cause?: Error });
  expect(err, 'expected the database to reject').not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ''}`).toMatch(re);
}

async function publicTables(): Promise<{ name: string; hasTenantId: boolean; rls: boolean; forced: boolean }[]> {
  return superQuery(
    tdb.superUrl,
    `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS "hasTenantId"
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
  );
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  db = createDb(tdb.appUrl);
  await seed();
});

afterAll(async () => {
  await db.close();
  await tdb.stop();
});

describe('schema guard (ADR-0003 §5)', () => {
  it('every public table has forced RLS, and has tenant_id unless it is on the closed global list', async () => {
    const tables = await publicTables();
    expect(tables.length).toBeGreaterThan(10);
    for (const t of tables) {
      expect.soft(t.rls, `${t.name} RLS enabled`).toBe(true);
      expect.soft(t.forced, `${t.name} RLS forced`).toBe(true);
      if (!(GLOBAL_TABLES as readonly string[]).includes(t.name)) {
        expect.soft(t.hasTenantId, `${t.name} must have tenant_id or be in GLOBAL_TABLES`).toBe(true);
      }
    }
  });

  it('every tenant table carries a RESTRICTIVE tenant_isolation policy', async () => {
    const tables = (await publicTables()).filter((t) => t.hasTenantId && !(GLOBAL_TABLES as readonly string[]).includes(t.name));
    const policies = await superQuery<{ tablename: string; permissive: string }>(
      tdb.superUrl,
      `SELECT tablename, permissive FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    for (const t of tables) {
      const p = policies.find((x) => x.tablename === t.name);
      expect.soft(p?.permissive, `${t.name} tenant_isolation`).toBe('RESTRICTIVE');
    }
  });

  it('every table with a segment column carries a RESTRICTIVE segment policy (ADR-0010)', async () => {
    // Configuration tables whose segment is a default/filter, not a visibility boundary (queue membership
    // and workflow choice are decided in P4 with user segment grants).
    const configOnly = new Set(['queues', 'workflows']);
    const cols = await superQuery<{ table_name: string }>(tdb.superUrl, `
      SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('segment', 'segments')`);
    const policies = await superQuery<{ tablename: string; permissive: string }>(tdb.superUrl,
      `SELECT tablename, permissive FROM pg_policies WHERE schemaname = 'public' AND policyname = 'segment_isolation'`);
    expect(cols.length).toBeGreaterThan(5);
    for (const { table_name } of cols) {
      if (configOnly.has(table_name)) continue;
      expect.soft(policies.find((p) => p.tablename === table_name)?.permissive, `${table_name} segment_isolation`).toBe('RESTRICTIVE');
    }
  });

  it('flexa_app cannot bypass RLS and owns no table', async () => {
    const [role] = await superQuery<{ rolbypassrls: boolean; rolsuper: boolean }>(
      tdb.superUrl, `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'flexa_app'`);
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await superQuery(tdb.superUrl, `SELECT relname FROM pg_class WHERE relowner = 'flexa_app'::regrole`);
    expect(owned).toEqual([]);
  });
});

describe('tenant isolation at the database level', () => {
  const tenantTables = ['memberships', 'roles', 'user_roles', 'invitations', 'tenant_modules', 'tenant_keys', 'tenant_sso_providers', 'audit_log'];
  const userTables = ['users', 'user_credentials', 'auth_sessions', 'refresh_tokens', 'email_tokens', 'auth_events'];

  it('without context every table returns zero rows', async () => {
    for (const t of [...tenantTables, ...userTables, 'tenants']) {
      const rows = await db.withAnonymous((tx) => tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${t}`)));
      expect.soft(rows.rows[0], t).toEqual({ n: 0 });
    }
  });

  it('a raw connection that never sets context sees nothing and cannot disable row security', async () => {
    const c = await rawAppClient(tdb.appUrl);
    try {
      expect((await c.query('SELECT count(*)::int AS n FROM memberships')).rows[0]).toEqual({ n: 0 });
      expect((await c.query('SELECT count(*)::int AS n FROM users')).rows[0]).toEqual({ n: 0 });
      await c.query('SET row_security = off');
      await expect(c.query('SELECT count(*) FROM memberships')).rejects.toThrow(/row-level security/i);
    } finally {
      await c.end();
    }
  });

  it('tenant A sees exactly its own rows in every tenant table', async () => {
    for (const t of tenantTables) {
      const rows = await db.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) =>
        tx.execute(sql.raw(`SELECT DISTINCT tenant_id::text AS t FROM ${t}`)));
      expect.soft(rows.rows, t).toEqual([{ t: A.tenant }]);
    }
    const tenants = await db.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) => tx.select().from(schema.tenants));
    expect(tenants.map((r) => r.id)).toEqual([A.tenant]);
  });

  it('tenant A cannot read, update or delete tenant B rows by id', async () => {
    const [bInv] = await superQuery<{ id: string }>(tdb.superUrl, `SELECT id FROM invitations WHERE tenant_id = $1`, [B.tenant]);
    await db.withTenant({ tenantId: A.tenant, userId: A.user }, async (tx) => {
      expect(await tx.select().from(schema.invitations).where(eq(schema.invitations.id, bInv!.id))).toEqual([]);
      const upd = await tx.update(schema.invitations).set({ roleKey: 'hacked' }).where(eq(schema.invitations.id, bInv!.id)).returning();
      expect(upd).toEqual([]);
      const upTenant = await tx.update(schema.tenants).set({ name: 'hacked' }).where(eq(schema.tenants.id, B.tenant)).returning();
      expect(upTenant).toEqual([]);
    });
    const [after] = await superQuery<{ role_key: string }>(tdb.superUrl, `SELECT role_key FROM invitations WHERE id = $1`, [bInv!.id]);
    expect(after!.role_key).toBe('admin');
  });

  it('tenant A cannot insert rows for tenant B or move its rows to tenant B', async () => {
    await expectDbError(
      db.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) =>
        tx.insert(schema.tenantModules).values({ tenantId: B.tenant, moduleId: 'crm', enabled: true, config: {} })),
      /row-level security/i,
    );
    await expectDbError(
      db.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) =>
        tx.update(schema.tenantModules).set({ tenantId: B.tenant }).where(eq(schema.tenantModules.tenantId, A.tenant))),
      /row-level security/i,
    );
  });

  it('user context sees only its own identity rows; tenant context sees only members of that tenant', async () => {
    const own = await db.withUser(A.user, (tx) => tx.select({ id: schema.users.id }).from(schema.users));
    expect(own).toEqual([{ id: A.user }]);
    for (const t of userTables) {
      const rows = await db.withUser(A.user, (tx) => tx.execute(sql.raw(`SELECT DISTINCT user_id::text AS u FROM ${t === 'users' ? '(SELECT id AS user_id FROM users) x' : t}`)));
      expect.soft(rows.rows, t).toEqual([{ u: A.user }]);
    }
    const members = await db.withTenant({ tenantId: A.tenant, userId: null }, (tx) => tx.select({ id: schema.users.id }).from(schema.users));
    expect(members).toEqual([{ id: A.user }]);
  });

  it('context does not leak between pooled transactions', async () => {
    const small = createDb(tdb.appUrl, { max: 1 });
    try {
      await small.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) => tx.select().from(schema.roles));
      const after = await small.withAnonymous((tx) => tx.execute(sql`SELECT current_setting('app.tenant_id', true) AS t, count(*)::int AS n FROM roles`));
      expect(after.rows[0]).toMatchObject({ n: 0 });
      expect([null, '']).toContain((after.rows[0] as { t: string | null }).t);
    } finally {
      await small.close();
    }
  });

  it('withTenant rejects malformed ids before touching the database', async () => {
    await expect(db.withTenant({ tenantId: "x' OR 1=1 --", userId: null }, () => Promise.resolve(1))).rejects.toThrow(TypeError);
  });
});

describe('append-only tables', () => {
  it('audit_log rejects UPDATE and DELETE, even for the owner role', async () => {
    await expect(db.withTenant({ tenantId: A.tenant, userId: A.user }, (tx) => tx.execute(sql`UPDATE audit_log SET action = 'x'`))).rejects.toThrow();
    const owner = createDb(tdb.ownerUrl, { max: 1 });
    try {
      await expectDbError(owner.withAnonymous((tx) => tx.execute(sql`DELETE FROM audit_log`)), /append-only/);
      await expectDbError(owner.withAnonymous((tx) => tx.execute(sql`UPDATE auth_events SET kind = 'x'`)), /append-only/);
      await expectDbError(owner.withAnonymous((tx) => tx.execute(sql`TRUNCATE audit_log`)), /append-only/);
    } finally {
      await owner.close();
    }
  });
});

describe('SECURITY DEFINER resolvers', () => {
  it('list_my_tenants is bound to app.user_id(), not to a caller-supplied id', async () => {
    const none = await db.withAnonymous((tx) => tx.execute(sql`SELECT * FROM app.list_my_tenants()`));
    expect(none.rows).toEqual([]);
    const mine = await db.withUser(A.user, (tx) => tx.execute(sql`SELECT tenant_id::text AS t, role_keys FROM app.list_my_tenants()`));
    expect(mine.rows).toEqual([{ t: A.tenant, role_keys: ['admin'] }]);
  });

  it('find_refresh_token resolves only by exact hash', async () => {
    const hit = await db.withAnonymous((tx) => tx.execute(sql`SELECT user_id::text AS u FROM app.find_refresh_token(${Buffer.from('rt0')})`));
    expect(hit.rows).toEqual([{ u: A.user }]);
    const miss = await db.withAnonymous((tx) => tx.execute(sql`SELECT * FROM app.find_refresh_token(${Buffer.from('nope')})`));
    expect(miss.rows).toEqual([]);
  });

  it('consume_email_token works once', async () => {
    const first = await db.withAnonymous((tx) => tx.execute(sql`SELECT app.consume_email_token(${Buffer.from('et1')}, 'verify_email') AS u`));
    expect(first.rows).toEqual([{ u: B.user }]);
    const second = await db.withAnonymous((tx) => tx.execute(sql`SELECT app.consume_email_token(${Buffer.from('et1')}, 'verify_email') AS u`));
    expect(second.rows).toEqual([{ u: null }]);
  });

  it('flexa_app cannot call owner-only helpers it was not granted', async () => {
    await expect(db.withAnonymous((tx) => tx.execute(sql`SELECT app.forbid_mutation()`))).rejects.toThrow();
  });
});

import pg from 'pg';

// Operations tooling (P7c, docs/ops/tenant-restore.md). Both functions use privileged connections: the owner
// for granting operators, a superuser for restores (foreign keys and append-only triggers are switched off
// for the copy with session_replication_role, which only a superuser may set).

/** Adds or removes a platform operator by e-mail (TEN-08). The account must exist and should use 2FA. */
export async function setOperator(ownerUrl: string, email: string, grant: boolean): Promise<'granted' | 'revoked' | 'unchanged'> {
  const c = new pg.Client({ connectionString: ownerUrl, application_name: 'flexa-ops' });
  await c.connect();
  try {
    const u = await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    const id = u.rows[0]?.id;
    if (!id) throw new Error(`no account with e-mail ${email}`);
    const r = grant
      ? await c.query('INSERT INTO platform_operators (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id])
      : await c.query('DELETE FROM platform_operators WHERE user_id = $1', [id]);
    return (r.rowCount ?? 0) === 0 ? 'unchanged' : grant ? 'granted' : 'revoked';
  } finally {
    await c.end();
  }
}

const BATCH = 5_000;

/** Rows as PostgreSQL renders them in JSON (bytea as \x hex, timestamps ISO): exactly what
 *  json_populate_recordset reads back on the target. */
async function jsonRows(c: pg.Client, query: string, params: unknown[]): Promise<unknown[]> {
  return (await c.query<{ j: unknown }>(`SELECT row_to_json(x) AS j FROM (${query}) x`, params)).rows.map((r) => r.j);
}

/**
 * Copies one tenant's rows from `sourceUrl` (a restored backup) into `targetUrl` in one transaction (TEN-11).
 * The target must not hold rows of the tenant (a deleted tenant's tombstone is overwritten). Members' accounts
 * are copied when missing and restored when the deletion anonymised them. Returns rows copied per table.
 */
export async function copyTenant(sourceUrl: string, targetUrl: string, tenantId: string): Promise<Record<string, number>> {
  const src = new pg.Client({ connectionString: sourceUrl, application_name: 'flexa-restore-source' });
  const dst = new pg.Client({ connectionString: targetUrl, application_name: 'flexa-restore-target' });
  await src.connect();
  await dst.connect();
  const counts: Record<string, number> = {};
  try {
    const tenant = await jsonRows(src, 'SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tenant.length === 0) throw new Error(`tenant ${tenantId} is not in the source`);
    await dst.query('BEGIN');
    await dst.query("SET LOCAL session_replication_role = 'replica'");
    await dst.query("SET LOCAL statement_timeout = '0'");
    const existing = await dst.query<{ status: string }>('SELECT status FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    const tables = (await dst.query<{ table_name: string }>(`SELECT DISTINCT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name NOT IN ('tenants', 'auth_sessions', 'auth_events')
      ORDER BY c.table_name`)).rows.map((r) => r.table_name);
    for (const t of tables) {
      const n = await dst.query<{ n: string }>(`SELECT count(*) AS n FROM ${pg.escapeIdentifier(t)} WHERE tenant_id = $1`, [tenantId]);
      if (Number(n.rows[0]?.n ?? 0) > 0 && t !== 'operator_actions') throw new Error(`target already holds rows of the tenant in ${t}; delete or purge it first`);
    }
    const insert = async (table: string, rows: unknown[], conflict = '') => {
      if (rows.length === 0) return;
      const cols = (await dst.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [table])).rows.map((r) => pg.escapeIdentifier(r.column_name)).join(', ');
      const t = pg.escapeIdentifier(table);
      const r = await dst.query(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::${t}, $1::json) ${conflict}`, [JSON.stringify(rows)]);
      counts[table] = (counts[table] ?? 0) + (r.rowCount ?? 0);
    };
    if (existing.rows.length > 0) await dst.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await insert('tenants', tenant);
    // Accounts of the members: missing ones are copied, anonymised ones get their data back.
    const members = (await src.query<{ user_id: string }>('SELECT DISTINCT user_id FROM memberships WHERE tenant_id = $1', [tenantId])).rows.map((r) => r.user_id);
    if (members.length > 0) {
      const users = await jsonRows(src, 'SELECT * FROM users WHERE id = ANY($1)', [members]);
      await insert('users', users, `ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, status = EXCLUDED.status
        WHERE users.email LIKE 'deleted+%@invalid'`);
      for (const t of ['user_credentials', 'user_mfa']) {
        await insert(t, await jsonRows(src, `SELECT * FROM ${t} WHERE user_id = ANY($1)`, [members]), 'ON CONFLICT DO NOTHING');
      }
    }
    for (const t of tables) {
      if (t === 'operator_actions') continue;
      for (let offset = 0; ; offset += BATCH) {
        const batch = await jsonRows(src, `SELECT * FROM ${pg.escapeIdentifier(t)} WHERE tenant_id = $1 ORDER BY ctid LIMIT ${String(BATCH)} OFFSET ${String(offset)}`, [tenantId]);
        await insert(t, batch);
        if (batch.length < BATCH) break;
      }
    }
    await dst.query('COMMIT');
    return counts;
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await src.end();
    await dst.end();
  }
}

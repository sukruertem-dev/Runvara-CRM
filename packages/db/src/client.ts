import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string | null;
  readonly segments?: readonly ('b2b' | 'b2c')[];
}

export interface DbHandle {
  /** Runs fn in a transaction bound to a tenant (and optionally a user). RLS sees only that tenant. */
  withTenant<T>(ctx: TenantContext, fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs fn in a transaction bound to a user only (identity tables, no tenant data visible). */
  withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T>;
  /** Runs fn with no context: only SECURITY DEFINER resolvers in schema `app` return rows. */
  withAnonymous<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new TypeError(`${name} must be a UUID`);
}

export function createDb(connectionString: string, options: { max?: number; applicationName?: string } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'flexa',
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });

  async function inTransaction<T>(settings: Record<string, string>, fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const entries = Object.entries(settings);
      if (entries.length > 0) {
        // set_config(..., true) == SET LOCAL: scoped to this transaction, never leaks to the pool.
        const parts = entries.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`);
        await client.query(`SELECT ${parts.join(', ')}`, entries.flat());
      }
      const result = await fn(drizzle(client, { schema }));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async withTenant(ctx, fn) {
      assertUuid(ctx.tenantId, 'tenantId');
      if (ctx.userId !== null) assertUuid(ctx.userId, 'userId');
      // Runtime guard for untyped callers: segments end up in a SQL array literal.
      for (const s of ctx.segments ?? []) {
        const v: string = s;
        if (v !== 'b2b' && v !== 'b2c') throw new TypeError('invalid segment');
      }
      return inTransaction(
        {
          'app.tenant_id': ctx.tenantId,
          'app.user_id': ctx.userId ?? '',
          'app.segments': `{${(ctx.segments ?? []).join(',')}}`,
        },
        fn,
      );
    },
    async withUser(userId, fn) {
      assertUuid(userId, 'userId');
      return inTransaction({ 'app.user_id': userId }, fn);
    },
    withAnonymous(fn) {
      return inTransaction({}, fn);
    },
    async ping() {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    },
    close() {
      return pool.end();
    },
  };
}

/** First row of an INSERT … RETURNING (or any query that must yield a row); throws instead of `!`. */
export function one<T>(rows: readonly T[], what = 'row'): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected one ${what}, got none`);
  return row;
}

/** Helper for SECURITY DEFINER calls: `await db.execute(call('app.slug_available', slug))`. */
export function call(fn: `app.${string}`, ...args: unknown[]): SQL {
  const params = args.map((a) => sql`${a}`);
  return sql`SELECT * FROM ${sql.raw(fn)}(${sql.join(params, sql`, `)})`;
}

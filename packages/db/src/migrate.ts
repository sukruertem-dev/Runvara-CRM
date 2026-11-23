import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const LOCK_KEY = 7_311_420_001; // advisory lock: one migrator at a time

/** Applies pending SQL migrations as the owner role. Each file runs in its own transaction
 *  unless its first line is `-- no-transaction`. Modified, already-applied files abort the run. */
export async function migrate(ownerUrl: string, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'flexa-migrate' });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query('ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY');
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      // Line endings depend on the checkout (Windows with autocrlf gives CRLF, CI gives LF): the checksum is
      // taken over LF text. Rows written before this rule hold the hash of the raw file as it was then.
      const raw = readFileSync(join(dir, file), 'utf8');
      const body = raw.replace(/\r\n/g, '\n');
      const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
      const checksum = sha(body);
      const accepted = new Set([checksum, sha(raw), sha(body.replace(/\n/g, '\r\n'))]);
      const version = file.replace(/\.sql$/, '');
      const known = applied.get(version);
      if (known !== undefined) {
        if (!accepted.has(known)) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        result.skipped.push(version);
        continue;
      }
      const transactional = !body.startsWith('-- no-transaction');
      try {
        if (transactional) await client.query('BEGIN');
        await client.query(body);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
        if (transactional) await client.query('COMMIT');
      } catch (err) {
        if (transactional) await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(version);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return result;
}

/** Reads packages/db/sql/roles.sql and substitutes psql-style variables (:'x' literal, :"x" identifier). */
export function rolesSql(vars: { owner_password: string; app_password: string; relay_password: string; db_name: string }): string {
  const text = readFileSync(resolve(__dirname, '..', 'sql', 'roles.sql'), 'utf8');
  return text
    .replace(/:'([a-z_]+)'/g, (_, k: keyof typeof vars) => pg.escapeLiteral(vars[k]))
    .replace(/:"([a-z_]+)"/g, (_, k: keyof typeof vars) => pg.escapeIdentifier(vars[k]));
}

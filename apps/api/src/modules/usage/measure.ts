import type { QuotaDimension } from '@flexa/modules';
import { sql, type Db } from '@flexa/db';
import type { Redis } from 'ioredis';
import { today, usageKey } from './rate-limit';

// Usage measurement (TEN-09, docs/p7-plan.md §9). Gauges are counted from the tenant's own rows (inside its
// RLS context); monthly counters are the month's flushed days plus what Redis has not flushed yet.

export type Usage = Record<QuotaDimension, number>;
export const GAUGES = ['users', 'storage_bytes', 'records'] as const;
export const COUNTERS = ['call_minutes', 'ai_tokens'] as const;

const n = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : 0);

/** Active members plus open invitations (an open invitation holds a seat). */
export async function measureUsers(tx: Db): Promise<number> {
  const r = await tx.execute<{ n: string }>(sql`SELECT
      (SELECT count(*) FROM memberships WHERE status = 'active')
    + (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS n`);
  return n(r.rows[0]?.n);
}

/** Attachments that are not deleted (including uploads in progress, which reserve their size) and logos. */
export async function measureStorage(tx: Db): Promise<number> {
  const r = await tx.execute<{ n: string }>(sql`SELECT
      (SELECT COALESCE(sum(size_bytes), 0) FROM attachments WHERE deleted_at IS NULL)
    + (SELECT COALESCE(sum(octet_length(bytes)), 0) FROM tenant_assets) AS n`);
  return n(r.rows[0]?.n);
}

/** Main records that are not deleted: accounts, contacts, leads, opportunities, cases and tasks. */
export async function measureRecords(tx: Db): Promise<number> {
  const r = await tx.execute<{ n: string }>(sql`SELECT
      (SELECT count(*) FROM accounts WHERE deleted_at IS NULL)
    + (SELECT count(*) FROM contacts WHERE deleted_at IS NULL)
    + (SELECT count(*) FROM leads WHERE deleted_at IS NULL)
    + (SELECT count(*) FROM opportunities WHERE deleted_at IS NULL)
    + (SELECT count(*) FROM cases WHERE deleted_at IS NULL)
    + (SELECT count(*) FROM tasks WHERE deleted_at IS NULL) AS n`);
  return n(r.rows[0]?.n);
}

/** This calendar month (UTC) of a counter dimension. */
export async function measureCounter(tx: Db, redis: Redis, tenantId: string, dimension: (typeof COUNTERS)[number]): Promise<number> {
  const r = await tx.execute<{ n: string }>(sql`SELECT COALESCE(sum(value), 0) AS n FROM tenant_usage_counters
    WHERE dimension = ${dimension} AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date`);
  const pending = await redis.hget(usageKey(tenantId, today()), dimension);
  return n(r.rows[0]?.n) + n(pending);
}

export async function measure(tx: Db, redis: Redis, tenantId: string, dimension: QuotaDimension): Promise<number> {
  switch (dimension) {
    case 'users': return measureUsers(tx);
    case 'storage_bytes': return measureStorage(tx);
    case 'records': return measureRecords(tx);
    case 'call_minutes':
    case 'ai_tokens': return measureCounter(tx, redis, tenantId, dimension);
  }
}

export async function measureAll(tx: Db, redis: Redis, tenantId: string): Promise<Usage> {
  return {
    users: await measureUsers(tx),
    storage_bytes: await measureStorage(tx),
    records: await measureRecords(tx),
    call_minutes: await measureCounter(tx, redis, tenantId, 'call_minutes'),
    ai_tokens: await measureCounter(tx, redis, tenantId, 'ai_tokens'),
  };
}

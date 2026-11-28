import { sql, type Db } from '@flexa/db';
import type { TenantRequestContext } from './request-context';

const PREFIX = { contract: 'S', order: 'SP', return: 'IA' } as const;

/** Next document number of the year in the tenant's time zone: `S-2026-00001`, `SP-…` (orders), `IA-…` (returns). */
export async function nextDocumentNumber(tx: Db, t: TenantRequestContext, kind: keyof typeof PREFIX): Promise<string> {
  const year = Number((await tx.execute<{ y: string }>(sql`SELECT extract(year FROM now() AT TIME ZONE ${t.tenant.timezone})::text AS y`)).rows[0]?.y);
  const r = await tx.execute<{ last: number }>(sql`INSERT INTO document_counters (tenant_id, kind, year, last) VALUES (${t.tenant.id}, ${kind}, ${year}, 1)
    ON CONFLICT (tenant_id, kind, year) DO UPDATE SET last = document_counters.last + 1 RETURNING last`);
  return `${PREFIX[kind]}-${String(year)}-${String(r.rows[0]?.last ?? 1).padStart(5, '0')}`;
}

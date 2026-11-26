import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DbHandle } from '@flexa/db';
import { DB, STORAGE } from '../../infra/tokens';
import type { ObjectStorage } from '../../infra/storage';

// Tenant deletion job (TEN-05, docs/p7-plan.md §15). When the grace period is over: the tenant's objects in
// storage go first, then app.purge_tenant() deletes every tenant row in foreign-key order, destroys the data
// key (crypto-shredding), anonymises people who belonged to no other workspace and leaves a tombstone.

@Injectable()
export class DeletionService {
  private readonly log = new Logger('tenant-deletion');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(STORAGE) private readonly storage: ObjectStorage | null,
  ) {}

  /** Hourly. Returns the tenants purged. */
  async runDue(): Promise<string[]> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ id: string }>(sql`SELECT app.tenants_due_for_deletion() AS id`)).rows.map((r) => r.id));
    const done: string[] = [];
    for (const tenantId of due) {
      try {
        await this.purge(tenantId);
        done.push(tenantId);
      } catch (e) {
        // Left for the next run; the tenant stays pending (nobody can sign in meanwhile).
        this.log.error(`purge of ${tenantId} failed: ${(e as Error).message}`);
      }
    }
    return done;
  }

  async purge(tenantId: string): Promise<Record<string, number>> {
    const keys = await this.db.withTenant({ tenantId, userId: null, segments: ['b2b', 'b2c'] }, async (tx) => (await tx.execute<{ k: string }>(sql`
      SELECT object_key AS k FROM attachments
      UNION ALL SELECT object_key FROM quote_documents
      UNION ALL SELECT object_key FROM tenant_exports WHERE object_key IS NOT NULL`)).rows.map((r) => r.k));
    if (keys.length > 0 && !this.storage) throw new Error('object storage is not configured; files would be left behind');
    for (const key of keys) await this.storage?.remove(key);
    const counts = await this.db.withAnonymous(async (tx) => (await tx.execute<{ c: Record<string, number> }>(sql`SELECT app.purge_tenant(${tenantId}) AS c`)).rows[0]?.c ?? {});
    this.log.log(`tenant ${tenantId} purged: ${String(Object.values(counts).reduce((a, b) => a + b, 0))} rows, ${String(keys.length)} files`);
    return counts;
  }
}

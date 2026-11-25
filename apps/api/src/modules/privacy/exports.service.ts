import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { Queue, Worker, type Job } from 'bullmq';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import { DB, ENV, REDIS, STORAGE, type ApiEnv, type Redis } from '../../infra/tokens';
import type { ObjectStorage } from '../../infra/storage';

// Tenant data export (TEN-05, KVKK/GDPR portability; docs/p7-plan.md §15). Every table that holds the
// tenant's rows is written as NDJSON and gzipped into object storage; the link is valid for 7 days. Secrets
// are left out: key material, token and key hashes, encrypted secrets.

export const EXPORTS_QUEUE = 'tenant-exports';
const DOWNLOAD_DAYS = 7;
const BATCH = 2_000;
const gz = promisify(gzip);

/** Tables never exported: key material and hashed credentials. */
const SKIP_TABLES = new Set(['tenant_keys', 'processed_events', 'outbox_events', 'tenant_exports', 'push_subscriptions', 'notification_deliveries']);
/** Columns never exported, whatever table they are in. */
const SECRET_COLUMN = /(_hash|_enc|wrapped_dek|^secret)$/;

type ExportRow = {
  id: string; status: 'pending' | 'running' | 'ready' | 'failed' | 'expired'; requested_as: 'admin' | 'operator'; size_bytes: string | null;
  row_count: string | null; error: string | null; created_at: Date | string; completed_at: Date | string | null; expires_at: Date | string | null; object_key: string | null;
};

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
export const exportView = (r: ExportRow) => ({
  id: r.id, status: r.status, requestedAs: r.requested_as, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  rowCount: r.row_count === null ? null : Number(r.row_count), error: r.error, createdAt: new Date(r.created_at).toISOString(),
  completedAt: iso(r.completed_at), expiresAt: iso(r.expires_at),
});

/** JSON-safe value of a column: binary as base64, everything else as the driver returns it. */
function jsonValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { base64: v.toString('base64') };
  if (v instanceof Date) return v.toISOString();
  return v;
}

@Injectable()
export class ExportsService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('exports');
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(STORAGE) private readonly storage: ObjectStorage | null,
  ) {
    this.queue = new Queue(EXPORTS_QUEUE, { connection: redis, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 1000, removeOnFail: 1000 } });
  }

  onModuleInit(): void {
    if (!this.env.EVENT_CONSUMERS) return;
    this.worker = new Worker(EXPORTS_QUEUE, async (job: Job<{ exportId: string; tenantId: string }>) => {
      await this.run(job.data.tenantId, job.data.exportId);
    }, { connection: this.redis.duplicate(), concurrency: 1 });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  private store(): ObjectStorage {
    if (!this.storage) throw new ProblemError('UPSTREAM_UNAVAILABLE', 'object storage is not configured');
    return this.storage;
  }

  /** Records the request inside the caller's tenant transaction; the job starts after commit. One export at
   *  a time per tenant (409 while another is pending or running). */
  async requestTx(tx: Db, tenantId: string, requestedBy: string, as: 'admin' | 'operator', ip: string | null) {
    this.store();
    const busy = await tx.execute(sql`SELECT 1 FROM tenant_exports WHERE status IN ('pending', 'running')`);
    if ((busy.rowCount ?? 0) > 0) throw new ProblemError('CONFLICT', 'an export is already in progress');
    const row = (await tx.execute<ExportRow>(sql`INSERT INTO tenant_exports (tenant_id, requested_by, requested_as) VALUES (${tenantId}, ${requestedBy}, ${as})
      RETURNING *`)).rows[0];
    if (!row) throw new ProblemError('INTERNAL');
    await audit(tx, tenantId, { action: 'tenant.export_requested', actorType: as === 'operator' ? 'operator' : 'user', actorId: requestedBy, targetType: 'tenant_export', targetId: row.id, ip });
    return row;
  }

  async enqueue(tenantId: string, exportId: string): Promise<void> {
    await this.queue.add('export', { tenantId, exportId }, { jobId: exportId });
  }

  async list(tx: Db) {
    const r = await tx.execute<ExportRow>(sql`SELECT * FROM tenant_exports ORDER BY created_at DESC LIMIT 20`);
    return { data: r.rows.map(exportView) };
  }

  async downloadUrl(tx: Db, id: string) {
    const row = (await tx.execute<ExportRow>(sql`SELECT * FROM tenant_exports WHERE id = ${id}`)).rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    if (row.status !== 'ready' || !row.object_key) throw new ProblemError('EXPORT_NOT_READY', `export is ${row.status}`);
    const ttl = 300;
    return { url: await this.store().signedGet(row.object_key, `flexa-export-${new Date(row.created_at).toISOString().slice(0, 10)}.ndjson.gz`, 'application/gzip', ttl), expiresIn: ttl };
  }

  /** Builds the file. Runs in the automation service (or directly in tests). */
  async run(tenantId: string, exportId: string): Promise<void> {
    const storage = this.store();
    const claimed = await this.db.withTenant({ tenantId, userId: null }, async (tx) => (await tx.execute(sql`UPDATE tenant_exports SET status = 'running'
      WHERE id = ${exportId} AND status IN ('pending', 'running') RETURNING 1`)).rowCount ?? 0);
    if (claimed === 0) return;
    try {
      const { body, rows } = await this.db.withTenant({ tenantId, userId: null, segments: ['b2b', 'b2c'] }, (tx) => this.build(tx, tenantId));
      const zipped = await gz(Buffer.from(body, 'utf8'));
      const key = `tenants/${tenantId}/exports/${exportId}.ndjson.gz`;
      await storage.put(key, zipped, 'application/gzip', `flexa-export-${exportId}.ndjson.gz`);
      await this.db.withTenant({ tenantId, userId: null }, (tx) => tx.execute(sql`UPDATE tenant_exports SET status = 'ready', object_key = ${key},
        size_bytes = ${zipped.length}, row_count = ${rows}, completed_at = now(), expires_at = now() + make_interval(days => ${DOWNLOAD_DAYS}) WHERE id = ${exportId}`));
    } catch (e) {
      this.log.warn(`export ${exportId} failed: ${(e as Error).message}`);
      await this.db.withTenant({ tenantId, userId: null }, (tx) => tx.execute(sql`UPDATE tenant_exports SET status = 'failed', error = ${(e as Error).message.slice(0, 500)},
        completed_at = now() WHERE id = ${exportId}`));
      throw e;
    }
  }

  private async build(tx: Db, tenantId: string): Promise<{ body: string; rows: number }> {
    // A large tenant takes longer than the request timeout; this transaction is a background job.
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    const tables = (await tx.execute<{ table_name: string }>(sql`SELECT DISTINCT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY c.table_name`)).rows.map((r) => r.table_name)
      .filter((name) => !SKIP_TABLES.has(name) && !['operator_actions', 'auth_events', 'auth_sessions'].includes(name));
    const lines: string[] = [JSON.stringify({ format: 'flexa.export/1', tenantId, exportedAt: new Date().toISOString(), tables })];
    let rows = 0;
    const emit = (table: string, row: Record<string, unknown>) => {
      const clean = Object.fromEntries(Object.entries(row).filter(([k]) => !SECRET_COLUMN.test(k)).map(([k, v]) => [k, jsonValue(v)]));
      lines.push(JSON.stringify({ table, row: clean }));
      rows += 1;
    };
    // The tenant row and the members' profiles (a member's account is global; only what the workspace sees).
    for (const r of (await tx.execute(sql`SELECT * FROM tenants WHERE id = ${tenantId}`)).rows) emit('tenants', r);
    for (const r of (await tx.execute(sql`SELECT u.id, u.email::text AS email, u.display_name, u.locale, u.timezone
      FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.id`)).rows) emit('users', r);
    for (const table of tables) {
      for (let offset = 0; ; offset += BATCH) {
        const batch = await tx.execute(sql.raw(`SELECT * FROM "${table.replace(/"/g, '')}" ORDER BY ctid LIMIT ${String(BATCH)} OFFSET ${String(offset)}`));
        for (const r of batch.rows) emit(table, r);
        if (batch.rows.length < BATCH) break;
      }
    }
    return { body: `${lines.join('\n')}\n`, rows };
  }

  /** Hourly: exports past their download window lose their file. */
  async expire(): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ id: string; tenant_id: string; object_key: string | null }>(sql`SELECT * FROM app.expired_exports()`)).rows);
    for (const e of due) {
      if (e.object_key) await this.storage?.remove(e.object_key).catch((err: unknown) => { this.log.warn(`export object ${e.id}: ${(err as Error).message}`); });
      await this.db.withTenant({ tenantId: e.tenant_id, userId: null }, (tx) => tx.execute(sql`UPDATE tenant_exports SET status = 'expired', object_key = NULL WHERE id = ${e.id}`));
    }
    return due.length;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { recordScope } from '@flexa/authz';
import type { AttachmentInitiate, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { randomUUID } from 'node:crypto';
import { recordActivity } from '../../common/activity';
import { ProblemError } from '../../common/problem';
import type { ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import type { AttachmentScanner } from '../../infra/scanner';
import { contentDisposition, signatureMatches, type ObjectStorage } from '../../infra/storage';
import { DB, SCANNER, STORAGE } from '../../infra/tokens';
import { attachedSegment } from '../crm/crm-objects';
import { RecordsService } from './records.service';
import { QuotaService } from '../usage/quota.service';

const PUT_TTL_SECONDS = 300;
const GET_TTL_SECONDS = 60;
const SIGNATURE_BYTES = 16;

type Row = {
  id: string; record_type: string; record_id: string; object_key: string; file_name: string; mime: string; size_bytes: string | number;
  status: 'pending' | 'quarantine' | 'clean' | 'infected' | 'unscanned'; uploaded_by: string; created_at: string;
};

const view = (a: Row) => ({
  id: a.id, record: { type: a.record_type, id: a.record_id }, fileName: a.file_name, mime: a.mime, sizeBytes: Number(a.size_bytes),
  status: a.status, uploadedBy: a.uploaded_by, createdAt: new Date(a.created_at).toISOString(),
});

/** File attachments (ADR-0013 §2): signed upload → verification (size, file signature) → scan → signed
 *  download. Authorization is checked on every step against the record the file belongs to. */
@Injectable()
export class AttachmentsService {
  private readonly log = new Logger('attachments');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(SCANNER) private readonly scanner: AttachmentScanner | null,
    private readonly records: RecordsService,
    private readonly quota: QuotaService,
  ) {}

  private store(): ObjectStorage {
    if (!this.storage) throw new ProblemError('UPSTREAM_UNAVAILABLE', 'file storage is not configured');
    return this.storage;
  }

  private async row(tx: Db, t: TenantRequestContext, id: string): Promise<Row> {
    const r = await tx.execute<Row>(sql`SELECT id, record_type, record_id, object_key, file_name, mime, size_bytes, status, uploaded_by, created_at
      FROM attachments WHERE id = ${id} AND deleted_at IS NULL`);
    const a = r.rows[0];
    if (!a) throw new ProblemError('NOT_FOUND');
    await this.records.readRecord(tx, t, a.record_type, a.record_id);
    return a;
  }

  async list(t: TenantRequestContext, type: ShareType, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.records.readRecord(tx, t, type, id);
      const r = await tx.execute<Row>(sql`SELECT id, record_type, record_id, object_key, file_name, mime, size_bytes, status, uploaded_by, created_at
        FROM attachments WHERE record_type = ${type} AND record_id = ${id} AND deleted_at IS NULL AND status <> 'pending' ORDER BY created_at, id`);
      return { data: r.rows.map(view) };
    });
  }

  async initiate(t: TenantRequestContext, type: ShareType, id: string, body: z.infer<typeof AttachmentInitiate>) {
    const storage = this.store();
    if (recordScope(t.authz, 'create', this.records.resourceOf(type)).kind === 'none') throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.records.readRecord(tx, t, type, id);
      await this.quota.assert(tx, t, 'storage_bytes', body.sizeBytes, 'soft');
      const now = new Date();
      // Storage key carries no user input (the file name lives in metadata only).
      const key = `tenants/${t.tenant.id}/attachments/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
      const segment = await attachedSegment(tx, type, id);
      const r = await tx.execute<Row>(sql`
        INSERT INTO attachments (tenant_id, record_type, record_id, segment, object_key, file_name, mime, size_bytes, uploaded_by)
        VALUES (${t.tenant.id}, ${type}, ${id}, ${segment}::segment, ${key}, ${body.fileName}, ${body.mime}, ${body.sizeBytes}, ${t.principal.userId})
        RETURNING id, record_type, record_id, object_key, file_name, mime, size_bytes, status, uploaded_by, created_at`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      const url = await storage.signedPut(key, body.mime, body.sizeBytes, body.fileName, PUT_TTL_SECONDS);
      return {
        attachment: view(row),
        upload: { url, method: 'PUT' as const, headers: { 'content-type': body.mime, 'content-disposition': contentDisposition(body.fileName) }, expiresAt: new Date(Date.now() + PUT_TTL_SECONDS * 1000).toISOString() },
      };
    });
  }

  /** Verifies what was uploaded (exists, declared size, signature of the declared type) before the file
   *  becomes visible; then the scanner decides. A mismatch deletes the object and the record. */
  async complete(t: TenantRequestContext, id: string) {
    const storage = this.store();
    const pending = await this.db.withTenant(dbCtx(t), async (tx) => {
      const a = await this.row(tx, t, id);
      if (a.uploaded_by !== t.principal.userId) throw new ProblemError('FORBIDDEN', 'only the uploader completes an upload');
      if (a.status !== 'pending') throw new ProblemError('ATTACHMENT_NOT_READY', 'the upload is already completed');
      return a;
    });
    const head = await storage.head(pending.object_key);
    if (!head) throw new ProblemError('ATTACHMENT_NOT_READY', 'the file has not been uploaded yet');
    const sig = await storage.firstBytes(pending.object_key, Math.min(SIGNATURE_BYTES, Number(pending.size_bytes)));
    const reason = head.size !== Number(pending.size_bytes) ? 'size differs from the declared size'
      : !signatureMatches(pending.mime, sig) ? `content is not ${pending.mime}` : null;
    if (reason) {
      await storage.remove(pending.object_key);
      await this.db.withTenant(dbCtx(t), (tx) => tx.execute(sql`DELETE FROM attachments WHERE id = ${id} AND status = 'pending'`));
      throw new ProblemError('ATTACHMENT_INVALID', reason);
    }
    let status: Row['status'] = 'unscanned';
    if (this.scanner) {
      try {
        status = await this.scanner.scan(await storage.stream(pending.object_key));
      } catch (e) {
        // Scanner down: keep the file in quarantine (not downloadable) rather than pretending it is clean.
        this.log.warn(`scan failed for attachment ${id}: ${(e as Error).message}`);
        status = 'quarantine';
      }
    }
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<Row>(sql`UPDATE attachments SET status = ${status}, completed_at = now() WHERE id = ${id} AND status = 'pending'
        RETURNING id, record_type, record_id, object_key, file_name, mime, size_bytes, status, uploaded_by, created_at`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('ATTACHMENT_NOT_READY');
      await recordActivity(tx, t, { type: row.record_type, id: row.record_id, kind: 'attachment', data: { attachmentId: id, fileName: row.file_name, status } });
      return view(row);
    });
  }

  async download(t: TenantRequestContext, id: string) {
    const storage = this.store();
    const a = await this.db.withTenant(dbCtx(t), (tx) => this.row(tx, t, id));
    if (a.status === 'pending' || a.status === 'quarantine' || a.status === 'infected') throw new ProblemError('ATTACHMENT_NOT_READY', `the file is ${a.status}`);
    const url = await storage.signedGet(a.object_key, a.file_name, a.mime, GET_TTL_SECONDS);
    return { url, expiresAt: new Date(Date.now() + GET_TTL_SECONDS * 1000).toISOString() };
  }

  /** Uploader, or a tenant-wide archive grant on the record's resource. The object is deleted too. */
  async remove(t: TenantRequestContext, id: string): Promise<void> {
    const a = await this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.row(tx, t, id);
      const archiveAll = recordScope(t.authz, 'archive', this.records.resourceOf(row.record_type)).kind === 'all';
      if (row.uploaded_by !== t.principal.userId && !archiveAll) throw new ProblemError('FORBIDDEN');
      await tx.execute(sql`UPDATE attachments SET deleted_at = now() WHERE id = ${id}`);
      return row;
    });
    if (this.storage) await this.storage.remove(a.object_key).catch((e: unknown) => { this.log.warn(`object cleanup failed: ${(e as Error).message}`); });
  }
}

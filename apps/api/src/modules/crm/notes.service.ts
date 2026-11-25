import { Inject, Injectable } from '@nestjs/common';
import { recordScope, type RecordResource } from '@flexa/authz';
import type { NoteCreate, NotePatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { ProblemError } from '../../common/problem';
import { renderRichText } from '../../common/rich-text';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import type { ShareType } from '../../common/record-access';
import { syncMentions } from '../records/mentions';
import { TasksService } from '../tasks/tasks.service';
import { attachedSegment, CRM, iso, isCrmType, readCrmRow } from './crm-objects';

type NoteRow = {
  id: string; related_type: string; related_id: string; body: unknown; body_text: string; visibility: 'standard' | 'private';
  author_id: string; created_at: string; updated_at: string;
};

const view = (n: NoteRow) => ({
  id: n.id, related: { type: n.related_type, id: n.related_id }, body: n.body ?? null, bodyText: n.body_text, visibility: n.visibility,
  authorId: n.author_id, createdAt: iso(n.created_at), updatedAt: iso(n.updated_at),
});

/** Notes on any record (task or CRM object). Reading needs read access to the record; writing needs create
 *  rights on the record's resource; private notes are visible to their author only. */
@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly tasks: TasksService) {}

  private resourceOf(type: string): RecordResource {
    if (type === 'task') return 'core.task';
    if (isCrmType(type)) return CRM[type].resource;
    throw new ProblemError('VALIDATION_FAILED', `unknown record type "${type}"`);
  }

  /** The parent must be visible to the caller (tenant, segment, record scope); otherwise 404. */
  private async readParent(tx: Db, t: TenantRequestContext, type: string, id: string): Promise<void> {
    if (type === 'task') await this.tasks.readRow(tx, t, id);
    else if (isCrmType(type)) await readCrmRow(tx, t, CRM[type], id);
    else throw new ProblemError('NOT_FOUND');
  }

  async list(t: TenantRequestContext, relatedType: string | undefined, relatedId: string | undefined) {
    if (!relatedType || !relatedId || !/^[0-9a-f-]{36}$/i.test(relatedId)) throw new ProblemError('VALIDATION_FAILED', 'relatedType and relatedId are required');
    this.resourceOf(relatedType);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readParent(tx, t, relatedType, relatedId);
      const r = await tx.execute<NoteRow>(sql`
        SELECT id, related_type, related_id, body, body_text, visibility, author_id, created_at, updated_at FROM notes
        WHERE related_type = ${relatedType} AND related_id = ${relatedId} AND deleted_at IS NULL
          AND (visibility = 'standard' OR author_id = ${t.principal.userId})
        ORDER BY created_at DESC, id DESC LIMIT 500`);
      return { data: r.rows.map(view) };
    });
  }

  async create(t: TenantRequestContext, body: z.infer<typeof NoteCreate>) {
    const resource = this.resourceOf(body.related.type);
    if (recordScope(t.authz, 'create', resource).kind === 'none') throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readParent(tx, t, body.related.type, body.related.id);
      const segment = await attachedSegment(tx, body.related.type, body.related.id);
      const r = await tx.execute<NoteRow>(sql`
        INSERT INTO notes (tenant_id, related_type, related_id, body, body_text, visibility, segment, author_id)
        VALUES (${t.tenant.id}, ${body.related.type}, ${body.related.id}, ${body.body ? JSON.stringify(body.body) : null}::jsonb, ${body.bodyText},
                ${body.visibility}, ${segment}::segment, ${t.principal.userId})
        RETURNING id, related_type, related_id, body, body_text, visibility, author_id, created_at, updated_at`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      await this.mentions(tx, t, row, null);
      return view(row);
    });
  }

  /** Mentions of a note; nobody else reads a private one, so it mentions nobody. */
  private async mentions(tx: Db, t: TenantRequestContext, n: NoteRow, previous: NoteRow | null): Promise<void> {
    const before = previous?.visibility === 'standard' ? previous.body : null;
    const target = { type: n.related_type as ShareType, id: n.related_id };
    if (n.visibility === 'standard') {
      await syncMentions(tx, t, target, 'note', n.id, before, n.body);
      return;
    }
    if (n.body) {
      const m = renderRichText(n.body).mentions;
      if (m.users.size + m.teams.size > 0) throw new ProblemError('VALIDATION_FAILED', 'a private note cannot mention anyone');
    }
    await syncMentions(tx, t, target, 'note', n.id, before, null);
  }

  private async readNote(tx: Db, t: TenantRequestContext, id: string): Promise<NoteRow> {
    const r = await tx.execute<NoteRow>(sql`
      SELECT id, related_type, related_id, body, body_text, visibility, author_id, created_at, updated_at FROM notes
      WHERE id = ${id} AND deleted_at IS NULL AND (visibility = 'standard' OR author_id = ${t.principal.userId}) FOR UPDATE`);
    const n = r.rows[0];
    if (!n) throw new ProblemError('NOT_FOUND');
    await this.readParent(tx, t, n.related_type, n.related_id);
    return n;
  }

  async patch(t: TenantRequestContext, id: string, body: z.infer<typeof NotePatch>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const n = await this.readNote(tx, t, id);
      if (n.author_id !== t.principal.userId) throw new ProblemError('FORBIDDEN', 'only the author can edit a note');
      const r = await tx.execute<NoteRow>(sql`
        UPDATE notes SET
          body = ${body.body !== undefined ? (body.body ? JSON.stringify(body.body) : null) : (n.body ? JSON.stringify(n.body) : null)}::jsonb,
          body_text = ${body.bodyText ?? n.body_text}, visibility = ${body.visibility ?? n.visibility}
        WHERE id = ${id}
        RETURNING id, related_type, related_id, body, body_text, visibility, author_id, created_at, updated_at`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('NOT_FOUND');
      await this.mentions(tx, t, row, n);
      return view(row);
    });
  }

  async remove(t: TenantRequestContext, id: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const n = await this.readNote(tx, t, id);
      const archiveAll = recordScope(t.authz, 'archive', this.resourceOf(n.related_type)).kind === 'all';
      if (n.author_id !== t.principal.userId && !archiveAll) throw new ProblemError('FORBIDDEN');
      await tx.execute(sql`UPDATE notes SET deleted_at = now() WHERE id = ${id}`);
      await syncMentions(tx, t, { type: n.related_type as ShareType, id: n.related_id }, 'note', id, n.body, null);
    });
  }
}

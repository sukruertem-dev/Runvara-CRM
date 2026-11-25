import { Inject, Injectable } from '@nestjs/common';
import { recordScope, type RecordResource } from '@flexa/authz';
import type { ActivityLogCreate, CommentCreate, CommentPatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { recordActivity } from '../../common/activity';
import { ProblemError } from '../../common/problem';
import { hiddenFields, type RecordShape, type ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { renderRichText } from '../../common/rich-text';
import { DB } from '../../infra/tokens';
import { attachedSegment, CRM, isCrmType, readCrmRow } from '../crm/crm-objects';
import { TASK_SHAPE, TasksService } from '../tasks/tasks.service';
import { mentionable, syncMentions, type MentionSource } from './mentions';

export const RECORD_TYPES: readonly ShareType[] = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'];

type EventRow = { id: string; kind: string; actor_id: string | null; actor_name: string | null; diff: Record<string, unknown>; data: Record<string, unknown>; occurred_at: string };
type CommentRow = {
  id: string; record_type: string; record_id: string; body: unknown; body_html: string; body_text: string; author_id: string; author_name: string | null;
  revision: number; created_at: string; edited_at: string | null; deleted_at: string | null;
};

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);

/** Everything that hangs off a record: timeline, manual activity logs, comments with mentions
 *  (docs/p4-plan.md §10). Reading needs read access to the record; writing needs create rights on its
 *  resource (Matrix A A09) — mentions additionally need `mentions.create` (A27). */
@Injectable()
export class RecordsService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly tasks: TasksService) {}

  resourceOf(type: string): RecordResource {
    if (type === 'task') return 'core.task';
    if (isCrmType(type)) return CRM[type].resource;
    throw new ProblemError('NOT_FOUND');
  }

  shapeOf(type: ShareType): RecordShape {
    return type === 'task' ? TASK_SHAPE : CRM[type].shape;
  }

  /** The record must be visible to the caller; otherwise 404 (indistinguishable from a missing record). */
  async readRecord(tx: Db, t: TenantRequestContext, type: string, id: string): Promise<void> {
    if (type === 'task') await this.tasks.readRow(tx, t, id);
    else if (isCrmType(type)) await readCrmRow(tx, t, CRM[type], id);
    else throw new ProblemError('NOT_FOUND');
  }

  private assertCreate(t: TenantRequestContext, type: string): void {
    if (recordScope(t.authz, 'create', this.resourceOf(type)).kind === 'none') throw new ProblemError('FORBIDDEN');
  }

  // ------------------------------------------------------------------ timeline
  async timeline(t: TenantRequestContext, type: ShareType, id: string, query: { before?: string; limit?: string }) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–200');
    const cursor = query.before ? this.decodeCursor(query.before) : null;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      const r = await tx.execute<EventRow>(sql`
        SELECT e.id, e.kind, e.actor_id, u.display_name AS actor_name, e.diff, e.data, e.occurred_at
        FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.record_type = ${type} AND e.record_id = ${id}
          ${cursor ? sql`AND (e.occurred_at, e.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${limit + 1}`);
      // Field-level security: diffs of fields the reader may not see are removed (an event that only
      // touched hidden fields disappears entirely).
      const hidden = type === 'task' ? new Set<string>() : hiddenFields(t, type);
      const rows = r.rows.slice(0, limit);
      const data = rows.flatMap((e) => {
        const diff = Object.fromEntries(Object.entries(e.diff).filter(([k]) => !hidden.has(k)));
        if (e.kind === 'field_changed' && Object.keys(diff).length === 0) return [];
        return [{
          id: e.id, kind: e.kind, actor: e.actor_id ? { id: e.actor_id, displayName: e.actor_name } : null, diff, data: e.data,
          occurredAt: new Date(e.occurred_at).toISOString(),
        }];
      });
      const last = rows.at(-1);
      const nextCursor = r.rows.length > limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.occurred_at).toISOString(), id: last.id })).toString('base64url') : null;
      return { data, page: { nextCursor, hasMore: nextCursor !== null } };
    });
  }

  private decodeCursor(raw: string): { at: string; id: string } {
    try {
      const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
      if (typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) && typeof v.id === 'string' && /^[0-9a-f-]{36}$/i.test(v.id)) return { at: v.at, id: v.id };
    } catch {
      // fall through
    }
    throw new ProblemError('CURSOR_INVALID');
  }

  /** E-mail and call logs added by hand or through the API (Faz 4). */
  async logActivity(t: TenantRequestContext, type: ShareType, id: string, body: z.infer<typeof ActivityLogCreate>) {
    this.assertCreate(t, type);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      const { kind, ...data } = body;
      await recordActivity(tx, t, { type, id, kind, data });
      const r = await tx.execute<EventRow>(sql`
        SELECT e.id, e.kind, e.actor_id, NULL::text AS actor_name, e.diff, e.data, e.occurred_at FROM activity_events e
        WHERE e.record_type = ${type} AND e.record_id = ${id} AND e.kind = ${kind} AND e.actor_id = ${t.principal.userId}
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1`);
      const e = r.rows[0];
      if (!e) throw new ProblemError('INTERNAL');
      return { id: e.id, kind: e.kind, actor: { id: t.principal.userId, displayName: null }, diff: {}, data: e.data, occurredAt: new Date(e.occurred_at).toISOString() };
    });
  }

  // ------------------------------------------------------------------ comments and mentions
  private commentView = (c: CommentRow) => ({
    id: c.id, record: { type: c.record_type, id: c.record_id }, body: c.deleted_at ? null : c.body, bodyHtml: c.deleted_at ? null : c.body_html,
    bodyText: c.deleted_at ? null : c.body_text, author: { id: c.author_id, displayName: c.author_name }, revision: c.revision,
    createdAt: new Date(c.created_at).toISOString(), editedAt: iso(c.edited_at), deleted: c.deleted_at !== null,
  });

  private async commentRows(tx: Db, where: SQL): Promise<CommentRow[]> {
    const r = await tx.execute<CommentRow>(sql`
      SELECT c.id, c.record_type, c.record_id, c.body, c.body_html, c.body_text, c.author_id, u.display_name AS author_name,
             c.revision, c.created_at, c.edited_at, c.deleted_at
      FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE ${where} ORDER BY c.created_at, c.id`);
    return r.rows;
  }

  async listComments(t: TenantRequestContext, type: ShareType, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      // Deleted comments keep their place in the thread as a tombstone (no content).
      return { data: (await this.commentRows(tx, sql`c.record_type = ${type} AND c.record_id = ${id}`)).map(this.commentView) };
    });
  }

  async createComment(t: TenantRequestContext, type: ShareType, id: string, body: z.infer<typeof CommentCreate>) {
    this.assertCreate(t, type);
    const rendered = renderRichText(body.body);
    if (!rendered.text) throw new ProblemError('VALIDATION_FAILED', 'body: empty comment');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      const segment = await attachedSegment(tx, type, id);
      const ins = await tx.execute<{ id: string }>(sql`
        INSERT INTO comments (tenant_id, record_type, record_id, segment, body, body_html, body_text, author_id)
        VALUES (${t.tenant.id}, ${type}, ${id}, ${segment}::segment, ${JSON.stringify(body.body)}::jsonb, ${rendered.html}, ${rendered.text}, ${t.principal.userId})
        RETURNING id`);
      const commentId = ins.rows[0]?.id ?? '';
      await tx.execute(sql`INSERT INTO comment_revisions (tenant_id, comment_id, revision, body, body_text, edited_by)
        VALUES (${t.tenant.id}, ${commentId}, 1, ${JSON.stringify(body.body)}::jsonb, ${rendered.text}, ${t.principal.userId})`);
      await syncMentions(tx, t, { type, id }, 'comment', commentId, null, body.body);
      await recordActivity(tx, t, { type, id, kind: 'comment', data: { commentId } });
      const [row] = await this.commentRows(tx, sql`c.id = ${commentId}`);
      if (!row) throw new ProblemError('INTERNAL');
      return this.commentView(row);
    });
  }

  private async ownComment(tx: Db, t: TenantRequestContext, commentId: string): Promise<CommentRow> {
    const [row] = await this.commentRows(tx, sql`c.id = ${commentId} AND c.deleted_at IS NULL`);
    if (!row) throw new ProblemError('NOT_FOUND');
    await this.readRecord(tx, t, row.record_type, row.record_id);
    return row;
  }

  /** Author only. New mentions are notified; removed ones are retracted together with unread notifications. */
  async editComment(t: TenantRequestContext, commentId: string, body: z.infer<typeof CommentPatch>) {
    const rendered = renderRichText(body.body);
    if (!rendered.text) throw new ProblemError('VALIDATION_FAILED', 'body: empty comment');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.ownComment(tx, t, commentId);
      if (row.author_id !== t.principal.userId) throw new ProblemError('FORBIDDEN', 'only the author can edit a comment');
      if (body.revision !== row.revision) throw new ProblemError('PRECONDITION_FAILED', 'the comment was edited meanwhile', { currentRevision: row.revision });
      const type = row.record_type as ShareType;
      await syncMentions(tx, t, { type, id: row.record_id }, 'comment', commentId, row.body, body.body);
      const revision = row.revision + 1;
      await tx.execute(sql`UPDATE comments SET body = ${JSON.stringify(body.body)}::jsonb, body_html = ${rendered.html}, body_text = ${rendered.text},
        revision = ${revision}, edited_at = now() WHERE id = ${commentId}`);
      await tx.execute(sql`INSERT INTO comment_revisions (tenant_id, comment_id, revision, body, body_text, edited_by)
        VALUES (${t.tenant.id}, ${commentId}, ${revision}, ${JSON.stringify(body.body)}::jsonb, ${rendered.text}, ${t.principal.userId})`);
      const [after] = await this.commentRows(tx, sql`c.id = ${commentId}`);
      if (!after) throw new ProblemError('INTERNAL');
      return this.commentView(after);
    });
  }

  /** Author, or a tenant-wide archive grant on the record's resource. Mentions and unread notifications are withdrawn. */
  async deleteComment(t: TenantRequestContext, commentId: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.ownComment(tx, t, commentId);
      const archiveAll = recordScope(t.authz, 'archive', this.resourceOf(row.record_type)).kind === 'all';
      if (row.author_id !== t.principal.userId && !archiveAll) throw new ProblemError('FORBIDDEN');
      await tx.execute(sql`UPDATE comments SET deleted_at = now() WHERE id = ${commentId}`);
      await syncMentions(tx, t, { type: row.record_type as ShareType, id: row.record_id }, 'comment', commentId, row.body, null);
    });
  }

  /** People and teams the `@` picker offers for a record. */
  async mentionable(t: TenantRequestContext, type: ShareType, id: string, source: MentionSource, q: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.readRecord(tx, t, type, id);
      return mentionable(tx, t, { type, id }, source, q);
    });
  }

  async revisions(t: TenantRequestContext, commentId: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.ownComment(tx, t, commentId);
      const r = await tx.execute<{ revision: number; body: unknown; body_text: string; edited_by: string; at: string }>(sql`
        SELECT revision, body, body_text, edited_by, at FROM comment_revisions WHERE comment_id = ${commentId} ORDER BY revision`);
      return { data: r.rows.map((x) => ({ revision: x.revision, body: x.body, bodyText: x.body_text, editedBy: x.edited_by, at: new Date(x.at).toISOString() })) };
    });
  }
}

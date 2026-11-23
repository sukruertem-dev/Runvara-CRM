import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { ProblemError } from '../../common/problem';
import { recordPredicate } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, isCrmType, type CrmType } from '../crm/crm-objects';
import { TASK_SHAPE, taskReadPredicate } from '../tasks/tasks.service';

import { notify, type NotificationKind } from '../../common/notify';

export { notify };
const KINDS: readonly NotificationKind[] = ['mention', 'assigned', 'automation'];

type Row = {
  id: string; kind: NotificationKind; source_type: string; source_id: string; record_type: string; record_id: string;
  actor_id: string | null; actor_name: string | null; created_at: string; read_at: string | null; accessible: boolean; title: string | null; message: string | null;
};

@Injectable()
export class NotificationsService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** SQL: is the record readable by the reader *now*, and its display title (MEN-09: access is re-checked on read). */
  private async accessColumns(tx: Db, t: TenantRequestContext) {
    const branches = [sql`WHEN n.record_type = 'task' THEN EXISTS (SELECT 1 FROM ${TASK_SHAPE.from} WHERE t.id = n.record_id AND t.deleted_at IS NULL AND ${await this.taskPredicate(tx, t)})`];
    const titles = [sql`WHEN n.record_type = 'task' THEN (SELECT t.title FROM tasks t WHERE t.id = n.record_id)`];
    const titleCol: Record<CrmType, string> = { account: 'name', contact: 'full_name', lead: 'full_name', opportunity: 'name', case: 'subject' };
    for (const type of Object.keys(CRM) as CrmType[]) {
      const def = CRM[type];
      branches.push(sql`WHEN n.record_type = ${type} THEN EXISTS (SELECT 1 FROM ${def.from} WHERE t.id = n.record_id AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, def.shape, 'read')})`);
      titles.push(sql`WHEN n.record_type = ${type} THEN (SELECT t.${sql.raw(titleCol[type])} FROM ${sql.raw(def.table)} t WHERE t.id = n.record_id)`);
    }
    // Operational notices about a webhook subscription are for those who may read the tenant configuration.
    const configReader = can(t.authz, 'tenant.config.read', 'read').allow;
    branches.push(sql`WHEN n.record_type = 'webhook' THEN ${configReader}`);
    titles.push(sql`WHEN n.record_type = 'webhook' THEN (SELECT w.name FROM webhook_subscriptions w WHERE w.id = n.record_id)`);
    return { accessible: sql`CASE ${sql.join(branches, sql` `)} ELSE false END`, title: sql`CASE ${sql.join(titles, sql` `)} END` };
  }

  private taskPredicate(tx: Db, t: TenantRequestContext) {
    return taskReadPredicate(tx, t);
  }

  async list(t: TenantRequestContext, query: { unread?: string; limit?: string; before?: string }) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–200');
    const before = query.before ? new Date(query.before) : null;
    if (before && Number.isNaN(before.getTime())) throw new ProblemError('VALIDATION_FAILED', 'before must be a timestamp');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const a = await this.accessColumns(tx, t);
      const r = await tx.execute<Row>(sql`
        WITH n AS (
          SELECT * FROM notifications
          WHERE user_id = ${t.principal.userId} AND retracted_at IS NULL
            ${query.unread === 'true' ? sql`AND read_at IS NULL` : sql``} ${before ? sql`AND created_at < ${before}` : sql``}
          ORDER BY created_at DESC, id DESC LIMIT ${limit}
        ), v AS (SELECT n.*, ${a.accessible} AS accessible FROM n)
        SELECT v.id, v.kind, v.source_type, v.source_id, v.record_type, v.record_id, v.actor_id, u.display_name AS actor_name, v.message,
               v.created_at, v.read_at, v.accessible, CASE WHEN v.accessible THEN (SELECT ${a.title} FROM (SELECT v.record_type, v.record_id) AS n) END AS title
        FROM v LEFT JOIN users u ON u.id = v.actor_id ORDER BY v.created_at DESC, v.id DESC`);
      const unread = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${t.principal.userId} AND retracted_at IS NULL AND read_at IS NULL`);
      return {
        data: r.rows.map((x) => ({
          id: x.id, kind: x.kind, accessible: x.accessible,
          // Without access, only the fact of a notification remains: no title, no record or source id, no actor.
          title: x.accessible ? x.title : null,
          message: x.accessible ? x.message : null,
          record: x.accessible ? { type: x.record_type, id: x.record_id } : null,
          source: x.accessible ? { type: x.source_type, id: x.source_id } : null,
          actor: x.accessible && x.actor_id ? { id: x.actor_id, displayName: x.actor_name } : null,
          link: x.accessible ? `/r/${x.record_type}/${x.record_id}${x.source_type === 'comment' ? `#comment-${x.source_id}` : ''}` : null,
          createdAt: new Date(x.created_at).toISOString(),
          readAt: x.read_at ? new Date(x.read_at).toISOString() : null,
        })),
        unreadCount: unread.rows[0]?.n ?? 0,
      };
    });
  }

  async markRead(t: TenantRequestContext, id: string | null): Promise<{ updated: number }> {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`UPDATE notifications SET read_at = now()
        WHERE user_id = ${t.principal.userId} AND read_at IS NULL AND retracted_at IS NULL ${id ? sql`AND id = ${id}` : sql``}`);
      if (id && (r.rowCount ?? 0) === 0) {
        const exists = await tx.execute(sql`SELECT 1 FROM notifications WHERE id = ${id} AND user_id = ${t.principal.userId}`);
        if ((exists.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      }
      // MEN-10: read state reaches the user's other devices through their streams.
      if ((r.rowCount ?? 0) > 0) {
        await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
          VALUES (${t.tenant.id}, 'notification.read', ${JSON.stringify({ type: 'user', id: t.principal.userId })}::jsonb,
                  ${JSON.stringify({ userIds: [t.principal.userId], notificationIds: id ? [id] : [] })}::jsonb, gen_random_uuid())`);
      }
      return { updated: r.rowCount ?? 0 };
    });
  }

  async preferences(t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ kind: NotificationKind; channels: string[] }>(sql`SELECT kind, channels FROM notification_preferences WHERE user_id = ${t.principal.userId}`);
      const set = new Map(r.rows.map((x) => [x.kind, x.channels]));
      const defaults = await tx.execute<{ kind: NotificationKind; channels: string[] }>(sql`
        SELECT k AS kind, app.default_channels(${t.tenant.id}, k) AS channels FROM unnest(${`{${KINDS.join(',')}}`}::text[]) AS k`);
      const fallback = new Map(defaults.rows.map((x) => [x.kind, x.channels]));
      return { data: KINDS.map((kind) => ({ kind, channels: set.get(kind) ?? fallback.get(kind) ?? ['in_app'] })) };
    });
  }

  async setPreferences(t: TenantRequestContext, prefs: { kind: NotificationKind; channels: string[] }[]) {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      for (const p of prefs) {
        await tx.execute(sql`INSERT INTO notification_preferences (tenant_id, user_id, kind, channels)
          VALUES (${t.tenant.id}, ${t.principal.userId}, ${p.kind}, ${`{${[...new Set(p.channels)].join(',')}}`}::text[])
          ON CONFLICT (tenant_id, user_id, kind) DO UPDATE SET channels = EXCLUDED.channels`);
      }
    });
    return this.preferences(t);
  }
}

export function isNotifiableType(type: string): boolean {
  return type === 'task' || isCrmType(type);
}

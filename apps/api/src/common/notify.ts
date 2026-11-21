import { sql, type Db } from '@flexa/db';
import { uuidArray } from './record-access';
import type { TenantRequestContext } from './request-context';

export type NotificationKind = 'mention' | 'assigned' | 'automation';

/** Creates in-app notifications (one per recipient and source; duplicates are ignored). Recipients who
 *  turned the in-app channel off for the kind get none. The actor is never notified of their own action. */
export async function notify(
  tx: Db,
  t: TenantRequestContext,
  n: { users: readonly string[]; kind: NotificationKind; sourceType: string; sourceId: string; recordType: string; recordId: string; message?: string; includeActor?: boolean },
): Promise<string[]> {
  // Automation notices may address the rule owner (the acting user); human actions never notify the actor.
  const users = [...new Set(n.users)].filter((u) => n.includeActor === true || u !== t.principal.userId);
  if (users.length === 0) return [];
  const off = await tx.execute<{ user_id: string }>(sql`SELECT user_id::text FROM notification_preferences
    WHERE kind = ${n.kind} AND user_id = ANY(${uuidArray(users)}) AND NOT ('in_app' = ANY(channels))`);
  const muted = new Set(off.rows.map((r) => r.user_id));
  const recipients = users.filter((u) => !muted.has(u));
  if (recipients.length) {
    await tx.execute(sql`SELECT app.create_notifications(${uuidArray(recipients)}, ${n.kind}, ${n.sourceType}, ${n.sourceId}::uuid, ${n.recordType}, ${n.recordId}::uuid, ${n.message ?? null})`);
    // Realtime: the recipients' open streams learn that something new arrived (no content, ADR-0007).
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
      VALUES (${t.tenant.id}, 'notification.created', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
              ${JSON.stringify({ userIds: recipients, kind: n.kind })}::jsonb, ${t.automation?.correlationId ?? sql`gen_random_uuid()`})`);
  }
  return recipients;
}


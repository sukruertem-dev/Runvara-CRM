import { sql, type Db } from '@flexa/db';
import { uuidArray } from './record-access';
import type { TenantRequestContext } from './request-context';

export type NotificationKind = 'mention' | 'assigned';

/** Creates in-app notifications (one per recipient and source; duplicates are ignored). Recipients who
 *  turned the in-app channel off for the kind get none. The actor is never notified of their own action. */
export async function notify(
  tx: Db,
  t: TenantRequestContext,
  n: { users: readonly string[]; kind: NotificationKind; sourceType: string; sourceId: string; recordType: string; recordId: string },
): Promise<string[]> {
  const users = [...new Set(n.users)].filter((u) => u !== t.principal.userId);
  if (users.length === 0) return [];
  const off = await tx.execute<{ user_id: string }>(sql`SELECT user_id::text FROM notification_preferences
    WHERE kind = ${n.kind} AND user_id = ANY(${uuidArray(users)}) AND NOT ('in_app' = ANY(channels))`);
  const muted = new Set(off.rows.map((r) => r.user_id));
  const recipients = users.filter((u) => !muted.has(u));
  if (recipients.length) {
    await tx.execute(sql`SELECT app.create_notifications(${uuidArray(recipients)}, ${n.kind}, ${n.sourceType}, ${n.sourceId}::uuid, ${n.recordType}, ${n.recordId}::uuid)`);
  }
  return recipients;
}


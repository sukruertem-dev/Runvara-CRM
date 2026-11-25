import { sql, type Db } from '@flexa/db';
import { uuidArray } from './record-access';
import type { TenantRequestContext } from './request-context';

/** What a notice needs of its context: background jobs have no request. */
type NotifyContext = { tenant: { id: string }; principal: { userId: string }; automation?: TenantRequestContext['automation'] };

export type NotificationKind = 'mention' | 'assigned' | 'automation' | 'approval';

/** Creates in-app notifications (one per recipient and source; duplicates are ignored). Recipients who
 *  turned the in-app channel off for the kind get none. The actor is never notified of their own action. */
export async function notify(
  tx: Db,
  t: NotifyContext,
  n: { users: readonly string[]; kind: NotificationKind; sourceType: string; sourceId: string; recordType: string; recordId: string; message?: string; includeActor?: boolean },
): Promise<string[]> {
  // Automation notices may address the rule owner (the acting user); human actions never notify the actor.
  const users = [...new Set(n.users)].filter((u) => n.includeActor === true || u !== t.principal.userId);
  if (users.length === 0) return [];
  // A user's own choice wins; without one the tenant default (notifications.defaults) applies. Nobody is told
  // through a channel they turned off; e-mail or push alone still makes a notice, kept out of the app.
  const chosen = await tx.execute<{ user_id: string; channels: string[] }>(sql`SELECT u.id::text AS user_id, COALESCE(p.channels, app.default_channels(${t.tenant.id}, ${n.kind})) AS channels
    FROM unnest(${uuidArray(users)}) AS u(id) LEFT JOIN notification_preferences p ON p.user_id = u.id AND p.kind = ${n.kind}`);
  const recipients = chosen.rows.filter((r) => r.channels.includes('in_app')).map((r) => r.user_id);
  const silent = chosen.rows.filter((r) => !r.channels.includes('in_app') && r.channels.length > 0).map((r) => r.user_id);
  const create = (to: readonly string[], inApp: boolean) => tx.execute(sql`
    SELECT app.create_notifications(${uuidArray(to)}, ${n.kind}, ${n.sourceType}, ${n.sourceId}::uuid, ${n.recordType}, ${n.recordId}::uuid, ${n.message ?? null}, ${inApp})`);
  if (recipients.length) await create(recipients, true);
  if (silent.length) await create(silent, false);
  if (recipients.length || silent.length) {
    // Realtime: the recipients' open streams learn that something new arrived (no content, ADR-0007).
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
      VALUES (${t.tenant.id}, 'notification.created', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
              ${JSON.stringify({ userIds: recipients, silentUserIds: silent, kind: n.kind, sourceType: n.sourceType, sourceId: n.sourceId })}::jsonb, ${t.automation?.correlationId ?? sql`gen_random_uuid()`})`);
  }
  return recipients;
}


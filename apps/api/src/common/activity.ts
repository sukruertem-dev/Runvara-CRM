import { sql, type Db } from '@flexa/db';
import { attachedSegment } from '../modules/crm/crm-objects';
import type { TenantRequestContext } from './request-context';

// Activity timeline writer (docs/p4-plan.md §10). Events are written in the same transaction as the change
// they describe, so the timeline can never disagree with the data. The table is append-only.

export type ActivityKind =
  | 'created' | 'field_changed' | 'status_changed' | 'assigned' | 'deleted' | 'restored'
  | 'converted' | 'merged' | 'comment' | 'attachment' | 'email_log' | 'call_log';

/** View fields that change on every write and carry no information of their own. */
const VOLATILE = new Set(['version', 'updatedAt', 'updatedBy', 'createdAt', 'createdBy', 'deletedAt', 'closedAt', 'contactPoints', 'accounts', 'tagIds', 'position', 'depth']);

/** Field-level diff of two API views: `{field: {from, to}}`; custom fields as `custom.cf_x`. */
export function viewDiff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (VOLATILE.has(key)) continue;
    if (key === 'custom') {
      const b = (before.custom ?? {}) as Record<string, unknown>;
      const a = (after.custom ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(b[k], a[k])) out[`custom.${k}`] = { from: b[k] ?? null, to: a[k] ?? null };
      continue;
    }
    if (!same(before[key], after[key])) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return out;
}

export async function recordActivity(
  tx: Db,
  t: TenantRequestContext,
  e: { type: string; id: string; kind: ActivityKind; diff?: Record<string, unknown>; data?: Record<string, unknown> },
): Promise<void> {
  if (e.kind === 'field_changed' && (!e.diff || Object.keys(e.diff).length === 0)) return;
  const segment = await attachedSegment(tx, e.type, e.id);
  await tx.execute(sql`
    INSERT INTO activity_events (tenant_id, record_type, record_id, segment, kind, actor_id, diff, data)
    VALUES (${t.tenant.id}, ${e.type}, ${e.id}, ${segment}::segment, ${e.kind}, ${t.principal.userId},
            ${JSON.stringify(e.diff ?? {})}::jsonb, ${JSON.stringify(e.data ?? {})}::jsonb)`);
}

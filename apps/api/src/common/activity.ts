import { sql, type Db } from '@flexa/db';
import { randomUUID } from 'node:crypto';
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

/** One correlation id per request (or per automation chain), shared by every event it causes. */
const correlations = new WeakMap<TenantRequestContext, string>();
function correlationOf(t: TenantRequestContext): string {
  if (t.automation) return t.automation.correlationId;
  let c = correlations.get(t);
  if (!c) {
    c = randomUUID();
    correlations.set(t, c);
  }
  return c;
}

/** Domain event type and minimal payload for a timeline entry (docs/events.md). Field values never enter
 *  an event — only field names and status keys — so FLS-hidden values cannot leak through the bus. */
function eventOf(type: string, kind: ActivityKind, diff: Record<string, unknown>, data: Record<string, unknown>): { type: string; payload: Record<string, unknown> } {
  switch (kind) {
    case 'created': return { type: `${type}.created`, payload: {} };
    case 'field_changed': return { type: `${type}.updated`, payload: { changedFields: Object.keys(diff).sort() } };
    case 'status_changed': {
      const s = diff.status as { from?: unknown; to?: unknown } | undefined;
      return { type: `${type}.status_changed`, payload: { from: s?.from ?? null, to: s?.to ?? null } };
    }
    case 'assigned': return { type: `${type}.assigned`, payload: {} };
    case 'deleted': return { type: `${type}.deleted`, payload: {} };
    case 'restored': return { type: `${type}.restored`, payload: {} };
    case 'converted': return { type: 'lead.converted', payload: { accountId: data.accountId ?? null, contactId: data.contactId ?? null, opportunityId: data.opportunityId ?? null } };
    case 'merged': return { type: 'record.merged', payload: { mergedIds: data.mergedIds ?? [] } };
    case 'comment': return { type: 'comment.created', payload: { commentId: data.commentId ?? null } };
    case 'attachment': return { type: 'attachment.uploaded', payload: { attachmentId: data.attachmentId ?? null, status: data.status ?? null } };
    case 'email_log':
    case 'call_log': return { type: 'activity.logged', payload: { kind } };
  }
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
  // The same transaction writes the domain event (transactional outbox, ADR-0006).
  const ev = eventOf(e.type, e.kind, e.diff ?? {}, e.data ?? {});
  const actor = t.automation ? { type: 'automation', id: t.principal.userId, ruleId: t.automation.ruleId } : { type: 'user', id: t.principal.userId };
  await tx.execute(sql`
    INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, causation_id, correlation_id, depth)
    VALUES (${t.tenant.id}, ${ev.type}, ${e.type}, ${e.id}, ${segment}::segment, ${JSON.stringify(actor)}::jsonb, ${JSON.stringify(ev.payload)}::jsonb,
            ${t.automation?.causationId ?? null}, ${correlationOf(t)}, ${t.automation ? t.automation.depth + 1 : 0})`);
}

import { z } from 'zod';
import { Uuid } from './schemas';

// Domain event envelope (ADR-0006, docs/events.md). Written to the outbox in the business transaction,
// relayed to the `events` queue, consumed with exactly-once effect.

/** Legacy single queue: still consumed so events relayed before sharding drain (docs/p7-plan.md §10). */
export const EVENTS_QUEUE = 'events';

/** Shard of a tenant's events (ADR-0014 §4): FNV-1a of the tenant id, modulo the shard count. */
export function eventShard(tenantId: string, shards: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tenantId.length; i += 1) {
    h ^= tenantId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

export const eventShardQueue = (shard: number): string => `events-${String(shard)}`;
export const eventQueueFor = (tenantId: string, shards: number): string => eventShardQueue(eventShard(tenantId, shards));
export const MAX_AUTOMATION_DEPTH = 5;

export const EventActor = z.object({
  type: z.enum(['user', 'service', 'automation', 'operator', 'system']),
  id: Uuid.nullable(),
  ruleId: Uuid.optional(),
});

export const DomainEvent = z.object({
  id: Uuid,
  type: z.string().regex(/^[a-z_]+\.[a-z_.]+$/),
  version: z.number().int().min(1),
  tenantId: Uuid,
  occurredAt: z.string(),
  actor: EventActor,
  resource: z.object({ type: z.string(), id: Uuid, segment: z.enum(['b2b', 'b2c']).nullable() }).nullable(),
  causationId: Uuid.nullable(),
  correlationId: Uuid,
  depth: z.number().int().min(0),
  /** Minimal: changed field names, status keys, ids — never field values (FLS-hidden values must not leak). */
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

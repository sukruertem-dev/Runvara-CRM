import { z } from 'zod';
import { Uuid } from './schemas';

// Domain event envelope (ADR-0006, docs/events.md). Written to the outbox in the business transaction,
// relayed to the `events` queue, consumed with exactly-once effect.

export const EVENTS_QUEUE = 'events';
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

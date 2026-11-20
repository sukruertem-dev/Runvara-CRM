import { schema, type Db, type DbHandle } from '@runvara/db';

export interface AuditEntry {
  action: string;
  actorType?: 'user' | 'service' | 'automation' | 'operator' | 'system';
  actorId: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Writes to the immutable audit_log inside the caller's tenant transaction (same commit as the change). */
export async function audit(tx: Db, tenantId: string, e: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId,
    action: e.action,
    actorType: e.actorType ?? 'user',
    actorId: e.actorId,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    ip: e.ip ?? null,
    details: e.details ?? {},
  });
}

export interface AuthEvent {
  kind: string;
  userId?: string | null;
  tenantId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

/** Security events that may precede any tenant context (login failures, token reuse). Append-only. */
export async function authEvent(db: DbHandle, e: AuthEvent): Promise<void> {
  await db.withAnonymous((tx) =>
    tx.insert(schema.authEvents).values({
      kind: e.kind,
      userId: e.userId ?? null,
      tenantId: e.tenantId ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      details: e.details ?? {},
    }),
  );
}

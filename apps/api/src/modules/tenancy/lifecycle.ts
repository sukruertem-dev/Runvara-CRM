import { configKey } from '@flexa/config';
import { sql, type Db } from '@flexa/db';
import { audit, type AuditEntry } from '../../common/audit';
import { ProblemError } from '../../common/problem';

// Tenant lifecycle (TEN-02, ADR-0014 §5). `deleted` is reached only by the deletion job (app.purge_tenant).

export type TenantStatus = 'trial' | 'active' | 'suspended' | 'pending_deletion' | 'deleted';

const TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  trial: ['active', 'suspended', 'pending_deletion'],
  active: ['suspended', 'pending_deletion'],
  suspended: ['active', 'pending_deletion'],
  pending_deletion: ['active'],
  deleted: [],
};

export function canTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Days between a deletion request and the deletion (tenant setting `privacy.deletionGraceDays`). */
export async function deletionGraceDays(tx: Db, tenantId: string): Promise<number> {
  const r = await tx.execute<{ days: number | null }>(sql`
    SELECT (s.value ->> 'deletionGraceDays')::int AS days FROM tenant_settings_head h
    JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = 'privacy'`);
  const fallback = configKey('privacy')?.default.deletionGraceDays;
  return r.rows[0]?.days ?? (typeof fallback === 'number' ? fallback : 30);
}

/**
 * Moves the tenant (the transaction's tenant context) to `to`. Cancelling a deletion returns to the status it
 * had before the request. Audit, a `tenant.status_changed` event and, for deletion, the scheduled date.
 */
export async function transitionTx(
  tx: Db,
  tenantId: string,
  to: TenantStatus,
  actor: Pick<AuditEntry, 'actorId' | 'actorType' | 'ip'>,
  reason: string,
): Promise<{ from: TenantStatus; to: TenantStatus; deletionScheduledAt: Date | null }> {
  const cur = (await tx.execute<{ status: TenantStatus }>(sql`SELECT status FROM tenants WHERE id = ${tenantId} FOR UPDATE`)).rows[0];
  if (!cur) throw new ProblemError('NOT_FOUND');
  const from = cur.status;
  if (!canTransition(from, to)) throw new ProblemError('TENANT_TRANSITION_INVALID', `${from} → ${to} is not allowed`, { from, to });
  let target = to;
  if (from === 'pending_deletion' && to === 'active') {
    const prev = (await tx.execute<{ from: TenantStatus | null }>(sql`SELECT details ->> 'from' AS from FROM audit_log
      WHERE action = 'tenant.status_changed' AND details ->> 'to' = 'pending_deletion' ORDER BY at DESC LIMIT 1`)).rows[0]?.from;
    if (prev === 'trial' || prev === 'suspended') target = prev;
  }
  let scheduled: Date | null = null;
  if (target === 'pending_deletion') {
    const days = await deletionGraceDays(tx, tenantId);
    scheduled = new Date(Date.now() + days * 86_400_000);
  }
  await tx.execute(sql`UPDATE tenants SET status = ${target}, status_changed_at = now(), deletion_scheduled_at = ${scheduled},
    authz_epoch = authz_epoch + 1 WHERE id = ${tenantId}`);
  await audit(tx, tenantId, {
    action: 'tenant.status_changed', targetType: 'tenant', targetId: tenantId, ...actor,
    details: { from, to: target, reason, ...(scheduled ? { deletionScheduledAt: scheduled.toISOString() } : {}) },
  });
  await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
    VALUES (${tenantId}, 'tenant.status_changed', ${JSON.stringify({ type: actor.actorType ?? 'user', id: actor.actorId })}::jsonb,
            ${JSON.stringify({ from, to: target, reason })}::jsonb, gen_random_uuid())`);
  return { from, to: target, deletionScheduledAt: scheduled };
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { authorize } from '../../common/authorize';
import { buildTenantContext } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { recordPredicate, uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, MAILER, type Mailer } from '../../infra/tokens';
import { CRM } from '../crm/crm-objects';
import { TasksService } from '../tasks/tasks.service';
import { CampaignsService } from './campaigns.service';
import { contactMask } from './customer-mask';
import { reachability } from './customers.service';

// P9f (docs/p9-plan.md §43–45): RFM on every B2C customer (nightly) and the built-in B2C automations — abandoned
// order, repeat purchase, win-back — which e-mail only customers with e-mail consent (B2C-06, AC-G5-2).

type Segment = 'champions' | 'loyal' | 'new' | 'at_risk' | 'hibernating' | 'regular';
type Rules = { windowDays: number; hibernatingDays: number };
type Step = { enabled: boolean; subject: string; body: string };
type Automations = { abandonedOrder: Step & { afterHours: number }; repeatPurchase: Step & { afterDays: number }; winback: Step & { task: boolean } };
type Mail = { to: string; jobId: string; subject: string; body: string; tenantName: string; tenantId: string; kind: string; key: string };

async function setting<T>(tx: Db, tenantId: string, key: string): Promise<T> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT v.value FROM tenant_settings_head h JOIN tenant_settings v USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = ${key}`);
  const def = configKey(key);
  if (!def) throw new Error(`${key} is not registered`);
  return mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as T;
}

/** Recency score by days since the last order, frequency score by orders in the window (absolute bands, so a small
 *  workspace gets the same answer as a large one); the segment follows from them. */
export function rfmSegment(recencyDays: number, frequency: number, hibernatingDays: number): { r: number; f: number; segment: Segment } {
  const r = recencyDays <= 30 ? 5 : recencyDays <= 60 ? 4 : recencyDays <= 90 ? 3 : recencyDays < hibernatingDays ? 2 : 1;
  const f = frequency >= 10 ? 5 : frequency >= 5 ? 4 : frequency >= 3 ? 3 : frequency === 2 ? 2 : 1;
  const segment: Segment = recencyDays >= hibernatingDays ? 'hibernating'
    : r >= 4 && f >= 4 ? 'champions'
      : f >= 3 ? 'loyal'
        : r >= 4 && frequency <= 1 ? 'new'
          : r <= 2 ? 'at_risk' : 'regular';
  return { r, f, segment };
}

@Injectable()
export class RfmService {
  private readonly log = new Logger('b2c');

  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(MAILER) private readonly mailer: Mailer, private readonly tasks: TasksService, private readonly campaigns: CampaignsService) {}

  // ------------------------------------------------------------------ reading
  async summary(t: TenantRequestContext, segment: Segment | undefined, limit: number) {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
    authorize(t, 'sales_b2c.rfm.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const visible = await recordPredicate(tx, t, CRM.contact.shape, 'read');
      const counts = (await tx.execute<{ segment: Segment; n: number }>(sql`
        SELECT cp.rfm_segment AS segment, count(*)::int AS n FROM customer_profiles cp JOIN contacts t ON t.tenant_id = cp.tenant_id AND t.id = cp.contact_id
        WHERE cp.rfm_segment IS NOT NULL AND t.deleted_at IS NULL AND ${visible} GROUP BY cp.rfm_segment ORDER BY cp.rfm_segment`)).rows;
      const rows = (await tx.execute<{ id: string; full_name: string; owner_user_id: string; owner_name: string; rfm_segment: Segment; rfm_score: string; rfm_recency: number; rfm_frequency: number; rfm_monetary: string; rfm_at: string }>(sql`
        SELECT t.id, t.full_name, t.owner_user_id, u.display_name AS owner_name, cp.rfm_segment, cp.rfm_score, cp.rfm_recency, cp.rfm_frequency, cp.rfm_monetary::text AS rfm_monetary, cp.rfm_at
        FROM customer_profiles cp JOIN contacts t ON t.tenant_id = cp.tenant_id AND t.id = cp.contact_id JOIN users u ON u.id = t.owner_user_id
        WHERE cp.rfm_segment IS NOT NULL AND t.deleted_at IS NULL AND ${visible} ${segment ? sql`AND cp.rfm_segment = ${segment}` : sql``}
        ORDER BY cp.rfm_recency DESC, t.id LIMIT ${limit}`)).rows;
      const at = (await tx.execute<{ at: string | null }>(sql`SELECT max(rfm_at) AS at FROM customer_profiles`)).rows[0]?.at ?? null;
      const mask = contactMask(t);
      return {
        segments: counts.map((c) => ({ segment: c.segment, count: c.n })),
        customers: rows.map((r) => ({
          id: r.id, fullName: mask.name ? r.full_name : '', owner: { id: r.owner_user_id, displayName: r.owner_name },
          rfm: { segment: r.rfm_segment, score: r.rfm_score, recencyDays: r.rfm_recency, frequency: r.rfm_frequency, monetary: Number(r.rfm_monetary).toFixed(2), at: new Date(r.rfm_at).toISOString() },
        })),
        computedAt: at ? new Date(at).toISOString() : null,
      };
    });
  }

  /** Admin: now, for the caller's workspace (the nightly job does every workspace). */
  async recomputeNow(t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    await this.recomputeTenant(t.tenant.id);
    return this.summary(t, undefined, 50);
  }

  // ------------------------------------------------------------------ jobs
  /** Nightly (catalogue job `sales_b2c.rfm.recompute`): RFM for every B2C workspace, then the win-back automation. */
  async recomputeAll(): Promise<number> {
    let n = 0;
    for (const { tenant_id: tenantId } of await this.tenants()) {
      try {
        n += await this.recomputeTenant(tenantId);
      } catch (e) {
        this.log.warn(`rfm failed for a tenant: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /** Hourly: abandoned orders and repeat-purchase reminders. */
  async runAutomations(): Promise<number> {
    let n = 0;
    for (const { tenant_id: tenantId } of await this.tenants()) {
      try {
        n += await this.automateTenant(tenantId);
        n += await this.requeueTenant(tenantId);
        n += await this.campaigns.requeue(tenantId);
      } catch (e) {
        this.log.warn(`b2c automations failed for a tenant: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async tenants(): Promise<{ tenant_id: string }[]> {
    return this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM app.b2c_tenants()`)).rows);
  }

  async recomputeTenant(tenantId: string): Promise<number> {
    const { count, entered } = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, async (tx) => {
      const rules = await setting<Rules>(tx, tenantId, 'sales_b2c.rfm');
      const rows = (await tx.execute<{ customer_id: string; last: string; recency: number; frequency: number; monetary: string; m: number; was: Segment | null }>(sql`
        WITH o AS (
          SELECT o.customer_id, max(o.created_at) AS last,
            count(*) FILTER (WHERE o.created_at >= now() - make_interval(days => ${rules.windowDays}))::int AS frequency,
            COALESCE(sum((o.totals ->> 'total')::numeric) FILTER (WHERE o.created_at >= now() - make_interval(days => ${rules.windowDays})), 0) AS monetary
          FROM orders o JOIN contacts c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
          WHERE o.segment = 'b2c' AND o.status NOT IN ('cancelled', 'returned') AND c.deleted_at IS NULL AND c.anonymized_at IS NULL
          GROUP BY o.customer_id
        )
        SELECT o.customer_id, o.last, floor(extract(epoch FROM now() - o.last) / 86400)::int AS recency, o.frequency, o.monetary::text AS monetary,
          ntile(5) OVER (ORDER BY o.monetary, o.customer_id)::int AS m, cp.rfm_segment AS was
        FROM o LEFT JOIN customer_profiles cp ON cp.contact_id = o.customer_id`)).rows;
      const entered: string[] = [];
      for (const r of rows) {
        const s = rfmSegment(r.recency, r.frequency, rules.hibernatingDays);
        await tx.execute(sql`
          INSERT INTO customer_profiles (tenant_id, contact_id, rfm_recency, rfm_frequency, rfm_monetary, rfm_score, rfm_segment, rfm_at, last_order_at)
          VALUES (${tenantId}, ${r.customer_id}, ${r.recency}, ${r.frequency}, ${r.monetary}::numeric, ${`${String(s.r)}${String(s.f)}${String(r.m)}`}, ${s.segment}, now(), ${r.last}::timestamptz)
          ON CONFLICT (tenant_id, contact_id) DO UPDATE SET rfm_recency = EXCLUDED.rfm_recency, rfm_frequency = EXCLUDED.rfm_frequency, rfm_monetary = EXCLUDED.rfm_monetary,
            rfm_score = EXCLUDED.rfm_score, rfm_segment = EXCLUDED.rfm_segment, rfm_at = EXCLUDED.rfm_at, last_order_at = EXCLUDED.last_order_at`);
        if (s.segment === 'hibernating' && r.was !== 'hibernating') entered.push(r.customer_id);
      }
      // No qualifying order any more (cancelled, returned): no RFM, so no segment-targeted discount or message.
      const cleared = await tx.execute(sql`
        UPDATE customer_profiles SET rfm_recency = NULL, rfm_frequency = NULL, rfm_monetary = NULL, rfm_score = NULL, rfm_segment = NULL, rfm_at = now(), last_order_at = NULL
        WHERE rfm_segment IS NOT NULL AND NOT (contact_id = ANY(${uuidArray(rows.map((r) => r.customer_id))}))`);
      const changed = rows.filter((r) => r.was !== rfmSegment(r.recency, r.frequency, rules.hibernatingDays).segment).length + (cleared.rowCount ?? 0);
      await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, segment, actor, payload, correlation_id)
        VALUES (${tenantId}, 'customer.rfm_recomputed', 'b2c', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
          ${JSON.stringify({ customers: rows.length, segmentChanges: changed })}::jsonb, gen_random_uuid())`);
      return { count: rows.length, entered };
    });
    await this.winback(tenantId, entered);
    return count;
  }

  // ------------------------------------------------------------------ automations
  /** The customer's owner acts (their segments and record rights); a task needs a person behind it. */
  private async ownerContext(tenantId: string, customerId: string): Promise<TenantRequestContext | null> {
    const owner = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, async (tx) => (await tx.execute<{ owner: string; active: boolean }>(sql`
      SELECT c.owner_user_id AS owner, m.status = 'active' AS active FROM contacts c JOIN memberships m ON m.user_id = c.owner_user_id WHERE c.id = ${customerId}`)).rows[0]);
    if (!owner?.active) return null;
    return buildTenantContext(this.db, { userId: owner.owner, sessionId: 'b2c-automation', tenantId, amr: [] });
  }

  /** One run per kind and subject: an e-mail when the customer may be e-mailed, otherwise the reason is kept. */
  private async act(tx: Db, tenantId: string, tenantName: string, kind: 'abandoned_order' | 'repeat_purchase' | 'winback', key: string, customerId: string, step: Step, taskId: string | null, mails: Mail[]): Promise<boolean> {
    const r = await reachability(tx, tenantId, customerId, 'email');
    const claimed = await tx.execute(sql`
      INSERT INTO b2c_automation_runs (tenant_id, kind, subject_key, customer_id, emailed, blocked, task_id)
      VALUES (${tenantId}, ${kind}, ${key}, ${customerId}, ${r.allowed}, ${r.allowed ? null : (r.reason ?? 'no_consent')}, ${taskId})
      ON CONFLICT (tenant_id, kind, subject_key) DO NOTHING`);
    if ((claimed.rowCount ?? 0) === 0) return false;
    if (r.allowed && r.address) mails.push({ to: r.address, jobId: `b2c-${kind}-${key}`.replace(/:/g, '-'), subject: step.subject, body: step.body, tenantName, tenantId, kind, key });
    return true;
  }

  /** Queues the mails after the commit and marks each run once its mail is on the queue (`requeueTenant` retries). */
  private async send(mails: readonly Mail[]): Promise<void> {
    for (const m of mails) {
      await this.mailer.send({ template: 'customer_message', to: m.to, locale: 'tr-TR', vars: { tenantName: m.tenantName, subject: m.subject, body: m.body } }, { jobId: m.jobId });
      await this.db.withTenant({ tenantId: m.tenantId, userId: null, segments: ['b2c'] }, (tx) => tx.execute(sql`
        UPDATE b2c_automation_runs SET queued_at = now() WHERE kind = ${m.kind} AND subject_key = ${m.key}`));
    }
  }

  /** Automation mails that never reached the queue are queued again, consent asked again, with the current text. */
  async requeueTenant(tenantId: string): Promise<number> {
    const { due, a, name } = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, async (tx) => ({
      due: (await tx.execute<{ kind: 'abandoned_order' | 'repeat_purchase' | 'winback'; subject_key: string; customer_id: string }>(sql`
        SELECT kind, subject_key, customer_id FROM b2c_automation_runs WHERE emailed AND queued_at IS NULL AND at < now() - interval '5 minutes' ORDER BY at LIMIT 1000`)).rows,
      a: await setting<Automations>(tx, tenantId, 'sales_b2c.automations'),
      name: (await tx.execute<{ name: string }>(sql`SELECT name FROM tenants`)).rows[0]?.name ?? '',
    }));
    const steps = { abandoned_order: a.abandonedOrder, repeat_purchase: a.repeatPurchase, winback: a.winback };
    let n = 0;
    for (const d of due) {
      const r = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, (tx) => reachability(tx, tenantId, d.customer_id, 'email'));
      if (r.allowed && r.address) {
        await this.mailer.send({ template: 'customer_message', to: r.address, locale: 'tr-TR', vars: { tenantName: name, subject: steps[d.kind].subject, body: steps[d.kind].body } },
          { jobId: `b2c-${d.kind}-${d.subject_key}`.replace(/:/g, '-') });
        n += 1;
      }
      await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, (tx) => tx.execute(sql`
        UPDATE b2c_automation_runs SET queued_at = now() WHERE kind = ${d.kind} AND subject_key = ${d.subject_key}`));
    }
    return n;
  }

  async automateTenant(tenantId: string): Promise<number> {
    const mails: Mail[] = [];
    const n = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, async (tx) => {
      const a = await setting<Automations>(tx, tenantId, 'sales_b2c.automations');
      const name = (await tx.execute<{ name: string }>(sql`SELECT name FROM tenants`)).rows[0]?.name ?? '';
      let done = 0;
      if (a.abandonedOrder.enabled) {
        const due = (await tx.execute<{ id: string; customer_id: string }>(sql`
          SELECT o.id, o.customer_id FROM orders o WHERE o.segment = 'b2c' AND o.status = 'new' AND o.payment_status = 'pending'
            AND o.created_at <= now() - make_interval(hours => ${a.abandonedOrder.afterHours})
            AND NOT EXISTS (SELECT 1 FROM b2c_automation_runs x WHERE x.kind = 'abandoned_order' AND x.subject_key = o.id::text) ORDER BY o.id LIMIT 500`)).rows;
        for (const o of due) if (await this.act(tx, tenantId, name, 'abandoned_order', o.id, o.customer_id, a.abandonedOrder, null, mails)) done += 1;
      }
      if (a.repeatPurchase.enabled) {
        const due = (await tx.execute<{ id: string; customer_id: string }>(sql`
          SELECT o.id, o.customer_id FROM orders o
          JOIN LATERAL (SELECT max(h.at) AS at FROM order_status_history h WHERE h.order_id = o.id AND h.kind = 'status' AND h.to_value = 'delivered') d ON d.at IS NOT NULL
          WHERE o.segment = 'b2c' AND o.status = 'delivered' AND d.at <= now() - make_interval(days => ${a.repeatPurchase.afterDays})
            AND NOT EXISTS (SELECT 1 FROM orders n WHERE n.customer_id = o.customer_id AND n.segment = 'b2c' AND n.created_at > o.created_at AND n.status <> 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM b2c_automation_runs x WHERE x.kind = 'repeat_purchase' AND x.subject_key = o.id::text) ORDER BY o.id LIMIT 500`)).rows;
        for (const o of due) if (await this.act(tx, tenantId, name, 'repeat_purchase', o.id, o.customer_id, a.repeatPurchase, null, mails)) done += 1;
      }
      return done;
    });
    await this.send(mails);
    return n;
  }

  /** Customers who just became hibernating: a win-back task for the owner and, with consent, an e-mail. */
  private async winback(tenantId: string, customers: readonly string[]): Promise<void> {
    if (customers.length === 0) return;
    const a = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, (tx) => setting<Automations>(tx, tenantId, 'sales_b2c.automations'));
    if (!a.winback.enabled) return;
    for (const id of customers) {
      const ctx = await this.ownerContext(tenantId, id);
      const mails: Mail[] = [];
      await this.db.withTenant(ctx ? dbCtx(ctx) : { tenantId, userId: null, segments: ['b2c'] }, async (tx) => {
        const [c] = (await tx.execute<{ full_name: string; last: string | null; tenant_name: string }>(sql`
          SELECT c.full_name, cp.last_order_at::text AS last, (SELECT name FROM tenants) AS tenant_name FROM contacts c LEFT JOIN customer_profiles cp ON cp.contact_id = c.id WHERE c.id = ${id}`)).rows;
        if (!c) return;
        // Once per entry into the segment: the last order dates the entry.
        const key = `${id}:${c.last ?? 'none'}`;
        const seen = await tx.execute(sql`SELECT 1 FROM b2c_automation_runs WHERE kind = 'winback' AND subject_key = ${key}`);
        if ((seen.rowCount ?? 0) > 0) return;
        let taskId: string | null = null;
        if (a.winback.task && ctx) {
          taskId = await this.tasks.insertTask(tx, ctx, {
            title: `Geri kazanım: ${c.full_name}`.slice(0, 300), priority: 2, owner: { type: 'user', id: ctx.principal.userId }, related: { type: 'contact', id },
          }, {});
        }
        await this.act(tx, tenantId, c.tenant_name, 'winback', key, id, a.winback, taskId, mails);
      });
      await this.send(mails);
    }
  }
}

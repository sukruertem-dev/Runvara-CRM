import { Inject, Injectable, Logger } from '@nestjs/common';
import { can } from '@flexa/authz';
import type { ContractCreate, ContractListQuery, ContractPatch, ContractRenew, ContractTerminate, OrderCreate, OrderListQuery, OrderStatusSet, PipelineCreate, PipelinePatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { recordActivity } from '../../common/activity';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { buildTenantContext } from '../../common/guards';
import { mapDbError } from '../../common/http-helpers';
import { notify } from '../../common/notify';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { assertCan, hiddenFields, recordPredicate } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, readCrmRow, type CrmRow } from '../crm/crm-objects';
import { TasksService } from '../tasks/tasks.service';

// B2B after the quote (docs/p9-plan.md §8–13): sales pipelines, contracts with renewal, orders. Contracts and orders
// belong to a won B2B opportunity and are as visible as it is; writing needs the permission and the right to edit it.

type ContractRow = {
  id: string; number: string; opportunity_id: string; opportunity_name: string; account_id: string | null; account_name: string | null; quote_id: string | null; quote_number: string | null;
  title: string; start_date: string; end_date: string; value: string | null; currency: string; auto_renew: boolean; renewal_notice_days: number; renewal_due_on: string;
  status: 'active' | 'ended' | 'renewed' | 'terminated'; terminated_on: string | null; termination_reason: string | null; renewed_from_id: string | null; renewed_from_number: string | null;
  renewed_by_id: string | null; renewed_by_number: string | null; reminded_at: string | null; note: string; created_by: string; creator_name: string; created_at: string; version: number;
};
type OrderRow = {
  id: string; number: string; segment: Segment; opportunity_id: string | null; opportunity_name: string | null; quote_id: string | null; quote_number: string | null; quote_version: number | null;
  contract_id: string | null; contract_number: string | null; currency: string; status: 'open' | 'fulfilled' | 'cancelled'; status_reason: string | null;
  totals: { subtotal?: string; discount?: string; net?: string; tax?: string; total?: string }; note: string; created_by: string; creator_name: string; created_at: string; version: number;
};

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
const ref = (id: string | null, number: string | null) => (id ? { id, number: number ?? '' } : null);
/** Money from numeric: at least two decimals, no trailing zeros beyond. */
const money = (v: string | null): string | null => {
  if (v === null) return null;
  const [i = '0', f = ''] = v.split('.');
  return `${i}.${f.replace(/0+$/, '').padEnd(2, '0')}`;
};
const cut = (v: string, d = 2): string => {
  const [i = '0', f = ''] = v.split('.');
  return `${i}.${f.padEnd(d, '0').slice(0, d)}`;
};

@Injectable()
export class B2bService {
  private readonly log = new Logger('b2b');

  constructor(@Inject(DB) private readonly db: DbHandle, private readonly tasks: TasksService) {}

  // ------------------------------------------------------------------ pipelines (tenant configuration, A02)
  async createPipeline(t: TenantRequestContext, body: z.infer<typeof PipelineCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const wf = await tx.execute<{ id: string }>(sql`SELECT id FROM workflows WHERE id = ${body.workflowId} AND resource_type = 'opportunity'`);
      if (!wf.rows[0]) throw new ProblemError('PIPELINE_INVALID', 'workflowId must be an opportunity workflow');
      let id: string;
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO pipelines (tenant_id, key, name, segment, workflow_id) VALUES (${t.tenant.id}, ${body.key}, ${body.name}, ${body.segment}::segment, ${body.workflowId}) RETURNING id`);
        id = r.rows[0]?.id ?? '';
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a pipeline with this key exists');
        return mapDbError(e);
      }
      // Every stage of the workflow, with a starting probability by its category; the Admin sets the real ones.
      await tx.execute(sql`INSERT INTO pipeline_stages (tenant_id, pipeline_id, status_id, probability)
        SELECT ${t.tenant.id}, ${id}, s.id, CASE s.category WHEN 'open' THEN 10 WHEN 'in_progress' THEN 50 ELSE 0 END FROM statuses s WHERE s.workflow_id = ${body.workflowId}`);
      await audit(tx, t.tenant.id, { action: 'pipeline.created', actorId: t.principal.userId, targetType: 'pipeline', targetId: id, ip, details: { key: body.key, segment: body.segment } });
      return { id };
    });
  }

  async patchPipeline(t: TenantRequestContext, id: string, body: z.infer<typeof PipelinePatch>, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const p = (await tx.execute<{ workflow_id: string }>(sql`SELECT workflow_id FROM pipelines WHERE id = ${id} FOR UPDATE`)).rows[0];
      if (!p) throw new ProblemError('NOT_FOUND');
      if (body.name) await tx.execute(sql`UPDATE pipelines SET name = ${body.name} WHERE id = ${id}`);
      if (body.isDefault) {
        await tx.execute(sql`UPDATE pipelines SET is_default = false WHERE is_default AND id <> ${id}`);
        await tx.execute(sql`UPDATE pipelines SET is_default = true WHERE id = ${id}`);
      }
      if (body.stages) {
        const own = new Set((await tx.execute<{ id: string }>(sql`SELECT id FROM statuses WHERE workflow_id = ${p.workflow_id}`)).rows.map((r) => r.id));
        if (body.stages.some((s) => !own.has(s.statusId))) throw new ProblemError('PIPELINE_INVALID', 'stages must be statuses of the pipeline’s workflow');
        for (const s of body.stages) {
          await tx.execute(sql`INSERT INTO pipeline_stages (tenant_id, pipeline_id, status_id, probability) VALUES (${t.tenant.id}, ${id}, ${s.statusId}, ${s.probability})
            ON CONFLICT (tenant_id, pipeline_id, status_id) DO UPDATE SET probability = EXCLUDED.probability`);
        }
        // Opportunities that follow the stage default move with it; manual values stay.
        await tx.execute(sql`UPDATE opportunities o SET probability = ps.probability, version = o.version + 1 FROM pipeline_stages ps
          WHERE ps.pipeline_id = o.pipeline_id AND ps.status_id = o.status_id AND o.pipeline_id = ${id} AND NOT o.probability_manual AND o.probability <> ps.probability`);
      }
      await audit(tx, t.tenant.id, { action: 'pipeline.updated', actorId: t.principal.userId, targetType: 'pipeline', targetId: id, ip, details: { fields: Object.keys(body) } });
    });
  }

  // ------------------------------------------------------------------ shared
  private assertAmounts(t: TenantRequestContext): void {
    if (hiddenFields(t, 'opportunity').has('amount')) throw new ProblemError('NOT_FOUND');
  }

  /** The opportunity of a contract or order: readable, B2B, editable by the caller, and won. */
  private async wonOpportunity(tx: Db, t: TenantRequestContext, id: string, permission: string): Promise<CrmRow> {
    const opp = await readCrmRow(tx, t, CRM.opportunity, id);
    authorize(t, permission);
    await assertCan(tx, t, CRM.opportunity.shape, id, 'update');
    if (opp.segment !== 'b2b') throw new ProblemError('SEGMENT_NOT_ALLOWED', 'contracts and orders here are for B2B opportunities');
    // Won = a closed stage the pipeline counts as won (its probability above zero), as targets count it (B86); the
    // opportunity's own probability may be set by hand and survives a loss.
    const won = opp.s_category === 'closed' && ((await tx.execute(sql`
      SELECT 1 FROM pipeline_stages WHERE pipeline_id = ${opp.pipeline_id} AND status_id = ${opp.status_id} AND probability > 0`)).rowCount ?? 0) > 0;
    if (!won) throw new ProblemError('OPPORTUNITY_NOT_WON');
    return opp;
  }

  private async next(tx: Db, t: TenantRequestContext, kind: 'contract' | 'order'): Promise<string> {
    const year = Number((await tx.execute<{ y: string }>(sql`SELECT extract(year FROM now() AT TIME ZONE ${t.tenant.timezone})::text AS y`)).rows[0]?.y);
    const r = await tx.execute<{ last: number }>(sql`INSERT INTO document_counters (tenant_id, kind, year, last) VALUES (${t.tenant.id}, ${kind}, ${year}, 1)
      ON CONFLICT (tenant_id, kind, year) DO UPDATE SET last = document_counters.last + 1 RETURNING last`);
    return `${kind === 'contract' ? 'S' : 'SP'}-${String(year)}-${String(r.rows[0]?.last ?? 1).padStart(5, '0')}`;
  }

  private async mayEdit(tx: Db, t: TenantRequestContext, opportunityId: string, permission: string): Promise<boolean> {
    if (!can(t.authz, permission).allow) return false;
    const r = await tx.execute(sql`SELECT 1 FROM ${CRM.opportunity.from} WHERE t.id = ${opportunityId} AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'update')}`);
    return (r.rowCount ?? 0) > 0;
  }

  private async log_(tx: Db, t: TenantRequestContext, kind: 'contract' | 'order', id: string, number: string, opportunityId: string, action: string, details: Record<string, unknown> = {}): Promise<void> {
    await recordActivity(tx, t, { type: 'opportunity', id: opportunityId, kind, data: { [`${kind}Id`]: id, number, action } });
    await audit(tx, t.tenant.id, { action: `${kind}.${action}`, actorId: t.principal.userId, targetType: kind, targetId: id, details: { number, opportunityId, ...details } });
  }

  // ------------------------------------------------------------------ contracts
  private async contractRows(tx: Db, t: TenantRequestContext, where: SQL, limit = 100): Promise<ContractRow[]> {
    return (await tx.execute<ContractRow>(sql`
      SELECT c.id, c.number, c.opportunity_id, t.name AS opportunity_name, a.id AS account_id, a.name AS account_name, c.quote_id, q.number AS quote_number, c.title,
        c.start_date::text, c.end_date::text, c.value::text, c.currency, c.auto_renew, c.renewal_notice_days, (c.end_date - c.renewal_notice_days)::text AS renewal_due_on,
        c.status, c.terminated_on::text, c.termination_reason, c.renewed_from_id, rf.number AS renewed_from_number, rb.id AS renewed_by_id, rb.number AS renewed_by_number,
        c.reminded_at, c.note, c.created_by, u.display_name AS creator_name, c.created_at, c.version
      FROM ${CRM.opportunity.from}
      JOIN contracts c ON c.tenant_id = t.tenant_id AND c.opportunity_id = t.id
      JOIN users u ON u.id = c.created_by
      LEFT JOIN accounts a ON a.tenant_id = t.tenant_id AND a.id = t.account_id AND a.deleted_at IS NULL AND ${await this.accountReadable(tx, t)}
      LEFT JOIN quotes q ON q.tenant_id = c.tenant_id AND q.id = c.quote_id
      LEFT JOIN contracts rf ON rf.tenant_id = c.tenant_id AND rf.id = c.renewed_from_id
      LEFT JOIN contracts rb ON rb.tenant_id = c.tenant_id AND rb.renewed_from_id = c.id
      WHERE t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')} AND ${where}
      ORDER BY c.id DESC LIMIT ${limit}`)).rows;
  }

  /** The account's name only for those who can read the account (predicate on alias `a`). */
  private async accountReadable(tx: Db, t: TenantRequestContext): Promise<SQL> {
    const p = await recordPredicate(tx, t, CRM.account.shape, 'read');
    return sql`EXISTS (SELECT 1 FROM accounts t WHERE t.id = a.id AND ${p})`;
  }

  private async contractView(tx: Db, t: TenantRequestContext, c: ContractRow) {
    return {
      id: c.id, number: c.number, opportunity: { id: c.opportunity_id, name: c.opportunity_name }, account: c.account_id ? { id: c.account_id, name: c.account_name ?? '' } : null,
      quote: ref(c.quote_id, c.quote_number), title: c.title, startDate: c.start_date, endDate: c.end_date, value: money(c.value), currency: c.currency, autoRenew: c.auto_renew,
      renewalNoticeDays: c.renewal_notice_days, renewalDueOn: c.renewal_due_on, status: c.status, terminatedOn: c.terminated_on, terminationReason: c.termination_reason,
      renewedFrom: ref(c.renewed_from_id, c.renewed_from_number), renewedBy: ref(c.renewed_by_id, c.renewed_by_number), remindedAt: iso(c.reminded_at), note: c.note,
      createdBy: { id: c.created_by, displayName: c.creator_name }, createdAt: new Date(c.created_at).toISOString(),
      canEdit: c.status === 'active' && (await this.mayEdit(tx, t, c.opportunity_id, 'sales_b2b.contract.manage')), version: c.version,
    };
  }

  private async readContract(tx: Db, t: TenantRequestContext, id: string, lock = false): Promise<ContractRow> {
    this.assertAmounts(t);
    if (lock) await tx.execute(sql`SELECT 1 FROM contracts WHERE id = ${id} FOR UPDATE`);
    const [c] = await this.contractRows(tx, t, sql`c.id = ${id}`, 1);
    if (!c) throw new ProblemError('NOT_FOUND');
    return c;
  }

  async listContracts(t: TenantRequestContext, q: z.infer<typeof ContractListQuery>) {
    this.assertAmounts(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if (q.opportunityId) await readCrmRow(tx, t, CRM.opportunity, q.opportunityId);
      const rows = await this.contractRows(tx, t, sql`TRUE ${q.opportunityId ? sql`AND c.opportunity_id = ${q.opportunityId}` : sql``}
        ${q.status ? sql`AND c.status = ${q.status}` : sql``} ${q.cursor ? sql`AND c.id < ${q.cursor}` : sql``}`, q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: await Promise.all(page.map((c) => this.contractView(tx, t, c))), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  async getContract(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => this.contractView(tx, t, await this.readContract(tx, t, id)));
  }

  async createContract(t: TenantRequestContext, body: z.infer<typeof ContractCreate>) {
    this.assertAmounts(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const opp = await this.wonOpportunity(tx, t, body.opportunityId, 'sales_b2b.contract.manage');
      let value = body.value ?? (typeof opp.amount === 'string' || typeof opp.amount === 'number' ? String(opp.amount) : null);
      let currency = String(opp.currency);
      if (body.quoteId) {
        const q = (await tx.execute<{ status: string; opportunity_id: string; currency: string; total: string | null }>(sql`
          SELECT q.status, q.opportunity_id, q.currency, v.totals ->> 'net' AS total FROM quotes q JOIN quote_versions v ON v.quote_id = q.id AND v.version = q.current_version WHERE q.id = ${body.quoteId}`)).rows[0];
        if (!q || q.opportunity_id !== body.opportunityId) throw new ProblemError('VALIDATION_FAILED', 'quoteId: not a quote of this opportunity');
        if (q.status !== 'accepted') throw new ProblemError('QUOTE_STATE', 'only an accepted quote becomes a contract', { quoteStatus: q.status });
        currency = q.currency;
        if (body.value === undefined) value = q.total;
      }
      const number = await this.next(tx, t, 'contract');
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO contracts (tenant_id, number, opportunity_id, quote_id, title, start_date, end_date, value, currency, auto_renew, renewal_notice_days, note, created_by)
        VALUES (${t.tenant.id}, ${number}, ${body.opportunityId}, ${body.quoteId}, ${body.title ?? String(opp.name)}, ${body.startDate}::date, ${body.endDate}::date, ${value}::numeric, ${currency},
          ${body.autoRenew ?? false}, ${body.renewalNoticeDays ?? 30}, ${body.note ?? ''}, ${t.principal.userId}) RETURNING id`);
      const id = r.rows[0]?.id ?? '';
      await this.log_(tx, t, 'contract', id, number, body.opportunityId, 'created');
      return this.contractView(tx, t, await this.readContract(tx, t, id));
    });
  }

  async patchContract(t: TenantRequestContext, id: string, expected: number, body: z.infer<typeof ContractPatch>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const c = await this.writableContract(tx, t, id);
      if (c.version !== expected) throw new ProblemError('PRECONDITION_FAILED', 'the contract was changed meanwhile', { currentVersion: c.version });
      const start = body.startDate ?? c.start_date;
      const end = body.endDate ?? c.end_date;
      if (end < start) throw new ProblemError('VALIDATION_FAILED', 'endDate is before startDate');
      // A new end date or notice period asks for a new reminder.
      const remind = body.endDate !== undefined || body.renewalNoticeDays !== undefined;
      await tx.execute(sql`UPDATE contracts SET title = ${body.title ?? c.title}, start_date = ${start}::date, end_date = ${end}::date,
        value = ${body.value === undefined ? c.value : body.value}::numeric, auto_renew = ${body.autoRenew ?? c.auto_renew}, renewal_notice_days = ${body.renewalNoticeDays ?? c.renewal_notice_days},
        note = ${body.note ?? c.note}, reminded_at = ${remind ? null : c.reminded_at}::timestamptz, version = version + 1 WHERE id = ${id}`);
      await this.log_(tx, t, 'contract', id, c.number, c.opportunity_id, 'updated', { fields: Object.keys(body) });
      return this.contractView(tx, t, await this.readContract(tx, t, id));
    });
  }

  private async writableContract(tx: Db, t: TenantRequestContext, id: string): Promise<ContractRow> {
    const c = await this.readContract(tx, t, id, true);
    authorize(t, 'sales_b2b.contract.manage');
    await assertCan(tx, t, CRM.opportunity.shape, c.opportunity_id, 'update');
    if (c.status !== 'active') throw new ProblemError('CONTRACT_STATE', `the contract is ${c.status}`, { contractStatus: c.status });
    return c;
  }

  async terminateContract(t: TenantRequestContext, id: string, body: z.infer<typeof ContractTerminate>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const c = await this.writableContract(tx, t, id);
      if (body.on < c.start_date || body.on > c.end_date) throw new ProblemError('VALIDATION_FAILED', 'on: must fall within the term');
      await tx.execute(sql`UPDATE contracts SET status = 'terminated', terminated_on = ${body.on}::date, termination_reason = ${body.reason}, version = version + 1 WHERE id = ${id}`);
      await this.log_(tx, t, 'contract', id, c.number, c.opportunity_id, 'terminated');
      return this.contractView(tx, t, await this.readContract(tx, t, id));
    });
  }

  async renewContract(t: TenantRequestContext, id: string, body: z.infer<typeof ContractRenew>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const c = await this.writableContract(tx, t, id);
      const next = await this.renewIn(tx, t, c, body.endDate ?? null, body.value);
      return this.contractView(tx, t, await this.readContract(tx, t, next));
    });
  }

  /** The next term from the day after the end, as long as this one in calendar terms (months, years) unless told otherwise; this one becomes `renewed`. */
  private async renewIn(tx: Db, t: TenantRequestContext, c: ContractRow, endDate: string | null, value: string | null | undefined): Promise<string> {
    const start = (await tx.execute<{ d: string }>(sql`SELECT (${c.end_date}::date + 1)::text AS d`)).rows[0]?.d ?? '';
    const end = endDate ?? (await tx.execute<{ d: string }>(sql`SELECT (${start}::date + age(${c.end_date}::date + 1, ${c.start_date}::date) - interval '1 day')::date::text AS d`)).rows[0]?.d ?? '';
    if (end < start) throw new ProblemError('VALIDATION_FAILED', 'endDate: the next term ends before it starts');
    const number = await this.next(tx, t, 'contract');
    let id: string;
    try {
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO contracts (tenant_id, number, opportunity_id, quote_id, title, start_date, end_date, value, currency, auto_renew, renewal_notice_days, note, renewed_from_id, created_by)
        SELECT tenant_id, ${number}, opportunity_id, quote_id, title, ${start}::date, ${end}::date, ${value === undefined ? sql`value` : sql`${value}::numeric`}, currency, auto_renew, renewal_notice_days, note, id, ${t.principal.userId}
        FROM contracts WHERE id = ${c.id} RETURNING id`);
      id = r.rows[0]?.id ?? '';
    } catch (e) {
      if (isUniqueViolation(e, 'contracts_one_renewal')) throw new ProblemError('CONTRACT_STATE', 'the contract is already renewed', { contractStatus: 'renewed' });
      return mapDbError(e);
    }
    await tx.execute(sql`UPDATE contracts SET status = 'renewed', version = version + 1 WHERE id = ${c.id}`);
    await this.log_(tx, t, 'contract', c.id, c.number, c.opportunity_id, 'renewed', { next: id });
    await this.log_(tx, t, 'contract', id, number, c.opportunity_id, 'created', { renewedFrom: c.id });
    return id;
  }

  /** Hourly: renewal reminders (a task and a notice for the opportunity's owner, `contract.renewal_due`), then the end
   *  of terms: renewed when the contract renews itself, `ended` otherwise. */
  async runDue(limit = 200): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; id: string }>(sql`SELECT tenant_id, id FROM app.due_contracts(${limit})`)).rows);
    let n = 0;
    for (const d of due) {
      try {
        if (await this.handleDue(d.tenant_id, d.id)) n += 1;
      } catch (e) {
        this.log.warn(`contract ${d.id}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  private async handleDue(tenantId: string, id: string): Promise<boolean> {
    const owner = await this.db.withTenant({ tenantId, userId: null, segments: ['b2b'] }, async (tx) => (await tx.execute<{ owner: string; active: boolean; admin: string | null }>(sql`
      SELECT o.owner_user_id AS owner, m.status = 'active' AS active,
        (SELECT ur.user_id::text FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN memberships am ON am.user_id = ur.user_id AND am.status = 'active' WHERE r.key = 'admin' ORDER BY ur.user_id LIMIT 1) AS admin
      FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id JOIN memberships m ON m.user_id = o.owner_user_id WHERE c.id = ${id}`)).rows[0]);
    if (!owner) return false;
    const actor = owner.active ? owner.owner : owner.admin;
    if (!actor) return false;
    const t = await buildTenantContext(this.db, { userId: actor, sessionId: 'contracts', tenantId, amr: [] });
    // Acting for the owner: within their segments, without a request's narrowing.
    return this.db.withTenant({ tenantId, userId: actor, segments: ['b2b'] }, async (tx) => {
      const locked = await tx.execute<{ reminded: boolean; ended: boolean }>(sql`
        SELECT c.reminded_at IS NOT NULL AS reminded, c.end_date < (now() AT TIME ZONE ${t.tenant.timezone})::date AS ended
        FROM contracts c WHERE c.id = ${id} AND c.status = 'active' FOR UPDATE SKIP LOCKED`);
      const s = locked.rows[0];
      if (!s) return false;
      const [c] = await tx.execute<ContractRow>(sql`SELECT c.*, c.start_date::text AS start_date, c.end_date::text AS end_date, c.value::text AS value, o.name AS opportunity_name
        FROM contracts c JOIN opportunities o ON o.id = c.opportunity_id WHERE c.id = ${id}`).then((r) => r.rows);
      if (!c) return false;
      const sys = t;
      if (!s.reminded) {
        const taskId = await this.tasks.insertTask(tx, sys, {
          title: `Sözleşme yenileme: ${c.number} · ${c.opportunity_name}`.slice(0, 300), priority: 2, owner: { type: 'user', id: actor },
          dueAt: new Date(`${c.end_date}T09:00:00Z`).toISOString(), related: { type: 'opportunity', id: c.opportunity_id },
        }, {});
        await tx.execute(sql`UPDATE contracts SET reminded_at = now() WHERE id = ${id}`);
        await notify(tx, sys, { users: [actor], kind: 'assigned', sourceType: 'contract', sourceId: id, recordType: 'opportunity', recordId: c.opportunity_id, includeActor: true });
        await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
          VALUES (${tenantId}, 'contract.renewal_due', 'opportunity', ${c.opportunity_id}, 'b2b', ${JSON.stringify({ type: 'system', id: null })}::jsonb,
            ${JSON.stringify({ contractId: id, endDate: c.end_date, taskId })}::jsonb, gen_random_uuid())`);
        await audit(tx, tenantId, { action: 'contract.renewal_due', actorType: 'system', actorId: null, targetType: 'contract', targetId: id, details: { taskId } });
      }
      if (s.ended) {
        if (c.auto_renew) await this.renewIn(tx, sys, c, null, undefined);
        else {
          await tx.execute(sql`UPDATE contracts SET status = 'ended', version = version + 1 WHERE id = ${id}`);
          await audit(tx, tenantId, { action: 'contract.ended', actorType: 'system', actorId: null, targetType: 'contract', targetId: id });
        }
      }
      return true;
    });
  }

  // ------------------------------------------------------------------ orders (B2B)
  private async orderRows(tx: Db, t: TenantRequestContext, where: SQL, limit = 100): Promise<OrderRow[]> {
    return (await tx.execute<OrderRow>(sql`
      SELECT o.id, o.number, o.segment, o.opportunity_id, t.name AS opportunity_name, o.quote_id, q.number AS quote_number, q.current_version AS quote_version, o.contract_id, c.number AS contract_number,
        o.currency, o.status, o.status_reason, o.totals, o.note, o.created_by, u.display_name AS creator_name, o.created_at, o.version
      FROM ${CRM.opportunity.from}
      JOIN orders o ON o.tenant_id = t.tenant_id AND o.opportunity_id = t.id
      JOIN users u ON u.id = o.created_by
      LEFT JOIN quotes q ON q.tenant_id = o.tenant_id AND q.id = o.quote_id
      LEFT JOIN contracts c ON c.tenant_id = o.tenant_id AND c.id = o.contract_id
      WHERE t.deleted_at IS NULL AND o.segment = 'b2b' AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')} AND ${where}
      ORDER BY o.id DESC LIMIT ${limit}`)).rows;
  }

  private async orderSummary(tx: Db, t: TenantRequestContext, o: OrderRow) {
    const totals = { subtotal: o.totals.subtotal ?? '0.00', discount: o.totals.discount ?? '0.00', net: o.totals.net ?? '0.00', tax: o.totals.tax ?? '0.00', total: o.totals.total ?? '0.00' };
    return {
      id: o.id, number: o.number, segment: o.segment, opportunity: o.opportunity_id ? { id: o.opportunity_id, name: o.opportunity_name ?? '' } : null,
      quote: o.quote_id ? { id: o.quote_id, number: o.quote_number ?? '', version: o.quote_version ?? 0 } : null, contract: ref(o.contract_id, o.contract_number),
      currency: o.currency, status: o.status, statusReason: o.status_reason, totals, note: o.note, createdBy: { id: o.created_by, displayName: o.creator_name },
      createdAt: new Date(o.created_at).toISOString(), canEdit: o.status === 'open' && o.opportunity_id !== null && (await this.mayEdit(tx, t, o.opportunity_id, 'sales_b2b.quote.create')), version: o.version,
    };
  }

  private async orderView(tx: Db, t: TenantRequestContext, o: OrderRow) {
    const lines = await tx.execute<{ product_id: string; sku: string; name: string; unit: string; quantity: string; unit_price: string; discount_percent: string; tax_percent: string; net: string; tax: string }>(sql`
      SELECT product_id, sku, name, unit, trim_scale(quantity)::text AS quantity, trim_scale(unit_price)::text AS unit_price, trim_scale(discount_percent)::text AS discount_percent,
        trim_scale(tax_percent)::text AS tax_percent, net::text, tax::text FROM order_lines WHERE order_id = ${o.id} ORDER BY position`);
    return {
      ...(await this.orderSummary(tx, t, o)),
      lines: lines.rows.map((l) => ({ productId: l.product_id, sku: l.sku, name: l.name, unit: l.unit, quantity: l.quantity, unitPrice: l.unit_price, discountPercent: l.discount_percent, taxPercent: l.tax_percent, net: cut(l.net), tax: cut(l.tax) })),
    };
  }

  private async readOrder(tx: Db, t: TenantRequestContext, id: string, lock = false): Promise<OrderRow> {
    this.assertAmounts(t);
    if (lock) await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${id} FOR UPDATE`);
    const [o] = await this.orderRows(tx, t, sql`o.id = ${id}`, 1);
    if (!o) throw new ProblemError('NOT_FOUND');
    return o;
  }

  async listOrders(t: TenantRequestContext, q: z.infer<typeof OrderListQuery>) {
    this.assertAmounts(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if (q.opportunityId) await readCrmRow(tx, t, CRM.opportunity, q.opportunityId);
      const rows = await this.orderRows(tx, t, sql`TRUE ${q.opportunityId ? sql`AND o.opportunity_id = ${q.opportunityId}` : sql``}
        ${q.status ? sql`AND o.status = ${q.status}` : sql``} ${q.cursor ? sql`AND o.id < ${q.cursor}` : sql``}`, q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: await Promise.all(page.map((o) => this.orderSummary(tx, t, o))), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  async getOrder(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => this.orderView(tx, t, await this.readOrder(tx, t, id)));
  }

  /** An order from an accepted quote of a won opportunity: lines and totals copied from the quote's version. */
  async createOrder(t: TenantRequestContext, body: z.infer<typeof OrderCreate>) {
    this.assertAmounts(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = (await tx.execute<{ id: string; opportunity_id: string; status: string; currency: string; version_id: string; totals: unknown }>(sql`
        SELECT q.id, q.opportunity_id, q.status, q.currency, v.id AS version_id, v.totals FROM quotes q JOIN quote_versions v ON v.quote_id = q.id AND v.version = q.current_version WHERE q.id = ${body.quoteId}`)).rows[0];
      if (!q) throw new ProblemError('NOT_FOUND');
      await this.wonOpportunity(tx, t, q.opportunity_id, 'sales_b2b.quote.create');
      if (q.status !== 'accepted') throw new ProblemError('QUOTE_STATE', 'only an accepted quote becomes an order', { quoteStatus: q.status });
      if (body.contractId) {
        const c = (await tx.execute<{ opportunity_id: string }>(sql`SELECT opportunity_id FROM contracts WHERE id = ${body.contractId}`)).rows[0];
        if (c?.opportunity_id !== q.opportunity_id) throw new ProblemError('VALIDATION_FAILED', 'contractId: not a contract of this opportunity');
      }
      const number = await this.next(tx, t, 'order');
      let id: string;
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO orders (tenant_id, number, segment, opportunity_id, quote_id, contract_id, currency, totals, note, created_by)
          VALUES (${t.tenant.id}, ${number}, 'b2b', ${q.opportunity_id}, ${q.id}, ${body.contractId}, ${q.currency}, ${JSON.stringify(q.totals)}::jsonb, ${body.note}, ${t.principal.userId}) RETURNING id`);
        id = r.rows[0]?.id ?? '';
      } catch (e) {
        if (isUniqueViolation(e, 'orders_one_per_quote')) throw new ProblemError('CONFLICT', 'this quote already has an order');
        return mapDbError(e);
      }
      await tx.execute(sql`INSERT INTO order_lines (tenant_id, order_id, position, product_id, sku, name, unit, quantity, unit_price, discount_percent, tax_percent, net, tax)
        SELECT tenant_id, ${id}, position, product_id, sku, name, unit, quantity, unit_price, discount_percent, tax_percent, net, tax
        FROM quote_lines WHERE quote_version_id = ${q.version_id}`);
      await this.log_(tx, t, 'order', id, number, q.opportunity_id, 'created', { quoteId: q.id });
      return this.orderView(tx, t, await this.readOrder(tx, t, id));
    });
  }

  async setOrderStatus(t: TenantRequestContext, id: string, body: z.infer<typeof OrderStatusSet>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const o = await this.readOrder(tx, t, id, true);
      authorize(t, 'sales_b2b.quote.create');
      if (o.opportunity_id) await assertCan(tx, t, CRM.opportunity.shape, o.opportunity_id, 'update');
      if (o.status !== 'open') throw new ProblemError('ORDER_STATE', `the order is ${o.status}`, { orderStatus: o.status });
      await tx.execute(sql`UPDATE orders SET status = ${body.status}, status_reason = ${body.reason ?? null}, version = version + 1 WHERE id = ${id}`);
      if (o.opportunity_id) await this.log_(tx, t, 'order', id, o.number, o.opportunity_id, body.status);
      return this.orderView(tx, t, await this.readOrder(tx, t, id));
    });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import {
  AccountCreate, AccountPatch, CaseCreate, CasePatch, ContactCreate, ContactPatch, ContactPointInput, LeadCreate, LeadPatch,
  OpportunityCreate, OpportunityPatch, RecordTransitionRequest, type z,
} from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { resolveTransition, type Condition, type PostFunction, type Validator, type Workflow } from '@flexa/workflow';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { CursorCodec } from '../../common/http-helpers';
import { recordActivity, viewDiff } from '../../common/activity';
import { audit } from '../../common/audit';
import { notify } from '../../common/notify';
import { randomUUID } from 'node:crypto';
import { mapDbError } from '../../common/http-helpers';
import { aggregate, keysetPage, parseFields, pickFields, type AggregateQuery, type ListQuery } from '../../common/keyset-list';
import { ProblemError } from '../../common/problem';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV } from '../../infra/tokens';
import { syncMentions } from '../records/mentions';
import { cursorCodec, TaskListService } from '../tasks/task-list.service';
import { loadFieldDefs, validateCustom } from '../tasks/task-fields';
import { assertCan, assertWritable, canAssignTo, maskRegistry, maskView, recordPredicate } from '../../common/record-access';
import { CRM, crmRegistry, crmScope, crmViewContext, readCrmRow, type CrmDef, type CrmRow, type CrmType } from './crm-objects';
import { QuotaService } from '../usage/quota.service';

export type AccountCreateBody = z.infer<typeof AccountCreate>;
export type ContactCreateBody = z.infer<typeof ContactCreate>;
export type LeadCreateBody = z.infer<typeof LeadCreate>;
export type OpportunityCreateBody = z.infer<typeof OpportunityCreate>;
export type CaseCreateBody = z.infer<typeof CaseCreate>;
export type ContactPointBody = z.infer<typeof ContactPointInput>;

export const CREATE_SCHEMAS = { account: AccountCreate, contact: ContactCreate, lead: LeadCreate, opportunity: OpportunityCreate, case: CaseCreate } as const;
export const PATCH_SCHEMAS = { account: AccountPatch, contact: ContactPatch, lead: LeadPatch, opportunity: OpportunityPatch, case: CasePatch } as const;

type Cols = Record<string, unknown>;
const JSONB_COLUMNS = new Set(['description', 'custom']);

/** Bound value for a column; arrays/enums/jsonb get explicit casts (drizzle would expand JS arrays into lists). */
function val(col: string, v: unknown): SQL {
  if (v === null || v === undefined) return sql`NULL`;
  if (col === 'segments') return sql`${`{${(v as string[]).join(',')}}`}::segment[]`;
  if (col === 'segment') return sql`${v}::segment`;
  if (JSONB_COLUMNS.has(col)) return sql`${JSON.stringify(v)}::jsonb`;
  return sql`${v}`;
}

/** Column names come from the fixed mappings in this file only — never from request keys. */
const ident = (col: string): SQL => sql.raw(`"${col.replace(/"/g, '')}"`);

const OWNER_FK = /_(owner_user_id|queue_id)_fkey$/;

function writeError(e: unknown): never {
  if (e instanceof ProblemError) throw e;
  const c = (e as { cause?: { constraint?: string; code?: string } }).cause;
  if (c?.constraint && OWNER_FK.test(c.constraint)) throw new ProblemError('OWNER_INVALID', 'owner is not a member or queue of this workspace');
  if (c?.code === '42501') throw new ProblemError('SEGMENT_NOT_ALLOWED');
  return mapDbError(e);
}

export function segmentsFor(t: TenantRequestContext, requested: readonly Segment[] | undefined): Segment[] {
  if (requested) {
    if (requested.some((s) => !t.segments.includes(s))) throw new ProblemError('SEGMENT_NOT_ALLOWED', 'segment is not available to you');
    return [...requested];
  }
  if (t.segments.length === 1) return [...t.segments];
  throw new ProblemError('SEGMENT_REQUIRED', 'choose a segment (b2b or b2c)');
}

export function oneSegmentFor(t: TenantRequestContext, requested: Segment | undefined, fallback: readonly Segment[] = []): Segment {
  if (requested) return segmentsFor(t, [requested])[0] as Segment;
  const usable = fallback.filter((s) => t.segments.includes(s));
  if (usable.length === 1) return usable[0] as Segment;
  return segmentsFor(t, undefined)[0] as Segment;
}

const parseSegs = (v: unknown): Segment[] => (Array.isArray(v) ? (v as Segment[]) : (typeof v === 'string' ? v : '').replace(/[{}]/g, '').split(',').filter(Boolean) as Segment[]);

export function phoneCountry(locale: string): CountryCode {
  const region = locale.split('-')[1];
  return (region && /^[A-Z]{2}$/.test(region) ? region : 'TR') as CountryCode;
}

export function normalisePoint(t: TenantRequestContext, p: ContactPointBody): { value: string; e164: string | null } {
  if (p.kind === 'email') return { value: p.value, e164: null };
  const parsed = parsePhoneNumberFromString(p.value, phoneCountry(t.tenant.locale));
  if (!parsed?.isValid()) throw new ProblemError('PHONE_INVALID', `"${p.value}" is not a valid phone number`);
  return { value: p.value, e164: parsed.number };
}

interface WorkflowInfo {
  id: string;
  statuses: { id: string; key: string; category: 'open' | 'in_progress' | 'closed'; isInitial: boolean }[];
  engine: Workflow;
}

@Injectable()
export class CrmService {
  private readonly cursors: CursorCodec;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) env: ApiEnv,
    private readonly taskList: TaskListService,
    private readonly quota: QuotaService,
  ) {
    this.cursors = cursorCodec(env);
  }

  // ------------------------------------------------------------------ read
  /** Grouped counts/sums over what the list would return (pipeline totals, dashboards). */
  async aggregate(t: TenantRequestContext, type: CrmType, query: AggregateQuery) {
    const def = CRM[type];
    if (crmScope(t, def, 'read').kind === 'none') throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const vc = await crmViewContext(tx, type);
      return aggregate(tx, t, {
        from: def.from,
        base: [sql`t.deleted_at IS NULL`, await recordPredicate(tx, t, def.shape, 'read')],
        registry: maskRegistry(t, type, crmRegistry(def, vc.defs), def.viewFieldOf),
      }, query);
    });
  }

  async list(t: TenantRequestContext, type: CrmType, query: ListQuery) {
    const def = CRM[type];
    if (crmScope(t, def, 'read').kind === 'none') throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const vc = await crmViewContext(tx, type);
      const page = await keysetPage<CrmRow>(tx, t, this.cursors, {
        resource: type,
        from: def.from,
        select: def.select,
        idExpr: sql`t.id`,
        base: [sql`t.deleted_at IS NULL`, await recordPredicate(tx, t, def.shape, 'read')],
        // Hidden fields cannot be filtered or sorted on (UNKNOWN_FIELD, like a field that does not exist).
        registry: maskRegistry(t, type, crmRegistry(def, vc.defs), def.viewFieldOf),
      }, query);
      const views = page.rows.map((r) => maskView(t, type, def.view(r, vc)));
      const fields = parseFields(query.fields, new Set(views[0] ? Object.keys(views[0]) : Object.keys(def.baseRegistry)));
      return {
        data: views.map((v) => pickFields(v, fields)),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        ...(page.total !== undefined ? { meta: { total: page.total } } : {}),
      };
    });
  }

  async get(t: TenantRequestContext, type: CrmType, id: string) {
    return this.db.withTenant(dbCtx(t), (tx) => this.view(tx, t, type, id));
  }

  async view(tx: Db, t: TenantRequestContext, type: CrmType, id: string): Promise<Record<string, unknown>> {
    return maskView(t, type, CRM[type].view(await readCrmRow(tx, t, CRM[type], id), await crmViewContext(tx, type)));
  }

  /** A referenced record must be readable by the caller; otherwise the reference is rejected as not found. */
  async ref(tx: Db, t: TenantRequestContext, type: CrmType, id: string): Promise<CrmRow> {
    try {
      return await readCrmRow(tx, t, CRM[type], id);
    } catch (e) {
      if (e instanceof ProblemError && e.code === 'NOT_FOUND') throw new ProblemError('RELATED_NOT_FOUND', `${type} ${id} not found`);
      throw e;
    }
  }

  async relatedTasks(t: TenantRequestContext, type: CrmType, id: string, query: ListQuery) {
    await this.get(t, type, id);
    return this.taskList.list(t, query, [sql`t.related_type = ${type}`, sql`t.related_id = ${id}`]);
  }

  // ------------------------------------------------------------------ create
  async create(t: TenantRequestContext, type: CrmType, body: unknown) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const id = await this.insert(tx, t, type, body);
      return this.view(tx, t, type, id);
    });
  }

  /** Inserts a record of `type` from an already-validated create body; returns its id. */
  async insert(tx: Db, t: TenantRequestContext, type: CrmType, body: unknown): Promise<string> {
    const def = CRM[type];
    if (crmScope(t, def, 'create').kind === 'none') throw new ProblemError('FORBIDDEN');
    assertWritable(t, type, body as Record<string, unknown>);
    await this.quota.assert(tx, t, 'records', 1, 'hard');
    const me = t.principal.userId;
    let cols: Cols;
    let points: ContactPointBody[] = [];
    let accountLink: { id: string; role: string; isPrimary: boolean } | null = null;
    switch (type) {
      case 'account': {
        const b = body as AccountCreateBody;
        if (b.parentAccountId) await this.ref(tx, t, 'account', b.parentAccountId);
        cols = {
          name: b.name, domain: b.domain ?? null, website: b.website ?? null, industry: b.industry ?? null, parent_account_id: b.parentAccountId ?? null,
          segments: segmentsFor(t, b.segments), owner_user_id: this.ownerFor(t, def, b.ownerUserId), description: b.description ?? null, description_text: b.descriptionText ?? null,
        };
        points = b.contactPoints ?? [];
        break;
      }
      case 'contact': {
        const b = body as ContactCreateBody;
        cols = {
          first_name: b.firstName ?? '', last_name: b.lastName ?? '', title: b.title ?? null, segments: segmentsFor(t, b.segments),
          owner_user_id: this.ownerFor(t, def, b.ownerUserId), description: b.description ?? null, description_text: b.descriptionText ?? null,
        };
        if (b.account) {
          const acc = await this.ref(tx, t, 'account', b.account.id);
          const accSegs = parseSegs(acc.segs);
          if (!(cols.segments as Segment[]).every((s) => accSegs.includes(s))) throw new ProblemError('SEGMENT_NOT_ALLOWED', 'the contact must share the account’s segments');
          accountLink = b.account;
        }
        points = b.contactPoints ?? [];
        break;
      }
      case 'lead': {
        const b = body as LeadCreateBody;
        const wf = await this.workflowFor(tx, 'lead', null);
        cols = {
          first_name: b.firstName ?? '', last_name: b.lastName ?? '', company: b.company ?? null, title: b.title ?? null,
          segment: oneSegmentFor(t, b.segment), workflow_id: wf.id, status_id: this.initial(wf), source: b.source ?? null, score: b.score ?? 0,
          ...this.userOrQueue(t, def, b.ownerUserId, b.queueId), description: b.description ?? null, description_text: b.descriptionText ?? null,
        };
        points = b.contactPoints ?? [];
        break;
      }
      case 'opportunity': {
        const b = body as OpportunityCreateBody;
        const account = b.accountId ? await this.ref(tx, t, 'account', b.accountId) : null;
        if (b.primaryContactId) await this.ref(tx, t, 'contact', b.primaryContactId);
        const accountSegs = account ? parseSegs(account.segs) : [];
        const segment = oneSegmentFor(t, b.segment, accountSegs);
        if (account && !accountSegs.includes(segment)) throw new ProblemError('SEGMENT_NOT_ALLOWED', 'the opportunity segment must be one of the account’s segments');
        const pipeline = await this.pipelineFor(tx, b.pipelineId ?? null, segment);
        const wf = await this.workflowFor(tx, 'opportunity', pipeline.workflowId);
        const statusId = this.initial(wf);
        const stageProbability = await this.stageProbability(tx, pipeline.id, statusId);
        cols = {
          name: b.name, account_id: b.accountId ?? null, primary_contact_id: b.primaryContactId ?? null, pipeline_id: pipeline.id, workflow_id: wf.id,
          status_id: statusId, segment, amount: b.amount ?? null, currency: b.currency ?? t.tenant.currency,
          probability: b.probability ?? stageProbability, probability_manual: b.probability !== undefined, expected_close: b.expectedClose ?? null,
          competitor: b.competitor ?? null, won_lost_reason: b.wonLostReason ?? null, owner_user_id: this.ownerFor(t, def, b.ownerUserId),
          description: b.description ?? null, description_text: b.descriptionText ?? null,
        };
        break;
      }
      case 'case': {
        const b = body as CaseCreateBody;
        const account = b.accountId ? await this.ref(tx, t, 'account', b.accountId) : null;
        const contact = b.contactId ? await this.ref(tx, t, 'contact', b.contactId) : null;
        const wf = await this.workflowFor(tx, 'case', null);
        const inherited = parseSegs(account?.segs ?? contact?.segs ?? null);
        const segment = b.segment === null ? null : b.segment ? oneSegmentFor(t, b.segment) : inherited.length === 1 && t.segments.includes(inherited[0] as Segment) ? (inherited[0] as Segment) : t.segments.length === 1 ? t.segments[0] : null;
        cols = {
          subject: b.subject, account_id: b.accountId ?? null, contact_id: b.contactId ?? null, workflow_id: wf.id, status_id: this.initial(wf),
          priority: b.priority ?? 2, channel: b.channel ?? 'other', category: b.category ?? null, segment: segment ?? null,
          ...this.userOrQueue(t, def, b.ownerUserId, b.queueId), description: b.description ?? null, description_text: b.descriptionText ?? null,
        };
        break;
      }
    }
    const defs = await loadFieldDefs(tx, type);
    const customIn = (body as { custom?: Record<string, unknown> }).custom ?? {};
    cols.custom = Object.fromEntries(Object.entries(await validateCustom(tx, defs, customIn, 'create')).filter(([, v]) => v !== null));
    cols.created_by = me;
    cols.updated_by = me;

    let id: string;
    try {
      const names = Object.keys(cols);
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO ${ident(def.table)} (tenant_id, ${sql.join(names.map(ident), sql`, `)})
        VALUES (${t.tenant.id}, ${sql.join(names.map((n) => val(n, cols[n])), sql`, `)}) RETURNING id`);
      const row = r.rows[0];
      if (!row) throw new ProblemError('INTERNAL');
      id = row.id;
    } catch (e) {
      return writeError(e);
    }
    for (const p of points) await this.insertPoint(tx, t, type as 'account' | 'contact' | 'lead', id, p);
    if (accountLink) await this.setAccountRole(tx, t, id, accountLink.id, accountLink.role, accountLink.isPrimary);
    await recordActivity(tx, t, { type, id, kind: 'created' });
    if (cols.description) await syncMentions(tx, t, { type, id }, 'description', id, null, cols.description);
    if (typeof cols.owner_user_id === 'string' && cols.owner_user_id !== me) await this.assigned(tx, t, type, id, cols.owner_user_id);
    return id;
  }

  private ownerFor(t: TenantRequestContext, def: CrmDef, requested: string | undefined): string {
    const me = t.principal.userId;
    if (requested !== undefined && requested !== me) this.assertAssignable(t, def, { userId: requested });
    return requested ?? me;
  }

  private userOrQueue(t: TenantRequestContext, def: CrmDef, ownerUserId: string | null | undefined, queueId: string | null | undefined): Cols {
    const me = t.principal.userId;
    if (ownerUserId !== undefined && ownerUserId !== null && ownerUserId !== me) this.assertAssignable(t, def, { userId: ownerUserId });
    if (queueId !== undefined && queueId !== null) this.assertAssignable(t, def, { queueId });
    const owner = ownerUserId === undefined ? (queueId ? null : me) : ownerUserId;
    if (owner === null && !queueId) throw new ProblemError('VALIDATION_FAILED', 'an owner or a queue is required');
    return { owner_user_id: owner, queue_id: queueId ?? null };
  }

  /** Giving a record to someone else is a reassignment (Matrix A A13): tenant-wide, or within the caller's
   *  teams/queues for scoped grants (record-access `canAssignTo`). */
  assertAssignable(t: TenantRequestContext, def: CrmDef, target: { userId: string } | { queueId: string }): void {
    if (!canAssignTo(t, def.resource, target)) throw new ProblemError('FORBIDDEN', 'assigning records to that person or queue requires the reassign permission');
  }

  // ------------------------------------------------------------------ update
  async patch(t: TenantRequestContext, type: CrmType, id: string, version: number, body: Record<string, unknown>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, CRM[type], id, { forUpdate: true });
      await this.applyPatch(tx, t, type, row, version, body);
      return this.view(tx, t, type, id);
    });
  }

  /** Patch inside an existing transaction without If-Match (automation actions; body validated by the caller). */
  async patchIn(tx: Db, t: TenantRequestContext, type: CrmType, id: string, body: Record<string, unknown>): Promise<void> {
    const row = await readCrmRow(tx, t, CRM[type], id, { forUpdate: true });
    await this.applyPatch(tx, t, type, row, null, body);
  }

  private async applyPatch(tx: Db, t: TenantRequestContext, type: CrmType, row: CrmRow, version: number | null, body: Record<string, unknown>, extra: Cols = {}): Promise<void> {
    const def = CRM[type];
    const me = t.principal.userId;
    await assertCan(tx, t, def.shape, row.id, 'update');
    assertWritable(t, type, body);
    if (version !== null && row.version !== version) throw new ProblemError('PRECONDITION_FAILED', `the ${type} was changed by someone else`, { currentVersion: row.version });
    if (type === 'lead' && row.converted_at) throw new ProblemError('LEAD_ALREADY_CONVERTED');
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const cols: Cols = { ...extra };
    const map: Record<string, string> = {
      name: 'name', domain: 'domain', website: 'website', industry: 'industry', parentAccountId: 'parent_account_id', firstName: 'first_name',
      lastName: 'last_name', title: 'title', company: 'company', source: 'source', score: 'score', subject: 'subject', priority: 'priority',
      channel: 'channel', category: 'category', accountId: 'account_id', primaryContactId: 'primary_contact_id', contactId: 'contact_id',
      amount: 'amount', currency: 'currency', expectedClose: 'expected_close', competitor: 'competitor', wonLostReason: 'won_lost_reason',
      description: 'description', descriptionText: 'description_text',
    };
    for (const [k, col] of Object.entries(map)) if (has(k)) cols[col] = body[k];

    // Ownership changes are reassignments.
    if (has('ownerUserId') && body.ownerUserId !== row.owner_user_id) {
      await assertCan(tx, t, def.shape, row.id, 'reassign');
      if (typeof body.ownerUserId === 'string' && body.ownerUserId !== me) this.assertAssignable(t, def, { userId: body.ownerUserId });
      cols.owner_user_id = body.ownerUserId;
    }
    if (has('queueId') && body.queueId !== row.queue_id) {
      await assertCan(tx, t, def.shape, row.id, 'reassign');
      if (typeof body.queueId === 'string') this.assertAssignable(t, def, { queueId: body.queueId });
      cols.queue_id = body.queueId;
    }
    if ((type === 'lead' || type === 'case') && (cols.owner_user_id ?? row.owner_user_id) === null && (cols.queue_id ?? row.queue_id) === null) {
      throw new ProblemError('VALIDATION_FAILED', 'an owner or a queue is required');
    }

    // References and segments.
    if (has('segments')) {
      const segs = segmentsFor(t, body.segments as Segment[]);
      cols.segments = segs;
    }
    if (has('segment') && type === 'case') cols.segment = body.segment === null ? null : oneSegmentFor(t, body.segment as Segment);
    if (typeof body.parentAccountId === 'string') {
      if (body.parentAccountId === row.id) throw new ProblemError('ACCOUNT_HIERARCHY_CYCLE');
      await this.ref(tx, t, 'account', body.parentAccountId);
    }
    if (typeof body.contactId === 'string') await this.ref(tx, t, 'contact', body.contactId);
    if (typeof body.primaryContactId === 'string') await this.ref(tx, t, 'contact', body.primaryContactId);
    if (typeof body.accountId === 'string') {
      const acc = await this.ref(tx, t, 'account', body.accountId);
      if (type === 'opportunity' && !parseSegs(acc.segs).includes(row.segment as Segment)) {
        throw new ProblemError('SEGMENT_NOT_ALLOWED', 'the opportunity segment must be one of the account’s segments');
      }
    }

    // Opportunity probability: manual value, or back to the stage default.
    if (type === 'opportunity') {
      if (has('probability')) {
        cols.probability = body.probability;
        cols.probability_manual = true;
      } else if (body.probabilityManual === false) {
        cols.probability = await this.stageProbability(tx, String(row.pipeline_id), String(row.status_id));
        cols.probability_manual = false;
      }
    }

    if (has('custom')) {
      const defs = await loadFieldDefs(tx, type);
      const changes = await validateCustom(tx, defs, body.custom as Record<string, unknown>, 'update');
      cols.custom = Object.fromEntries(Object.entries({ ...row.custom, ...changes }).filter(([, v]) => v !== null));
    }
    if (Object.keys(cols).length === 0) return;
    if (cols.owner_user_id !== undefined || cols.queue_id !== undefined) {
      await audit(tx, t.tenant.id, {
        action: 'record.reassigned', actorId: me, targetType: type, targetId: row.id,
        details: { from: { ownerUserId: row.owner_user_id, queueId: row.queue_id ?? null }, to: { ownerUserId: cols.owner_user_id ?? row.owner_user_id, queueId: cols.queue_id ?? row.queue_id ?? null } },
      });
    }
    cols.updated_by = me;
    try {
      const sets = Object.keys(cols).map((c) => sql`${ident(c)} = ${val(c, cols[c])}`);
      const r = await tx.execute(sql`UPDATE ${ident(def.table)} SET ${sql.join(sets, sql`, `)}, version = version + 1
        WHERE id = ${row.id} AND version = ${row.version} RETURNING id`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('PRECONDITION_FAILED', `the ${type} was changed by someone else`);
    } catch (e) {
      writeError(e);
    }
    if (has('description')) await syncMentions(tx, t, { type, id: row.id }, 'description', row.id, row.description, body.description);
    // Timeline: the field diff in API terms (masked per reader on the way out), plus an assignment event.
    const vc = await crmViewContext(tx, type);
    const afterRows = await tx.execute<CrmRow>(sql`${def.select} WHERE t.id = ${row.id}`);
    const after = afterRows.rows[0] ?? row;
    await recordActivity(tx, t, { type, id: row.id, kind: 'field_changed', diff: viewDiff(def.view(row, vc), def.view(after, vc)) });
    if (typeof cols.owner_user_id === 'string' && cols.owner_user_id !== row.owner_user_id && cols.owner_user_id !== me) {
      await this.assigned(tx, t, type, row.id, cols.owner_user_id);
    }
  }

  /** Assignment to another user: timeline event + in-app notification for the new owner. */
  private async assigned(tx: Db, t: TenantRequestContext, type: CrmType, id: string, ownerUserId: string): Promise<void> {
    await recordActivity(tx, t, { type, id, kind: 'assigned', data: { ownerUserId } });
    await notify(tx, t, { users: [ownerUserId], kind: 'assigned', sourceType: 'assignment', sourceId: randomUUID(), recordType: type, recordId: id });
  }

  async remove(t: TenantRequestContext, type: CrmType, id: string, version: number): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const def = CRM[type];
      const row = await readCrmRow(tx, t, def, id, { forUpdate: true });
      await assertCan(tx, t, def.shape, row.id, 'archive');
      if (row.version !== version) throw new ProblemError('PRECONDITION_FAILED', `the ${type} was changed by someone else`, { currentVersion: row.version });
      await tx.execute(sql`UPDATE ${ident(def.table)} SET deleted_at = now(), version = version + 1, updated_by = ${t.principal.userId} WHERE id = ${id}`);
      await recordActivity(tx, t, { type, id, kind: 'deleted' });
    });
  }

  async restore(t: TenantRequestContext, type: CrmType, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const def = CRM[type];
      const row = await readCrmRow(tx, t, def, id, { includeDeleted: true, forUpdate: true });
      await assertCan(tx, t, def.shape, row.id, 'archive');
      if (row.merged_into) throw new ProblemError('CONFLICT', 'a merged record cannot be restored');
      if (row.deleted_at) {
        await tx.execute(sql`UPDATE ${ident(def.table)} SET deleted_at = NULL, version = version + 1, updated_by = ${t.principal.userId} WHERE id = ${id}`);
        await recordActivity(tx, t, { type, id, kind: 'restored' });
      }
      return this.view(tx, t, type, id);
    });
  }

  // ------------------------------------------------------------------ workflow
  async transition(t: TenantRequestContext, type: CrmType, id: string, body: z.infer<typeof RecordTransitionRequest>) {
    const def = CRM[type];
    if (!def.workflow) throw new ProblemError('NOT_FOUND');
    const fields = body.fields ? PATCH_SCHEMAS[type].safeParse(body.fields) : null;
    if (fields && !fields.success) throw new ProblemError('VALIDATION_FAILED', fields.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.transitionIn(tx, t, type, id, 'transitionKey' in body ? { transitionKey: body.transitionKey } : { toStatusId: body.toStatusId }, fields?.data);
      return this.view(tx, t, type, id);
    });
  }

  async transitionIn(tx: Db, t: TenantRequestContext, type: CrmType, id: string, target: { transitionKey: string } | { toStatusId: string }, fields?: Record<string, unknown>): Promise<void> {
    const def = CRM[type];
    const me = t.principal.userId;
    let row = await readCrmRow(tx, t, def, id, { forUpdate: true });
    await assertCan(tx, t, def.shape, row.id, 'update');
    if (type === 'lead' && row.converted_at) throw new ProblemError('LEAD_ALREADY_CONVERTED');
    if (fields && Object.keys(fields).length > 0) {
      await this.applyPatch(tx, t, type, row, null, fields);
      row = await readCrmRow(tx, t, def, id, { forUpdate: true });
    }
    const wf = await this.workflowFor(tx, type as 'lead' | 'opportunity' | 'case', String(row.workflow_id));
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!k.startsWith('s_') && k !== 'custom' && k !== 'contact_points') record[k] = v;
    for (const [k, v] of Object.entries(row.custom)) record[`custom.${k}`] = v;
    const result = resolveTransition(wf.engine, String(row.status_id), target, {
      actorUserId: me, actorRoleKeys: t.authz.roleKeys, ownerUserId: row.owner_user_id, record, openSubtaskCount: 0, openBlockerCount: 0,
    });
    if (!result.ok) {
      const { code, ...rest } = result;
      throw new ProblemError(code, undefined, rest);
    }
    const to = wf.statuses.find((s) => s.id === result.transition.toStatusId);
    if (!to) throw new ProblemError('WORKFLOW_INVALID');
    if (type === 'lead' && to.key === 'converted') throw new ProblemError('USE_TRANSITION_ENDPOINT', 'use POST /v1/leads/{id}/convert');
    const sets: SQL[] = [sql`status_id = ${to.id}`, sql`version = version + 1`, sql`updated_by = ${me}`];
    if (type === 'opportunity' || type === 'case') {
      const wasClosed = row.s_category === 'closed';
      sets.push(to.category === 'closed' ? (wasClosed ? sql`closed_at = closed_at` : sql`closed_at = now()`) : sql`closed_at = NULL`);
    }
    if (type === 'opportunity' && !row.probability_manual) {
      sets.push(sql`probability = ${await this.stageProbability(tx, String(row.pipeline_id), to.id)}`);
    }
    // Post-functions: only fields that exist on the record apply (task-specific ones such as assignee are skipped).
    for (const [k, v] of Object.entries(result.patch)) {
      if (k === 'priority' && type === 'case' && typeof v === 'number') sets.push(sql`priority = ${v}`);
    }
    await tx.execute(sql`UPDATE ${ident(def.table)} SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    await recordActivity(tx, t, { type, id, kind: 'status_changed', diff: { status: { from: row.s_key, to: to.key } }, data: { transition: result.transition.key } });
  }

  async workflowFor(tx: Db, resourceType: 'lead' | 'opportunity' | 'case', workflowId: string | null): Promise<WorkflowInfo> {
    const w = await tx.execute<{ id: string }>(workflowId
      ? sql`SELECT id FROM workflows WHERE id = ${workflowId} AND resource_type = ${resourceType}`
      : sql`SELECT id FROM workflows WHERE resource_type = ${resourceType} AND is_default`);
    const wfId = w.rows[0]?.id;
    if (!wfId) throw new ProblemError('WORKFLOW_INVALID', `no ${resourceType} workflow`);
    const st = await tx.execute<{ id: string; key: string; category: 'open' | 'in_progress' | 'closed'; is_initial: boolean }>(sql`
      SELECT id, key, category, is_initial FROM statuses WHERE workflow_id = ${wfId}`);
    const tr = await tx.execute<{ id: string; key: string; from_status_id: string | null; to_status_id: string; conditions: unknown; validators: unknown; post_functions: unknown }>(sql`
      SELECT id, key, from_status_id, to_status_id, conditions, validators, post_functions FROM workflow_transitions WHERE workflow_id = ${wfId}`);
    const statuses = st.rows.map((s) => ({ id: s.id, key: s.key, category: s.category, isInitial: s.is_initial }));
    return {
      id: wfId,
      statuses,
      engine: {
        statuses,
        transitions: tr.rows.map((x) => ({
          id: x.id, key: x.key, fromStatusId: x.from_status_id, toStatusId: x.to_status_id,
          // Stored definitions were validated when the workflow was created (seed or WorkflowCreate).
          conditions: x.conditions as Condition[], validators: x.validators as Validator[], postFunctions: x.post_functions as PostFunction[],
        })),
      },
    };
  }

  private initial(wf: WorkflowInfo): string {
    const s = wf.statuses.find((x) => x.isInitial);
    if (!s) throw new ProblemError('WORKFLOW_INVALID', 'workflow has no initial status');
    return s.id;
  }

  async pipelineFor(tx: Db, pipelineId: string | null, segment: Segment): Promise<{ id: string; workflowId: string }> {
    const r = await tx.execute<{ id: string; workflow_id: string; segment: Segment | null }>(pipelineId
      ? sql`SELECT id, workflow_id, segment FROM pipelines WHERE id = ${pipelineId}`
      : sql`SELECT id, workflow_id, segment FROM pipelines WHERE is_default`);
    const p = r.rows[0];
    if (!p) throw new ProblemError('PIPELINE_INVALID', pipelineId ? 'pipeline not found' : 'no default pipeline');
    if (p.segment !== null && p.segment !== segment) throw new ProblemError('PIPELINE_INVALID', `pipeline is for ${p.segment}`);
    return { id: p.id, workflowId: p.workflow_id };
  }

  async stageProbability(tx: Db, pipelineId: string, statusId: string): Promise<number> {
    const r = await tx.execute<{ p: string }>(sql`SELECT probability AS p FROM pipeline_stages WHERE pipeline_id = ${pipelineId} AND status_id = ${statusId}`);
    return r.rows[0] ? Number(r.rows[0].p) : 0;
  }

  async pipelines(t: TenantRequestContext) {
    if (crmScope(t, CRM.opportunity, 'read').kind === 'none') throw new ProblemError('FORBIDDEN');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const ps = await tx.execute<{ id: string; key: string; name: string; segment: Segment | null; workflow_id: string; is_default: boolean }>(sql`
        SELECT id, key, name, segment, workflow_id, is_default FROM pipelines ORDER BY is_default DESC, name, id`);
      const stages = await tx.execute<{ pipeline_id: string; id: string; key: string; category: string; label_i18n: unknown; color_token: string; position: string; probability: string }>(sql`
        SELECT ps.pipeline_id, s.id, s.key, s.category, s.label_i18n, s.color_token, s.position, ps.probability
        FROM pipeline_stages ps JOIN statuses s ON s.tenant_id = ps.tenant_id AND s.id = ps.status_id ORDER BY s.position COLLATE "C"`);
      return {
        data: ps.rows.map((p) => ({
          id: p.id, key: p.key, name: p.name, segment: p.segment, workflowId: p.workflow_id, isDefault: p.is_default,
          stages: stages.rows.filter((s) => s.pipeline_id === p.id).map((s) => ({
            id: s.id, key: s.key, category: s.category, label: s.label_i18n, colorToken: s.color_token, position: s.position, probability: Number(s.probability),
          })),
        })),
      };
    });
  }

  // ------------------------------------------------------------------ contact points and account roles
  async addContactPoint(t: TenantRequestContext, type: 'account' | 'contact' | 'lead', id: string, body: ContactPointBody) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, CRM[type], id, { forUpdate: true });
      await assertCan(tx, t, CRM[type].shape, row.id, 'update');
      const pointId = await this.insertPoint(tx, t, type, id, body);
      const r = await tx.execute<{ id: string; kind: 'email' | 'phone'; value: string; e164: string | null; label: string | null; is_primary: boolean }>(sql`
        SELECT id, kind, value, e164, label, is_primary FROM contact_points WHERE id = ${pointId}`);
      const p = r.rows[0];
      if (!p) throw new ProblemError('INTERNAL');
      return { id: p.id, kind: p.kind, value: p.value, e164: p.e164, label: p.label, isPrimary: p.is_primary };
    });
  }

  async insertPoint(tx: Db, t: TenantRequestContext, ownerType: 'account' | 'contact' | 'lead', ownerId: string, p: ContactPointBody): Promise<string> {
    const n = normalisePoint(t, p);
    if (p.isPrimary) await tx.execute(sql`UPDATE contact_points SET is_primary = false WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} AND kind = ${p.kind}`);
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO contact_points (tenant_id, owner_type, owner_id, kind, label, value, e164, is_primary)
      VALUES (${t.tenant.id}, ${ownerType}, ${ownerId}, ${p.kind}, ${p.label ?? null}, ${n.value}, ${n.e164}, ${p.isPrimary}) RETURNING id`);
    const row = r.rows[0];
    if (!row) throw new ProblemError('INTERNAL');
    return row.id;
  }

  async removeContactPoint(t: TenantRequestContext, type: 'account' | 'contact' | 'lead', id: string, pointId: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, CRM[type], id, { forUpdate: true });
      await assertCan(tx, t, CRM[type].shape, row.id, 'update');
      const r = await tx.execute(sql`DELETE FROM contact_points WHERE id = ${pointId} AND owner_type = ${type} AND owner_id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
    });
  }

  async linkAccount(t: TenantRequestContext, contactId: string, accountId: string, role: string, isPrimary: boolean) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const contact = await readCrmRow(tx, t, CRM.contact, contactId, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, contact.id, 'update');
      const acc = await this.ref(tx, t, 'account', accountId);
      const accSegs = parseSegs(acc.segs);
      if (!parseSegs(contact.segs).some((s) => accSegs.includes(s))) throw new ProblemError('SEGMENT_NOT_ALLOWED', 'contact and account share no segment');
      await this.setAccountRole(tx, t, contactId, accountId, role, isPrimary);
      return this.view(tx, t, 'contact', contactId);
    });
  }

  async setAccountRole(tx: Db, t: TenantRequestContext, contactId: string, accountId: string, role: string, isPrimary: boolean): Promise<void> {
    if (isPrimary) await tx.execute(sql`UPDATE account_contact_roles SET is_primary = false WHERE contact_id = ${contactId} AND account_id <> ${accountId}`);
    await tx.execute(sql`
      INSERT INTO account_contact_roles (tenant_id, account_id, contact_id, role, is_primary) VALUES (${t.tenant.id}, ${accountId}, ${contactId}, ${role}, ${isPrimary})
      ON CONFLICT (tenant_id, account_id, contact_id) DO UPDATE SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary`);
  }

  async unlinkAccount(t: TenantRequestContext, contactId: string, accountId: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const contact = await readCrmRow(tx, t, CRM.contact, contactId, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, contact.id, 'update');
      const r = await tx.execute(sql`DELETE FROM account_contact_roles WHERE contact_id = ${contactId} AND account_id = ${accountId}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
    });
  }

  defOf(type: CrmType): CrmDef {
    return CRM[type];
  }
}

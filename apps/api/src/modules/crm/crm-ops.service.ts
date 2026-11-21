import { Inject, Injectable } from '@nestjs/common';
import type { LeadConvertRequest, MergeRequest, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { recordActivity } from '../../common/activity';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { assertCan, recordPredicate } from '../../common/record-access';
import { asText, CRM, readCrmRow, type CrmRow } from './crm-objects';
import { CrmService, type ContactPointBody } from './crm.service';

type Convert = z.infer<typeof LeadConvertRequest>;
type Merge = z.infer<typeof MergeRequest>;

/** Fields a merge may take from a losing record (API name → column), per type. */
const MERGE_FIELDS = {
  account: { name: 'name', domain: 'domain', website: 'website', industry: 'industry', parentAccountId: 'parent_account_id', ownerUserId: 'owner_user_id', description: 'description' },
  contact: { firstName: 'first_name', lastName: 'last_name', title: 'title', ownerUserId: 'owner_user_id', description: 'description' },
} as const;

const DUPLICATE_SIMILARITY = 0.45;

const segsOf = (row: CrmRow): Segment[] => (Array.isArray(row.segs) ? (row.segs as Segment[]) : []);

/** Lead conversion, merge and duplicate detection (Faz 3). Each operation is one transaction. */
@Injectable()
export class CrmOpsService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly crm: CrmService) {}

  // ------------------------------------------------------------------ lead conversion
  async convert(t: TenantRequestContext, leadId: string, body: Convert, ip: string) {
    const me = t.principal.userId;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const lead = await readCrmRow(tx, t, CRM.lead, leadId, { forUpdate: true });
      await assertCan(tx, t, CRM.lead.shape, lead.id, 'update');
      if (lead.converted_at) throw new ProblemError('LEAD_ALREADY_CONVERTED');
      if (lead.s_category === 'closed') throw new ProblemError('LEAD_NOT_CONVERTIBLE', `a lead in status "${String(lead.s_key)}" cannot be converted`);
      const segment = lead.segment as Segment;
      if (body.ownerUserId !== undefined && body.ownerUserId !== me) this.crm.assertAssignable(t, CRM.lead, { userId: body.ownerUserId });
      const owner = body.ownerUserId ?? lead.owner_user_id ?? me;
      const ownerField = owner === me ? {} : { ownerUserId: owner };
      const personName = asText(lead.full_name).trim();

      // Account: an existing one the caller can read (sharing the lead's segment), or a new one.
      let accountId: string;
      if ('existingId' in body.account) {
        const acc = await this.crm.ref(tx, t, 'account', body.account.existingId);
        if (!segsOf(acc).includes(segment)) throw new ProblemError('SEGMENT_NOT_ALLOWED', 'the account does not belong to the lead’s segment');
        accountId = acc.id;
      } else {
        const name = body.account.name ?? (typeof lead.company === 'string' && lead.company.trim() ? lead.company : personName);
        accountId = await this.crm.insert(tx, t, 'account', { name, segments: [segment], ...ownerField });
      }

      const points = (lead.contact_points as { kind: 'email' | 'phone'; value: string; label: string | null; isPrimary: boolean }[])
        .map((p): ContactPointBody => ({ kind: p.kind, value: p.value, isPrimary: p.isPrimary, ...(p.label ? { label: p.label } : {}) }));
      const contactId = await this.crm.insert(tx, t, 'contact', {
        firstName: lead.first_name, lastName: lead.last_name, ...(lead.title ? { title: lead.title } : {}), segments: [segment], ...ownerField,
        account: { id: accountId, role: 'decision_maker', isPrimary: true }, contactPoints: points,
        ...(personName ? {} : { lastName: asText(lead.company) || 'Contact' }),
      });

      let opportunityId: string | null = null;
      if (body.opportunity) {
        const o = body.opportunity;
        opportunityId = await this.crm.insert(tx, t, 'opportunity', {
          name: o.name ?? (asText(lead.company).trim() || personName || 'Opportunity'), accountId, primaryContactId: contactId, segment,
          ...(o.pipelineId ? { pipelineId: o.pipelineId } : {}), ...(o.amount !== undefined ? { amount: o.amount } : {}),
          ...(o.currency ? { currency: o.currency } : {}), ...(o.expectedClose ? { expectedClose: o.expectedClose } : {}), ...ownerField,
        });
      }

      const wf = await this.crm.workflowFor(tx, 'lead', String(lead.workflow_id));
      const converted = wf.statuses.find((s) => s.key === 'converted');
      if (!converted) throw new ProblemError('LEAD_NOT_CONVERTIBLE', 'the lead workflow has no "converted" status');
      await tx.execute(sql`INSERT INTO lead_conversions (tenant_id, lead_id, account_id, contact_id, opportunity_id, converted_by)
        VALUES (${t.tenant.id}, ${leadId}, ${accountId}, ${contactId}, ${opportunityId}, ${me})`);
      const r = await tx.execute<{ converted_at: string }>(sql`
        UPDATE leads SET status_id = ${converted.id}, converted_at = now(), version = version + 1, updated_by = ${me}
        WHERE id = ${leadId} RETURNING converted_at`);
      await recordActivity(tx, t, { type: 'lead', id: leadId, kind: 'converted', data: { accountId, contactId, opportunityId } });
      await audit(tx, t.tenant.id, { action: 'lead.converted', actorId: me, targetType: 'lead', targetId: leadId, ip, details: { accountId, contactId, opportunityId } });
      return { leadId, accountId, contactId, opportunityId, convertedAt: new Date(String(r.rows[0]?.converted_at)).toISOString() };
    });
  }

  // ------------------------------------------------------------------ merge
  async merge(t: TenantRequestContext, type: 'account' | 'contact', body: Merge, ip: string) {
    const def = CRM[type];
    const me = t.principal.userId;
    const ids = [body.survivorId, ...new Set(body.mergedIds)];
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Lock in a stable order so two concurrent merges over the same records cannot deadlock.
      const rows = new Map<string, CrmRow>();
      for (const id of [...ids].sort()) rows.set(id, await readCrmRow(tx, t, def, id, { forUpdate: true }));
      const survivor = rows.get(body.survivorId);
      if (!survivor) throw new ProblemError('NOT_FOUND');
      await assertCan(tx, t, def.shape, survivor.id, 'update');
      const losers = ids.slice(1).map((id) => rows.get(id) as CrmRow);
      for (const l of losers) await assertCan(tx, t, def.shape, l.id, 'archive');
      const union = [...new Set([survivor, ...losers].flatMap(segsOf))];
      // Moving related rows happens under RLS: the caller must see every segment involved, or rows in a
      // hidden segment would silently stay behind on a deleted record.
      if (union.some((s) => !t.segments.includes(s))) throw new ProblemError('MERGE_INVALID', 'the records belong to a segment you cannot see');

      // Field values chosen from losing records.
      const allowed = MERGE_FIELDS[type] as Record<string, string>;
      const sets: SQL[] = [];
      const customChoice: Record<string, unknown> = { ...survivor.custom };
      for (const [field, sourceId] of Object.entries(body.fieldChoices)) {
        const source = rows.get(sourceId);
        if (!source) throw new ProblemError('MERGE_INVALID', `fieldChoices.${field}: ${sourceId} is not part of this merge`);
        if (field.startsWith('custom.')) {
          const key = field.slice('custom.'.length);
          if (!/^cf_[a-z0-9_]{1,45}$/.test(key)) throw new ProblemError('MERGE_INVALID', `unknown field "${field}"`);
          customChoice[key] = source.custom[key] ?? null;
          continue;
        }
        const col = allowed[field];
        if (!col) throw new ProblemError('MERGE_INVALID', `field "${field}" cannot be chosen`);
        if (col === 'owner_user_id' && source.owner_user_id !== survivor.owner_user_id) {
          await assertCan(tx, t, def.shape, survivor.id, 'reassign');
          if (typeof source.owner_user_id === 'string' && source.owner_user_id !== me) this.crm.assertAssignable(t, def, { userId: source.owner_user_id });
        }
        if (col === 'parent_account_id' && ids.includes(String(source.parent_account_id))) continue; // would point into the merge (or at the survivor)
        const v = source[col];
        sets.push(col === 'description' ? sql`description = ${v === null || v === undefined ? null : JSON.stringify(v)}::jsonb, description_text = ${source.description_text ?? null}` : sql`${sql.raw(col)} = ${v ?? null}`);
      }
      const segLiteral = `{${union.join(',')}}`;
      const losersIds = losers.map((l) => l.id);
      const losersArr = `{${losersIds.join(',')}}`;
      const moved: Record<string, number> = {};
      const count = (k: string, n: number | null) => { moved[k] = (moved[k] ?? 0) + (n ?? 0); };

      // Survivor first gets the union of segments, so moved rows stay visible.
      await tx.execute(sql`UPDATE ${sql.raw(def.table)} SET segments = ${segLiteral}::segment[], custom = ${JSON.stringify(Object.fromEntries(Object.entries(customChoice).filter(([, v]) => v !== null)))}::jsonb
        ${sets.length ? sql`, ${sql.join(sets, sql`, `)}` : sql``}, version = version + 1, updated_by = ${me} WHERE id = ${survivor.id}`);

      count('tasks', (await tx.execute(sql`UPDATE tasks SET related_id = ${survivor.id}, version = version + 1
        WHERE related_type = ${type} AND related_id = ANY(${losersArr}::uuid[])`)).rowCount);
      count('notes', (await tx.execute(sql`UPDATE notes SET related_id = ${survivor.id}
        WHERE related_type = ${type} AND related_id = ANY(${losersArr}::uuid[])`)).rowCount);
      // Contact points: duplicates of what the survivor already has are dropped; primaries do not collide.
      await tx.execute(sql`DELETE FROM contact_points l WHERE l.owner_type = ${type} AND l.owner_id = ANY(${losersArr}::uuid[])
        AND EXISTS (SELECT 1 FROM contact_points s WHERE s.owner_type = ${type} AND s.owner_id = ${survivor.id} AND s.kind = l.kind
                    AND coalesce(s.e164, s.value) = coalesce(l.e164, l.value))`);
      count('contactPoints', (await tx.execute(sql`UPDATE contact_points l SET owner_id = ${survivor.id},
          is_primary = l.is_primary AND NOT EXISTS (SELECT 1 FROM contact_points s WHERE s.owner_type = ${type} AND s.owner_id = ${survivor.id} AND s.kind = l.kind AND s.is_primary)
        WHERE l.owner_type = ${type} AND l.owner_id = ANY(${losersArr}::uuid[])`)).rowCount);

      const roleCol = sql.raw(type === 'account' ? 'account_id' : 'contact_id');
      const otherCol = sql.raw(type === 'account' ? 'contact_id' : 'account_id');
      await tx.execute(sql`DELETE FROM account_contact_roles l WHERE l.${roleCol} = ANY(${losersArr}::uuid[])
        AND EXISTS (SELECT 1 FROM account_contact_roles s WHERE s.${roleCol} = ${survivor.id} AND s.${otherCol} = l.${otherCol})`);
      count('accountContactRoles', (await tx.execute(sql`UPDATE account_contact_roles SET ${roleCol} = ${survivor.id} WHERE ${roleCol} = ANY(${losersArr}::uuid[])`)).rowCount);
      if (type === 'account') {
        count('opportunities', (await tx.execute(sql`UPDATE opportunities SET account_id = ${survivor.id}, version = version + 1 WHERE account_id = ANY(${losersArr}::uuid[])`)).rowCount);
        count('cases', (await tx.execute(sql`UPDATE cases SET account_id = ${survivor.id}, version = version + 1 WHERE account_id = ANY(${losersArr}::uuid[])`)).rowCount);
        await tx.execute(sql`UPDATE accounts SET parent_account_id = NULL WHERE id = ${survivor.id} AND parent_account_id = ANY(${losersArr}::uuid[])`);
        count('childAccounts', (await tx.execute(sql`UPDATE accounts SET parent_account_id = ${survivor.id}, version = version + 1
          WHERE parent_account_id = ANY(${losersArr}::uuid[]) AND NOT (id = ANY(${losersArr}::uuid[]))`)).rowCount);
      } else {
        count('opportunities', (await tx.execute(sql`UPDATE opportunities SET primary_contact_id = ${survivor.id}, version = version + 1 WHERE primary_contact_id = ANY(${losersArr}::uuid[])`)).rowCount);
        count('cases', (await tx.execute(sql`UPDATE cases SET contact_id = ${survivor.id}, version = version + 1 WHERE contact_id = ANY(${losersArr}::uuid[])`)).rowCount);
      }
      await tx.execute(sql`UPDATE ${sql.raw(def.table)} SET merged_into = ${survivor.id}, deleted_at = now(), version = version + 1, updated_by = ${me}
        ${type === 'account' ? sql`, parent_account_id = NULL` : sql``} WHERE id = ANY(${losersArr}::uuid[])`);

      const m = await tx.execute<{ id: string }>(sql`INSERT INTO merges (tenant_id, record_type, survivor_id, merged_ids, field_choices, moved, merged_by)
        VALUES (${t.tenant.id}, ${type}, ${survivor.id}, ${losersArr}::uuid[], ${JSON.stringify(body.fieldChoices)}::jsonb, ${JSON.stringify(moved)}::jsonb, ${me}) RETURNING id`);
      const mergeId = m.rows[0]?.id;
      if (!mergeId) throw new ProblemError('INTERNAL');
      await recordActivity(tx, t, { type, id: survivor.id, kind: 'merged', data: { mergeId, mergedIds: losersIds, moved } });
      await audit(tx, t.tenant.id, { action: `${type}.merged`, actorId: me, targetType: type, targetId: survivor.id, ip, details: { mergeId, mergedIds: losersIds, moved } });
      return { mergeId, survivorId: survivor.id, mergedIds: losersIds, moved };
    });
  }

  // ------------------------------------------------------------------ duplicates
  async duplicates(t: TenantRequestContext, type: 'account' | 'contact', id: string) {
    const def = CRM[type];
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, def, id);
      const scope = await recordPredicate(tx, t, def.shape, 'read');
      const r = type === 'account' ? await this.accountDuplicates(tx, row, scope) : await this.contactDuplicates(tx, row, scope);
      return { data: r };
    });
  }

  private async accountDuplicates(tx: Db, row: CrmRow, scope: SQL) {
    const name = String(row.name);
    const r = await tx.execute<{ id: string; name: string; sim: number; same_domain: boolean }>(sql`
      SELECT t.id, t.name, similarity(t.name, ${name})::float8 AS sim, (t.domain IS NOT NULL AND t.domain = ${row.domain ?? null}) AS same_domain
      FROM accounts t
      WHERE t.id <> ${row.id} AND t.deleted_at IS NULL AND ${scope}
        AND ((t.domain IS NOT NULL AND t.domain = ${row.domain ?? null}) OR (t.name % ${name} AND similarity(t.name, ${name}) >= ${DUPLICATE_SIMILARITY}))
      ORDER BY same_domain DESC, sim DESC, t.id LIMIT 20`);
    return r.rows.map((x) => ({
      id: x.id, name: x.name, score: x.same_domain ? 1 : Math.round(x.sim * 100) / 100,
      reasons: [...(x.same_domain ? ['domain' as const] : []), ...(x.sim >= DUPLICATE_SIMILARITY ? ['name' as const] : [])],
    }));
  }

  private async contactDuplicates(tx: Db, row: CrmRow, scope: SQL) {
    const name = String(row.full_name);
    const r = await tx.execute<{ id: string; name: string; sim: number; same_email: boolean; same_phone: boolean }>(sql`
      WITH mine AS (SELECT kind, value, e164 FROM contact_points WHERE owner_type = 'contact' AND owner_id = ${row.id}),
      hits AS (
        SELECT cp.owner_id AS id, bool_or(cp.kind = 'email') AS e, bool_or(cp.kind = 'phone') AS p
        FROM contact_points cp JOIN mine m ON cp.kind = m.kind AND ((cp.kind = 'email' AND cp.value = m.value) OR (cp.kind = 'phone' AND cp.e164 = m.e164))
        WHERE cp.owner_type = 'contact' AND cp.owner_id <> ${row.id}
        GROUP BY cp.owner_id
      )
      SELECT t.id, t.full_name AS name, similarity(t.full_name, ${name})::float8 AS sim, coalesce(h.e, false) AS same_email, coalesce(h.p, false) AS same_phone
      FROM contacts t LEFT JOIN hits h ON h.id = t.id
      WHERE t.id <> ${row.id} AND t.deleted_at IS NULL AND ${scope}
        AND (h.id IS NOT NULL OR (t.full_name % ${name} AND similarity(t.full_name, ${name}) >= ${DUPLICATE_SIMILARITY}))
      ORDER BY (h.id IS NOT NULL) DESC, sim DESC, t.id LIMIT 20`);
    return r.rows.map((x) => ({
      id: x.id, name: x.name, score: x.same_email || x.same_phone ? 1 : Math.round(x.sim * 100) / 100,
      reasons: [...(x.same_email ? ['email' as const] : []), ...(x.same_phone ? ['phone' as const] : []), ...(x.sim >= DUPLICATE_SIMILARITY ? ['name' as const] : [])],
    }));
  }
}

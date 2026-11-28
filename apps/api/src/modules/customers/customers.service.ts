import { Inject, Injectable } from '@nestjs/common';
import { can, scopesOf } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import type { ConsentSet, CustomerAddressInput, CustomerAnonymize, CustomerListQuery, CustomerProfilePut, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { recordActivity } from '../../common/activity';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { ProblemError } from '../../common/problem';
import { assertCan, recordPredicate } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, readCrmRow, type CrmRow } from '../crm/crm-objects';
import { contactMask } from './customer-mask';
import { OrdersService } from './orders.service';

// P9d (docs/p9-plan.md §22–28): the B2C customer — a contact with the `b2c` segment — with profile, addresses and
// channel consent. `reachability` is the one check every outbound path asks before contacting a customer.

export type Channel = 'email' | 'sms' | 'phone' | 'whatsapp';
export const CHANNELS: readonly Channel[] = ['email', 'sms', 'phone', 'whatsapp'];
type Reason = 'not_b2c' | 'no_consent' | 'withdrawn' | 'channel_disabled' | 'no_contact_point';
type ConsentRow = {
  channel: Channel; status: 'granted' | 'withdrawn'; source: string; evidence: string; external_ref: string | null; occurred_at: string;
  recorded_by: string | null; recorder_name: string | null; recorded_at: string;
};
type AddressRow = { id: string; label: string; recipient: string; line1: string; line2: string; district: string; city: string; postal_code: string; country: string; is_default: boolean };
const MAX_ADDRESSES = 20;


const iso = (v: string | Date): string => new Date(v).toISOString();
const consentView = (c: ConsentRow) => ({
  channel: c.channel, status: c.status, source: c.source as 'web_form', evidence: c.evidence, externalRef: c.external_ref, occurredAt: iso(c.occurred_at),
  recordedBy: c.recorded_by ? { id: c.recorded_by, displayName: c.recorder_name ?? '' } : null, recordedAt: iso(c.recorded_at),
});
const CONSENT_COLS = sql`c.channel, c.status, c.source, c.evidence, c.external_ref, c.occurred_at, c.recorded_by, u.display_name AS recorder_name, c.recorded_at`;

/** The channels the workspace uses (`sales_b2c.consent_channels`). */
export async function enabledChannels(tx: Db, tenantId: string): Promise<Channel[]> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT v.value FROM tenant_settings_head h JOIN tenant_settings v USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = 'sales_b2c.consent_channels'`);
  const def = configKey('sales_b2c.consent_channels');
  if (!def) throw new Error('consent channels config key is not registered');
  return (mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as { channels: Channel[] }).channels;
}

/** May the customer be contacted on the channel now? Not a B2C customer, channel off, no or withdrawn consent, or no
 *  e-mail address / phone number: no. Runs inside the caller's transaction, without the caller's permissions. */
export async function reachability(tx: Db, tenantId: string, contactId: string, channel: Channel): Promise<{ allowed: boolean; reason: Reason | null; consent: ConsentRow | null; address: string | null }> {
  const [c] = (await tx.execute<{ b2c: boolean; email: string | null; phone: string | null }>(sql`
    SELECT 'b2c' = ANY (t.segments) AS b2c,
      (SELECT p.value FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'email' ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS email,
      (SELECT p.e164 FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'phone' ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS phone
    FROM contacts t WHERE t.id = ${contactId} AND t.deleted_at IS NULL AND t.merged_into IS NULL`)).rows;
  if (!c?.b2c) return { allowed: false, reason: 'not_b2c', consent: null, address: null };
  const [consent] = (await tx.execute<ConsentRow>(sql`
    SELECT ${CONSENT_COLS} FROM consents c LEFT JOIN users u ON u.id = c.recorded_by WHERE c.contact_id = ${contactId} AND c.channel = ${channel}`)).rows;
  const address = channel === 'email' ? c.email : c.phone;
  const reason: Reason | null = !(await enabledChannels(tx, tenantId)).includes(channel) ? 'channel_disabled'
    : !consent ? 'no_consent'
      : consent.status === 'withdrawn' ? 'withdrawn'
        : !address ? 'no_contact_point' : null;
  return { allowed: reason === null, reason, consent: consent ?? null, address };
}

@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly orders: OrdersService) {}

  // ------------------------------------------------------------------ access
  /** The readable B2C customer; anything else is not there (404). */
  private async customer(tx: Db, t: TenantRequestContext, id: string, opts: { forUpdate?: boolean } = {}): Promise<CrmRow> {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
    const row = await readCrmRow(tx, t, CRM.contact, id, opts);
    if (!(row['segments'] as string[] | undefined)?.includes('b2c') || row['merged_into']) throw new ProblemError('NOT_FOUND');
    return row;
  }

  private async mayEdit(tx: Db, t: TenantRequestContext, id: string): Promise<boolean> {
    const r = await tx.execute(sql`SELECT 1 FROM ${CRM.contact.shape.from} WHERE t.id = ${id} AND ${await recordPredicate(tx, t, CRM.contact.shape, 'update')}`);
    return (r.rowCount ?? 0) > 0;
  }

  /** Consent permissions (A25) by the customer's owner: own, the team's, all; a queue scope covers what the agent may read. */
  private consentAllowed(t: TenantRequestContext, ownerId: string | null, permission: 'sales_b2c.consent.read' | 'sales_b2c.consent.manage'): boolean {
    const d = can(t.authz, permission, permission.endsWith('.read') ? 'read' : 'full');
    if (!d.allow) return false;
    const scopes = scopesOf(d.grant);
    if (scopes.includes('all') || scopes.includes('segment') || scopes.includes('queue')) return true;
    if (ownerId === t.principal.userId) return true;
    return scopes.includes('team') && ownerId !== null && (t.access.teamMemberIds.includes(ownerId) || t.access.managedMemberIds.includes(ownerId));
  }

  // ------------------------------------------------------------------ reading
  private async view(tx: Db, t: TenantRequestContext, row: CrmRow) {
    const id = row.id;
    const [p] = (await tx.execute<{ preferred_channel: Channel | null; language: 'tr' | 'en' | null; tags: string[]; version: number;
      rfm_segment: string | null; rfm_score: string | null; rfm_recency: number | null; rfm_frequency: number | null; rfm_monetary: string | null; rfm_at: string | null }>(sql`
      SELECT preferred_channel, language, tags, version, rfm_segment, rfm_score, rfm_recency, rfm_frequency, rfm_monetary::text AS rfm_monetary, rfm_at
      FROM customer_profiles WHERE contact_id = ${id}`)).rows;
    const addresses = (await tx.execute<AddressRow>(sql`
      SELECT id, label, recipient, line1, line2, district, city, postal_code, country, is_default FROM customer_addresses WHERE contact_id = ${id} ORDER BY is_default DESC, created_at, id`)).rows;
    const owner = (await tx.execute<{ display_name: string }>(sql`SELECT display_name FROM users WHERE id = ${row.owner_user_id}`)).rows[0];
    const readConsent = this.consentAllowed(t, row.owner_user_id, 'sales_b2c.consent.read');
    const channels = await enabledChannels(tx, t.tenant.id);
    const consents = readConsent
      ? (await tx.execute<ConsentRow>(sql`SELECT ${CONSENT_COLS} FROM consents c LEFT JOIN users u ON u.id = c.recorded_by WHERE c.contact_id = ${id}`)).rows
      : [];
    return {
      id, fullName: contactMask(t).name && typeof row['full_name'] === 'string' ? row['full_name'] : '', owner: { id: row.owner_user_id ?? '', displayName: owner?.display_name ?? '' },
      preferredChannel: p?.preferred_channel ?? null, language: p?.language ?? null, tags: p?.tags ?? [],
      addresses: addresses.map((a) => ({
        id: a.id, label: a.label, recipient: a.recipient, line1: a.line1, line2: a.line2, district: a.district, city: a.city, postalCode: a.postal_code, country: a.country, isDefault: a.is_default,
      })),
      consents: readConsent ? channels.map((channel) => {
        const c = consents.find((x) => x.channel === channel);
        return { channel, consent: c ? consentView(c) : null };
      }) : [],
      rfm: p?.rfm_segment && can(t.authz, 'sales_b2c.rfm.read', 'read').allow ? {
        segment: p.rfm_segment, score: p.rfm_score ?? '', recencyDays: p.rfm_recency ?? 0, frequency: p.rfm_frequency ?? 0,
        monetary: Number(p.rfm_monetary ?? 0).toFixed(2), at: iso(p.rfm_at ?? new Date().toISOString()),
      } : null,
      canEdit: await this.mayEdit(tx, t, id),
      canManageConsent: this.consentAllowed(t, row.owner_user_id, 'sales_b2c.consent.manage'),
      version: p?.version ?? 0,
    };
  }

  async get(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => this.view(tx, t, await this.customer(tx, t, id)));
  }

  async list(t: TenantRequestContext, q: z.infer<typeof CustomerListQuery>) {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const terms: SQL[] = [sql`'b2c' = ANY (t.segments)`, sql`t.deleted_at IS NULL`, sql`t.merged_into IS NULL`, await recordPredicate(tx, t, CRM.contact.shape, 'read')];
      const mask = contactMask(t);
      if (q.q) {
        const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        const by: SQL[] = [];
        if (mask.name) by.push(sql`t.full_name ILIKE ${like}`);
        if (mask.points) by.push(sql`EXISTS (SELECT 1 FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND (p.value ILIKE ${like} OR p.e164 ILIKE ${like}))`);
        terms.push(by.length ? sql`(${sql.join(by, sql` OR `)})` : sql`FALSE`);
      }
      if (q.tag) terms.push(sql`EXISTS (SELECT 1 FROM customer_profiles cp WHERE cp.contact_id = t.id AND cp.tags @> ARRAY[${q.tag}]::text[])`);
      if (q.reachable) {
        if (!(await enabledChannels(tx, t.tenant.id)).includes(q.reachable)) terms.push(sql`FALSE`);
        terms.push(sql`EXISTS (SELECT 1 FROM consents c WHERE c.contact_id = t.id AND c.channel = ${q.reachable} AND c.status = 'granted')`);
        terms.push(q.reachable === 'email'
          ? sql`EXISTS (SELECT 1 FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'email')`
          : sql`EXISTS (SELECT 1 FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'phone')`);
      }
      if (q.cursor) terms.push(sql`t.id < ${q.cursor}`);
      const rows = (await tx.execute<{ id: string; full_name: string; owner_user_id: string; owner_name: string; email: string | null; phone: string | null; tags: string[] | null; granted: Channel[] | null }>(sql`
        SELECT t.id, t.full_name, t.owner_user_id, u.display_name AS owner_name,
          (SELECT p.value FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'email' ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS email,
          (SELECT p.value FROM contact_points p WHERE p.owner_type = 'contact' AND p.owner_id = t.id AND p.kind = 'phone' ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS phone,
          (SELECT cp.tags FROM customer_profiles cp WHERE cp.contact_id = t.id) AS tags,
          (SELECT array_agg(c.channel ORDER BY c.channel) FROM consents c WHERE c.contact_id = t.id AND c.status = 'granted') AS granted
        FROM ${CRM.contact.from} JOIN users u ON u.id = t.owner_user_id
        WHERE ${sql.join(terms, sql` AND `)} ORDER BY t.id DESC LIMIT ${q.limit + 1}`)).rows;
      const page = rows.slice(0, q.limit);
      return {
        data: page.map((r) => ({
          id: r.id, fullName: mask.name ? r.full_name : '', owner: { id: r.owner_user_id, displayName: r.owner_name }, email: mask.points ? r.email : null, phone: mask.points ? r.phone : null, tags: r.tags ?? [],
          granted: this.consentAllowed(t, r.owner_user_id, 'sales_b2c.consent.read') ? (r.granted ?? []) : [],
        })),
        nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  // ------------------------------------------------------------------ profile and addresses
  async putProfile(t: TenantRequestContext, id: string, ifMatch: number, body: z.infer<typeof CustomerProfilePut>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, id, 'update');
      const [before] = (await tx.execute<{ preferred_channel: string | null; language: string | null; tags: string[]; version: number }>(sql`
        SELECT preferred_channel, language, tags, version FROM customer_profiles WHERE contact_id = ${id} FOR UPDATE`)).rows;
      if ((before?.version ?? 0) !== ifMatch) throw new ProblemError('PRECONDITION_FAILED');
      const tags = [...new Set(body.tags)];
      await tx.execute(sql`
        INSERT INTO customer_profiles (tenant_id, contact_id, preferred_channel, language, tags, updated_by)
        VALUES (${t.tenant.id}, ${id}, ${body.preferredChannel}, ${body.language}, ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(tags)}::jsonb)), ${t.principal.userId})
        ON CONFLICT (tenant_id, contact_id) DO UPDATE SET preferred_channel = EXCLUDED.preferred_channel, language = EXCLUDED.language, tags = EXCLUDED.tags,
          updated_by = EXCLUDED.updated_by, updated_at = now(), version = customer_profiles.version + 1`);
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      const was = { preferredChannel: before?.preferred_channel ?? null, language: before?.language ?? null, tags: before?.tags ?? [] };
      const now = { preferredChannel: body.preferredChannel, language: body.language, tags };
      for (const k of Object.keys(now) as (keyof typeof now)[]) if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) diff[k] = { from: was[k], to: now[k] };
      if (Object.keys(diff).length) await recordActivity(tx, t, { type: 'contact', id, kind: 'customer', diff, segment: 'b2c' });
      return this.view(tx, t, row);
    });
  }

  async addAddress(t: TenantRequestContext, id: string, body: z.infer<typeof CustomerAddressInput>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, id, 'update');
      const n = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM customer_addresses WHERE contact_id = ${id}`)).rows[0]?.n ?? 0;
      if (n >= MAX_ADDRESSES) throw new ProblemError('VALIDATION_FAILED', `at most ${String(MAX_ADDRESSES)} addresses`);
      const isDefault = body.isDefault || n === 0;
      if (isDefault) await tx.execute(sql`UPDATE customer_addresses SET is_default = false WHERE contact_id = ${id} AND is_default`);
      await tx.execute(sql`
        INSERT INTO customer_addresses (tenant_id, contact_id, label, recipient, line1, line2, district, city, postal_code, country, is_default)
        VALUES (${t.tenant.id}, ${id}, ${body.label}, ${body.recipient}, ${body.line1}, ${body.line2}, ${body.district}, ${body.city}, ${body.postalCode}, ${body.country}, ${isDefault})`);
      await recordActivity(tx, t, { type: 'contact', id, kind: 'customer', diff: { addresses: { from: n, to: n + 1 } }, segment: 'b2c' });
      return this.view(tx, t, row);
    });
  }

  async putAddress(t: TenantRequestContext, id: string, addressId: string, body: z.infer<typeof CustomerAddressInput>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, id, 'update');
      const [a] = (await tx.execute<{ is_default: boolean }>(sql`SELECT is_default FROM customer_addresses WHERE id = ${addressId} AND contact_id = ${id} FOR UPDATE`)).rows;
      if (!a) throw new ProblemError('NOT_FOUND');
      // The default stays somewhere: it moves only to another address, never off the last one.
      const isDefault = body.isDefault || a.is_default;
      if (body.isDefault && !a.is_default) await tx.execute(sql`UPDATE customer_addresses SET is_default = false WHERE contact_id = ${id} AND is_default`);
      await tx.execute(sql`
        UPDATE customer_addresses SET label = ${body.label}, recipient = ${body.recipient}, line1 = ${body.line1}, line2 = ${body.line2}, district = ${body.district},
          city = ${body.city}, postal_code = ${body.postalCode}, country = ${body.country}, is_default = ${isDefault}
        WHERE id = ${addressId}`);
      await recordActivity(tx, t, { type: 'contact', id, kind: 'customer', diff: { address: { from: addressId, to: addressId } }, segment: 'b2c' });
      return this.view(tx, t, row);
    });
  }

  async deleteAddress(t: TenantRequestContext, id: string, addressId: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, CRM.contact.shape, id, 'update');
      const [a] = (await tx.execute<{ is_default: boolean }>(sql`DELETE FROM customer_addresses WHERE id = ${addressId} AND contact_id = ${id} RETURNING is_default`)).rows;
      if (!a) throw new ProblemError('NOT_FOUND');
      if (a.is_default) {
        await tx.execute(sql`UPDATE customer_addresses SET is_default = true WHERE id = (SELECT id FROM customer_addresses WHERE contact_id = ${id} ORDER BY created_at, id LIMIT 1)`);
      }
      await recordActivity(tx, t, { type: 'contact', id, kind: 'customer', diff: { address: { from: addressId, to: null } }, segment: 'b2c' });
      return this.view(tx, t, row);
    });
  }

  // ------------------------------------------------------------------ consent
  async setConsent(t: TenantRequestContext, id: string, body: z.infer<typeof ConsentSet>) {
    authorize(t, 'sales_b2c.consent.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      if (!this.consentAllowed(t, row.owner_user_id, 'sales_b2c.consent.manage')) throw new ProblemError('FORBIDDEN');
      if (!(await enabledChannels(tx, t.tenant.id)).includes(body.channel)) throw new ProblemError('VALIDATION_FAILED', `the ${body.channel} channel is turned off`);
      const occurred = body.occurredAt ? new Date(body.occurredAt) : new Date();
      if (occurred.getTime() > Date.now() + 60_000) throw new ProblemError('VALIDATION_FAILED', 'occurredAt is in the future');
      const at = occurred.toISOString();
      await tx.execute(sql`
        INSERT INTO consents (tenant_id, contact_id, channel, status, source, evidence, external_ref, occurred_at, recorded_by)
        VALUES (${t.tenant.id}, ${id}, ${body.channel}, ${body.status}, ${body.source}, ${body.evidence}, ${body.externalRef}, ${at}::timestamptz, ${t.principal.userId})
        ON CONFLICT (tenant_id, contact_id, channel) DO UPDATE SET status = EXCLUDED.status, source = EXCLUDED.source, evidence = EXCLUDED.evidence,
          external_ref = EXCLUDED.external_ref, occurred_at = EXCLUDED.occurred_at, recorded_by = EXCLUDED.recorded_by, recorded_at = now(), version = consents.version + 1`);
      await tx.execute(sql`
        INSERT INTO consent_events (tenant_id, contact_id, channel, status, source, evidence, external_ref, occurred_at, recorded_by)
        VALUES (${t.tenant.id}, ${id}, ${body.channel}, ${body.status}, ${body.source}, ${body.evidence}, ${body.externalRef}, ${at}::timestamptz, ${t.principal.userId})`);
      await recordActivity(tx, t, { type: 'contact', id, kind: 'consent', data: { channel: body.channel, status: body.status, source: body.source }, segment: 'b2c' });
      await audit(tx, t.tenant.id, {
        action: `consent.${body.status}`, actorType: 'user', actorId: t.principal.userId, targetType: 'contact', targetId: id,
        details: { channel: body.channel, source: body.source, occurredAt: at, externalRef: body.externalRef },
      });
      return this.view(tx, t, row);
    });
  }

  async history(t: TenantRequestContext, id: string, cursor: string | undefined, limit: number) {
    authorize(t, 'sales_b2c.consent.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id);
      if (!this.consentAllowed(t, row.owner_user_id, 'sales_b2c.consent.read')) throw new ProblemError('FORBIDDEN');
      const rows = (await tx.execute<ConsentRow & { id: string }>(sql`
        SELECT c.id, ${CONSENT_COLS} FROM consent_events c LEFT JOIN users u ON u.id = c.recorded_by
        WHERE c.contact_id = ${id} ${cursor ? sql`AND c.id < ${cursor}` : sql``} ORDER BY c.id DESC LIMIT ${limit + 1}`)).rows;
      const page = rows.slice(0, limit);
      return { data: page.map((r) => ({ id: r.id, ...consentView(r) })), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  async reachable(t: TenantRequestContext, id: string, channel: Channel) {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await readCrmRow(tx, t, CRM.contact, id);
      const r = await reachability(tx, t.tenant.id, id, channel);
      // The reason is enough to act on; the consent details need the consent permission.
      const show = r.consent && this.consentAllowed(t, row.owner_user_id, 'sales_b2c.consent.read');
      return { channel, allowed: r.allowed, reason: r.reason, consent: show && r.consent ? consentView(r.consent) : null };
    });
  }

  // ------------------------------------------------------------------ KVKK / GDPR (data subject requests, Admin)
  /** Everything held about the customer: identity and contact points, profile, addresses, consent history, orders
   *  with their lines and returns, and the timeline. The export itself is audited. */
  async export(t: TenantRequestContext, id: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id);
      const points = (await tx.execute<{ kind: string; label: string | null; value: string; e164: string | null; is_primary: boolean }>(sql`
        SELECT kind, label, value, e164, is_primary FROM contact_points WHERE owner_type = 'contact' AND owner_id = ${id} ORDER BY created_at`)).rows;
      const consents = (await tx.execute<ConsentRow & { id: string }>(sql`
        SELECT c.id, ${CONSENT_COLS} FROM consent_events c LEFT JOIN users u ON u.id = c.recorded_by WHERE c.contact_id = ${id} ORDER BY c.id`)).rows;
      const timeline = (await tx.execute<{ kind: string; diff: unknown; data: unknown; occurred_at: string }>(sql`
        SELECT kind, diff, data, occurred_at FROM activity_events WHERE record_type = 'contact' AND record_id = ${id} ORDER BY occurred_at, id`)).rows;
      const view = await this.view(tx, t, row);
      await audit(tx, t.tenant.id, { action: 'customer.exported', actorType: 'user', actorId: t.principal.userId, targetType: 'contact', targetId: id });
      return {
        exportedAt: new Date().toISOString(),
        customer: {
          id, firstName: row['first_name'], lastName: row['last_name'], title: row['title'] ?? null, segments: row['segments'], createdAt: iso(String(row['created_at'])),
          contactPoints: points.map((p) => ({ kind: p.kind, label: p.label, value: p.value, e164: p.e164, isPrimary: p.is_primary })),
        },
        profile: { preferredChannel: view.preferredChannel, language: view.language, tags: view.tags },
        addresses: view.addresses,
        consents: consents.map((c) => ({ id: c.id, ...consentView(c) })),
        orders: await this.orders.exportFor(tx, t, row),
        // After anonymization the old values of edited fields are not given out (same rule as the timeline).
        timeline: timeline.map((e) => ({
          kind: e.kind, occurredAt: iso(e.occurred_at), data: e.data,
          diff: row['anonymized_at'] ? Object.fromEntries(Object.keys((e.diff ?? {}) as Record<string, unknown>).map((k) => [k, { from: null, to: null }])) : e.diff,
        })),
      };
    });
  }

  /** Erasure: the person can no longer be identified. Name, contact points, notes, profile, addresses and the order
   *  shipping addresses go; every consent is withdrawn. Orders and returns stay for the books, without the person. */
  async anonymize(t: TenantRequestContext, id: string, body: z.infer<typeof CustomerAnonymize>) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const row = await this.customer(tx, t, id, { forUpdate: true });
      if (row['anonymized_at']) throw new ProblemError('NOT_A_CUSTOMER', 'already anonymized');
      const name = typeof row['full_name'] === 'string' ? row['full_name'] : '';
      if (body.confirmName.toLocaleLowerCase('tr') !== name.trim().toLocaleLowerCase('tr')) throw new ProblemError('CONFIRM_MISMATCH');
      await tx.execute(sql`UPDATE contacts SET first_name = 'Anonim', last_name = ${`#${id.slice(-6)}`}, title = NULL, description = NULL, description_text = NULL,
        custom = '{}', anonymized_at = now(), version = version + 1, updated_by = ${t.principal.userId} WHERE id = ${id}`);
      await tx.execute(sql`DELETE FROM contact_points WHERE owner_type = 'contact' AND owner_id = ${id}`);
      await tx.execute(sql`DELETE FROM customer_addresses WHERE contact_id = ${id}`);
      await tx.execute(sql`UPDATE customer_profiles SET preferred_channel = NULL, language = NULL, tags = '{}', version = version + 1 WHERE contact_id = ${id}`);
      await tx.execute(sql`UPDATE orders SET shipping_address = NULL, note = '' WHERE customer_id = ${id}`);
      const granted = (await tx.execute<{ channel: Channel }>(sql`SELECT channel FROM consents WHERE contact_id = ${id} AND status = 'granted'`)).rows;
      for (const c of granted) {
        await tx.execute(sql`UPDATE consents SET status = 'withdrawn', source = 'other', evidence = 'KVKK silme talebi', external_ref = NULL, occurred_at = now(),
          recorded_by = ${t.principal.userId}, recorded_at = now(), version = version + 1 WHERE contact_id = ${id} AND channel = ${c.channel}`);
        await tx.execute(sql`INSERT INTO consent_events (tenant_id, contact_id, channel, status, source, evidence, occurred_at, recorded_by)
          VALUES (${t.tenant.id}, ${id}, ${c.channel}, 'withdrawn', 'other', 'KVKK silme talebi', now(), ${t.principal.userId})`);
      }
      await audit(tx, t.tenant.id, { action: 'customer.anonymized', actorType: 'user', actorId: t.principal.userId, targetType: 'contact', targetId: id });
      await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
        VALUES (${t.tenant.id}, 'customer.anonymized', 'contact', ${id}, 'b2c', ${JSON.stringify({ type: 'user', id: t.principal.userId })}::jsonb, '{}'::jsonb, gen_random_uuid())`);
      return this.view(tx, t, await this.customer(tx, t, id));
    });
  }
}

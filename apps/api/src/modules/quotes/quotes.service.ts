import { Inject, Injectable, Logger } from '@nestjs/common';
import { can } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import { minorDigits, priceQuote, type MailJob, type Priced, type QuoteCreate, type QuoteDraft, type QuoteListQuery, type QuoteOutcome, type QuoteSend, type QuoteSubmit, type QuoteVersionView, type z } from '@flexa/contracts';
import { schema, sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { createHash, randomUUID } from 'node:crypto';
import { recordActivity } from '../../common/activity';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { mapDbError } from '../../common/http-helpers';
import { ProblemError } from '../../common/problem';
import { assertCan, hiddenFields, recordPredicate } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import type { ObjectStorage } from '../../infra/storage';
import { DB, MAILER, STORAGE, type Mailer } from '../../infra/tokens';
import { ApprovalsService } from '../approvals/approvals.service';
import { PricingService } from '../catalog/pricing.service';
import { CRM, readCrmRow, type CrmRow } from '../crm/crm-objects';
import { syncMentions } from '../records/mentions';
import { renderQuotePdf } from './quote-pdf';

// Quotes (docs/p9-plan.md §1–6, ADR-0021). A quote is a part of its B2B opportunity: reading it needs read access to
// the opportunity (and to its amount), writing needs the quote permission and the right to edit the opportunity.
// Versions are immutable once sent; the database enforces it (0019_quotes.sql).

type Status = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'rejected' | 'expired';
type QuoteRow = {
  id: string; number: string; opportunity_id: string; opportunity_name: string; currency: string; status: Status; current_version: number; outcome_reason: string | null;
  note: unknown; version: number; created_by: string; creator_name: string; created_at: string; total: string | null; valid_until: string;
};
type VersionRow = {
  id: string; version: number; discount_percent: string; valid_until: string; intro: string; terms: string; customer: { account?: string | null; contact?: string | null };
  approval_percent: string; locked_at: string | null; sent_at: string | null; sent_by: string | null; sender_name: string | null; sent_to: string[] | null; created_at: string;
};
type LineRow = {
  product_id: string; sku: string; name: string; unit: string; description: string; quantity: string; list_price: string | null; price_list_id: string | null; unit_price: string;
  discount_percent: string; tax_percent: string; gross: string; net: string; tax: string;
};
interface Template { prefix: string; validDays: number; intro: string; terms: string; footer: string }

const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const pgArray = (v: readonly string[]): string => `{${v.map((x) => `"${x.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
const PDF = 'application/pdf';
/** How long sending a quote waits for the mail queue. */
const ENQUEUE_WAIT_MS = 5_000;
type QuoteMail = Extract<MailJob, { template: 'quote' }>;
type StoredMail = Omit<QuoteMail, 'template' | 'attachment'>;

@Injectable()
export class QuotesService {
  private readonly log = new Logger('quotes');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly pricing: PricingService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ------------------------------------------------------------------ reading
  /** Amounts of a quote are amounts of the opportunity: whoever may not see the field does not see quotes. */
  private assertAmounts(t: TenantRequestContext): void {
    if (hiddenFields(t, 'opportunity').has('amount')) throw new ProblemError('NOT_FOUND');
  }

  private async template(tx: Db, t: TenantRequestContext): Promise<Template> {
    const r = await tx.execute<{ value: JsonObject }>(sql`
      SELECT v.value FROM tenant_settings_head h JOIN tenant_settings v USING (tenant_id, scope_type, scope_id, key, version)
      WHERE h.scope_type = 'tenant' AND h.scope_id = ${t.tenant.id} AND h.key = 'sales_b2b.quote_template'`);
    const def = configKey('sales_b2b.quote_template');
    if (!def) throw new Error('quote template config key is not registered');
    return mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as Template;
  }

  private async rows(tx: Db, t: TenantRequestContext, where: SQL, limit = 100): Promise<QuoteRow[]> {
    return (await tx.execute<QuoteRow>(sql`
      SELECT q.id, q.number, q.opportunity_id, t.name AS opportunity_name, q.currency, q.status, q.current_version, q.outcome_reason, q.note, q.version, q.created_by,
        u.display_name AS creator_name, q.created_at, v.totals ->> 'total' AS total, v.valid_until::text AS valid_until
      FROM ${CRM.opportunity.from}
      JOIN quotes q ON q.tenant_id = t.tenant_id AND q.opportunity_id = t.id
      JOIN quote_versions v ON v.tenant_id = q.tenant_id AND v.quote_id = q.id AND v.version = q.current_version
      JOIN users u ON u.id = q.created_by
      WHERE t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'read')} AND ${where}
      ORDER BY q.id DESC LIMIT ${limit}`)).rows;
  }

  private summary(q: QuoteRow) {
    return {
      id: q.id, number: q.number, opportunity: { id: q.opportunity_id, name: q.opportunity_name }, status: q.status, currency: q.currency, currentVersion: q.current_version,
      total: q.total ?? '0', validUntil: q.valid_until, createdBy: { id: q.created_by, displayName: q.creator_name }, createdAt: new Date(q.created_at).toISOString(), version: q.version,
    };
  }

  async list(t: TenantRequestContext, q: z.infer<typeof QuoteListQuery>) {
    this.assertAmounts(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if (q.opportunityId) await readCrmRow(tx, t, CRM.opportunity, q.opportunityId);
      const rows = await this.rows(tx, t, sql`TRUE
        ${q.opportunityId ? sql`AND q.opportunity_id = ${q.opportunityId}` : sql``} ${q.status ? sql`AND q.status = ${q.status}` : sql``}
        ${q.cursor ? sql`AND q.id < ${q.cursor}` : sql``}`, q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: page.map((r) => this.summary(r)), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  private async read(tx: Db, t: TenantRequestContext, id: string): Promise<QuoteRow> {
    this.assertAmounts(t);
    const [row] = await this.rows(tx, t, sql`q.id = ${id}`, 1);
    if (!row) throw new ProblemError('NOT_FOUND');
    return row;
  }

  /** The quote, locked, for someone who may change it. */
  private async forWrite(tx: Db, t: TenantRequestContext, id: string): Promise<QuoteRow> {
    const seen = await this.read(tx, t, id);
    authorize(t, 'sales_b2b.quote.create');
    await assertCan(tx, t, CRM.opportunity.shape, seen.opportunity_id, 'update');
    await tx.execute(sql`SELECT 1 FROM quotes WHERE id = ${id} FOR UPDATE`);
    return this.read(tx, t, id);
  }

  private assertStatus(q: QuoteRow, ...allowed: Status[]): void {
    if (!allowed.includes(q.status)) throw new ProblemError('QUOTE_STATE', `the quote is ${q.status}`, { quoteStatus: q.status });
  }

  private async versionRow(tx: Db, quoteId: string, version: number): Promise<VersionRow> {
    const r = await tx.execute<VersionRow>(sql`
      SELECT v.id, v.version, v.discount_percent::text, v.valid_until::text, v.intro, v.terms, v.customer, v.approval_percent::text, v.locked_at, v.sent_at, v.sent_by,
        u.display_name AS sender_name, to_jsonb(v.sent_to) AS sent_to, v.created_at
      FROM quote_versions v LEFT JOIN users u ON u.id = v.sent_by WHERE v.quote_id = ${quoteId} AND v.version = ${version}`);
    const row = r.rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    return row;
  }

  private async lineRows(tx: Db, versionId: string): Promise<LineRow[]> {
    return (await tx.execute<LineRow>(sql`
      SELECT product_id, sku, name, unit, description, trim_scale(quantity)::text AS quantity, trim_scale(list_price)::text AS list_price, price_list_id, trim_scale(unit_price)::text AS unit_price,
        trim_scale(discount_percent)::text AS discount_percent, trim_scale(tax_percent)::text AS tax_percent, gross::text, net::text, tax::text
      FROM quote_lines WHERE quote_version_id = ${versionId} ORDER BY position`)).rows;
  }

  private price(lines: readonly LineRow[], discountPercent: string, currency: string): Priced {
    return priceQuote(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, listPrice: l.list_price, discountPercent: l.discount_percent, taxPercent: l.tax_percent })), discountPercent, currency);
  }

  private async content(tx: Db, q: QuoteRow, version: number): Promise<z.infer<typeof QuoteVersionView>> {
    const v = await this.versionRow(tx, q.id, version);
    const lines = await this.lineRows(tx, v.id);
    const p = this.price(lines, v.discount_percent, q.currency);
    const cut = (x: string): string => {
      const d = minorDigits(q.currency);
      const [i = '0', f = ''] = x.split('.');
      return d === 0 ? i : `${i}.${f.padEnd(d, '0').slice(0, d)}`;
    };
    return {
      version: v.version, discountPercent: String(Number(v.discount_percent)), validUntil: v.valid_until, intro: v.intro, terms: v.terms,
      customer: { account: v.customer.account ?? null, contact: v.customer.contact ?? null }, totals: p.totals, taxes: p.taxes, approvalPercent: v.approval_percent,
      sentAt: iso(v.sent_at), sentBy: v.sent_by ? { id: v.sent_by, displayName: v.sender_name ?? '' } : null, sentTo: v.sent_to ?? [], createdAt: new Date(v.created_at).toISOString(),
      lines: lines.map((l) => ({
        productId: l.product_id, sku: l.sku, name: l.name, unit: l.unit, description: l.description, quantity: l.quantity, listPrice: l.list_price, unitPrice: l.unit_price,
        discountPercent: l.discount_percent, taxPercent: l.tax_percent, gross: cut(l.gross), net: cut(l.net), tax: cut(l.tax),
      })),
    };
  }

  private async view(tx: Db, t: TenantRequestContext, id: string) {
    const q = await this.read(tx, t, id);
    const versions = await tx.execute<{ version: number; total: string | null; sent_at: string | null; created_at: string }>(sql`
      SELECT version, totals ->> 'total' AS total, sent_at, created_at FROM quote_versions WHERE quote_id = ${id} ORDER BY version DESC`);
    const may = await tx.execute(sql`SELECT 1 FROM ${CRM.opportunity.from} WHERE t.id = ${q.opportunity_id} AND ${await recordPredicate(tx, t, CRM.opportunity.shape, 'update')}`);
    return {
      ...this.summary(q), outcomeReason: q.outcome_reason, note: q.note ?? null, content: await this.content(tx, q, q.current_version),
      versions: versions.rows.map((v) => ({ version: v.version, total: v.total ?? '0', sentAt: iso(v.sent_at), createdAt: new Date(v.created_at).toISOString() })),
      canEdit: (may.rowCount ?? 0) > 0 && can(t.authz, 'sales_b2b.quote.create').allow,
    };
  }

  async get(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), (tx) => this.view(tx, t, id));
  }

  async getVersion(t: TenantRequestContext, id: string, version: number) {
    return this.db.withTenant(dbCtx(t), async (tx) => this.content(tx, await this.read(tx, t, id), version));
  }

  // ------------------------------------------------------------------ draft
  private async today(tx: Db, t: TenantRequestContext): Promise<string> {
    return (await tx.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${t.tenant.timezone})::date::text AS d`)).rows[0]?.d ?? '';
  }

  /** Whom the quote is for, as far as the author can read it. */
  private async customer(tx: Db, t: TenantRequestContext, opp: CrmRow): Promise<{ accountId: string | null; names: { account: string | null; contact: string | null } }> {
    const name = async (type: 'account' | 'contact', id: string | null): Promise<string | null> => {
      if (!id) return null;
      const r = await tx.execute<{ n: string }>(sql`SELECT ${sql.raw(type === 'account' ? 't.name' : 't.full_name')} AS n FROM ${CRM[type].from}
        WHERE t.id = ${id} AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM[type].shape, 'read')}`);
      return r.rows[0]?.n ?? null;
    };
    const accountId = s(opp.account_id);
    const account = await name('account', accountId);
    return { accountId: account === null ? null : accountId, names: { account, contact: await name('contact', s(opp.primary_contact_id)) } };
  }

  private async log_(tx: Db, t: TenantRequestContext, q: { id: string; number: string; opportunity_id: string }, version: number, action: string): Promise<void> {
    await recordActivity(tx, t, { type: 'opportunity', id: q.opportunity_id, kind: 'quote', data: { quoteId: q.id, number: q.number, version, action } });
    await audit(tx, t.tenant.id, { action: `quote.${action}`, actorId: t.principal.userId, targetType: 'quote', targetId: q.id, details: { number: q.number, version, opportunityId: q.opportunity_id } });
  }

  async create(t: TenantRequestContext, body: z.infer<typeof QuoteCreate>) {
    this.assertAmounts(t);
    authorize(t, 'sales_b2b.quote.create');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const opp = await readCrmRow(tx, t, CRM.opportunity, body.opportunityId);
      await assertCan(tx, t, CRM.opportunity.shape, body.opportunityId, 'update');
      if (opp.segment !== 'b2b') throw new ProblemError('SEGMENT_NOT_ALLOWED', 'quotes are for B2B opportunities');
      const tpl = await this.template(tx, t);
      const day = await this.today(tx, t);
      const year = Number(day.slice(0, 4));
      const counter = await tx.execute<{ last: number }>(sql`INSERT INTO quote_counters (tenant_id, year, last) VALUES (${t.tenant.id}, ${year}, 1)
        ON CONFLICT (tenant_id, year) DO UPDATE SET last = quote_counters.last + 1 RETURNING last`);
      const number = `${tpl.prefix}-${String(year)}-${String(counter.rows[0]?.last ?? 1).padStart(5, '0')}`;
      const currency = body.currency ?? s(opp.currency) ?? t.tenant.currency;
      const customer = await this.customer(tx, t, opp);
      try {
        const r = await tx.execute<{ id: string }>(sql`INSERT INTO quotes (tenant_id, number, opportunity_id, currency, created_by)
          VALUES (${t.tenant.id}, ${number}, ${body.opportunityId}, ${currency}, ${t.principal.userId}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await tx.execute(sql`INSERT INTO quote_versions (tenant_id, quote_id, version, valid_until, intro, terms, customer, totals, created_by)
          VALUES (${t.tenant.id}, ${id}, 1, (${day}::date + ${tpl.validDays}::int), ${tpl.intro}, ${tpl.terms}, ${JSON.stringify(customer.names)}::jsonb,
            ${JSON.stringify(priceQuote([], '0', currency).totals)}::jsonb, ${t.principal.userId})`);
        await this.log_(tx, t, { id, number, opportunity_id: body.opportunityId }, 1, 'created');
        return await this.view(tx, t, id);
      } catch (e) {
        return mapDbError(e);
      }
    });
  }

  /** Replaces the content of the draft. Names, units, tax rates and list prices come from the catalogue. */
  async saveDraft(t: TenantRequestContext, id: string, expected: number, body: z.infer<typeof QuoteDraft>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.forWrite(tx, t, id);
      if (q.version !== expected) throw new ProblemError('PRECONDITION_FAILED', 'the quote was changed meanwhile', { currentVersion: q.version });
      this.assertStatus(q, 'draft');
      const v = await this.versionRow(tx, id, q.current_version);
      const opp = await readCrmRow(tx, t, CRM.opportunity, q.opportunity_id);
      const customer = await this.customer(tx, t, opp);
      const before = new Set((await this.lineRows(tx, v.id)).map((l) => l.product_id));
      const found = await this.catalogue(tx, t, q.currency, customer.accountId, body.lines);
      const lines: LineRow[] = body.lines.map((l, i) => {
        const c = found[i];
        // An unknown product, or one withdrawn from sale that the draft did not already carry.
        if (!c || (!c.active && !before.has(l.productId))) throw new ProblemError('VALIDATION_FAILED', `lines[${String(i)}]: the product is not for sale`);
        const unitPrice = l.unitPrice ?? c.listPrice;
        if (unitPrice === null) throw new ProblemError('QUOTE_PRICE_MISSING', `lines[${String(i)}]: the catalogue has no price; enter one`, { line: i });
        return {
          product_id: l.productId, sku: c.sku, name: c.name, unit: c.unit, description: l.description, quantity: l.quantity, list_price: c.listPrice, price_list_id: c.priceListId,
          unit_price: unitPrice, discount_percent: l.discountPercent, tax_percent: c.taxPercent, gross: '0', net: '0', tax: '0',
        };
      });
      await tx.execute(sql`UPDATE quote_versions SET valid_until = ${body.validUntil}::date, intro = ${body.intro}, terms = ${body.terms} WHERE id = ${v.id}`);
      await this.store(tx, t, q, v.id, lines, body.discountPercent, customer.names);
      await tx.execute(sql`UPDATE quotes SET version = version + 1 WHERE id = ${id}`);
      return this.view(tx, t, id);
    });
  }

  private async catalogue(tx: Db, t: TenantRequestContext, currency: string, accountId: string | null, lines: readonly { productId: string; quantity: string }[]) {
    if (lines.length === 0) return [];
    const products = new Map((await tx.execute<{ id: string; sku: string; name: string; unit: string; active: boolean; tax: string | null }>(sql`
      SELECT p.id, p.sku, p.name, p.unit, p.active, trim_scale(r.rate)::text AS tax FROM products p LEFT JOIN tax_rates r ON r.tenant_id = p.tenant_id AND r.id = p.tax_rate_id
      WHERE p.id = ANY(${pgArray([...new Set(lines.map((l) => l.productId))])}::uuid[]) AND 'b2b' = ANY (p.segments)`)).rows.map((p) => [p.id, p]));
    if (lines.some((l) => !products.has(l.productId))) throw new ProblemError('VALIDATION_FAILED', 'lines: unknown product');
    const prices = await this.pricing.resolveTx(tx, t, { segment: 'b2b', currency, accountId, items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
    return lines.map((l, i) => {
      const p = products.get(l.productId);
      if (!p) return null;
      const price = prices.data[i]?.price ?? null;
      return { sku: p.sku, name: p.name, unit: p.unit, active: p.active, taxPercent: p.tax ?? '0', listPrice: price?.unitPrice ?? null, priceListId: price?.priceListId ?? null };
    });
  }

  /** Writes lines and totals of an unlocked version. */
  private async store(tx: Db, t: TenantRequestContext, q: QuoteRow, versionId: string, lines: readonly LineRow[], discountPercent: string, customer: { account: string | null; contact: string | null }): Promise<Priced> {
    const p = this.price(lines, discountPercent, q.currency);
    await tx.execute(sql`DELETE FROM quote_lines WHERE quote_version_id = ${versionId}`);
    for (const [i, l] of lines.entries()) {
      const x = p.lines[i];
      if (!x) continue;
      await tx.execute(sql`INSERT INTO quote_lines (tenant_id, quote_version_id, position, product_id, sku, name, unit, description, quantity, list_price, price_list_id, unit_price, discount_percent, tax_percent, gross, net, tax)
        VALUES (${t.tenant.id}, ${versionId}, ${i}, ${l.product_id}, ${l.sku}, ${l.name}, ${l.unit}, ${l.description}, ${l.quantity}::numeric, ${l.list_price}::numeric, ${l.price_list_id}, ${l.unit_price}::numeric,
          ${l.discount_percent}::numeric, ${l.tax_percent}::numeric, ${x.gross}::numeric, ${x.net}::numeric, ${x.tax}::numeric)`);
    }
    await tx.execute(sql`UPDATE quote_versions SET discount_percent = ${discountPercent}::numeric, customer = ${JSON.stringify(customer)}::jsonb, totals = ${JSON.stringify(p.totals)}::jsonb,
      approval_percent = ${p.approvalPercent}::numeric WHERE id = ${versionId}`);
    return p;
  }

  /** The internal note: any time, by those who may edit; mentions are checked against the opportunity. */
  async setNote(t: TenantRequestContext, id: string, note: unknown) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.forWrite(tx, t, id);
      const rendered = await syncMentions(tx, t, { type: 'opportunity', id: q.opportunity_id }, 'quote', id, q.note, note);
      await tx.execute(sql`UPDATE quotes SET note = ${note === null || note === undefined ? null : JSON.stringify(note)}::jsonb, note_text = ${rendered?.text ?? null} WHERE id = ${id}`);
      return this.view(tx, t, id);
    });
  }

  // ------------------------------------------------------------------ submit, revise, send, outcome
  /** Fixes the content. The discount against the list prices of now decides whether someone must approve it. */
  async submit(t: TenantRequestContext, id: string, body: z.infer<typeof QuoteSubmit>, ip: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.forWrite(tx, t, id);
      this.assertStatus(q, 'draft');
      const v = await this.versionRow(tx, id, q.current_version);
      if (v.valid_until < (await this.today(tx, t))) throw new ProblemError('VALIDATION_FAILED', 'validUntil is in the past');
      const opp = await readCrmRow(tx, t, CRM.opportunity, q.opportunity_id);
      const customer = await this.customer(tx, t, opp);
      const stored = await this.lineRows(tx, v.id);
      if (stored.length === 0) throw new ProblemError('VALIDATION_FAILED', 'a quote needs at least one line');
      const now = await this.catalogue(tx, t, q.currency, customer.accountId, stored.map((l) => ({ productId: l.product_id, quantity: l.quantity })));
      const lines = stored.map((l, i) => ({ ...l, list_price: now[i]?.listPrice ?? l.list_price, price_list_id: now[i]?.listPrice ? now[i].priceListId : l.price_list_id }));
      const p = await this.store(tx, t, q, v.id, lines, v.discount_percent, customer.names);
      await tx.execute(sql`UPDATE quote_versions SET locked_at = now() WHERE id = ${v.id}`);
      let status: Status = 'approved';
      if (Number(p.approvalPercent) > 0) {
        const r = await this.approvals.requestTx(tx, t, { percent: p.approvalPercent, reason: body.reason, opportunityId: q.opportunity_id, quote: { id, version: q.current_version } }, ip);
        status = r.automatic ? 'approved' : 'pending_approval';
      }
      await tx.execute(sql`UPDATE quotes SET status = ${status}, version = version + 1 WHERE id = ${id}`);
      await this.log_(tx, t, q, q.current_version, 'submitted');
      return this.view(tx, t, id);
    });
  }

  /** A new draft copied from the current version; what was sent or approved stays as it is. */
  async revise(t: TenantRequestContext, id: string) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.forWrite(tx, t, id);
      this.assertStatus(q, 'approved', 'sent', 'rejected', 'expired');
      const v = await this.versionRow(tx, id, q.current_version);
      const next = q.current_version + 1;
      const tpl = await this.template(tx, t);
      const day = await this.today(tx, t);
      const r = await tx.execute<{ id: string }>(sql`
        INSERT INTO quote_versions (tenant_id, quote_id, version, discount_percent, valid_until, intro, terms, customer, totals, approval_percent, created_by)
        SELECT tenant_id, quote_id, ${next}, discount_percent, GREATEST(valid_until, ${day}::date + CASE WHEN valid_until < ${day}::date THEN ${tpl.validDays}::int ELSE 0 END), intro, terms, customer, totals,
          approval_percent, ${t.principal.userId} FROM quote_versions WHERE id = ${v.id} RETURNING id`);
      await tx.execute(sql`
        INSERT INTO quote_lines (tenant_id, quote_version_id, position, product_id, sku, name, unit, description, quantity, list_price, price_list_id, unit_price, discount_percent, tax_percent, gross, net, tax)
        SELECT tenant_id, ${r.rows[0]?.id ?? null}, position, product_id, sku, name, unit, description, quantity, list_price, price_list_id, unit_price, discount_percent, tax_percent, gross, net, tax
        FROM quote_lines WHERE quote_version_id = ${v.id}`);
      await tx.execute(sql`UPDATE quotes SET status = 'draft', current_version = ${next}, outcome_reason = NULL, version = version + 1 WHERE id = ${id}`);
      await this.log_(tx, t, q, next, 'revised');
      return this.view(tx, t, id);
    });
  }

  private async pdfOf(tx: Db, t: TenantRequestContext, q: QuoteRow, content: z.infer<typeof QuoteVersionView>, draft: boolean): Promise<Buffer> {
    return renderQuotePdf({
      locale: t.tenant.locale, tenantName: t.tenant.name, number: q.number, title: q.opportunity_name, currency: q.currency, footer: (await this.template(tx, t)).footer, draft, content,
    });
  }

  /** Sends the approved version: the PDF is stored, the version sealed, and its e-mails recorded with it, then queued. */
  async send(t: TenantRequestContext, id: string, body: z.infer<typeof QuoteSend>) {
    authorize(t, 'sales_b2b.quote.send');
    const storage = this.storage;
    if (!storage) throw new ProblemError('UPSTREAM_UNAVAILABLE', 'file storage is not configured');
    const to = [...new Set(body.to.map((x) => x.toLowerCase()))];
    const key = `tenants/${t.tenant.id}/quotes/${randomUUID()}`;
    const put = { done: false };
    try {
      const { view, versionId } = await this.db.withTenant(dbCtx(t), async (tx) => {
        const q = await this.forWrite(tx, t, id);
        this.assertStatus(q, 'approved');
        const v = await this.versionRow(tx, id, q.current_version);
        if (v.valid_until < (await this.today(tx, t))) throw new ProblemError('VALIDATION_FAILED', 'validUntil is in the past');
        const content = { ...(await this.content(tx, q, q.current_version)), sentAt: new Date().toISOString() };
        const pdfBytes = await this.pdfOf(tx, t, q, content, false);
        put.done = true;
        await storage.put(key, pdfBytes, PDF, `${q.number}-v${String(q.current_version)}.pdf`);
        await tx.execute(sql`UPDATE quote_versions SET sent_at = now(), sent_by = ${t.principal.userId}, sent_to = ${pgArray(to)}::text[] WHERE id = ${v.id}`);
        await tx.execute(sql`INSERT INTO quote_documents (tenant_id, quote_version_id, object_key, sha256, size_bytes)
          VALUES (${t.tenant.id}, ${v.id}, ${key}, ${createHash('sha256').update(pdfBytes).digest('hex')}, ${pdfBytes.length})`);
        await tx.execute(sql`UPDATE quotes SET status = 'sent', version = version + 1 WHERE id = ${id}`);
        await this.log_(tx, t, q, q.current_version, 'sent');
        const me = await tx.select({ email: schema.users.email }).from(schema.users).where(sql`id = ${t.principal.userId}`);
        const sent = await this.view(tx, t, id);
        const replyTo = me[0]?.email;
        for (const [i, address] of to.entries()) {
          const mail: StoredMail = {
            to: address, locale: t.tenant.locale.startsWith('tr') ? 'tr-TR' : 'en-US',
            vars: { tenantName: t.tenant.name, number: sent.number, message: body.message, total: `${sent.total} ${sent.currency}`, validUntil: sent.validUntil },
            ...(replyTo ? { replyTo } : {}),
          };
          await tx.execute(sql`INSERT INTO quote_deliveries (tenant_id, quote_version_id, position, mail) VALUES (${t.tenant.id}, ${v.id}, ${i}, ${JSON.stringify(mail)}::jsonb)`);
        }
        return { view: sent, versionId: v.id };
      });
      // Best effort: what cannot be queued now (or takes too long) stays recorded for deliverDue().
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.deliver(t.tenant.id, versionId),
        new Promise<void>((done) => { timer = setTimeout(done, ENQUEUE_WAIT_MS); }),
      ]).finally(() => { clearTimeout(timer); });
      return view;
    } catch (e) {
      // Nothing was sent: the stored file belongs to no version.
      if (put.done) await this.dropOrphan(t, storage, key);
      throw e;
    }
  }

  private async dropOrphan(t: TenantRequestContext, storage: ObjectStorage, key: string): Promise<void> {
    try {
      const kept = await this.db.withTenant(dbCtx(t), (tx) => tx.execute(sql`SELECT 1 FROM quote_documents WHERE object_key = ${key}`));
      if ((kept.rowCount ?? 0) === 0) await storage.remove(key);
    } catch (e) {
      this.log.warn(`object cleanup failed: ${(e as Error).message}`);
    }
  }

  async outcome(t: TenantRequestContext, id: string, body: z.infer<typeof QuoteOutcome>) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.forWrite(tx, t, id);
      this.assertStatus(q, 'sent');
      if (body.outcome === 'accepted' && q.valid_until < (await this.today(tx, t))) throw new ProblemError('QUOTE_STATE', 'the quote has expired', { quoteStatus: 'expired' });
      await tx.execute(sql`UPDATE quotes SET status = ${body.outcome}, outcome_reason = ${body.reason ?? null}, version = version + 1 WHERE id = ${id}`);
      await this.log_(tx, t, q, q.current_version, body.outcome);
      return this.view(tx, t, id);
    });
  }

  /** A sent version: the stored document. Otherwise a preview marked as a draft. */
  async pdf(t: TenantRequestContext, id: string, version: number): Promise<{ bytes: Buffer; fileName: string }> {
    const r = await this.db.withTenant(dbCtx(t), async (tx) => {
      const q = await this.read(tx, t, id);
      const content = await this.content(tx, q, version);
      const fileName = `${q.number}-v${String(version)}.pdf`;
      if (!content.sentAt) return { bytes: await this.pdfOf(tx, t, q, content, true), fileName, key: null, sha: null };
      const d = await tx.execute<{ object_key: string; sha256: string }>(sql`SELECT d.object_key, d.sha256 FROM quote_documents d JOIN quote_versions v ON v.id = d.quote_version_id WHERE v.quote_id = ${id} AND v.version = ${version}`);
      return { bytes: null, fileName, key: d.rows[0]?.object_key ?? null, sha: d.rows[0]?.sha256 ?? null };
    });
    if (r.bytes) return { bytes: r.bytes, fileName: r.fileName };
    if (!this.storage || !r.key) throw new ProblemError('UPSTREAM_UNAVAILABLE', 'the document is not available');
    const bytes = await this.document(this.storage, r.key, r.sha);
    return { bytes, fileName: r.fileName };
  }

  /** The stored document, checked against its hash. */
  private async document(storage: ObjectStorage, key: string, sha: string | null): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    for await (const c of await storage.stream(key)) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== sha) {
      this.log.error(`quote document ${key} does not match its hash`);
      throw new ProblemError('UPSTREAM_UNAVAILABLE', 'the document is damaged');
    }
    return bytes;
  }

  // ------------------------------------------------------------------ delivery (background)
  /** Queues what is still owed of a sent version. Never throws; the job id keeps a repeat from being queued twice. */
  private async deliver(tenantId: string, versionId: string): Promise<number> {
    const ctx = { tenantId, userId: null, segments: ['b2b' as const] };
    let n = 0;
    try {
      const due = await this.db.withTenant(ctx, async (tx) => (await tx.execute<{ id: string; position: number; mail: StoredMail; object_key: string; sha256: string; number: string; version: number }>(sql`
        SELECT d.id, d.position, d.mail, f.object_key, f.sha256, q.number, v.version
        FROM quote_deliveries d JOIN quote_versions v ON v.id = d.quote_version_id JOIN quotes q ON q.id = v.quote_id JOIN quote_documents f ON f.quote_version_id = v.id
        WHERE d.quote_version_id = ${versionId} AND d.queued_at IS NULL ORDER BY d.position`)).rows);
      let base64: string | null = null;
      for (const d of due) {
        try {
          if (!this.storage) throw new Error('file storage is not configured');
          base64 ??= (await this.document(this.storage, d.object_key, d.sha256)).toString('base64');
          await this.mailer.send(
            { template: 'quote', ...d.mail, attachment: { fileName: `${d.number}-v${String(d.version)}.pdf`, mime: PDF, base64 } },
            { jobId: `quote-${versionId}-${String(d.position)}` },
          );
          await this.db.withTenant(ctx, (tx) => tx.execute(sql`UPDATE quote_deliveries SET queued_at = now(), attempts = attempts + 1 WHERE id = ${d.id}`));
          n += 1;
        } catch (e) {
          this.log.warn(`quote mail ${d.id} not queued: ${(e as Error).message}`);
          // Later and later, at most an hour apart.
          await this.db.withTenant(ctx, (tx) => tx.execute(sql`
            UPDATE quote_deliveries SET attempts = attempts + 1, next_attempt_at = now() + least(interval '1 hour', interval '1 minute' * power(2, least(attempts, 6)))
            WHERE id = ${d.id} AND queued_at IS NULL`));
        }
      }
    } catch (e) {
      this.log.error(`quote delivery of version ${versionId} failed: ${(e as Error).message}`);
    }
    return n;
  }

  async deliverDue(limit = 100): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; quote_version_id: string }>(sql`SELECT tenant_id, quote_version_id FROM app.due_quote_deliveries(${limit})`)).rows);
    let n = 0;
    for (const d of due) n += await this.deliver(d.tenant_id, d.quote_version_id);
    return n;
  }

  // ------------------------------------------------------------------ validity (background)
  async expireDue(limit = 500): Promise<number> {
    const due = await this.db.withAnonymous(async (tx) => (await tx.execute<{ tenant_id: string; id: string }>(sql`SELECT tenant_id, id FROM app.expired_quotes(${limit})`)).rows);
    let n = 0;
    for (const d of due) {
      n += await this.db.withTenant({ tenantId: d.tenant_id, userId: null, segments: ['b2b'] }, async (tx) => {
        const r = await tx.execute<{ opportunity_id: string; number: string; current_version: number }>(sql`
          UPDATE quotes SET status = 'expired', version = version + 1 WHERE id = ${d.id} AND status = 'sent' RETURNING opportunity_id, number, current_version`);
        const q = r.rows[0];
        if (!q) return 0;
        const data = { quoteId: d.id, number: q.number, version: q.current_version, action: 'expired' };
        await tx.execute(sql`INSERT INTO activity_events (tenant_id, record_type, record_id, segment, kind, actor_id, data)
          VALUES (${d.tenant_id}, 'opportunity', ${q.opportunity_id}, 'b2b', 'quote', NULL, ${JSON.stringify(data)}::jsonb)`);
        await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, resource_type, resource_id, segment, actor, payload, correlation_id)
          VALUES (${d.tenant_id}, 'quote.expired', 'opportunity', ${q.opportunity_id}, 'b2b', ${JSON.stringify({ type: 'system', id: null })}::jsonb, ${JSON.stringify({ quoteId: d.id, version: q.current_version })}::jsonb, gen_random_uuid())`);
        await audit(tx, d.tenant_id, { action: 'quote.expired', actorType: 'system', actorId: null, targetType: 'quote', targetId: d.id });
        return 1;
      });
    }
    return n;
  }
}

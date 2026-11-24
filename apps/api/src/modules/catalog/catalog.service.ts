import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { can } from '@flexa/authz';
import type {
  FxRate, FxRateKey, PriceListCreate, PriceListItemSet, PriceListItemsQuery, PriceListPatch, ProductCreate, ProductListQuery, ProductPatch, TaxRateCreate, TaxRatePatch, z,
} from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { CursorCodec, mapDbError } from '../../common/http-helpers';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { recordPredicate } from '../../common/record-access';
import { dbCtx, type Segment, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV, type ApiEnv } from '../../infra/tokens';
import { CRM, readCrmRow } from '../crm/crm-objects';

// Product catalogue, tax rates, price lists and exchange rates (docs/p8-plan.md §1–2). Row visibility by
// segment is RLS; customer price lists additionally follow the customer's record access.

type TaxRow = { id: string; name: string; rate: string; active: boolean; version: number };
type ProductRow = {
  id: string; sku: string; name: string; description: string; category: string | null; unit: string; tax_rate_id: string | null; segs: Segment[];
  unit_cost: string | null; cost_currency: string | null; active: boolean; version: number; created_at: Date | string; updated_at: Date | string; sort_name: string;
};
export type PriceListRow = {
  id: string; name: string; currency: string; segment: Segment | null; account_id: string | null; account_name: string | null;
  valid_from: string | null; valid_to: string | null; active: boolean; version: number; product_count: number;
};

const taxView = (r: TaxRow) => ({ id: r.id, name: r.name, rate: r.rate, active: r.active, version: r.version });
const listView = (r: PriceListRow) => ({
  id: r.id, name: r.name, currency: r.currency, segment: r.segment, account: r.account_id ? { id: r.account_id, name: r.account_name ?? '' } : null,
  validFrom: r.valid_from, validTo: r.valid_to, active: r.active, productCount: r.product_count, version: r.version,
});

const LIKE = /[\\%_]/g;
const segLiteral = (s: readonly Segment[]): SQL => sql`${`{${s.join(',')}}`}::segment[]`;

/** FROM/WHERE of the price lists the caller may see (alias `pl`): a customer list only with the customer. */
export async function visiblePriceLists(tx: Db, t: TenantRequestContext): Promise<SQL> {
  return sql`(pl.account_id IS NULL OR EXISTS (
    SELECT 1 FROM accounts t WHERE t.id = pl.account_id AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.account.shape, 'read')}))`;
}

@Injectable()
export class CatalogService {
  private readonly cursors: CursorCodec;

  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(ENV) env: ApiEnv) {
    this.cursors = new CursorCodec(createHash('sha256').update(`cursor-key:${env.CSRF_SECRET}`).digest('hex'));
  }

  private seesCost(t: TenantRequestContext): boolean {
    return can(t.authz, 'fields.cost_margin.read', 'read').allow;
  }

  private assertCost(t: TenantRequestContext, body: { cost?: unknown }): void {
    if (body.cost !== undefined && !this.seesCost(t)) throw new ProblemError('FIELD_READ_ONLY', 'a field in the request cannot be changed');
  }

  private productView(t: TenantRequestContext, r: ProductRow) {
    return {
      id: r.id, sku: r.sku, name: r.name, description: r.description, category: r.category, unit: r.unit, taxRateId: r.tax_rate_id, segments: r.segs,
      ...(this.seesCost(t) ? { cost: r.unit_cost !== null && r.cost_currency !== null ? { amount: r.unit_cost, currency: r.cost_currency } : null } : {}),
      active: r.active, version: r.version, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    };
  }

  // ------------------------------------------------------------------ tax rates
  async listTaxRates(t: TenantRequestContext) {
    authorize(t, 'catalog.product.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await tx.execute<TaxRow>(sql`SELECT * FROM tax_rates ORDER BY active DESC, lower(name)`)).rows.map(taxView) }));
  }

  async createTaxRate(t: TenantRequestContext, body: z.infer<typeof TaxRateCreate>, ip: string) {
    authorize(t, 'catalog.product.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const row = (await tx.execute<TaxRow>(sql`INSERT INTO tax_rates (tenant_id, name, rate, active) VALUES (${t.tenant.id}, ${body.name}, ${body.rate}::numeric, ${body.active ?? true}) RETURNING *`)).rows[0];
        if (!row) throw new ProblemError('INTERNAL');
        await audit(tx, t.tenant.id, { action: 'tax_rate.created', actorId: t.principal.userId, targetType: 'tax_rate', targetId: row.id, ip, details: { name: row.name, rate: row.rate } });
        return taxView(row);
      } catch (e) {
        return mapDbError(e);
      }
    });
  }

  async patchTaxRate(t: TenantRequestContext, id: string, version: number, body: z.infer<typeof TaxRatePatch>, ip: string) {
    authorize(t, 'catalog.product.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.lock(tx, 'tax_rates', id, version);
      const sets: SQL[] = [sql`version = version + 1`];
      if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
      if (body.rate !== undefined) sets.push(sql`rate = ${body.rate}::numeric`);
      if (body.active !== undefined) sets.push(sql`active = ${body.active}`);
      try {
        const row = (await tx.execute<TaxRow>(sql`UPDATE tax_rates SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING *`)).rows[0];
        if (!row) throw new ProblemError('NOT_FOUND');
        await audit(tx, t.tenant.id, { action: 'tax_rate.updated', actorId: t.principal.userId, targetType: 'tax_rate', targetId: id, ip, details: body });
        return taxView(row);
      } catch (e) {
        return mapDbError(e);
      }
    });
  }

  /** Locks a visible row and checks the caller's version (404 / 412). */
  private async lock(tx: Db, table: 'tax_rates' | 'products' | 'price_lists', id: string, version: number): Promise<void> {
    const r = await tx.execute<{ version: number }>(sql`SELECT version FROM ${sql.raw(table)} WHERE id = ${id} FOR UPDATE`);
    const row = r.rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    if (row.version !== version) throw new ProblemError('PRECONDITION_FAILED');
  }

  // ------------------------------------------------------------------ products
  private readonly productCols = sql`p.*, to_jsonb(p.segments) AS segs, lower(p.name) AS sort_name`;

  async listProducts(t: TenantRequestContext, q: z.infer<typeof ProductListQuery>) {
    authorize(t, 'catalog.product.manage', 'read');
    const fingerprint = `products:${t.tenant.id}:${q.q ?? ''}:${q.active}`;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const where: SQL[] = [sql`TRUE`];
      if (q.active !== 'all') where.push(sql`p.active = ${q.active === 'true'}`);
      if (q.q) {
        const like = `%${q.q.replace(LIKE, '\\$&')}%`;
        where.push(sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.category ILIKE ${like})`);
      }
      if (q.cursor) {
        const [name, id] = this.cursors.decode(q.cursor, fingerprint) as [string, string];
        where.push(sql`(lower(p.name), p.id) > (${name}, ${id}::uuid)`);
      }
      const rows = (await tx.execute<ProductRow>(sql`SELECT ${this.productCols} FROM products p WHERE ${sql.join(where, sql` AND `)} ORDER BY lower(p.name), p.id LIMIT ${q.limit + 1}`)).rows;
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const hasMore = rows.length > q.limit;
      return { data: page.map((r) => this.productView(t, r)), page: { hasMore, nextCursor: hasMore && last ? this.cursors.encode([last.sort_name, last.id], fingerprint) : null } };
    });
  }

  private async product(tx: Db, id: string): Promise<ProductRow> {
    const row = (await tx.execute<ProductRow>(sql`SELECT ${this.productCols} FROM products p WHERE p.id = ${id}`)).rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    return row;
  }

  async getProduct(t: TenantRequestContext, id: string) {
    authorize(t, 'catalog.product.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => this.productView(t, await this.product(tx, id)));
  }

  private assertSegments(t: TenantRequestContext, segments: readonly Segment[]): void {
    if (segments.some((s) => !t.segments.includes(s))) throw new ProblemError('SEGMENT_NOT_ALLOWED');
  }

  async createProduct(t: TenantRequestContext, body: z.infer<typeof ProductCreate>, ip: string) {
    authorize(t, 'catalog.product.manage');
    this.assertCost(t, body);
    this.assertSegments(t, body.segments);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const r = await tx.execute<{ id: string }>(sql`
          INSERT INTO products (tenant_id, sku, name, description, category, unit, tax_rate_id, segments, unit_cost, cost_currency, active, created_by)
          VALUES (${t.tenant.id}, ${body.sku}, ${body.name}, ${body.description ?? ''}, ${body.category ?? null}, ${body.unit ?? 'adet'}, ${body.taxRateId ?? null},
            ${segLiteral(body.segments)}, ${body.cost?.amount ?? null}::numeric, ${body.cost?.currency ?? null}, ${body.active ?? true}, ${t.principal.userId}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'product.created', actorId: t.principal.userId, targetType: 'product', targetId: id, ip, details: { sku: body.sku } });
        return this.productView(t, await this.product(tx, id));
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `SKU "${body.sku}" already exists`);
        return mapDbError(e);
      }
    });
  }

  async patchProduct(t: TenantRequestContext, id: string, version: number, body: z.infer<typeof ProductPatch>, ip: string) {
    authorize(t, 'catalog.product.manage');
    this.assertCost(t, body);
    if (body.segments) this.assertSegments(t, body.segments);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.lock(tx, 'products', id, version);
      const sets: SQL[] = [sql`version = version + 1`];
      if (body.sku !== undefined) sets.push(sql`sku = ${body.sku}`);
      if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
      if (body.description !== undefined) sets.push(sql`description = ${body.description}`);
      if (body.category !== undefined) sets.push(sql`category = ${body.category}`);
      if (body.unit !== undefined) sets.push(sql`unit = ${body.unit}`);
      if (body.taxRateId !== undefined) sets.push(sql`tax_rate_id = ${body.taxRateId}`);
      if (body.segments !== undefined) {
        // A segment the caller cannot see stays as it is.
        const kept = (await this.product(tx, id)).segs.filter((s) => !t.segments.includes(s));
        sets.push(sql`segments = ${segLiteral([...new Set([...kept, ...body.segments])].sort())}`);
      }
      if (body.cost !== undefined) sets.push(sql`unit_cost = ${body.cost?.amount ?? null}::numeric`, sql`cost_currency = ${body.cost?.currency ?? null}`);
      if (body.active !== undefined) sets.push(sql`active = ${body.active}`);
      try {
        await tx.execute(sql`UPDATE products SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a product with that SKU exists');
        mapDbError(e);
      }
      // Field names only: the audit log is read by people who may not see costs.
      await audit(tx, t.tenant.id, { action: 'product.updated', actorId: t.principal.userId, targetType: 'product', targetId: id, ip, details: { fields: Object.keys(body).sort() } });
      return this.productView(t, await this.product(tx, id));
    });
  }

  // ------------------------------------------------------------------ price lists
  private async priceLists(tx: Db, t: TenantRequestContext, id?: string): Promise<PriceListRow[]> {
    return (await tx.execute<PriceListRow>(sql`
      SELECT pl.id, pl.name, pl.currency, pl.segment, pl.account_id, a.name AS account_name, pl.valid_from::text, pl.valid_to::text, pl.active, pl.version,
        (SELECT count(DISTINCT i.product_id)::int FROM price_list_items i WHERE i.price_list_id = pl.id) AS product_count
      FROM price_lists pl LEFT JOIN accounts a ON a.id = pl.account_id
      WHERE ${await visiblePriceLists(tx, t)} ${id ? sql`AND pl.id = ${id}` : sql``}
      ORDER BY pl.active DESC, lower(pl.name), pl.id LIMIT 1000`)).rows;
  }

  private async priceList(tx: Db, t: TenantRequestContext, id: string): Promise<PriceListRow> {
    const [row] = await this.priceLists(tx, t, id);
    if (!row) throw new ProblemError('NOT_FOUND');
    return row;
  }

  async listPriceLists(t: TenantRequestContext) {
    authorize(t, 'catalog.price_list.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.priceLists(tx, t)).map(listView) }));
  }

  async createPriceList(t: TenantRequestContext, body: z.infer<typeof PriceListCreate>, ip: string) {
    authorize(t, 'catalog.price_list.manage');
    if (body.segment) this.assertSegments(t, [body.segment]);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      if (body.accountId) {
        await readCrmRow(tx, t, CRM.account, body.accountId).catch((e: unknown) => {
          throw e instanceof ProblemError && e.code === 'NOT_FOUND' ? new ProblemError('RELATED_NOT_FOUND') : e;
        });
      }
      try {
        const r = await tx.execute<{ id: string }>(sql`
          INSERT INTO price_lists (tenant_id, name, currency, segment, account_id, valid_from, valid_to, active, created_by)
          VALUES (${t.tenant.id}, ${body.name}, ${body.currency}, ${body.segment ?? null}, ${body.accountId ?? null}, ${body.validFrom ?? null}, ${body.validTo ?? null},
            ${body.active ?? true}, ${t.principal.userId}) RETURNING id`);
        const id = r.rows[0]?.id ?? '';
        await audit(tx, t.tenant.id, { action: 'price_list.created', actorId: t.principal.userId, targetType: 'price_list', targetId: id, ip, details: { currency: body.currency, segment: body.segment ?? null, accountId: body.accountId ?? null } });
        return listView(await this.priceList(tx, t, id));
      } catch (e) {
        return mapDbError(e);
      }
    });
  }

  async patchPriceList(t: TenantRequestContext, id: string, version: number, body: z.infer<typeof PriceListPatch>, ip: string) {
    authorize(t, 'catalog.price_list.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.priceList(tx, t, id);
      await this.lock(tx, 'price_lists', id, version);
      const sets: SQL[] = [sql`version = version + 1`];
      if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
      if (body.validFrom !== undefined) sets.push(sql`valid_from = ${body.validFrom}`);
      if (body.validTo !== undefined) sets.push(sql`valid_to = ${body.validTo}`);
      if (body.active !== undefined) sets.push(sql`active = ${body.active}`);
      try {
        await tx.execute(sql`UPDATE price_lists SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
      } catch (e) {
        mapDbError(e);
      }
      await audit(tx, t.tenant.id, { action: 'price_list.updated', actorId: t.principal.userId, targetType: 'price_list', targetId: id, ip, details: body });
      return listView(await this.priceList(tx, t, id));
    });
  }

  async listItems(t: TenantRequestContext, id: string, q: z.infer<typeof PriceListItemsQuery>) {
    authorize(t, 'catalog.price_list.manage', 'read');
    const fingerprint = `price-items:${t.tenant.id}:${id}`;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const list = await this.priceList(tx, t, id);
      const after = q.cursor ? (this.cursors.decode(q.cursor, fingerprint) as [string, string]) : null;
      const rows = (await tx.execute<{ id: string; sku: string; name: string; sort_name: string; breaks: { minQty: string; unitPrice: string; margin: string | null }[] }>(sql`
        SELECT p.id, p.sku, p.name, lower(p.name) AS sort_name,
          jsonb_agg(jsonb_build_object('minQty', trim_scale(i.min_qty)::text, 'unitPrice', i.unit_price::text,
            'margin', CASE WHEN p.cost_currency = ${list.currency} AND i.unit_price > 0 THEN round((i.unit_price - p.unit_cost) * 100 / i.unit_price, 2)::text END) ORDER BY i.min_qty) AS breaks
        FROM price_list_items i JOIN products p ON p.id = i.product_id
        WHERE i.price_list_id = ${id} ${after ? sql`AND (lower(p.name), p.id) > (${after[0]}, ${after[1]}::uuid)` : sql``}
        GROUP BY p.id, p.sku, p.name ORDER BY lower(p.name), p.id LIMIT ${q.limit + 1}`)).rows;
      const cost = this.seesCost(t);
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      const hasMore = rows.length > q.limit;
      return {
        data: page.map((r) => ({
          productId: r.id, sku: r.sku, productName: r.name,
          breaks: r.breaks.map((b) => ({ minQty: b.minQty, unitPrice: b.unitPrice, ...(cost ? { marginPercent: b.margin } : {}) })),
        })),
        page: { hasMore, nextCursor: hasMore && last ? this.cursors.encode([last.sort_name, last.id], fingerprint) : null },
      };
    });
  }

  /** Replaces a product's prices in a list (empty = the product leaves the list). */
  async setItem(t: TenantRequestContext, id: string, productId: string, body: z.infer<typeof PriceListItemSet>, ip: string) {
    authorize(t, 'catalog.price_list.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.priceList(tx, t, id);
      await this.product(tx, productId);
      // Serializes writers of the same list.
      await tx.execute(sql`UPDATE price_lists SET version = version + 1 WHERE id = ${id}`);
      await tx.execute(sql`DELETE FROM price_list_items WHERE price_list_id = ${id} AND product_id = ${productId}`);
      for (const b of body.breaks) {
        await tx.execute(sql`INSERT INTO price_list_items (tenant_id, price_list_id, product_id, min_qty, unit_price) VALUES (${t.tenant.id}, ${id}, ${productId}, ${b.minQty}::numeric, ${b.unitPrice}::numeric)`);
      }
      await audit(tx, t.tenant.id, { action: 'price_list.prices_set', actorId: t.principal.userId, targetType: 'price_list', targetId: id, ip, details: { productId, breaks: body.breaks } });
    });
  }

  // ------------------------------------------------------------------ exchange rates
  async listFx(t: TenantRequestContext) {
    authorize(t, 'catalog.price_list.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => ({
      data: (await tx.execute<{ base: string; quote: string; validOn: string; rate: string }>(sql`
        SELECT base, quote, valid_on::text AS "validOn", trim_scale(rate)::text AS rate FROM fx_rates ORDER BY valid_on DESC, base, quote LIMIT 500`)).rows,
    }));
  }

  async setFx(t: TenantRequestContext, body: z.infer<typeof FxRate>, ip: string) {
    authorize(t, 'catalog.price_list.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`INSERT INTO fx_rates (tenant_id, base, quote, valid_on, rate) VALUES (${t.tenant.id}, ${body.base}, ${body.quote}, ${body.validOn}, ${body.rate}::numeric)
        ON CONFLICT (tenant_id, base, quote, valid_on) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()`);
      await audit(tx, t.tenant.id, { action: 'fx_rate.set', actorId: t.principal.userId, targetType: 'fx_rate', ip, details: body });
    });
  }

  async removeFx(t: TenantRequestContext, key: z.infer<typeof FxRateKey>, ip: string): Promise<void> {
    authorize(t, 'catalog.price_list.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`DELETE FROM fx_rates WHERE base = ${key.base} AND quote = ${key.quote} AND valid_on = ${key.validOn}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'fx_rate.removed', actorId: t.principal.userId, targetType: 'fx_rate', ip, details: key });
    });
  }
}

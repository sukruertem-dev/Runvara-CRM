import { Inject, Injectable } from '@nestjs/common';
import type { PriceResolveRequest, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { authorize } from '../../common/authorize';
import { ProblemError } from '../../common/problem';
import { uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { CRM, readCrmRow } from '../crm/crm-objects';
import { visiblePriceLists } from './catalog.service';

// Which price applies (docs/p8-plan.md §3): customer list → segment list → general list; within a level the
// requested currency first, then the newest start date, then the newest list; the highest quantity break that
// the quantity reaches. Other currencies are converted with the latest rate on or before the date.

type Candidate = {
  ord: number; list_id: string; list_name: string; source: 'account' | 'segment' | 'general'; min_qty: string; list_unit_price: string; list_currency: string;
  fx: string | null; unit_price: string | null;
};
type Resolved = {
  productId: string; quantity: string; reason: 'no_price' | 'no_rate' | 'inactive' | null;
  price: null | { unitPrice: string; currency: string; priceListId: string; priceListName: string; source: Candidate['source']; minQty: string; listUnitPrice: string; listCurrency: string; fxRate: string | null };
};

@Injectable()
export class PricingService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async resolve(t: TenantRequestContext, body: z.infer<typeof PriceResolveRequest>) {
    authorize(t, 'catalog.price_list.manage', 'read');
    if (!t.segments.includes(body.segment)) throw new ProblemError('SEGMENT_NOT_ALLOWED');
    return this.db.withTenant(dbCtx(t), (tx) => this.resolveTx(tx, t, body));
  }

  async resolveTx(tx: Db, t: TenantRequestContext, body: z.infer<typeof PriceResolveRequest>) {
    if (body.accountId) await readCrmRow(tx, t, CRM.account, body.accountId);
    const currency = body.currency ?? t.tenant.currency;
    const date = body.date ?? (await tx.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${t.tenant.timezone})::date::text AS d`)).rows[0]?.d ?? '';
    const known = new Map(
      (await tx.execute<{ id: string; active: boolean; sells: boolean }>(sql`
        SELECT id, active, ${body.segment}::segment = ANY (segments) AS sells FROM products WHERE id = ANY(${uuidArray([...new Set(body.items.map((i) => i.productId))])})`)).rows.map((r) => [r.id, r]),
    );
    // Unknown, invisible and other-segment products are the same answer: they do not exist for this caller.
    if (body.items.some((i) => known.get(i.productId)?.sells !== true)) throw new ProblemError('NOT_FOUND');

    const visible = await visiblePriceLists(tx, t);
    const lines = JSON.stringify(body.items.map((i, ord) => ({ ord, product_id: i.productId, qty: i.quantity })));
    const rows = (await tx.execute<Candidate>(sql`
      WITH line AS (SELECT * FROM jsonb_to_recordset(${lines}::jsonb) AS l(ord int, product_id uuid, qty numeric)),
      cand AS (
        SELECT line.ord, pl.id AS list_id, pl.name AS list_name, pl.currency AS list_currency, pl.valid_from,
          CASE WHEN pl.account_id IS NOT NULL THEN 1 WHEN pl.segment IS NOT NULL THEN 2 ELSE 3 END AS level, i.min_qty, i.unit_price
        FROM line
        JOIN price_lists pl ON pl.active
          AND (pl.valid_from IS NULL OR pl.valid_from <= ${date}::date) AND (pl.valid_to IS NULL OR pl.valid_to >= ${date}::date)
          AND (pl.segment IS NULL OR pl.segment = ${body.segment}::segment)
          AND (pl.account_id IS NULL OR pl.account_id = ${body.accountId}::uuid)
        JOIN LATERAL (
          SELECT x.min_qty, x.unit_price FROM price_list_items x
          WHERE x.price_list_id = pl.id AND x.product_id = line.product_id AND x.min_qty <= line.qty ORDER BY x.min_qty DESC LIMIT 1) i ON true
        WHERE ${visible}
      )
      SELECT c.ord, c.list_id, c.list_name, CASE c.level WHEN 1 THEN 'account' WHEN 2 THEN 'segment' ELSE 'general' END AS source,
        trim_scale(c.min_qty)::text AS min_qty, c.unit_price::text AS list_unit_price, c.list_currency,
        trim_scale(round(fx.rate, 8))::text AS fx, round(c.unit_price * fx.rate, 4)::text AS unit_price
      FROM cand c
      LEFT JOIN LATERAL (
        SELECT 1::numeric AS rate, NULL::date AS valid_on, 0 AS inverse WHERE c.list_currency = ${currency}
        UNION ALL SELECT f.rate, f.valid_on, 0 FROM fx_rates f WHERE f.base = c.list_currency AND f.quote = ${currency} AND f.valid_on <= ${date}::date
        UNION ALL SELECT 1 / f.rate, f.valid_on, 1 FROM fx_rates f WHERE f.base = ${currency} AND f.quote = c.list_currency AND f.valid_on <= ${date}::date
        ORDER BY inverse, valid_on DESC LIMIT 1) fx ON true
      ORDER BY c.ord, c.level, (c.list_currency = ${currency}) DESC, c.valid_from DESC NULLS LAST, c.list_id DESC`)).rows;

    const data: Resolved[] = body.items.map((item, ord) => {
      const base = { productId: item.productId, quantity: item.quantity };
      if (!known.get(item.productId)?.active) return { ...base, price: null, reason: 'inactive' };
      const mine = rows.filter((r) => r.ord === ord);
      const hit = mine.find((r) => r.unit_price !== null);
      if (!hit || hit.unit_price === null) return { ...base, price: null, reason: mine.length > 0 ? 'no_rate' : 'no_price' };
      return {
        ...base,
        reason: null,
        price: {
          unitPrice: hit.unit_price, currency, priceListId: hit.list_id, priceListName: hit.list_name, source: hit.source, minQty: hit.min_qty,
          listUnitPrice: hit.list_unit_price, listCurrency: hit.list_currency, fxRate: hit.list_currency === currency ? null : hit.fx,
        },
      };
    });
    return { data, currency, date };
  }
}

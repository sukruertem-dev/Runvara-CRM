import { z } from 'zod';
import { Uuid } from './schemas';

// P8a product catalogue and prices (docs/p8-plan.md §1–3). Amounts are decimal strings, never floats.

const Segment = z.enum(['b2b', 'b2c']);
const Segments = z.array(Segment).min(1).max(2).transform((v) => [...new Set(v)]);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
const Amount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).openapi({ example: '125.5000' });
const Quantity = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/).refine((v) => Number(v) > 0, 'must be greater than zero').openapi({ example: '1' });
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/).refine((v) => Number(v) <= 100, 'must be 100 or less').openapi({ example: '20' });
const Page = z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() });
const notEmpty = (v: object): boolean => Object.keys(v).length > 0;

// ------------------------------------------------------------------ tax rates
const taxWritable = { name: z.string().trim().min(1).max(80), rate: Percent, active: z.boolean() };
export const TaxRateCreate = z.object(taxWritable).partial({ active: true }).strict().openapi('TaxRateCreate');
export const TaxRatePatch = z.object(taxWritable).partial().strict().refine(notEmpty, 'empty patch').openapi('TaxRatePatch');
export const TaxRateView = z.object({ id: Uuid, name: z.string(), rate: z.string(), active: z.boolean(), version: z.number().int() }).openapi('TaxRateView');
export const TaxRateListResponse = z.object({ data: z.array(TaxRateView) }).openapi('TaxRateListResponse');

// ------------------------------------------------------------------ products
const productWritable = {
  sku: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  category: z.string().trim().min(1).max(80).nullable(),
  unit: z.string().trim().min(1).max(20),
  taxRateId: Uuid.nullable(),
  segments: Segments,
  /** Needs `fields.cost_margin.read`; null clears the cost. */
  cost: z.object({ amount: Amount, currency: CurrencyCode }).strict().nullable(),
  active: z.boolean(),
};
export const ProductCreate = z
  .object(productWritable)
  .partial({ description: true, category: true, unit: true, taxRateId: true, cost: true, active: true })
  .strict()
  .openapi('ProductCreate');
export const ProductPatch = z.object(productWritable).partial().strict().refine(notEmpty, 'empty patch').openapi('ProductPatch');
export const ProductView = z
  .object({
    id: Uuid,
    sku: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.string().nullable(),
    unit: z.string(),
    taxRateId: Uuid.nullable(),
    segments: z.array(Segment),
    /** Absent without `fields.cost_margin.read`. */
    cost: z.object({ amount: z.string(), currency: z.string() }).nullable().optional(),
    active: z.boolean(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('ProductView');
export const ProductListResponse = z.object({ data: z.array(ProductView), page: Page }).openapi('ProductListResponse');
export const ProductListQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    active: z.enum(['true', 'false', 'all']).default('true'),
    cursor: z.string().max(1000).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

// ------------------------------------------------------------------ price lists
const listWritable = {
  name: z.string().trim().min(1).max(120),
  validFrom: z.iso.date().nullable(),
  validTo: z.iso.date().nullable(),
  active: z.boolean(),
};
/** Currency, segment and customer decide what the prices mean: fixed at creation. */
export const PriceListCreate = z
  .object({ ...listWritable, currency: CurrencyCode, segment: Segment.nullable(), accountId: Uuid.nullable() })
  .partial({ validFrom: true, validTo: true, active: true, segment: true, accountId: true })
  .strict()
  .openapi('PriceListCreate');
export const PriceListPatch = z.object(listWritable).partial().strict().refine(notEmpty, 'empty patch').openapi('PriceListPatch');
export const PriceListView = z
  .object({
    id: Uuid,
    name: z.string(),
    currency: z.string(),
    segment: Segment.nullable(),
    account: z.object({ id: Uuid, name: z.string() }).nullable(),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    active: z.boolean(),
    productCount: z.number().int(),
    version: z.number().int(),
  })
  .openapi('PriceListView');
export const PriceListListResponse = z.object({ data: z.array(PriceListView) }).openapi('PriceListListResponse');

export const PriceBreak = z.object({ minQty: Quantity, unitPrice: Amount }).strict();
export const PriceListItemSet = z
  .object({ breaks: z.array(PriceBreak).max(20) })
  .strict()
  .refine((v) => new Set(v.breaks.map((b) => Number(b.minQty))).size === v.breaks.length, 'duplicate minimum quantity')
  .openapi('PriceListItemSet');
export const PriceListItemView = z
  .object({
    productId: Uuid,
    sku: z.string(),
    productName: z.string(),
    breaks: z.array(
      z.object({
        minQty: z.string(),
        unitPrice: z.string(),
        /** (price − cost) / price in percent; null when unknown, absent without `fields.cost_margin.read`. */
        marginPercent: z.string().nullable().optional(),
      }),
    ),
  })
  .openapi('PriceListItemView');
export const PriceListItemsResponse = z.object({ data: z.array(PriceListItemView), page: Page }).openapi('PriceListItemsResponse');
export const PriceListItemsQuery = z.object({ cursor: z.string().max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

// ------------------------------------------------------------------ exchange rates
export const FxRate = z
  .object({
    base: CurrencyCode,
    quote: CurrencyCode,
    validOn: z.iso.date(),
    rate: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/).refine((v) => Number(v) > 0, 'must be greater than zero'),
  })
  .strict()
  .refine((v) => v.base !== v.quote, 'base and quote must differ')
  .openapi('FxRate');
export const FxRateListResponse = z.object({ data: z.array(z.object({ base: z.string(), quote: z.string(), validOn: z.string(), rate: z.string() })) }).openapi('FxRateListResponse');
export const FxRateKey = z.object({ base: CurrencyCode, quote: CurrencyCode, validOn: z.iso.date() }).strict();

// ------------------------------------------------------------------ price resolution
export const PriceResolveRequest = z
  .object({
    items: z.array(z.object({ productId: Uuid, quantity: Quantity.default('1') }).strict()).min(1).max(200),
    segment: Segment,
    accountId: Uuid.nullable().default(null),
    /** Defaults to the workspace currency and today (workspace time zone). */
    currency: CurrencyCode.optional(),
    date: z.iso.date().optional(),
  })
  .strict()
  .openapi('PriceResolveRequest');
export const ResolvedPrice = z
  .object({
    productId: Uuid,
    quantity: z.string(),
    price: z
      .object({
        unitPrice: z.string(),
        currency: z.string(),
        priceListId: Uuid,
        priceListName: z.string(),
        source: z.enum(['account', 'segment', 'general']),
        minQty: z.string(),
        listUnitPrice: z.string(),
        listCurrency: z.string(),
        /** Present when the list's currency was converted. */
        fxRate: z.string().nullable(),
      })
      .nullable(),
    reason: z.enum(['no_price', 'no_rate', 'inactive']).nullable(),
  })
  .openapi('ResolvedPrice');
export const PriceResolveResponse = z.object({ data: z.array(ResolvedPrice), currency: z.string(), date: z.string() }).openapi('PriceResolveResponse');

// ------------------------------------------------------------------ primary team (docs/p8-plan.md §4)
export const PrimaryTeamSet = z.object({ teamId: Uuid }).strict().openapi('PrimaryTeamSet');

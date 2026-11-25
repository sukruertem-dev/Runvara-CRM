import { z } from 'zod';
import { CurrencyCode } from './catalog';
import { Uuid } from './schemas';

// P9a quotes (docs/p9-plan.md §1–6, ADR-0021). Amounts are decimal strings, never floats.

const Amount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const Quantity = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/).refine((v) => Number(v) > 0, 'must be greater than zero');
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,3})?$/).refine((v) => Number(v) <= 100, 'must be 100 or less');
const Person = z.object({ id: Uuid, displayName: z.string() });
export const QuoteStatus = z.enum(['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired']);

export const QuoteCreate = z.object({ opportunityId: Uuid, currency: CurrencyCode.optional() }).strict().openapi('QuoteCreate');
export const QuoteLineInput = z
  .object({
    productId: Uuid,
    quantity: Quantity,
    /** Left out: the catalogue's price. */
    unitPrice: Amount.optional(),
    discountPercent: Percent.default('0'),
    description: z.string().trim().max(1000).default(''),
  })
  .strict();
export const QuoteDraft = z
  .object({
    discountPercent: Percent.default('0'),
    validUntil: z.iso.date(),
    intro: z.string().max(4000).default(''),
    terms: z.string().max(8000).default(''),
    lines: z.array(QuoteLineInput).max(200),
  })
  .strict()
  .openapi('QuoteDraft');
export const QuoteSubmit = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict().openapi('QuoteSubmit');
export const QuoteSend = z
  .object({ to: z.array(z.email().max(254)).min(1).max(5), message: z.string().trim().max(2000).default('') })
  .strict()
  .openapi('QuoteSend');
export const QuoteOutcome = z.object({ outcome: z.enum(['accepted', 'rejected']), reason: z.string().trim().min(1).max(500).optional() }).strict().openapi('QuoteOutcome');
/** Internal note (never part of the document); mentions are allowed. */
export const QuoteNote = z.object({ note: z.unknown().nullable() }).strict().openapi('QuoteNote');
export const QuoteListQuery = z
  .object({ opportunityId: Uuid.optional(), status: QuoteStatus.optional(), cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

const Totals = z.object({ subtotal: z.string(), discount: z.string(), net: z.string(), tax: z.string(), total: z.string() });
export const QuoteSummary = z
  .object({
    id: Uuid,
    number: z.string(),
    opportunity: z.object({ id: Uuid, name: z.string() }),
    status: QuoteStatus,
    currency: z.string(),
    currentVersion: z.number().int(),
    total: z.string(),
    validUntil: z.string(),
    createdBy: Person,
    createdAt: z.string(),
    version: z.number().int(),
  })
  .openapi('QuoteSummary');
export const QuoteListResponse = z.object({ data: z.array(QuoteSummary), nextCursor: Uuid.nullable() }).openapi('QuoteListResponse');
export const QuoteVersionView = z
  .object({
    version: z.number().int(),
    discountPercent: z.string(),
    validUntil: z.string(),
    intro: z.string(),
    terms: z.string(),
    customer: z.object({ account: z.string().nullable(), contact: z.string().nullable() }),
    totals: Totals,
    taxes: z.array(z.object({ percent: z.string(), base: z.string(), tax: z.string() })),
    approvalPercent: z.string(),
    sentAt: z.string().nullable(),
    sentBy: Person.nullable(),
    sentTo: z.array(z.string()),
    createdAt: z.string(),
    lines: z.array(
      z.object({
        productId: Uuid,
        sku: z.string(),
        name: z.string(),
        unit: z.string(),
        description: z.string(),
        quantity: z.string(),
        listPrice: z.string().nullable(),
        unitPrice: z.string(),
        discountPercent: z.string(),
        taxPercent: z.string(),
        gross: z.string(),
        net: z.string(),
        tax: z.string(),
      }),
    ),
  })
  .openapi('QuoteVersionView');
export const QuoteView = QuoteSummary.extend({
  outcomeReason: z.string().nullable(),
  note: z.unknown().nullable(),
  content: QuoteVersionView,
  versions: z.array(z.object({ version: z.number().int(), total: z.string(), sentAt: z.string().nullable(), createdAt: z.string() })),
  /** What the caller may do now (the API checks again). */
  canEdit: z.boolean(),
}).openapi('QuoteView');

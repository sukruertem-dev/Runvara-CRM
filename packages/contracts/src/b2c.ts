import { z } from 'zod';
import { Uuid } from './schemas';

// P9d: B2C customer profile, addresses and channel consent (docs/p9-plan.md §22–28).

export const ConsentChannel = z.enum(['email', 'sms', 'phone', 'whatsapp']);
export const ConsentStatus = z.enum(['granted', 'withdrawn']);
export const ConsentSource = z.enum(['web_form', 'phone', 'store', 'email', 'import', 'api', 'other']);
const Person = z.object({ id: Uuid, displayName: z.string() });
const Tag = z.string().trim().min(1).max(40).regex(/^[^,]+$/, 'no commas');

// ------------------------------------------------------------------ profile
export const CustomerProfilePut = z
  .object({
    preferredChannel: ConsentChannel.nullable(),
    language: z.enum(['tr', 'en']).nullable(),
    tags: z.array(Tag).max(20),
  })
  .strict()
  .openapi('CustomerProfilePut');

export const CustomerAddressInput = z
  .object({
    label: z.string().trim().max(40).default(''),
    recipient: z.string().trim().max(200).default(''),
    line1: z.string().trim().min(1).max(300),
    line2: z.string().trim().max(300).default(''),
    district: z.string().trim().max(120).default(''),
    city: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().max(20).default(''),
    country: z.string().regex(/^[A-Z]{2}$/).default('TR'),
    isDefault: z.boolean().default(false),
  })
  .strict()
  .openapi('CustomerAddressInput');
export const CustomerAddressView = z
  .object({
    id: Uuid, label: z.string(), recipient: z.string(), line1: z.string(), line2: z.string(), district: z.string(), city: z.string(),
    postalCode: z.string(), country: z.string(), isDefault: z.boolean(),
  })
  .openapi('CustomerAddressView');

// ------------------------------------------------------------------ consent
export const ConsentSet = z
  .object({
    channel: ConsentChannel,
    status: ConsentStatus,
    source: ConsentSource,
    /** What shows the customer's choice (form name, call note, signed paper). */
    evidence: z.string().trim().max(500).default(''),
    externalRef: z.string().trim().min(1).max(200).nullable().default(null),
    /** When the customer gave or withdrew it; defaults to now, never in the future. */
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .openapi('ConsentSet');
export const ConsentView = z
  .object({
    channel: ConsentChannel, status: ConsentStatus, source: ConsentSource, evidence: z.string(), externalRef: z.string().nullable(),
    occurredAt: z.string(), recordedBy: Person.nullable(), recordedAt: z.string(),
  })
  .openapi('ConsentView');
export const ConsentEventView = ConsentView.extend({ id: Uuid }).openapi('ConsentEventView');
export const ConsentHistoryResponse = z.object({ data: z.array(ConsentEventView), nextCursor: Uuid.nullable() }).openapi('ConsentHistoryResponse');
export const ConsentHistoryQuery = z.object({ cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

/** May the customer be contacted on a channel now? The single check for campaigns, automations and outbound calls. */
export const ReachabilityQuery = z.object({ channel: ConsentChannel }).strict();
export const ReachabilityView = z
  .object({
    channel: ConsentChannel,
    allowed: z.boolean(),
    /** Why not: no B2C customer, no consent on record, consent withdrawn, channel turned off, no address to reach. */
    reason: z.enum(['not_b2c', 'no_consent', 'withdrawn', 'channel_disabled', 'no_contact_point']).nullable(),
    consent: ConsentView.nullable(),
  })
  .openapi('ReachabilityView');

// ------------------------------------------------------------------ the customer
export const CustomerView = z
  .object({
    id: Uuid,
    fullName: z.string(),
    owner: Person,
    preferredChannel: ConsentChannel.nullable(),
    language: z.enum(['tr', 'en']).nullable(),
    tags: z.array(z.string()),
    addresses: z.array(CustomerAddressView),
    /** One entry per enabled channel; `null` status = nothing on record. */
    consents: z.array(z.object({ channel: ConsentChannel, consent: ConsentView.nullable() })),
    canEdit: z.boolean(),
    canManageConsent: z.boolean(),
    version: z.number().int(),
  })
  .openapi('CustomerView');
export const CustomerListQuery = z
  .object({
    q: z.string().trim().max(200).optional(),
    tag: Tag.optional(),
    /** Only customers who may be reached on this channel. */
    reachable: ConsentChannel.optional(),
    cursor: Uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const CustomerSummary = z
  .object({
    id: Uuid, fullName: z.string(), owner: Person, email: z.string().nullable(), phone: z.string().nullable(), tags: z.array(z.string()),
    granted: z.array(ConsentChannel),
  })
  .openapi('CustomerSummary');
export const CustomerListResponse = z.object({ data: z.array(CustomerSummary), nextCursor: Uuid.nullable() }).openapi('CustomerListResponse');

// ------------------------------------------------------------------ B2C orders (P9e, docs/p9-plan.md §30–33)
export const B2cChannel = z.enum(['web', 'store', 'phone', 'social']);
export const B2cOrderStatus = z.enum(['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned']);
export const B2cOrderStepKey = z.enum(['confirm', 'prepare', 'ship', 'deliver', 'cancel']);
export const PaymentStatus = z.enum(['pending', 'paid', 'failed', 'refunded', 'partially_refunded']);
const Qty = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/).refine((v) => Number(v) > 0, 'must be greater than zero');
const Money = z.string();

export const B2cOrderCreate = z
  .object({
    customerId: Uuid,
    channel: B2cChannel,
    /** Defaults to the workspace currency. */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    lines: z.array(z.object({ productId: Uuid, quantity: Qty }).strict()).min(1).max(100),
    /** One of the customer's addresses, copied onto the order. */
    shippingAddressId: Uuid.nullable().default(null),
    paymentStatus: PaymentStatus.default('pending'),
    note: z.string().trim().max(4000).default(''),
  })
  .strict()
  .openapi('B2cOrderCreate');
export const B2cOrderStepRequest = z
  .object({
    step: B2cOrderStepKey,
    /** Required to cancel. */
    note: z.string().trim().max(500).default(''),
    carrier: z.string().trim().min(1).max(80).optional(),
    trackingNumber: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => v.step !== 'cancel' || v.note.length > 0, { message: 'a cancellation needs a reason', path: ['note'] })
  .openapi('B2cOrderStepRequest');
export const B2cOrderBulkStep = z
  .object({ ids: z.array(Uuid).min(1).max(100), step: B2cOrderStepKey, note: z.string().trim().max(500).default('') })
  .strict()
  .refine((v) => v.step !== 'cancel' || v.note.length > 0, { message: 'a cancellation needs a reason', path: ['note'] })
  .openapi('B2cOrderBulkStep');
export const B2cOrderBulkResult = z.object({ data: z.array(z.object({ id: Uuid, ok: z.boolean(), code: z.string().nullable() })) }).openapi('B2cOrderBulkResult');
export const B2cOrderPayment = z.object({ status: PaymentStatus, note: z.string().trim().max(500).default('') }).strict().openapi('B2cOrderPayment');
export const B2cOrderListQuery = z
  .object({
    status: B2cOrderStatus.optional(), channel: B2cChannel.optional(), customerId: Uuid.optional(),
    /** Order number, or part of it. */
    q: z.string().trim().max(40).optional(),
    cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const ReturnReason = z.enum(['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other']);
export const ReturnStatus = z.enum(['requested', 'approved', 'rejected', 'cancelled']);
export const ReturnSummary = z
  .object({
    id: Uuid, number: z.string(), order: z.object({ id: Uuid, number: z.string() }), customer: z.object({ id: Uuid, fullName: z.string() }),
    reasonCode: ReturnReason, amount: Money, currency: z.string(), status: ReturnStatus, requestedBy: Person, createdAt: z.string(),
  })
  .openapi('ReturnSummary');

export const B2cOrderSummary = z
  .object({
    id: Uuid, number: z.string(), customer: z.object({ id: Uuid, fullName: z.string() }), channel: B2cChannel, status: B2cOrderStatus,
    paymentStatus: PaymentStatus, currency: z.string(), total: Money, createdAt: z.string(),
  })
  .openapi('B2cOrderSummary');
export const B2cOrderView = B2cOrderSummary.extend({
  deliveryStatus: z.enum(['pending', 'preparing', 'shipped', 'delivered', 'none']),
  totals: z.object({ net: Money, tax: Money, total: Money }),
  lines: z.array(z.object({
    id: Uuid, productId: Uuid, sku: z.string(), name: z.string(), unit: z.string(), quantity: z.string(), unitPrice: z.string(), taxPercent: z.string(),
    net: Money, tax: Money, total: Money,
    /** Already in an approved or pending return. */
    returnedQuantity: z.string(),
  })),
  shippingAddress: CustomerAddressView.omit({ id: true, isDefault: true }).nullable(),
  carrier: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  note: z.string(),
  history: z.array(z.object({ kind: z.enum(['status', 'payment']), from: z.string().nullable(), to: z.string(), note: z.string(), actor: Person.nullable(), at: z.string() })),
  returns: z.array(ReturnSummary),
  /** Steps the caller may take now. */
  steps: z.array(B2cOrderStepKey),
  canPay: z.boolean(),
  canRequestReturn: z.boolean(),
  createdBy: Person,
  version: z.number().int(),
}).openapi('B2cOrderView');
export const B2cOrderListResponse = z.object({ data: z.array(B2cOrderSummary), nextCursor: Uuid.nullable() }).openapi('B2cOrderListResponse');

// ------------------------------------------------------------------ returns (B2C-05)
export const ReturnCreate = z
  .object({
    orderId: Uuid,
    reasonCode: ReturnReason,
    reason: z.string().trim().max(500).default(''),
    lines: z.array(z.object({ orderLineId: Uuid, quantity: Qty }).strict()).min(1).max(100),
  })
  .strict()
  .openapi('ReturnCreate');
export const ReturnDecision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).default('') }).strict().openapi('ReturnDecision');
export const ReturnView = ReturnSummary.extend({
  reason: z.string(),
  lines: z.array(z.object({ orderLineId: Uuid, name: z.string(), quantity: z.string(), amount: Money })),
  decidedBy: Person.nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  canDecide: z.boolean(),
  canCancel: z.boolean(),
}).openapi('ReturnView');
export const ReturnListQuery = z
  .object({ status: ReturnStatus.optional(), orderId: Uuid.optional(), cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
export const ReturnListResponse = z.object({ data: z.array(ReturnSummary), nextCursor: Uuid.nullable() }).openapi('ReturnListResponse');

// ------------------------------------------------------------------ KVKK (data subject requests)
export const CustomerExport = z.record(z.string(), z.unknown()).openapi('CustomerExport');
export const CustomerAnonymize = z
  .object({ /** The customer's full name, typed again: the step cannot be undone. */ confirmName: z.string().trim().min(1).max(300) })
  .strict()
  .openapi('CustomerAnonymize');

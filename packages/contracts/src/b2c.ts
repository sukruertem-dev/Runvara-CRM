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

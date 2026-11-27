import { z } from 'zod';
import { Uuid } from './schemas';

// P9b: sales pipelines, contracts, B2B orders (docs/p9-plan.md §8–13).

const Segment = z.enum(['b2b', 'b2c']);
const Person = z.object({ id: Uuid, displayName: z.string() });
const Probability = z.number().min(0).max(100);
const Amount = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);

// ------------------------------------------------------------------ pipelines
export const PipelineCreated = z.object({ id: Uuid }).openapi('PipelineCreated');
export const PipelineCreate = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
    name: z.string().trim().min(1).max(120),
    segment: Segment.nullable(),
    /** An opportunity workflow; its stages become the pipeline's stages. */
    workflowId: Uuid,
  })
  .strict()
  .openapi('PipelineCreate');
export const PipelinePatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    isDefault: z.literal(true),
    stages: z.array(z.object({ statusId: Uuid, probability: Probability }).strict()).min(1).max(30),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('PipelinePatch');

// ------------------------------------------------------------------ contracts
export const ContractStatus = z.enum(['active', 'ended', 'renewed', 'terminated']);
const contractTerms = {
  title: z.string().trim().min(1).max(300),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  value: Amount.nullable(),
  autoRenew: z.boolean(),
  renewalNoticeDays: z.number().int().min(0).max(365),
  note: z.string().max(4000),
};
const datesInOrder = (v: { startDate?: string | undefined; endDate?: string | undefined }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
export const ContractCreate = z
  .object({ opportunityId: Uuid, quoteId: Uuid.nullable().default(null), ...contractTerms })
  .partial({ value: true, autoRenew: true, renewalNoticeDays: true, note: true, title: true })
  .strict()
  .refine(datesInOrder, 'endDate is before startDate')
  .openapi('ContractCreate');
export const ContractPatch = z
  .object(contractTerms)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .refine(datesInOrder, 'endDate is before startDate')
  .openapi('ContractPatch');
export const ContractTerminate = z.object({ on: z.iso.date(), reason: z.string().trim().min(1).max(500) }).strict().openapi('ContractTerminate');
/** The next term; left out, it is as long as the current one and starts the day after it ends. */
export const ContractRenew = z.object({ endDate: z.iso.date().optional(), value: Amount.nullable().optional() }).strict().openapi('ContractRenew');
export const ContractListQuery = z
  .object({ opportunityId: Uuid.optional(), status: ContractStatus.optional(), cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
export const ContractView = z
  .object({
    id: Uuid,
    number: z.string(),
    opportunity: z.object({ id: Uuid, name: z.string() }),
    account: z.object({ id: Uuid, name: z.string() }).nullable(),
    quote: z.object({ id: Uuid, number: z.string() }).nullable(),
    title: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    value: z.string().nullable(),
    currency: z.string(),
    autoRenew: z.boolean(),
    renewalNoticeDays: z.number().int(),
    /** When the renewal reminder is (or was) due. */
    renewalDueOn: z.string(),
    status: ContractStatus,
    terminatedOn: z.string().nullable(),
    terminationReason: z.string().nullable(),
    renewedFrom: z.object({ id: Uuid, number: z.string() }).nullable(),
    renewedBy: z.object({ id: Uuid, number: z.string() }).nullable(),
    remindedAt: z.string().nullable(),
    note: z.string(),
    createdBy: Person,
    createdAt: z.string(),
    canEdit: z.boolean(),
    version: z.number().int(),
  })
  .openapi('ContractView');
export const ContractListResponse = z.object({ data: z.array(ContractView), nextCursor: Uuid.nullable() }).openapi('ContractListResponse');

// ------------------------------------------------------------------ orders (B2B)
export const OrderStatus = z.enum(['open', 'fulfilled', 'cancelled']);
export const OrderCreate = z.object({ quoteId: Uuid, contractId: Uuid.nullable().default(null), note: z.string().max(4000).default('') }).strict().openapi('OrderCreate');
export const OrderStatusSet = z
  .object({ status: z.enum(['fulfilled', 'cancelled']), reason: z.string().trim().min(1).max(500).optional() })
  .strict()
  .refine((v) => v.status !== 'cancelled' || v.reason !== undefined, 'a cancellation needs a reason')
  .openapi('OrderStatusSet');
export const OrderListQuery = z
  .object({ opportunityId: Uuid.optional(), status: OrderStatus.optional(), cursor: Uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
export const OrderView = z
  .object({
    id: Uuid,
    number: z.string(),
    segment: Segment,
    opportunity: z.object({ id: Uuid, name: z.string() }).nullable(),
    quote: z.object({ id: Uuid, number: z.string(), version: z.number().int() }).nullable(),
    contract: z.object({ id: Uuid, number: z.string() }).nullable(),
    currency: z.string(),
    status: OrderStatus,
    statusReason: z.string().nullable(),
    totals: z.object({ subtotal: z.string(), discount: z.string(), net: z.string(), tax: z.string(), total: z.string() }),
    lines: z.array(z.object({ productId: Uuid, sku: z.string(), name: z.string(), unit: z.string(), quantity: z.string(), unitPrice: z.string(), discountPercent: z.string(), taxPercent: z.string(), net: z.string(), tax: z.string() })),
    note: z.string(),
    createdBy: Person,
    createdAt: z.string(),
    canEdit: z.boolean(),
    version: z.number().int(),
  })
  .openapi('OrderView');
export const OrderListResponse = z.object({ data: z.array(OrderView.omit({ lines: true })), nextCursor: Uuid.nullable() }).openapi('OrderListResponse');

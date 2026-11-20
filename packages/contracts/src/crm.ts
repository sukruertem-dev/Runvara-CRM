import { z } from 'zod';
import { Uuid } from './schemas';
import { ProseMirrorDoc, StatusView } from './tasks';

// P3 CRM objects (docs/p3-plan.md). Money is a decimal string (never a float) with an ISO 4217 currency.

const Segment = z.enum(['b2b', 'b2c']);
const Segments = z.array(Segment).min(1).max(2).transform((v) => [...new Set(v)]);
const Key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);
const Custom = z.record(z.string().regex(/^cf_[a-z0-9_]{1,45}$/), z.unknown());
const Name = (max: number) => z.string().trim().max(max);
const Money = z
  .union([z.string().regex(/^\d{1,14}(\.\d{1,4})?$/), z.number().nonnegative().max(99_999_999_999_999)])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .openapi({ type: 'string', example: '125000.00' });
const Currency = z.string().regex(/^[A-Z]{3}$/);
const IsoDate = z.iso.date();
const Page = z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() });
const listOf = <T extends z.ZodType>(item: T, name: string) =>
  z.object({ data: z.array(item), page: Page, meta: z.object({ total: z.number().int() }).optional() }).openapi(name);

export const CrmRecordType = z.enum(['account', 'contact', 'lead', 'opportunity', 'case']);

// ------------------------------------------------------------------ contact points
export const ContactPointInput = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('email'), value: z.string().trim().toLowerCase().pipe(z.email().max(254)), label: z.string().max(40).optional(), isPrimary: z.boolean().default(false) }).strict(),
    z.object({ kind: z.literal('phone'), value: z.string().trim().min(3).max(40), label: z.string().max(40).optional(), isPrimary: z.boolean().default(false) }).strict(),
  ])
  .openapi('ContactPointInput');
export const ContactPointView = z
  .object({ id: Uuid, kind: z.enum(['email', 'phone']), value: z.string(), e164: z.string().nullable(), label: z.string().nullable(), isPrimary: z.boolean() })
  .openapi('ContactPointView');

const common = {
  description: ProseMirrorDoc.nullable(),
  descriptionText: z.string().max(100_000).nullable(),
  custom: Custom,
};
const meta = {
  version: z.number().int(),
  createdBy: Uuid.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
};

// ------------------------------------------------------------------ accounts
const accountWritable = {
  name: Name(300).min(1),
  domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/).max(253).nullable(),
  website: z.url().max(500).nullable(),
  industry: Name(120).nullable(),
  parentAccountId: Uuid.nullable(),
  segments: Segments,
  ownerUserId: Uuid,
  ...common,
};
export const AccountCreate = z
  .object({ ...accountWritable, contactPoints: z.array(ContactPointInput).max(20).optional() })
  .partial({ domain: true, website: true, industry: true, parentAccountId: true, segments: true, ownerUserId: true, description: true, descriptionText: true, custom: true })
  .strict()
  .openapi('AccountCreate');
export const AccountPatch = z.object(accountWritable).partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch').openapi('AccountPatch');
export const AccountView = z
  .object({
    id: Uuid, name: z.string(), domain: z.string().nullable(), website: z.string().nullable(), industry: z.string().nullable(),
    parentAccountId: Uuid.nullable(), segments: z.array(Segment), ownerUserId: Uuid, description: ProseMirrorDoc.nullable(),
    descriptionText: z.string().nullable(), custom: z.record(z.string(), z.unknown()), mergedInto: Uuid.nullable(),
    contactPoints: z.array(ContactPointView), ...meta,
  })
  .partial()
  .required({ id: true })
  .openapi('AccountView');
export const AccountListResponse = listOf(AccountView, 'AccountListResponse');

// ------------------------------------------------------------------ contacts
const AccountRole = z.enum(['decision_maker', 'influencer', 'user', 'approver', 'other']);
const contactWritable = {
  firstName: Name(120),
  lastName: Name(120),
  title: Name(120).nullable(),
  segments: Segments,
  ownerUserId: Uuid,
  ...common,
};
export const ContactCreate = z
  .object({
    ...contactWritable,
    account: z.object({ id: Uuid, role: AccountRole.default('other'), isPrimary: z.boolean().default(true) }).strict().optional(),
    contactPoints: z.array(ContactPointInput).max(20).optional(),
  })
  .partial({ firstName: true, lastName: true, title: true, segments: true, ownerUserId: true, description: true, descriptionText: true, custom: true })
  .strict()
  .refine((v) => `${v.firstName ?? ''}${v.lastName ?? ''}`.trim().length > 0, 'firstName or lastName is required')
  .openapi('ContactCreate');
export const ContactPatch = z.object(contactWritable).partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch').openapi('ContactPatch');
export const AccountRoleView = z.object({ accountId: Uuid, role: AccountRole, isPrimary: z.boolean() }).openapi('AccountRoleView');
export const ContactView = z
  .object({
    id: Uuid, firstName: z.string(), lastName: z.string(), fullName: z.string(), title: z.string().nullable(), segments: z.array(Segment),
    ownerUserId: Uuid, description: ProseMirrorDoc.nullable(), descriptionText: z.string().nullable(), custom: z.record(z.string(), z.unknown()),
    mergedInto: Uuid.nullable(), accounts: z.array(AccountRoleView), contactPoints: z.array(ContactPointView), ...meta,
  })
  .partial()
  .required({ id: true })
  .openapi('ContactView');
export const ContactListResponse = listOf(ContactView, 'ContactListResponse');
export const AccountRoleSet = z.object({ role: AccountRole, isPrimary: z.boolean().default(false) }).strict().openapi('AccountRoleSet');

// ------------------------------------------------------------------ leads
const leadWritable = {
  firstName: Name(120),
  lastName: Name(120),
  company: Name(300).nullable(),
  title: Name(120).nullable(),
  segment: Segment,
  source: Name(60).nullable(),
  score: z.number().int().min(0).max(100),
  ownerUserId: Uuid.nullable(),
  queueId: Uuid.nullable(),
  ...common,
};
export const LeadCreate = z
  .object({ ...leadWritable, contactPoints: z.array(ContactPointInput).max(20).optional() })
  .partial()
  .strict()
  .refine((v) => `${v.firstName ?? ''}${v.lastName ?? ''}${v.company ?? ''}`.trim().length > 0, 'a name or company is required')
  .openapi('LeadCreate');
export const LeadPatch = z.object(leadWritable).omit({ segment: true }).partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch').openapi('LeadPatch');
export const LeadView = z
  .object({
    id: Uuid, firstName: z.string(), lastName: z.string(), fullName: z.string(), company: z.string().nullable(), title: z.string().nullable(),
    segment: Segment, workflowId: Uuid, status: StatusView, source: z.string().nullable(), score: z.number().int(), ownerUserId: Uuid.nullable(),
    queueId: Uuid.nullable(), description: ProseMirrorDoc.nullable(), descriptionText: z.string().nullable(), custom: z.record(z.string(), z.unknown()),
    convertedAt: z.string().nullable(), contactPoints: z.array(ContactPointView), ...meta,
  })
  .partial()
  .required({ id: true })
  .openapi('LeadView');
export const LeadListResponse = listOf(LeadView, 'LeadListResponse');

export const LeadConvertRequest = z
  .object({
    account: z.union([z.object({ existingId: Uuid }).strict(), z.object({ name: Name(300).min(1).optional() }).strict()]).default({}),
    opportunity: z
      .object({ name: Name(300).min(1).optional(), pipelineId: Uuid.optional(), amount: Money.optional(), currency: Currency.optional(), expectedClose: IsoDate.optional() })
      .strict()
      .nullable()
      .default(null),
    ownerUserId: Uuid.optional(),
  })
  .strict()
  .openapi('LeadConvertRequest');
export const LeadConvertResponse = z
  .object({ leadId: Uuid, accountId: Uuid, contactId: Uuid, opportunityId: Uuid.nullable(), convertedAt: z.string() })
  .openapi('LeadConvertResponse');

// ------------------------------------------------------------------ opportunities
const opportunityWritable = {
  name: Name(300).min(1),
  accountId: Uuid.nullable(),
  primaryContactId: Uuid.nullable(),
  amount: Money.nullable(),
  currency: Currency,
  probability: z.number().min(0).max(100),
  expectedClose: IsoDate.nullable(),
  competitor: Name(200).nullable(),
  wonLostReason: Name(500).nullable(),
  ownerUserId: Uuid,
  ...common,
};
export const OpportunityCreate = z
  .object({ ...opportunityWritable, segment: Segment, pipelineId: Uuid })
  .partial()
  .required({ name: true })
  .strict()
  .openapi('OpportunityCreate');
export const OpportunityPatch = z
  .object({ ...opportunityWritable, probabilityManual: z.literal(false) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .refine((v) => !(v.probability !== undefined && v.probabilityManual === false), 'probability and probabilityManual=false are exclusive')
  .openapi('OpportunityPatch');
export const OpportunityView = z
  .object({
    id: Uuid, name: z.string(), accountId: Uuid.nullable(), primaryContactId: Uuid.nullable(), pipelineId: Uuid, workflowId: Uuid,
    status: StatusView, segment: Segment, amount: z.string().nullable(), currency: z.string(), probability: z.number(),
    probabilityManual: z.boolean(), expectedClose: z.string().nullable(), competitor: z.string().nullable(), wonLostReason: z.string().nullable(),
    ownerUserId: Uuid, description: ProseMirrorDoc.nullable(), descriptionText: z.string().nullable(), custom: z.record(z.string(), z.unknown()),
    closedAt: z.string().nullable(), ...meta,
  })
  .partial()
  .required({ id: true })
  .openapi('OpportunityView');
export const OpportunityListResponse = listOf(OpportunityView, 'OpportunityListResponse');

export const PipelineView = z
  .object({
    id: Uuid, key: z.string(), name: z.string(), segment: Segment.nullable(), workflowId: Uuid, isDefault: z.boolean(),
    stages: z.array(StatusView.extend({ probability: z.number(), position: z.string() })),
  })
  .openapi('PipelineView');
export const PipelineListResponse = z.object({ data: z.array(PipelineView) }).openapi('PipelineListResponse');

// ------------------------------------------------------------------ cases
const caseWritable = {
  subject: Name(300).min(1),
  accountId: Uuid.nullable(),
  contactId: Uuid.nullable(),
  priority: z.number().int().min(0).max(4),
  channel: z.enum(['email', 'phone', 'web', 'chat', 'social', 'other']),
  category: Name(60).nullable(),
  ownerUserId: Uuid.nullable(),
  queueId: Uuid.nullable(),
  segment: Segment.nullable(),
  ...common,
};
export const CaseCreate = z.object(caseWritable).partial().required({ subject: true }).strict().openapi('CaseCreate');
export const CasePatch = z.object(caseWritable).partial().strict().refine((v) => Object.keys(v).length > 0, 'empty patch').openapi('CasePatch');
export const CaseView = z
  .object({
    id: Uuid, subject: z.string(), accountId: Uuid.nullable(), contactId: Uuid.nullable(), workflowId: Uuid, status: StatusView,
    priority: z.number().int(), channel: z.string(), category: z.string().nullable(), ownerUserId: Uuid.nullable(), queueId: Uuid.nullable(),
    segment: Segment.nullable(), description: ProseMirrorDoc.nullable(), descriptionText: z.string().nullable(),
    custom: z.record(z.string(), z.unknown()), closedAt: z.string().nullable(), ...meta,
  })
  .partial()
  .required({ id: true })
  .openapi('CaseView');
export const CaseListResponse = listOf(CaseView, 'CaseListResponse');

// ------------------------------------------------------------------ shared record operations
export const RecordTransitionRequest = z
  .union([
    z.object({ transitionKey: Key, fields: z.record(z.string(), z.unknown()).optional() }).strict(),
    z.object({ toStatusId: Uuid, fields: z.record(z.string(), z.unknown()).optional() }).strict(),
  ])
  .openapi('RecordTransitionRequest');

export const MergeRequest = z
  .object({
    survivorId: Uuid,
    mergedIds: z.array(Uuid).min(1).max(10),
    /** Per field: the id of the record whose value the survivor keeps (default: the survivor's own). */
    fieldChoices: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9.]{0,60}$/), Uuid).default({}),
  })
  .strict()
  .refine((v) => !v.mergedIds.includes(v.survivorId), 'survivorId must not be in mergedIds')
  .openapi('MergeRequest');
export const MergeResponse = z
  .object({ mergeId: Uuid, survivorId: Uuid, mergedIds: z.array(Uuid), moved: z.record(z.string(), z.number().int()) })
  .openapi('MergeResponse');

export const DuplicateListResponse = z
  .object({ data: z.array(z.object({ id: Uuid, name: z.string(), score: z.number(), reasons: z.array(z.enum(['email', 'phone', 'domain', 'name'])) })) })
  .openapi('DuplicateListResponse');

// ------------------------------------------------------------------ notes
export const NoteCreate = z
  .object({
    related: z.object({ type: z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']), id: Uuid }).strict(),
    body: ProseMirrorDoc.nullable().optional(),
    bodyText: z.string().trim().min(1).max(100_000),
    visibility: z.enum(['standard', 'private']).default('standard'),
  })
  .strict()
  .openapi('NoteCreate');
export const NotePatch = z
  .object({ body: ProseMirrorDoc.nullable(), bodyText: z.string().trim().min(1).max(100_000), visibility: z.enum(['standard', 'private']) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('NotePatch');
export const NoteView = z
  .object({
    id: Uuid, related: z.object({ type: z.string(), id: Uuid }), body: ProseMirrorDoc.nullable(), bodyText: z.string(),
    visibility: z.enum(['standard', 'private']), authorId: Uuid, createdAt: z.string(), updatedAt: z.string(),
  })
  .openapi('NoteView');
export const NoteListResponse = z.object({ data: z.array(NoteView) }).openapi('NoteListResponse');

/** Accepted by the generic transition endpoint; re-validated per object by its own patch schema. */
export type RecordTransition = z.infer<typeof RecordTransitionRequest>;

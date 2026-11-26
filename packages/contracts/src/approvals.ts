import { z } from 'zod';
import { Uuid } from './schemas';

// P8b approvals and sales targets (docs/p8-plan.md §7–10, ADR-0021).

const Segment = z.enum(['b2b', 'b2c']);
const Percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) > 0 && Number(v) <= 100, 'must be between 0 and 100').openapi({ example: '12.5' });
const Person = z.object({ id: Uuid, displayName: z.string() });

// ------------------------------------------------------------------ approvals
export const ApprovalCreate = z
  .object({
    kind: z.literal('discount'),
    subject: z.object({ type: z.literal('opportunity'), id: Uuid }).strict(),
    percent: Percent,
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .openapi('ApprovalCreate');
export const ApprovalDecision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }).strict().openapi('ApprovalDecision');
export const ApprovalBulkDecision = z
  .object({ ids: z.array(Uuid).min(1).max(50), decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() })
  .strict()
  .openapi('ApprovalBulkDecision');
export const ApprovalView = z
  .object({
    id: Uuid,
    kind: z.literal('discount'),
    subject: z.object({ type: z.string(), id: Uuid, title: z.string().nullable() }),
    segment: Segment,
    /** The quote whose discount is asked for; null = a discount of the opportunity itself. */
    quote: z.object({ id: Uuid, number: z.string(), version: z.number().int() }).nullable(),
    requestedBy: Person,
    percent: z.string(),
    reason: z.string(),
    state: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
    automatic: z.boolean(),
    level: z.number().int(),
    /** Null while pending = any Admin may decide. */
    assignedTo: Person.nullable(),
    dueAt: z.string().nullable(),
    decidedBy: Person.nullable(),
    decidedAt: z.string().nullable(),
    decisionNote: z.string().nullable(),
    createdAt: z.string(),
    /** The caller may decide it now. */
    canDecide: z.boolean(),
    steps: z.array(z.object({ action: z.string(), actor: Person.nullable(), assignedTo: Person.nullable(), at: z.string() })),
  })
  .openapi('ApprovalView');
export const ApprovalListResponse = z.object({ data: z.array(ApprovalView) }).openapi('ApprovalListResponse');
export const ApprovalListQuery = z
  .object({
    /** inbox = waiting for the caller; mine = requested by the caller; subject = of one record the caller reads. */
    box: z.enum(['inbox', 'mine', 'all', 'subject']).default('inbox'),
    subjectType: z.literal('opportunity').optional(),
    subjectId: Uuid.optional(),
  })
  .strict()
  .refine((v) => (v.box === 'subject') === (v.subjectId !== undefined && v.subjectType !== undefined), 'subjectType and subjectId go with box=subject');
export const ApprovalBulkResult = z
  .object({ data: z.array(z.object({ id: Uuid, ok: z.boolean(), code: z.string().nullable() })) })
  .openapi('ApprovalBulkResult');

export const ApprovalLimitSet = z.object({ maxPercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((v) => Number(v) <= 100, 'must be 100 or less').nullable() }).strict().openapi('ApprovalLimitSet');
export const ApprovalLimitListResponse = z
  .object({ data: z.array(z.object({ user: Person, maxPercent: z.string().nullable(), effectivePercent: z.string() })) })
  .openapi('ApprovalLimitListResponse');

// ------------------------------------------------------------------ targets
const Metric = z.enum(['won_amount', 'won_count', 'tasks_closed']);
const Value = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).refine((v) => Number(v) > 0, 'must be greater than zero');
export const TargetCreate = z
  .object({
    subject: z.discriminatedUnion('type', [
      z.object({ type: z.literal('user'), id: Uuid }).strict(),
      z.object({ type: z.literal('team'), id: Uuid }).strict(),
      z.object({ type: z.literal('segment') }).strict(),
    ]),
    segment: Segment.nullable().default(null),
    period: z.enum(['month', 'quarter']),
    periodStart: z.iso.date(),
    metric: Metric,
    targetValue: Value,
    /** Amounts only; defaults to the workspace currency. */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict()
  .refine((v) => v.subject.type !== 'segment' || v.segment !== null, 'a segment target needs a segment')
  .refine((v) => v.periodStart.endsWith('-01') && (v.period === 'month' || ['01', '04', '07', '10'].includes(v.periodStart.slice(5, 7))), 'periodStart must be the first day of the period')
  .refine((v) => v.metric === 'won_amount' || v.currency === undefined, 'currency goes with won_amount')
  .refine((v) => v.metric !== 'tasks_closed' || v.subject.type !== 'segment', 'tasks are counted per person or team')
  .openapi('TargetCreate');
export const TargetPatch = z.object({ targetValue: Value }).strict().openapi('TargetPatch');
export const TargetView = z
  .object({
    id: Uuid,
    subject: z.object({ type: z.enum(['user', 'team', 'segment']), id: Uuid.nullable(), name: z.string() }),
    segment: Segment.nullable(),
    period: z.enum(['month', 'quarter']),
    periodStart: z.string(),
    periodEnd: z.string(),
    metric: Metric,
    targetValue: z.string(),
    currency: z.string().nullable(),
    actual: z.string(),
    /** Won opportunities left out because their currency differs. */
    otherCurrencyCount: z.number().int(),
    progressPercent: z.number(),
    elapsedPercent: z.number(),
    atRisk: z.boolean(),
    canEdit: z.boolean(),
    version: z.number().int(),
  })
  .openapi('TargetView');
export const TargetListResponse = z.object({ data: z.array(TargetView) }).openapi('TargetListResponse');
export const TargetListQuery = z.object({ on: z.iso.date().optional() }).strict();

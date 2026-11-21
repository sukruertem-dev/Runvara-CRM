import { z } from 'zod';
import { Uuid } from './schemas';

// P5a automation rules (docs/p5-plan.md §2). The definition is plain JSON so that the visual rule editor (P6)
// produces exactly this shape.

const Resource = z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']);
const FieldName = z.string().regex(/^(?:[a-zA-Z][a-zA-Z0-9]{0,47}|custom\.cf_[a-z0-9_]{1,45})$/);

export const AutomationTrigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record.created') }).strict(),
  z.object({ type: z.literal('record.updated') }).strict(),
  z.object({ type: z.literal('field_changed'), fields: z.array(FieldName).min(1).max(20) }).strict(),
  z.object({ type: z.literal('status_changed'), toStatus: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).optional() }).strict(),
  z.object({
    type: z.literal('schedule'),
    /** Five-field cron expression (minute hour day month weekday), evaluated in `timezone`. */
    cron: z.string().regex(/^(\S+\s+){4}\S+$/).max(100),
    timezone: z.string().min(1).max(64).default('Europe/Istanbul'),
  }).strict(),
  z.object({ type: z.literal('inbound_webhook') }).strict(),
]);

/** Who receives a notification / e-mail or becomes the owner: the record owner, a fixed member, or a policy. */
const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record_owner') }).strict(),
  z.object({ kind: z.literal('user'), userId: Uuid }).strict(),
  z.object({ kind: z.literal('policy'), policyId: Uuid }).strict(),
]);

export const AutomationAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update_field'), field: FieldName, value: z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]) }).strict(),
  z.object({
    type: z.literal('create_task'),
    title: z.string().trim().min(1).max(500),
    priority: z.number().int().min(0).max(4).default(2),
    dueInDays: z.number().int().min(0).max(3650).optional(),
    assignTo: Target.default({ kind: 'record_owner' }),
  }).strict(),
  z.object({ type: z.literal('assign'), to: Target }).strict(),
  z.object({ type: z.literal('notify'), to: Target, message: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('send_email'), to: Target, subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ type: z.literal('transition'), transitionKey: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/) }).strict(),
]);

export const AutomationRuleDefinition = z
  .object({
    resourceType: Resource,
    trigger: AutomationTrigger,
    /** RQL expression on the triggering record (e.g. `priority >= 3 AND account.industry = "Enerji"`); empty = always. */
    condition: z.string().max(2000).default(''),
    actions: z.array(AutomationAction).min(1).max(10),
  })
  .strict()
  .openapi('AutomationRuleDefinition');
export type AutomationRuleDefinition = z.infer<typeof AutomationRuleDefinition>;

export const AutomationRuleCreate = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(), enabled: z.boolean().default(true), definition: AutomationRuleDefinition })
  .strict()
  .openapi('AutomationRuleCreate');
export const AutomationRulePatch = z
  .object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullable(), enabled: z.boolean(), definition: AutomationRuleDefinition })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('AutomationRulePatch');
export const AutomationRuleView = z
  .object({
    id: Uuid, name: z.string(), description: z.string().nullable(), enabled: z.boolean(), definition: AutomationRuleDefinition, runAs: Uuid,
    version: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
    /** Returned once, when an inbound-webhook rule is created or its token rotated. */
    hookToken: z.string().optional(),
  })
  .openapi('AutomationRuleView');
export const AutomationRuleListResponse = z.object({ data: z.array(AutomationRuleView) }).openapi('AutomationRuleListResponse');

export const AutomationRunView = z
  .object({
    id: Uuid, ruleId: Uuid, ruleVersion: z.number().int(), eventId: Uuid, correlationId: Uuid, depth: z.number().int(),
    record: z.object({ type: z.string(), id: Uuid }), status: z.enum(['succeeded', 'skipped', 'failed', 'halted_depth', 'halted_loop', 'dead']),
    conditionResult: z.boolean().nullable(), actions: z.array(z.unknown()), error: z.string().nullable(), attempt: z.number().int(),
    durationMs: z.number().int().nullable(), startedAt: z.string(),
  })
  .openapi('AutomationRunView');
export const AutomationRunListResponse = z.object({ data: z.array(AutomationRunView) }).openapi('AutomationRunListResponse');

export const DeadLetterView = z
  .object({ id: Uuid, consumer: z.string(), eventId: Uuid, eventType: z.string(), error: z.string(), attempts: z.number().int(), createdAt: z.string(), replayedAt: z.string().nullable() })
  .openapi('DeadLetterView');
export const DeadLetterListResponse = z.object({ data: z.array(DeadLetterView) }).openapi('DeadLetterListResponse');

export const InboundHookRequest = z.object({ recordId: Uuid, data: z.record(z.string(), z.unknown()).default({}) }).strict().openapi('InboundHookRequest');
export const InboundHookResponse = z.object({ eventId: Uuid }).openapi('InboundHookResponse');

export const AssignmentPolicyCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    strategy: z.enum(['round_robin', 'load_balanced']),
    teamId: Uuid.optional(),
    queueId: Uuid.optional(),
    fallbackUserId: Uuid.optional(),
  })
  .strict()
  .refine((v) => (v.teamId === undefined) !== (v.queueId === undefined), 'exactly one of teamId / queueId')
  .openapi('AssignmentPolicyCreate');
export const AssignmentPolicyView = z
  .object({ id: Uuid, name: z.string(), strategy: z.enum(['round_robin', 'load_balanced']), teamId: Uuid.nullable(), queueId: Uuid.nullable(), fallbackUserId: Uuid.nullable() })
  .openapi('AssignmentPolicyView');
export const AssignmentPolicyListResponse = z.object({ data: z.array(AssignmentPolicyView) }).openapi('AssignmentPolicyListResponse');

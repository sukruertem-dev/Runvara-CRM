import { z } from 'zod';
import { Uuid } from './schemas';

// P5b: SLA, webhooks, API keys (docs/p5-plan.md §5).

const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const Name = z.string().trim().min(1).max(120);

// ------------------------------------------------------------------ SLA
export const BusinessCalendarInput = z
  .object({
    name: Name,
    timezone: z.string().min(1).max(64),
    weeklyHours: z.array(z.object({ day: z.number().int().min(1).max(7), start: HHMM, end: HHMM }).strict()).min(1).max(70),
    holidays: z.array(z.object({
      date: z.iso.date(),
      name: z.string().max(120).optional(),
      hours: z.array(z.object({ start: HHMM, end: HHMM }).strict()).max(10).optional(),
    }).strict()).max(400).default([]),
  })
  .strict()
  .openapi('BusinessCalendarInput');
export const BusinessCalendarView = z
  .object({
    id: Uuid, name: z.string(), timezone: z.string(),
    weeklyHours: z.array(z.object({ day: z.number().int(), start: z.string(), end: z.string() })),
    holidays: z.array(z.object({ date: z.string(), name: z.string().optional(), hours: z.array(z.object({ start: z.string(), end: z.string() })).optional() })),
  })
  .openapi('BusinessCalendarView');
export const BusinessCalendarListResponse = z.object({ data: z.array(BusinessCalendarView) }).openapi('BusinessCalendarListResponse');

export const SlaPolicyCreate = z
  .object({
    name: Name,
    resourceType: z.enum(['case', 'task', 'lead']),
    /** RQL; the first enabled policy (by position) whose criteria match a new record applies. Empty = all. */
    criteria: z.string().max(2000).default(''),
    position: z.number().int().min(0).max(10_000).default(0),
    calendarId: Uuid,
    firstResponseMinutes: z.number().int().min(1).max(525_600).optional(),
    resolutionMinutes: z.number().int().min(1).max(525_600).optional(),
    warnPercent: z.number().int().min(1).max(99).default(80),
    /** Status keys during which the clocks stop (e.g. waiting on customer). */
    pauseStatuses: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.firstResponseMinutes !== undefined || v.resolutionMinutes !== undefined, 'set first response and/or resolution time')
  .openapi('SlaPolicyCreate');
export const SlaPolicyView = z
  .object({
    id: Uuid, name: z.string(), resourceType: z.string(), criteria: z.string(), position: z.number().int(), calendarId: Uuid,
    firstResponseMinutes: z.number().int().nullable(), resolutionMinutes: z.number().int().nullable(), warnPercent: z.number().int(),
    pauseStatuses: z.array(z.string()), enabled: z.boolean(),
  })
  .openapi('SlaPolicyView');
export const SlaPolicyListResponse = z.object({ data: z.array(SlaPolicyView) }).openapi('SlaPolicyListResponse');
export const SlaTimerView = z
  .object({
    id: Uuid, policyId: Uuid, milestone: z.enum(['first_response', 'resolution']), state: z.enum(['running', 'paused', 'met', 'breached']),
    budgetMinutes: z.number().int(), startedAt: z.string(), targetAt: z.string().nullable(), warnAt: z.string().nullable(),
    remainingMinutes: z.number().nullable(), warnedAt: z.string().nullable(), breachedAt: z.string().nullable(), metAt: z.string().nullable(),
  })
  .openapi('SlaTimerView');
export const SlaTimerListResponse = z.object({ data: z.array(SlaTimerView) }).openapi('SlaTimerListResponse');

// ------------------------------------------------------------------ webhooks
export const WebhookCreate = z
  .object({
    name: Name,
    url: z.url().max(2000),
    /** Exact event types, `prefix.*` patterns or `*`. */
    eventTypes: z.array(z.string().regex(/^(?:\*|[a-z_]+\.(?:\*|[a-z_.]+))$/)).min(1).max(50),
  })
  .strict()
  .openapi('WebhookCreate');
export const WebhookPatch = z
  .object({ name: Name, url: z.url().max(2000), eventTypes: WebhookCreate.shape.eventTypes, enabled: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('WebhookPatch');
export const WebhookView = z
  .object({
    id: Uuid, name: z.string(), url: z.string(), eventTypes: z.array(z.string()), enabled: z.boolean(), disabledReason: z.string().nullable(),
    consecutiveFailures: z.number().int(), createdAt: z.string(),
    /** Returned once on creation and on rotation; store it to verify `Flexa-Signature`. */
    secret: z.string().optional(),
  })
  .openapi('WebhookView');
export const WebhookListResponse = z.object({ data: z.array(WebhookView) }).openapi('WebhookListResponse');
export const WebhookDeliveryView = z
  .object({
    id: Uuid, eventId: Uuid, eventType: z.string(), status: z.enum(['pending', 'succeeded', 'failed', 'dead']), attempts: z.number().int(),
    responseStatus: z.number().int().nullable(), error: z.string().nullable(), latencyMs: z.number().int().nullable(), createdAt: z.string(), lastAttemptAt: z.string().nullable(),
  })
  .openapi('WebhookDeliveryView');
export const WebhookDeliveryListResponse = z.object({ data: z.array(WebhookDeliveryView) }).openapi('WebhookDeliveryListResponse');

// ------------------------------------------------------------------ API keys
export const ApiKeyCreate = z
  .object({
    name: Name,
    scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).transform((v) => [...new Set(v)]),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(100_000).default(600),
  })
  .strict()
  .openapi('ApiKeyCreate');
export const ApiKeyView = z
  .object({
    id: Uuid, name: z.string(), prefix: z.string(), scopes: z.array(z.enum(['read', 'write'])), rateLimitPerMinute: z.number().int(),
    createdBy: Uuid, createdAt: z.string(), expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), lastUsedAt: z.string().nullable(),
    /** The full key, returned once on creation. */
    key: z.string().optional(),
  })
  .openapi('ApiKeyView');
export const ApiKeyListResponse = z.object({ data: z.array(ApiKeyView) }).openapi('ApiKeyListResponse');

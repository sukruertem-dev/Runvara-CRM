import { z } from 'zod';
import { RoleKey, Uuid } from './schemas';
import { ProseMirrorDoc } from './tasks';

// P4b: records around records (docs/p4-plan.md §10).

const Segment = z.enum(['b2b', 'b2c']);
const IsoDateTime = z.iso.datetime({ offset: true });
const Actor = z.object({ id: Uuid, displayName: z.string().nullable() }).nullable();
const Page = z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() });

// ------------------------------------------------------------------ timeline and activity logs
export const TimelineEvent = z
  .object({
    id: Uuid, kind: z.string(), actor: Actor,
    diff: z.record(z.string(), z.unknown()), data: z.record(z.string(), z.unknown()), occurredAt: z.string(),
  })
  .openapi('TimelineEvent');
export const TimelineResponse = z.object({ data: z.array(TimelineEvent), page: Page }).openapi('TimelineResponse');

export const ActivityLogCreate = z
  .object({
    kind: z.enum(['email_log', 'call_log']),
    direction: z.enum(['inbound', 'outbound']),
    subject: z.string().trim().min(1).max(300),
    body: z.string().max(20_000).optional(),
    at: IsoDateTime,
    durationSeconds: z.number().int().min(0).max(86_400).optional(),
    counterpart: z.string().trim().max(254).optional(),
  })
  .strict()
  .openapi('ActivityLogCreate');

// ------------------------------------------------------------------ comments
export const CommentCreate = z.object({ body: ProseMirrorDoc }).strict().openapi('CommentCreate');
export const CommentPatch = z.object({ body: ProseMirrorDoc, revision: z.number().int().min(1) }).strict().openapi('CommentPatch');
export const CommentView = z
  .object({
    id: Uuid, record: z.object({ type: z.string(), id: Uuid }), body: ProseMirrorDoc.nullable(), bodyHtml: z.string().nullable(),
    bodyText: z.string().nullable(), author: Actor, revision: z.number().int(), createdAt: z.string(), editedAt: z.string().nullable(), deleted: z.boolean(),
  })
  .openapi('CommentView');
export const CommentListResponse = z.object({ data: z.array(CommentView) }).openapi('CommentListResponse');
export const CommentRevisionListResponse = z
  .object({ data: z.array(z.object({ revision: z.number().int(), body: ProseMirrorDoc, bodyText: z.string(), editedBy: Uuid, at: z.string() })) })
  .openapi('CommentRevisionListResponse');

/** The `@` picker (ADR-0017 §2): only people who can read the record, and the field for `description`. */
export const MentionableQuery = z.object({ q: z.string().trim().max(100).default(''), source: z.enum(['comment', 'note', 'description']).default('comment') }).strict();
export const MentionableResponse = z
  .object({
    /** `grantsAccess`: the person gets read access when mentioned (tenant policy, off by default). */
    users: z.array(z.object({ id: Uuid, displayName: z.string(), grantsAccess: z.boolean() })),
    teams: z.array(z.object({ id: Uuid, name: z.string(), memberCount: z.number().int() })),
  })
  .openapi('MentionableResponse');

// ------------------------------------------------------------------ notifications
export const NotificationView = z
  .object({
    id: Uuid, kind: z.enum(['mention', 'assigned', 'automation', 'approval']), accessible: z.boolean(), title: z.string().nullable(), message: z.string().nullable(),
    record: z.object({ type: z.string(), id: Uuid }).nullable(), source: z.object({ type: z.string(), id: Uuid }).nullable(),
    actor: Actor, link: z.string().nullable(), createdAt: z.string(), readAt: z.string().nullable(),
  })
  .openapi('NotificationView');
export const NotificationListResponse = z.object({ data: z.array(NotificationView), unreadCount: z.number().int() }).openapi('NotificationListResponse');
export const NotificationReadResponse = z.object({ updated: z.number().int() }).openapi('NotificationReadResponse');
const Channel = z.enum(['in_app', 'email', 'push']);
export const NotificationPreferences = z
  .object({ data: z.array(z.object({ kind: z.enum(['mention', 'assigned', 'automation', 'approval']), channels: z.array(Channel) })) })
  .openapi('NotificationPreferences');
export const NotificationPreferencesSet = z
  .object({ preferences: z.array(z.object({ kind: z.enum(['mention', 'assigned', 'automation', 'approval']), channels: z.array(Channel).max(3) }).strict()).min(1).max(4) })
  .strict()
  .openapi('NotificationPreferencesSet');

// ------------------------------------------------------------------ web push and delivery measurements
export const PushConfig = z.object({ publicKey: z.string().nullable() }).openapi('PushConfig');
export const PushSubscribe = z
  .object({
    endpoint: z.url({ protocol: /^https?$/ }).max(2000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}$/) }).strict(),
  })
  .strict()
  .openapi('PushSubscribe');
export const PushUnsubscribe = z.object({ endpoint: z.string().min(10).max(2000) }).strict().openapi('PushUnsubscribe');
export const StreamAck = z.object({ eventId: Uuid }).strict().openapi('StreamAck');
export const DeliveryStatsQuery = z.object({ minutes: z.coerce.number().int().min(1).max(1440).default(60) }).strict();
export const DeliveryStats = z
  .object({ minutes: z.number().int(), data: z.array(z.object({ channel: z.string(), delivered: z.number().int(), failed: z.number().int(), p50Ms: z.number().nullable(), p95Ms: z.number().nullable() })) })
  .openapi('DeliveryStats');

// ------------------------------------------------------------------ attachments
export const ATTACHMENT_MIME_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const AttachmentInitiate = z
  .object({
    // No path separators or control characters (code points below 0x20) in a file name.
    fileName: z.string().trim().min(1).max(255).refine((v) => {
      if (/[\\/]/.test(v)) return false;
      for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) < 0x20) return false;
      return true;
    }, 'invalid file name'),
    mime: z.enum(ATTACHMENT_MIME_TYPES),
    sizeBytes: z.number().int().min(1).max(ATTACHMENT_MAX_BYTES),
  })
  .strict()
  .openapi('AttachmentInitiate');
export const AttachmentView = z
  .object({
    id: Uuid, record: z.object({ type: z.string(), id: Uuid }), fileName: z.string(), mime: z.string(), sizeBytes: z.number().int(),
    status: z.enum(['pending', 'quarantine', 'clean', 'infected', 'unscanned']), uploadedBy: Uuid, createdAt: z.string(),
  })
  .openapi('AttachmentView');
export const AttachmentUpload = z
  .object({ attachment: AttachmentView, upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()), expiresAt: z.string() }) })
  .openapi('AttachmentUpload');
export const AttachmentListResponse = z.object({ data: z.array(AttachmentView) }).openapi('AttachmentListResponse');
export const AttachmentDownload = z.object({ url: z.string(), expiresAt: z.string() }).openapi('AttachmentDownload');

// ------------------------------------------------------------------ audit
export const AuditEntryView = z
  .object({
    id: Uuid, action: z.string(), actorType: z.string(), actor: Actor, targetType: z.string().nullable(), targetId: Uuid.nullable(),
    ip: z.string().nullable(), details: z.record(z.string(), z.unknown()), at: z.string(),
  })
  .openapi('AuditEntryView');
export const AuditListResponse = z.object({ data: z.array(AuditEntryView), page: Page }).openapi('AuditListResponse');

// ------------------------------------------------------------------ delegation and access requests
export const DelegationCreate = z
  .object({
    delegateId: Uuid,
    roleKey: RoleKey.optional(),
    segments: z.array(Segment).max(2).default([]),
    endsAt: IsoDateTime,
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.roleKey !== undefined || v.segments.length > 0, 'delegate a role or at least one segment')
  .openapi('DelegationCreate');
export const DelegationView = z
  .object({
    id: Uuid, delegatorId: Uuid, delegateId: Uuid, roleKey: z.string().nullable(), segments: z.array(Segment), reason: z.string().nullable(),
    startsAt: z.string(), endsAt: z.string(), revokedAt: z.string().nullable(), active: z.boolean(),
  })
  .openapi('DelegationView');
export const DelegationListResponse = z.object({ data: z.array(DelegationView) }).openapi('DelegationListResponse');

export const AccessRequestCreate = z
  .object({ roleKey: RoleKey.optional(), segments: z.array(Segment).max(2).default([]), reason: z.string().trim().min(1).max(500), validUntil: IsoDateTime.optional() })
  .strict()
  .refine((v) => v.roleKey !== undefined || v.segments.length > 0, 'request a role or at least one segment')
  .openapi('AccessRequestCreate');
export const AccessRequestDecision = z
  .object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() })
  .strict()
  .openapi('AccessRequestDecision');
export const AccessRequestView = z
  .object({
    id: Uuid, requesterId: Uuid, roleKey: z.string().nullable(), segments: z.array(Segment), reason: z.string(), validUntil: z.string().nullable(),
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']), decidedBy: Uuid.nullable(), decidedAt: z.string().nullable(),
    decisionNote: z.string().nullable(), createdAt: z.string(),
  })
  .openapi('AccessRequestView');
export const AccessRequestListResponse = z.object({ data: z.array(AccessRequestView) }).openapi('AccessRequestListResponse');

// ------------------------------------------------------------------ matrix administration
const GrantSpec = z
  .object({
    mode: z.enum(['full', 'read', 'approve', 'request']),
    scope: z.union([z.enum(['own', 'queue', 'team', 'segment', 'all']), z.array(z.enum(['own', 'queue', 'team', 'segment', 'all'])).min(1).max(5)]),
    policy: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    constraints: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(10).optional(),
    resources: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(20).optional(),
  })
  .strict();
export const MatrixChange = z
  .object({
    changes: z.array(z.object({ roleKey: RoleKey, permission: z.string().min(3).max(100), grant: GrantSpec.nullable() }).strict()).min(1).max(200),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('MatrixChange');
export const MatrixCell = z
  .object({ roleKey: z.string(), permission: z.string(), module: z.string(), grant: GrantSpec.nullable(), overridden: z.boolean() })
  .openapi('MatrixCell');
export const MatrixView = z.object({ version: z.number().int(), cells: z.array(MatrixCell) }).openapi('MatrixView');
export const MatrixDiff = z
  .object({ changes: z.array(z.object({ roleKey: z.string(), permission: z.string(), before: GrantSpec.nullable(), after: GrantSpec.nullable() })) })
  .openapi('MatrixDiff');
export const MatrixVersionListResponse = z
  .object({ data: z.array(z.object({ version: z.number().int(), note: z.string().nullable(), createdBy: Uuid, createdAt: z.string(), overrideCount: z.number().int() })) })
  .openapi('MatrixVersionListResponse');

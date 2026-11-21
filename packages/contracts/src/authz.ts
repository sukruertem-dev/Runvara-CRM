import { z } from 'zod';
import { RoleKey, Uuid } from './schemas';

// P4a administration of the authorization engine (docs/p4-plan.md §6).

const Segment = z.enum(['b2b', 'b2c']);
const Name = z.string().trim().min(1).max(120);
const ShareResource = z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']);
const FlsResource = z.enum(['account', 'contact', 'lead', 'opportunity', 'case']);

// ------------------------------------------------------------------ teams and queues
export const TeamCreate = z.object({ name: Name, parentTeamId: Uuid.nullable().optional() }).strict().openapi('TeamCreate');
export const TeamPatch = z.object({ name: Name, parentTeamId: Uuid.nullable() }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch').openapi('TeamPatch');
export const TeamMemberView = z.object({ userId: Uuid, displayName: z.string(), role: z.enum(['member', 'manager']) }).openapi('TeamMemberView');
export const TeamView = z
  .object({ id: Uuid, name: z.string(), parentTeamId: Uuid.nullable(), members: z.array(TeamMemberView) })
  .openapi('TeamView');
export const TeamListResponse = z.object({ data: z.array(TeamView) }).openapi('TeamListResponse');
export const TeamMemberSet = z.object({ role: z.enum(['member', 'manager']).default('member') }).strict().openapi('TeamMemberSet');

export const QueueCreate = z.object({ name: Name, kind: z.enum(['work', 'call']).default('work'), segment: Segment.nullable().default(null) }).strict().openapi('QueueCreate');
export const QueueView = z
  .object({ id: Uuid, name: z.string(), kind: z.enum(['work', 'call']), segment: Segment.nullable(), memberIds: z.array(Uuid) })
  .openapi('QueueView');
export const QueueListResponse = z.object({ data: z.array(QueueView) }).openapi('QueueListResponse');

// ------------------------------------------------------------------ users, segments, roles
export const UserAccessView = z
  .object({
    userId: Uuid,
    displayName: z.string(),
    email: z.string(),
    status: z.string(),
    roles: z.array(z.string()),
    segments: z.array(z.object({ segment: Segment, validUntil: z.string().nullable() })),
    teams: z.array(z.object({ teamId: Uuid, role: z.enum(['member', 'manager']) })),
  })
  .openapi('UserAccessView');
export const UserListResponse = z.object({ data: z.array(UserAccessView) }).openapi('UserListResponse');
export const UserSegmentsSet = z
  .object({
    segments: z.array(z.object({ segment: Segment, validUntil: z.iso.datetime({ offset: true }).nullable().default(null) }).strict()).max(2),
  })
  .strict()
  .refine((v) => new Set(v.segments.map((s) => s.segment)).size === v.segments.length, 'duplicate segment')
  .openapi('UserSegmentsSet');
export const UserRolesSet = z.object({ roles: z.array(RoleKey).min(1).max(5) }).strict().openapi('UserRolesSet');

export const RoleView = z
  .object({ id: Uuid, key: z.string(), name: z.string(), isSystem: z.boolean(), parentRoleId: Uuid.nullable() })
  .openapi('RoleView');
export const RoleListResponse = z.object({ data: z.array(RoleView) }).openapi('RoleListResponse');
export const RoleParentSet = z.object({ parentRoleId: Uuid.nullable() }).strict().openapi('RoleParentSet');

// ------------------------------------------------------------------ sharing
export const SharingDefaultsView = z
  .object({ data: z.array(z.object({ resourceType: ShareResource, access: z.enum(['private', 'read', 'read_write']) })) })
  .openapi('SharingDefaultsView');
export const SharingDefaultsSet = z
  .object({ defaults: z.array(z.object({ resourceType: ShareResource, access: z.enum(['private', 'read', 'read_write']) }).strict()).min(1).max(6) })
  .strict()
  .openapi('SharingDefaultsSet');

export const SharingRuleCreate = z
  .object({ resourceType: ShareResource, name: Name, criteria: z.string().min(1).max(2000), granteeTeamId: Uuid, access: z.enum(['read', 'edit']).default('read') })
  .strict()
  .openapi('SharingRuleCreate');
export const SharingRuleView = z
  .object({ id: Uuid, resourceType: ShareResource, name: z.string(), criteria: z.string(), granteeTeamId: Uuid, access: z.enum(['read', 'edit']), enabled: z.boolean() })
  .openapi('SharingRuleView');
export const SharingRuleListResponse = z.object({ data: z.array(SharingRuleView) }).openapi('SharingRuleListResponse');

export const ShareCreate = z
  .object({ grantee: z.object({ type: z.enum(['user', 'team']), id: Uuid }).strict(), access: z.enum(['read', 'edit']).default('read') })
  .strict()
  .openapi('ShareCreate');
export const ShareView = z
  .object({ id: Uuid, grantee: z.object({ type: z.enum(['user', 'team']), id: Uuid }), access: z.enum(['read', 'edit']), source: z.string(), createdAt: z.string() })
  .openapi('ShareView');
export const ShareListResponse = z.object({ data: z.array(ShareView) }).openapi('ShareListResponse');

// ------------------------------------------------------------------ field-level security
export const FieldPolicyView = z
  .object({ roleId: Uuid, resourceType: FlsResource, field: z.string(), access: z.enum(['hidden', 'read']) })
  .openapi('FieldPolicyView');
export const FieldPolicyListResponse = z.object({ data: z.array(FieldPolicyView) }).openapi('FieldPolicyListResponse');
export const FieldPolicySet = z
  .object({
    roleId: Uuid,
    resourceType: FlsResource,
    field: z.string().regex(/^(?:[a-zA-Z][a-zA-Z0-9]{0,47}|custom\.cf_[a-z0-9_]{1,45})$/),
    /** null removes the restriction (field writable again). */
    access: z.enum(['hidden', 'read']).nullable(),
  })
  .strict()
  .openapi('FieldPolicySet');

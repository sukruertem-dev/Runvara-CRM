import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);

export const tenants = pgTable('tenants', {
  id: id(),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status', { enum: ['trial', 'active', 'suspended', 'pending_deletion', 'deleted'] }).notNull(),
  salesMode: text('sales_mode', { enum: ['b2b_only', 'b2c_only', 'both'] }).notNull(),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  country: char('country', { length: 2 }).notNull(),
  authzEpoch: integer('authz_epoch').notNull(),
  statusChangedAt: ts('status_changed_at').notNull(),
  deletionScheduledAt: ts('deletion_scheduled_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: id(),
  email: citext('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  locale: text('locale').notNull(),
  timezone: text('timezone').notNull(),
  status: text('status', { enum: ['active', 'disabled'] }).notNull(),
  emailVerifiedAt: ts('email_verified_at'),
  anonymizedAt: ts('anonymized_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const userCredentials = pgTable('user_credentials', {
  userId: uuid('user_id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id').primaryKey(),
  totpSecretEnc: bytea('totp_secret_enc').notNull(),
  totpEnabledAt: ts('totp_enabled_at'),
  totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
  recoveryCodeHashes: text('recovery_code_hashes').array().notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: text('status', { enum: ['active', 'suspended'] }).notNull(),
    primaryTeamId: uuid('primary_team_id'),
    authzVersion: integer('authz_version').notNull(),
    density: text('density', { enum: ['comfortable', 'compact'] }).notNull(),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const roles = pgTable('roles', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  isSystem: boolean('is_system').notNull(),
  path: text('path').notNull(),
  version: integer('version').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const userRoles = pgTable(
  'user_roles',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    validUntil: ts('valid_until'),
    grantedBy: uuid('granted_by'),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.roleId] })],
);

export const invitations = pgTable('invitations', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  email: citext('email').notNull(),
  roleKey: text('role_key').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  acceptedBy: uuid('accepted_by'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const tenantModules = pgTable(
  'tenant_modules',
  {
    tenantId: uuid('tenant_id').notNull(),
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull(),
    enabledBy: uuid('enabled_by'),
    enabledAt: ts('enabled_at'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.moduleId] })],
);

export const tenantKeys = pgTable(
  'tenant_keys',
  {
    tenantId: uuid('tenant_id').notNull(),
    version: integer('version').notNull(),
    wrappedDek: bytea('wrapped_dek').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    retiredAt: ts('retired_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.version] })],
);

export const tenantSsoProviders = pgTable('tenant_sso_providers', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['oidc'] }).notNull(),
  name: text('name').notNull(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretEnc: bytea('client_secret_enc').notNull(),
  keyVersion: integer('key_version').notNull(),
  emailDomains: text('email_domains').array().notNull(),
  jitEnabled: boolean('jit_enabled').notNull(),
  enabled: boolean('enabled').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    tenantId: uuid('tenant_id').notNull(),
    action: text('action').notNull(),
    actorType: text('actor_type', { enum: ['user', 'service', 'automation', 'operator', 'system'] }).notNull(),
    actorId: uuid('actor_id'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    ip: inet('ip'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_log_tenant_at').on(t.tenantId, t.at)],
);

export const authSessions = pgTable('auth_sessions', {
  id: id(),
  userId: uuid('user_id').notNull(),
  tenantId: uuid('tenant_id'),
  amr: text('amr').array().notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
  revokeReason: text('revoke_reason'),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  sessionId: uuid('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  familyId: uuid('family_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  replacedBy: uuid('replaced_by'),
});

export const emailTokens = pgTable('email_tokens', {
  id: id(),
  userId: uuid('user_id').notNull(),
  purpose: text('purpose', { enum: ['verify_email', 'reset_password'] }).notNull(),
  tokenHash: bytea('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const authEvents = pgTable('auth_events', {
  id: id(),
  userId: uuid('user_id'),
  tenantId: uuid('tenant_id'),
  kind: text('kind').notNull(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  at: ts('at').notNull().defaultNow(),
});

/** Closed list of tables without tenant_id (docs/architecture.md §6, ADR-0003 §5). */
export const GLOBAL_TABLES = [
  'tenants',
  'users',
  'user_credentials',
  'user_mfa',
  'auth_sessions',
  'refresh_tokens',
  'email_tokens',
  'auth_events',
  'schema_migrations',
] as const;

export * from './schema-tasks';

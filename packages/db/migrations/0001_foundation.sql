-- 0001 foundation: helper schema, tenancy, identity, sessions, memberships, roles, invitations,
-- modules, keys, SSO providers, audit. ADR-0002, ADR-0003, ADR-0009, ADR-0014.
-- Every table: FORCE ROW LEVEL SECURITY. Tenant tables: RESTRICTIVE tenant_isolation policy.
-- Global tables (closed list, docs/architecture.md §6): tenants, users, user_credentials, user_mfa,
-- auth_sessions, refresh_tokens, email_tokens, auth_events.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA app AUTHORIZATION runvara_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO runvara_app;

-- ---------------------------------------------------------------------------------------------
-- Context helpers. Missing context → NULL → every policy comparison is NULL → zero rows.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION app.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege'; END $$;

-- ---------------------------------------------------------------------------------------------
-- Tenants (global table; a tenant context sees only its own row)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenants (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  slug                  citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status                text NOT NULL DEFAULT 'trial'
                        CHECK (status IN ('trial', 'active', 'suspended', 'pending_deletion', 'deleted')),
  sales_mode            text NOT NULL DEFAULT 'both' CHECK (sales_mode IN ('b2b_only', 'b2c_only', 'both')),
  locale                text NOT NULL DEFAULT 'tr-TR',
  timezone              text NOT NULL DEFAULT 'Europe/Istanbul',
  currency              char(3) NOT NULL DEFAULT 'TRY',
  country               char(2) NOT NULL DEFAULT 'TR',
  authz_epoch           integer NOT NULL DEFAULT 0,
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  deletion_scheduled_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app.tenant_id()) WITH CHECK (id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenants TO runvara_app;

-- ---------------------------------------------------------------------------------------------
-- Identity (global tables; a user context sees only its own rows)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  email             citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  locale            text NOT NULL DEFAULT 'tr-TR',
  timezone          text NOT NULL DEFAULT 'Europe/Istanbul',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at timestamptz,
  anonymized_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON users USING (id = app.user_id()) WITH CHECK (id = app.user_id());
GRANT SELECT, INSERT, UPDATE ON users TO runvara_app;

CREATE TABLE user_credentials (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_credentials_touch BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON user_credentials USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id());
GRANT SELECT, INSERT, UPDATE ON user_credentials TO runvara_app;

CREATE TABLE user_mfa (
  user_id              uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  totp_secret_enc      bytea NOT NULL,
  totp_enabled_at      timestamptz,
  totp_last_used_step  bigint,
  recovery_code_hashes text[] NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_mfa_touch BEFORE UPDATE ON user_mfa FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self ON user_mfa USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa TO runvara_app;

-- ---------------------------------------------------------------------------------------------
-- Tenant tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE memberships (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  user_id         uuid NOT NULL REFERENCES users (id),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  primary_team_id uuid,
  authz_version   integer NOT NULL DEFAULT 0,
  density         text NOT NULL DEFAULT 'comfortable' CHECK (density IN ('comfortable', 'compact')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);
CREATE TRIGGER memberships_touch BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Users of the current tenant are visible (read-only) in tenant context, e.g. member lists.
CREATE POLICY tenant_members_read ON users FOR SELECT USING (
  EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app.tenant_id())
);

CREATE TABLE roles (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,
  path       text NOT NULL DEFAULT '',
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER roles_touch BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE user_roles (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     uuid NOT NULL,
  valid_until timestamptz,
  granted_by  uuid,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  email       citext NOT NULL,
  role_key    text NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users (id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users (id),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_tenant_email ON invitations (tenant_id, email);

CREATE TABLE tenant_modules (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  module_id  text NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  enabled    boolean NOT NULL DEFAULT false,
  enabled_by uuid REFERENCES users (id),
  enabled_at timestamptz,
  config     jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_id)
);
CREATE TRIGGER tenant_modules_touch BEFORE UPDATE ON tenant_modules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE tenant_keys (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  version     integer NOT NULL CHECK (version > 0),
  wrapped_dek bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  retired_at  timestamptz,
  PRIMARY KEY (tenant_id, version)
);

CREATE TABLE tenant_sso_providers (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  kind              text NOT NULL CHECK (kind IN ('oidc')),
  name              text NOT NULL,
  issuer            text NOT NULL,
  client_id         text NOT NULL,
  client_secret_enc bytea NOT NULL,
  key_version       integer NOT NULL,
  email_domains     text[] NOT NULL DEFAULT '{}',
  jit_enabled       boolean NOT NULL DEFAULT false,
  enabled           boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_sso_providers_touch BEFORE UPDATE ON tenant_sso_providers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  action      text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'service', 'automation', 'operator', 'system')),
  actor_id    uuid,
  target_type text,
  target_id   uuid,
  ip          inet,
  details     jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_at ON audit_log (tenant_id, at DESC);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- RLS for all tenant tables (RESTRICTIVE: later permissive policies can never relax it)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships', 'roles', 'user_roles', 'invitations', 'tenant_modules',
                           'tenant_keys', 'tenant_sso_providers', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON memberships, roles, invitations, tenant_modules, tenant_sso_providers TO runvara_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO runvara_app;
GRANT SELECT, INSERT, UPDATE ON tenant_keys TO runvara_app;
GRANT SELECT, INSERT ON audit_log TO runvara_app;

-- ---------------------------------------------------------------------------------------------
-- Sessions and tokens (global; user context)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id     uuid REFERENCES tenants (id),
  amr           text[] NOT NULL,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoke_reason text
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  session_id  uuid NOT NULL REFERENCES auth_sessions (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_events (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  tenant_id  uuid,
  kind       text NOT NULL,
  ip         inet,
  user_agent text,
  details    jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_at ON auth_events (user_id, at DESC);
CREATE TRIGGER auth_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON auth_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['auth_sessions', 'refresh_tokens', 'email_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY user_self ON %I USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id())', t);
  END LOOP;
END $$;
ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_events_read ON auth_events FOR SELECT USING (user_id = app.user_id());
CREATE POLICY append ON auth_events FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON auth_sessions, refresh_tokens, email_tokens TO runvara_app;
GRANT SELECT, INSERT ON auth_events TO runvara_app;

-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER resolvers: the only way to read rows before a context exists.
-- Each returns the minimum needed; user-scoped ones use app.user_id(), never a caller-supplied id.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.find_user_for_login(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, status text, email_verified boolean, mfa_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, c.password_hash, u.status, u.email_verified_at IS NOT NULL,
         EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id = u.id AND f.totp_enabled_at IS NOT NULL)
  FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
  WHERE u.email = p_email AND u.anonymized_at IS NULL
$$;

CREATE FUNCTION app.email_registered(p_email citext) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE email = p_email)
$$;

CREATE FUNCTION app.slug_available(p_slug citext) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM tenants WHERE slug = p_slug)
$$;

CREATE FUNCTION app.list_my_tenants()
RETURNS TABLE (tenant_id uuid, slug citext, name text, status text, role_keys text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.slug, t.name, t.status,
         coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}')
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  LEFT JOIN user_roles ur ON ur.tenant_id = m.tenant_id AND ur.user_id = m.user_id
       AND (ur.valid_until IS NULL OR ur.valid_until > now())
  LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
  WHERE m.user_id = app.user_id() AND m.status = 'active' AND t.status IN ('trial', 'active')
  GROUP BY t.id, t.slug, t.name, t.status
  ORDER BY t.name
$$;

CREATE FUNCTION app.find_refresh_token(p_hash bytea)
RETURNS TABLE (token_id uuid, session_id uuid, user_id uuid, family_id uuid, expires_at timestamptz,
               used_at timestamptz, session_revoked boolean, session_tenant_id uuid, session_amr text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.id, r.session_id, r.user_id, r.family_id, r.expires_at, r.used_at,
         s.revoked_at IS NOT NULL, s.tenant_id, s.amr
  FROM refresh_tokens r JOIN auth_sessions s ON s.id = r.session_id
  WHERE r.token_hash = p_hash
$$;

CREATE FUNCTION app.consume_email_token(p_hash bytea, p_purpose text) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE email_tokens SET used_at = now()
  WHERE token_hash = p_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > now()
  RETURNING user_id
$$;

CREATE FUNCTION app.peek_email_token(p_hash bytea, p_purpose text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT user_id FROM email_tokens
  WHERE token_hash = p_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > now()
$$;

CREATE FUNCTION app.find_invitation(p_hash bytea)
RETURNS TABLE (invitation_id uuid, tenant_id uuid, tenant_name text, email citext, role_key text,
               expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT i.id, i.tenant_id, t.name, i.email, i.role_key, i.expires_at, i.accepted_at, i.revoked_at
  FROM invitations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_hash AND t.status IN ('trial', 'active')
$$;

CREATE FUNCTION app.resolve_sso_provider(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.tenant_id FROM tenant_sso_providers p JOIN tenants t ON t.id = p.tenant_id
  WHERE p.id = p_id AND p.enabled AND t.status IN ('trial', 'active')
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_id(), app.user_id() TO runvara_app;
GRANT EXECUTE ON FUNCTION app.find_user_for_login(citext), app.email_registered(citext), app.slug_available(citext),
  app.list_my_tenants(), app.find_refresh_token(bytea), app.consume_email_token(bytea, text), app.peek_email_token(bytea, text),
  app.find_invitation(bytea), app.resolve_sso_provider(uuid) TO runvara_app;

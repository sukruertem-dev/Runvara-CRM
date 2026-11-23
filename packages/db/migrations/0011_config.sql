-- 0011 configuration engine (P7a, ADR-0011, docs/p7-plan.md §1–4): layered, versioned tenant settings and the
-- tenant logo. Every write is a new immutable version row; the head table points at the current one. A
-- revert writes the old value again as a new version, so history is never rewritten.

CREATE TABLE tenant_settings (
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  scope_type     text NOT NULL CHECK (scope_type IN ('tenant', 'team', 'user')),
  -- tenant: the tenant id; team: the team id; user: the user id.
  scope_id       uuid NOT NULL,
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(key) <= 64),
  version        integer NOT NULL CHECK (version > 0),
  -- The layer's own (partial) value; {} means the layer no longer overrides anything.
  value          jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  change_note    text CHECK (length(change_note) <= 500),
  reverted_from  integer,
  PRIMARY KEY (tenant_id, scope_type, scope_id, key, version)
);
CREATE TRIGGER tenant_settings_immutable BEFORE UPDATE OR DELETE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE tenant_settings_head (
  tenant_id  uuid NOT NULL,
  scope_type text NOT NULL,
  scope_id   uuid NOT NULL,
  key        text NOT NULL,
  version    integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope_type, scope_id, key),
  FOREIGN KEY (tenant_id, scope_type, scope_id, key, version) REFERENCES tenant_settings (tenant_id, scope_type, scope_id, key, version)
);
CREATE TRIGGER tenant_settings_head_touch BEFORE UPDATE ON tenant_settings_head FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Tenant logo (CFG-06). Small images live in the database: no object storage needed and the row goes with
-- the tenant on export and deletion. SVG is stored only after server-side sanitizing.
CREATE TABLE tenant_assets (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  kind       text NOT NULL CHECK (kind IN ('logo')),
  mime       text NOT NULL CHECK (mime IN ('image/png', 'image/webp', 'image/svg+xml')),
  bytes      bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 524288),
  sha256     bytea NOT NULL CHECK (octet_length(sha256) = 32),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_assets_tenant ON tenant_assets (tenant_id, kind, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings', 'tenant_settings_head', 'tenant_assets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON tenant_settings TO flexa_app;
GRANT SELECT, INSERT, UPDATE ON tenant_settings_head TO flexa_app;
GRANT SELECT, INSERT, DELETE ON tenant_assets TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- Tenant notification defaults (key notifications.defaults): users without their own preference row
-- get the tenant default; without a tenant value the platform default is in-app only.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.default_channels(p_tenant uuid, p_kind text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    (SELECT ARRAY(SELECT jsonb_array_elements_text(s.value -> p_kind))
       FROM tenant_settings_head h
       JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
      WHERE h.tenant_id = p_tenant AND h.scope_type = 'tenant' AND h.scope_id = p_tenant AND h.key = 'notifications.defaults'
        AND s.value ? p_kind),
    ARRAY['in_app'])
$$;
REVOKE ALL ON FUNCTION app.default_channels(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.default_channels(uuid, text) TO flexa_app;

CREATE OR REPLACE FUNCTION app.digest_candidates(p_age interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT n.tenant_id, n.user_id FROM notifications n
  LEFT JOIN notification_preferences p ON p.tenant_id = n.tenant_id AND p.user_id = n.user_id AND p.kind = n.kind
  WHERE n.read_at IS NULL AND n.emailed_at IS NULL AND n.retracted_at IS NULL AND n.created_at <= now() - p_age
    AND 'email' = ANY (COALESCE(p.channels, app.default_channels(n.tenant_id, n.kind)))
  LIMIT p_limit
$$;

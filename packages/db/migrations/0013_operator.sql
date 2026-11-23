-- 0013 platform operator, support access, tenant export and deletion (P7c, ADR-0014 §5–6, docs/p7-plan.md §13–15).

-- ---------------------------------------------------------------------------------------------
-- Platform operators (global). A user marked as operator; the app role only reads its own row. Operators are
-- added with the owner connection (scripts/grant-operator.mjs).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE platform_operators (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operators FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_self ON platform_operators USING (user_id = app.user_id());
GRANT SELECT ON platform_operators TO flexa_app;

CREATE FUNCTION app.is_operator() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM platform_operators WHERE user_id = app.user_id())
$$;
REVOKE ALL ON FUNCTION app.is_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_operator() TO flexa_app;

-- Every operator action, kept even when the tenant is deleted (no foreign key to tenants on purpose).
CREATE TABLE operator_actions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  -- NULL: the platform itself (the deletion job).
  operator_user_id uuid,
  operator_name    text,
  tenant_id        uuid,
  action           text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_.]+$'),
  details          jsonb NOT NULL DEFAULT '{}',
  ip               inet,
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_actions_tenant ON operator_actions (tenant_id, at DESC);
CREATE TRIGGER operator_actions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON operator_actions
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();
ALTER TABLE operator_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_only ON operator_actions USING (app.is_operator()) WITH CHECK (app.is_operator() AND operator_user_id = app.user_id());
GRANT SELECT, INSERT ON operator_actions TO flexa_app;

-- Tenant list for the console: metadata only, never record content.
CREATE FUNCTION app.operator_tenants()
RETURNS TABLE (id uuid, slug text, name text, status text, sales_mode text, created_at timestamptz, status_changed_at timestamptz,
               deletion_scheduled_at timestamptz, plan_id text, add_ons text[], limit_overrides jsonb, trial_ends_at timestamptz, members integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_operator() THEN RAISE EXCEPTION 'not a platform operator' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY
    SELECT t.id, t.slug::text, t.name, t.status, t.sales_mode, t.created_at, t.status_changed_at, t.deletion_scheduled_at,
           p.plan_id, p.add_ons, p.limit_overrides, p.trial_ends_at,
           (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active')
    FROM tenants t LEFT JOIN tenant_plans p ON p.tenant_id = t.id
    ORDER BY t.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION app.operator_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_tenants() TO flexa_app;

-- The plan is changed by operators (P7b granted only SELECT, INSERT).
GRANT UPDATE ON tenant_plans TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- Support access (TEN-08): requested by an operator, decided by the tenant's Admin, time-boxed, read-only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE support_access_grants (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  operator_user_id uuid NOT NULL REFERENCES users (id),
  -- Snapshot: the operator is not a member, so the workspace cannot read their user row.
  operator_name    text NOT NULL CHECK (length(operator_name) BETWEEN 1 AND 120),
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  -- Empty: every enabled module. Otherwise the support context sees only these.
  modules          text[] NOT NULL DEFAULT '{}',
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'cancelled')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text CHECK (length(decision_note) <= 500),
  valid_until      timestamptz,
  revoked_by       uuid,
  revoked_at       timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'approved') <= (valid_until IS NOT NULL))
);
CREATE INDEX support_access_grants_tenant ON support_access_grants (tenant_id, requested_at DESC);

ALTER TABLE auth_sessions ADD COLUMN support_grant_id uuid;

-- ---------------------------------------------------------------------------------------------
-- Tenant exports (TEN-05): NDJSON + gzip in object storage, downloadable for 7 days.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenant_exports (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  requested_by uuid NOT NULL,
  requested_as text NOT NULL DEFAULT 'admin' CHECK (requested_as IN ('admin', 'operator')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ready', 'failed', 'expired')),
  object_key   text,
  size_bytes   bigint,
  row_count    bigint,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at   timestamptz
);
CREATE INDEX tenant_exports_tenant ON tenant_exports (tenant_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_access_grants', 'tenant_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON support_access_grants, tenant_exports TO flexa_app;

-- Support sessions are validated before a tenant context exists (the operator is not a member).
CREATE FUNCTION app.support_grant_for_session(p_session uuid)
RETURNS TABLE (grant_id uuid, tenant_id uuid, operator_user_id uuid, modules text[], valid_until timestamptz, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT g.id, g.tenant_id, g.operator_user_id, g.modules, g.valid_until,
         (g.status = 'approved' AND g.valid_until > now() AND t.status IN ('trial', 'active'))
  FROM auth_sessions s
  JOIN support_access_grants g ON g.id = s.support_grant_id
  JOIN tenants t ON t.id = g.tenant_id
  WHERE s.id = p_session AND s.user_id = app.user_id() AND s.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.support_grant_for_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.support_grant_for_session(uuid) TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- Tenant deletion (TEN-05). Append-only tables accept deletes only inside app.purge_tenant().
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.purge_tenant', true), '') <> '' THEN
    RETURN CASE WHEN TG_LEVEL = 'ROW' THEN OLD ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- Tables holding tenant rows, children before parents (foreign keys among them decide the order).
CREATE FUNCTION app.tenant_tables_child_first() RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  remaining text[];
  ordered text[] := '{}';
  t text;
  progressed boolean;
BEGIN
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO remaining
  FROM information_schema.columns c
  JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND c.table_name NOT IN ('tenants', 'operator_actions', 'auth_events', 'auth_sessions');
  WHILE cardinality(remaining) > 0 LOOP
    progressed := false;
    FOREACH t IN ARRAY remaining LOOP
      -- A table can go when no other remaining table references it.
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint k
        WHERE k.contype = 'f' AND k.confrelid = ('public.' || t)::regclass AND k.conrelid <> k.confrelid
          AND k.conrelid::regclass::text = ANY (remaining)
      ) THEN
        ordered := ordered || t;
        remaining := array_remove(remaining, t);
        progressed := true;
      END IF;
    END LOOP;
    IF NOT progressed THEN RAISE EXCEPTION 'foreign key cycle among %', remaining; END IF;
  END LOOP;
  RETURN ordered;
END $$;

CREATE FUNCTION app.purge_tenant(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t text;
  n bigint;
  counts jsonb := '{}';
  pass int;
  left_over bigint;
  members uuid[];
BEGIN
  PERFORM 1 FROM tenants WHERE id = p_tenant AND status = 'pending_deletion' AND deletion_scheduled_at <= now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant % is not due for deletion', p_tenant USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  SELECT coalesce(array_agg(user_id), '{}') INTO members FROM memberships WHERE tenant_id = p_tenant;
  PERFORM set_config('app.purge_tenant', p_tenant::text, true);
  -- Sessions bound to the tenant end first (auth_sessions is a user table; only the tenant link goes).
  UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'tenant_deleted' WHERE tenant_id = p_tenant AND revoked_at IS NULL;
  UPDATE auth_sessions SET tenant_id = NULL WHERE tenant_id = p_tenant;
  -- Two passes: delete triggers may write rows into tables that were already emptied.
  FOR pass IN 1..2 LOOP
    FOREACH t IN ARRAY app.tenant_tables_child_first() LOOP
      EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', t) USING p_tenant;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN counts := jsonb_set(counts, ARRAY[t], to_jsonb(coalesce((counts ->> t)::bigint, 0) + n)); END IF;
    END LOOP;
  END LOOP;
  FOREACH t IN ARRAY app.tenant_tables_child_first() LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1', t) INTO left_over USING p_tenant;
    IF left_over > 0 THEN RAISE EXCEPTION 'rows left in % after purge', t; END IF;
  END LOOP;
  -- People who belonged only to this workspace: personal data removed, the row kept for foreign keys.
  UPDATE users SET email = 'deleted+' || id::text || '@invalid', display_name = 'Silinmiş kullanıcı', status = 'disabled'
  WHERE id = ANY (members)
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)
    AND NOT EXISTS (SELECT 1 FROM platform_operators o WHERE o.user_id = users.id);
  DELETE FROM user_credentials WHERE user_id = ANY (members) AND user_id IN (SELECT id FROM users WHERE status = 'disabled' AND email LIKE 'deleted+%@invalid');
  DELETE FROM user_mfa WHERE user_id = ANY (members) AND user_id IN (SELECT id FROM users WHERE status = 'disabled' AND email LIKE 'deleted+%@invalid');
  UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'user_deleted'
  WHERE user_id = ANY (members) AND revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE status = 'disabled' AND email LIKE 'deleted+%@invalid');
  UPDATE tenants SET status = 'deleted', name = 'Silinmiş çalışma alanı', slug = 'deleted-' || left(replace(id::text, '-', ''), 12),
    status_changed_at = now(), deletion_scheduled_at = NULL
  WHERE id = p_tenant;
  -- Evidence that outlives the tenant: what was removed, never what it contained.
  INSERT INTO operator_actions (operator_user_id, tenant_id, action, details)
  VALUES (NULL, p_tenant, 'tenant.purged', jsonb_build_object('rows', counts, 'anonymizedUsers',
    (SELECT count(*) FROM users WHERE id = ANY (members) AND email LIKE 'deleted+%@invalid')));
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION app.purge_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_tenant(uuid) TO flexa_app;

-- Tenants whose deletion is due (for the deletion job, which has no tenant context yet).
CREATE FUNCTION app.tenants_due_for_deletion() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM tenants WHERE status = 'pending_deletion' AND deletion_scheduled_at <= now() ORDER BY deletion_scheduled_at
$$;
REVOKE ALL ON FUNCTION app.tenants_due_for_deletion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenants_due_for_deletion() TO flexa_app;

-- A workspace waiting for deletion can still be entered: its Admin may cancel or export (TEN-05). The API
-- lets such a session reach only those screens.
CREATE OR REPLACE FUNCTION app.list_my_tenants()
RETURNS TABLE (tenant_id uuid, slug citext, name text, status text, role_keys text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.slug, t.name, t.status,
         coalesce(array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL), '{}')
  FROM memberships m
  JOIN tenants t ON t.id = m.tenant_id
  LEFT JOIN user_roles ur ON ur.tenant_id = m.tenant_id AND ur.user_id = m.user_id
       AND (ur.valid_until IS NULL OR ur.valid_until > now())
  LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
  WHERE m.user_id = app.user_id() AND m.status = 'active' AND t.status IN ('trial', 'active', 'pending_deletion')
  GROUP BY t.id, t.slug, t.name, t.status
  ORDER BY t.name
$$;

-- An operator's own support requests across tenants (the console has no tenant context).
CREATE FUNCTION app.operator_grants()
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, operator_user_id uuid, operator_name text, reason text, modules text[],
               duration_minutes integer, status text, requested_at timestamptz, decided_at timestamptz, decision_note text, valid_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT app.is_operator() THEN RAISE EXCEPTION 'not a platform operator' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN QUERY
    SELECT g.id, g.tenant_id, t.name, g.operator_user_id, g.operator_name, g.reason, g.modules, g.duration_minutes, g.status,
           g.requested_at, g.decided_at, g.decision_note, g.valid_until
    FROM support_access_grants g JOIN tenants t ON t.id = g.tenant_id
    WHERE g.operator_user_id = app.user_id()
    ORDER BY g.requested_at DESC
    LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION app.operator_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_grants() TO flexa_app;

-- Finished exports past their download window (for the hourly clean-up job).
CREATE FUNCTION app.expired_exports() RETURNS TABLE (id uuid, tenant_id uuid, object_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, tenant_id, object_key FROM tenant_exports WHERE status = 'ready' AND expires_at <= now() ORDER BY expires_at LIMIT 500
$$;
REVOKE ALL ON FUNCTION app.expired_exports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_exports() TO flexa_app;

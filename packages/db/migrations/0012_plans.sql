-- 0012 plans, quota and usage (P7b, ADR-0014 §3, docs/p7-plan.md §9). Plan definitions live in code
-- (packages/modules/src/plans.json); a tenant row names its plan, its add-on modules and negotiated limits.

CREATE TABLE tenant_plans (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants (id),
  plan_id         text NOT NULL CHECK (plan_id IN ('trial', 'starter', 'growth', 'enterprise')),
  add_ons         text[] NOT NULL DEFAULT '{}',
  -- Per-dimension limits that replace the plan's (e.g. {"users": 75}).
  limit_overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(limit_overrides) = 'object'),
  trial_ends_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((plan_id = 'trial') = (trial_ends_at IS NOT NULL))
);
CREATE TRIGGER tenant_plans_touch BEFORE UPDATE ON tenant_plans FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Daily usage per dimension. Counters (API requests, call minutes, AI tokens) are summed from Redis every
-- minute; gauges (users, storage, records) are snapshots of the day's last measurement.
CREATE TABLE tenant_usage_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  day        date NOT NULL,
  dimension  text NOT NULL CHECK (dimension IN ('api_requests', 'call_minutes', 'ai_tokens', 'users', 'storage_bytes', 'records')),
  value      bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, dimension)
);

-- One alert per dimension, level and month (80 % warning, 100 % soft, 120 % hard).
CREATE TABLE tenant_quota_alerts (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  dimension   text NOT NULL CHECK (dimension IN ('users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens')),
  level       text NOT NULL CHECK (level IN ('warning', 'soft', 'hard')),
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  used        bigint NOT NULL,
  quota_limit bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, dimension, level, period)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_plans', 'tenant_usage_counters', 'tenant_quota_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
-- The plan is changed by the platform operator (P7c); the tenant's own API only reads it. Inserting is for
-- tenant creation.
GRANT SELECT, INSERT ON tenant_plans TO flexa_app;
GRANT SELECT, INSERT, UPDATE ON tenant_usage_counters TO flexa_app;
GRANT SELECT, INSERT ON tenant_quota_alerts TO flexa_app;

-- Tenants that existed before plans keep everything they had.
INSERT INTO tenant_plans (tenant_id, plan_id) SELECT id, 'enterprise' FROM tenants ON CONFLICT DO NOTHING;

-- Background usage jobs visit every live tenant; this is the only cross-tenant read they need.
CREATE FUNCTION app.live_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id FROM tenants WHERE status IN ('trial', 'active') ORDER BY id
$$;
REVOKE ALL ON FUNCTION app.live_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.live_tenant_ids() TO flexa_app;

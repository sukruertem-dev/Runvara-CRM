-- P9c (docs/p9-plan.md §15–20): forecast adjustments and snapshots, untouched-opportunity alerts.

-- A Manager's call for one person, period and currency; replaces the computed forecast of that person.
CREATE TABLE forecast_adjustments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  period        text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  owner_user_id uuid NOT NULL,
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount        numeric(18,4) NOT NULL CHECK (amount >= 0),
  note          text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  updated_by    uuid NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, owner_user_id, currency),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id)
);

-- What the forecast said at a moment: one row per person and currency. Never changed afterwards.
CREATE TABLE forecast_snapshots (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  period    text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2]|Q[1-4])$'),
  kind      text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  taken_by  uuid,
  taken_at  timestamptz NOT NULL DEFAULT now(),
  rows      jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  CHECK ((kind = 'manual') = (taken_by IS NOT NULL))
);
CREATE INDEX forecast_snapshots_period ON forecast_snapshots (tenant_id, period, taken_at DESC);
CREATE TRIGGER forecast_snapshots_immutable BEFORE UPDATE OR DELETE ON forecast_snapshots FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- One alert per opportunity and last touch: a new touch makes a later alert possible again.
CREATE TABLE opportunity_stale_alerts (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  opportunity_id uuid NOT NULL,
  touched_at     timestamptz NOT NULL,
  alerted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, opportunity_id, touched_at),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['forecast_adjustments', 'forecast_snapshots', 'opportunity_stale_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON forecast_adjustments TO flexa_app;
GRANT SELECT, INSERT ON forecast_snapshots, opportunity_stale_alerts TO flexa_app;

-- Workspaces whose B2B module is on (scheduled forecast snapshots and the untouched-opportunity scan).
CREATE FUNCTION app.b2b_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id FROM tenants t JOIN tenant_modules m ON m.tenant_id = t.id AND m.module_id = 'sales_b2b' AND m.enabled
  WHERE t.status IN ('trial', 'active') ORDER BY t.id
$$;
REVOKE ALL ON FUNCTION app.b2b_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.b2b_tenants() TO flexa_app;

-- P8b (docs/p8-plan.md §7–10, ADR-0021): approval requests with routing history, approver limits, sales targets.

-- How much a person may approve; without a row the tenant's `approvals` configuration applies.
CREATE TABLE approval_limits (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('discount')),
  max_percent numeric(5,2) NOT NULL CHECK (max_percent BETWEEN 0 AND 100),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, kind),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  kind          text NOT NULL CHECK (kind IN ('discount')),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  segment       segment NOT NULL,
  requested_by  uuid NOT NULL,
  percent       numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  -- Within the requester's own authority: approved without anyone deciding.
  automatic     boolean NOT NULL DEFAULT false,
  level         integer NOT NULL DEFAULT 1 CHECK (level > 0),
  -- The approver and the team whose manager they are; both null = any Admin.
  assigned_to   uuid,
  level_team_id uuid,
  due_at        timestamptz,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'pending') = (decided_at IS NULL)),
  CHECK (decided_by IS DISTINCT FROM requested_by OR state = 'cancelled'),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, level_team_id) REFERENCES teams (tenant_id, id) ON DELETE SET NULL (level_team_id),
  FOREIGN KEY (tenant_id, subject_type, subject_id) REFERENCES record_registry (tenant_id, record_type, record_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX approval_requests_one_pending ON approval_requests (tenant_id, kind, subject_type, subject_id) WHERE state = 'pending';
CREATE INDEX approval_requests_due ON approval_requests (due_at) WHERE state = 'pending';
CREATE INDEX approval_requests_assignee ON approval_requests (tenant_id, assigned_to) WHERE state = 'pending';
CREATE INDEX approval_requests_requester ON approval_requests (tenant_id, requested_by, created_at DESC);

-- Routing and decision history (append-only).
CREATE TABLE approval_steps (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  request_id  uuid NOT NULL REFERENCES approval_requests (id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('requested', 'auto_approved', 'assigned', 'escalated', 'approved', 'rejected', 'cancelled', 'expired')),
  actor_id    uuid,
  assigned_to uuid,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX approval_steps_request ON approval_steps (tenant_id, request_id, id);

CREATE TABLE sales_targets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'team', 'segment')),
  user_id      uuid,
  team_id      uuid,
  segment      segment,
  period       text NOT NULL CHECK (period IN ('month', 'quarter')),
  period_start date NOT NULL CHECK (extract(day FROM period_start) = 1),
  metric       text NOT NULL CHECK (metric IN ('won_amount', 'won_count', 'tasks_closed')),
  target_value numeric(18,4) NOT NULL CHECK (target_value > 0),
  currency     char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  at_risk_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'user') = (user_id IS NOT NULL)),
  CHECK ((subject_type = 'team') = (team_id IS NOT NULL)),
  CHECK (subject_type <> 'segment' OR segment IS NOT NULL),
  CHECK ((metric = 'won_amount') = (currency IS NOT NULL)),
  CHECK (period <> 'quarter' OR extract(month FROM period_start) IN (1, 4, 7, 10)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX sales_targets_one ON sales_targets (tenant_id, subject_type, user_id, team_id, segment, period, period_start, metric) NULLS NOT DISTINCT;
CREATE INDEX sales_targets_period ON sales_targets (period_start) WHERE at_risk_at IS NULL;
CREATE TRIGGER sales_targets_touch BEFORE UPDATE ON sales_targets FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_limits', 'approval_requests', 'approval_steps', 'sales_targets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_limits, sales_targets TO flexa_app;
GRANT SELECT, INSERT, UPDATE ON approval_requests TO flexa_app;
GRANT SELECT, INSERT ON approval_steps TO flexa_app;

CREATE POLICY segment_isolation ON approval_requests AS RESTRICTIVE
  USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON sales_targets AS RESTRICTIVE
  USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY request_visible ON approval_steps AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM approval_requests r WHERE r.tenant_id = approval_steps.tenant_id AND r.id = approval_steps.request_id));

-- Work lists of the background jobs (ids only; the work itself runs in the tenant's context).
CREATE FUNCTION app.due_approvals(p_limit integer) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.id FROM approval_requests r JOIN tenants t ON t.id = r.tenant_id
  WHERE r.state = 'pending' AND r.due_at <= now() AND t.status IN ('trial', 'active') ORDER BY r.due_at LIMIT p_limit
$$;
CREATE FUNCTION app.open_targets(p_limit integer) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT g.tenant_id, g.id FROM sales_targets g JOIN tenants t ON t.id = g.tenant_id
  WHERE g.at_risk_at IS NULL AND t.status IN ('trial', 'active')
    AND g.period_start <= (now() AT TIME ZONE t.timezone)::date
    AND (now() AT TIME ZONE t.timezone)::date < (g.period_start + CASE g.period WHEN 'month' THEN interval '1 month' ELSE interval '3 months' END)::date
  ORDER BY g.period_start, g.id LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.due_approvals(integer), app.open_targets(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_approvals(integer), app.open_targets(integer) TO flexa_app;

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'assigned', 'automation', 'approval'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK (kind IN ('mention', 'assigned', 'automation', 'approval'));

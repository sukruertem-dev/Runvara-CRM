-- 0007 integrations (P5b, docs/p5-plan.md §5): SLA calendars/policies/timers, webhook subscriptions and
-- deliveries, API keys, notification e-mail digest marker, `sla` automation trigger.

-- ---------------------------------------------------------------------------------------------
-- SLA (ADR-0020): business calendars, policies, timers (the table is the source of truth; the minute
-- checker in the automation service turns due timers into sla.warning / sla.breached events)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE business_calendars (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  timezone     text NOT NULL,
  weekly_hours jsonb NOT NULL CHECK (jsonb_typeof(weekly_hours) = 'array'),
  holidays     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(holidays) = 'array'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER business_calendars_touch BEFORE UPDATE ON business_calendars FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE sla_policies (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  name                   text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  resource_type          text NOT NULL CHECK (resource_type IN ('case', 'task', 'lead')),
  criteria               text NOT NULL DEFAULT '' CHECK (length(criteria) <= 2000),
  position               integer NOT NULL DEFAULT 0,
  calendar_id            uuid NOT NULL,
  first_response_minutes integer CHECK (first_response_minutes BETWEEN 1 AND 525600),
  resolution_minutes     integer CHECK (resolution_minutes BETWEEN 1 AND 525600),
  warn_percent           smallint NOT NULL DEFAULT 80 CHECK (warn_percent BETWEEN 1 AND 99),
  pause_statuses         text[] NOT NULL DEFAULT '{}',
  enabled                boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (first_response_minutes IS NOT NULL OR resolution_minutes IS NOT NULL),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES business_calendars (tenant_id, id)
);

CREATE TABLE sla_timers (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  record_type       text NOT NULL,
  record_id         uuid NOT NULL,
  segment           segment,
  policy_id         uuid NOT NULL,
  milestone         text NOT NULL CHECK (milestone IN ('first_response', 'resolution')),
  state             text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'paused', 'met', 'breached')),
  budget_minutes    integer NOT NULL,
  started_at        timestamptz NOT NULL,
  target_at         timestamptz,
  warn_at           timestamptz,
  remaining_minutes numeric(12, 3),
  paused_at         timestamptz,
  warned_at         timestamptz,
  breached_at       timestamptz,
  met_at            timestamptz,
  UNIQUE (tenant_id, record_type, record_id, milestone),
  CHECK ((state = 'paused') = (paused_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES sla_policies (tenant_id, id),
  FOREIGN KEY (tenant_id, record_type, record_id) REFERENCES record_registry (tenant_id, record_type, record_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX sla_timers_due ON sla_timers (warn_at) WHERE state = 'running' AND warned_at IS NULL;
CREATE INDEX sla_timers_breach ON sla_timers (target_at) WHERE state = 'running';

-- Timers due across all tenants (the checker then works inside each tenant's context).
CREATE FUNCTION app.due_sla_timers(p_limit integer)
RETURNS TABLE (tenant_id uuid, timer_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT tenant_id, id FROM sla_timers
  WHERE state = 'running' AND ((warned_at IS NULL AND warn_at <= now()) OR target_at <= now())
  ORDER BY least(coalesce(warn_at, target_at), target_at) LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.due_sla_timers(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_sla_timers(integer) TO flexa_app;

-- Automation rules may react to SLA events.
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_type_check;
ALTER TABLE automation_rules ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN ('record.created', 'record.updated', 'field_changed', 'status_changed', 'schedule', 'inbound_webhook', 'sla'));

-- ---------------------------------------------------------------------------------------------
-- Webhooks (ADR-0013 §1)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE webhook_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  url                  text NOT NULL CHECK (length(url) <= 2000),
  event_types          text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  secret_enc           bytea NOT NULL,
  previous_secret_enc  bytea,
  previous_valid_until timestamptz,
  key_version          integer NOT NULL,
  enabled              boolean NOT NULL DEFAULT true,
  disabled_reason      text CHECK (disabled_reason IN ('manual', 'auto_failures')),
  first_failure_at     timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  subscription_id uuid NOT NULL,
  event_id        uuid NOT NULL,
  event_type      text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  response_status integer,
  error           text,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  UNIQUE (tenant_id, subscription_id, event_id),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES webhook_subscriptions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_sub ON webhook_deliveries (tenant_id, subscription_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- API keys: the key acts with its creator's current rights, narrowed to its scopes
-- ---------------------------------------------------------------------------------------------
CREATE TABLE api_keys (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  prefix                text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{8}$'),
  key_hash              bytea NOT NULL UNIQUE,
  scopes                text[] NOT NULL CHECK (scopes <@ ARRAY['read', 'write'] AND cardinality(scopes) >= 1),
  rate_limit_per_minute integer NOT NULL DEFAULT 600 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  revoked_at            timestamptz,
  last_used_at          timestamptz,
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
);

-- Authenticating a key happens before any tenant context exists.
CREATE FUNCTION app.resolve_api_key(p_hash bytea)
RETURNS TABLE (key_id uuid, tenant_id uuid, user_id uuid, scopes text[], rate_limit_per_minute integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT id, tenant_id, created_by, scopes, rate_limit_per_minute FROM api_keys
  WHERE key_hash = p_hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
$$;
REVOKE ALL ON FUNCTION app.resolve_api_key(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_api_key(bytea) TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- Notification e-mail digest
-- ---------------------------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN emailed_at timestamptz;
CREATE INDEX notifications_digest ON notifications (created_at) WHERE read_at IS NULL AND emailed_at IS NULL AND retracted_at IS NULL;

-- Users with unread notifications older than p_age that were not e-mailed yet and want e-mail for the kind.
CREATE FUNCTION app.digest_candidates(p_age interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT n.tenant_id, n.user_id FROM notifications n
  JOIN notification_preferences p ON p.tenant_id = n.tenant_id AND p.user_id = n.user_id AND p.kind = n.kind AND 'email' = ANY (p.channels)
  WHERE n.read_at IS NULL AND n.emailed_at IS NULL AND n.retracted_at IS NULL AND n.created_at <= now() - p_age
  LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.digest_candidates(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.digest_candidates(interval, integer) TO flexa_app;

-- The recipient's digest marks their own rows; the writer (digest job) acts in no user's context.
CREATE FUNCTION app.mark_digested(p_user uuid, p_ids uuid[]) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (UPDATE notifications SET emailed_at = now() WHERE tenant_id = app.tenant_id() AND user_id = p_user AND id = ANY (p_ids) RETURNING 1)
  SELECT count(*)::int FROM r
$$;
REVOKE ALL ON FUNCTION app.mark_digested(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_digested(uuid, uuid[]) TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_calendars', 'sla_policies', 'sla_timers', 'webhook_subscriptions', 'webhook_deliveries', 'api_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
CREATE POLICY segment_isolation ON sla_timers AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));

-- 0006 automation (P5a, docs/p5-plan.md, ADR-0006): transactional outbox, consumer idempotency, automation
-- rules + run log, dead letters, assignment policies.

-- ---------------------------------------------------------------------------------------------
-- Outbox: written in the same transaction as the business change; published by the relay role.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  type           text NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_.]+$'),
  version        smallint NOT NULL DEFAULT 1,
  resource_type  text,
  resource_id    uuid,
  segment        segment,
  actor          jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  payload        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  causation_id   uuid,
  correlation_id uuid NOT NULL,
  depth          smallint NOT NULL DEFAULT 0 CHECK (depth >= 0),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON outbox_events (occurred_at, id) WHERE published_at IS NULL;

-- Wake the relay as soon as a transaction with events commits (NOTIFY is delivered on commit only).
CREATE FUNCTION app.outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox_events FOR EACH STATEMENT EXECUTE FUNCTION app.outbox_notify();

-- Exactly-once effect per consumer: the marker is written in the consumer's transaction.
CREATE TABLE processed_events (
  tenant_id    uuid NOT NULL,
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, event_id)
);

-- ---------------------------------------------------------------------------------------------
-- Automation rules, runs, dead letters
-- ---------------------------------------------------------------------------------------------
CREATE TABLE automation_rules (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description     text CHECK (length(description) <= 1000),
  enabled         boolean NOT NULL DEFAULT true,
  resource_type   text NOT NULL CHECK (resource_type IN ('task', 'account', 'contact', 'lead', 'opportunity', 'case')),
  trigger_type    text NOT NULL CHECK (trigger_type IN ('record.created', 'record.updated', 'field_changed', 'status_changed', 'schedule', 'inbound_webhook')),
  definition      jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  hook_token_hash bytea,
  run_as          uuid NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK ((trigger_type = 'inbound_webhook') = (hook_token_hash IS NOT NULL)),
  FOREIGN KEY (tenant_id, run_as) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX automation_rules_trigger ON automation_rules (tenant_id, resource_type, trigger_type) WHERE enabled;
CREATE TRIGGER automation_rules_touch BEFORE UPDATE ON automation_rules FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE automation_runs (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  rule_id          uuid NOT NULL,
  rule_version     integer NOT NULL,
  event_id         uuid NOT NULL,
  correlation_id   uuid NOT NULL,
  depth            smallint NOT NULL,
  record_type      text NOT NULL,
  record_id        uuid NOT NULL,
  status           text NOT NULL CHECK (status IN ('succeeded', 'skipped', 'failed', 'halted_depth', 'halted_loop', 'dead')),
  condition_result boolean,
  input            jsonb NOT NULL DEFAULT '{}',
  actions          jsonb NOT NULL DEFAULT '[]',
  error            text,
  attempt          integer NOT NULL DEFAULT 1,
  duration_ms      integer,
  started_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_id, event_id, record_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES automation_rules (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX automation_runs_rule ON automation_runs (tenant_id, rule_id, started_at DESC);
CREATE INDEX automation_runs_chain ON automation_runs (tenant_id, correlation_id, rule_id, record_id);

CREATE TABLE dead_letters (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  consumer    text NOT NULL,
  event_id    uuid NOT NULL,
  event       jsonb NOT NULL,
  error       text NOT NULL,
  attempts    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_by uuid
);
CREATE INDEX dead_letters_open ON dead_letters (tenant_id, created_at DESC) WHERE replayed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Assignment policies (round-robin, load-balanced, fallback)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE assignment_policies (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  strategy         text NOT NULL CHECK (strategy IN ('round_robin', 'load_balanced')),
  team_id          uuid,
  queue_id         uuid,
  fallback_user_id uuid,
  last_user_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK ((team_id IS NULL) <> (queue_id IS NULL)),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, fallback_user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE SET NULL (fallback_user_id)
);

-- Notifications raised by automation rules.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('mention', 'assigned', 'automation'));
ALTER TABLE notifications ADD COLUMN message text CHECK (length(message) <= 500);
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_kind_check;
-- create_notifications gains the message (automation notices); same guarantees as in 0005.
DROP FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid);
CREATE FUNCTION app.create_notifications(p_users uuid[], p_kind text, p_source_type text, p_source_id uuid, p_record_type text, p_record_id uuid, p_message text)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (
    INSERT INTO notifications (tenant_id, user_id, kind, source_type, source_id, record_type, record_id, actor_id, message)
    SELECT app.tenant_id(), m.user_id, p_kind, p_source_type, p_source_id, p_record_type, p_record_id, app.user_id(), p_message
    FROM memberships m
    WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (p_users) AND m.status = 'active'
    ON CONFLICT (tenant_id, user_id, kind, source_type, source_id) DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM r
$$;
REVOKE ALL ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid, text) TO flexa_app;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_kind_check CHECK (kind IN ('mention', 'assigned', 'automation'));

-- ---------------------------------------------------------------------------------------------
-- RLS + grants. The relay role bypasses RLS (BYPASSRLS) and may only read and mark the outbox.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events', 'processed_events', 'automation_rules', 'automation_runs', 'dead_letters', 'assignment_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON outbox_events FROM flexa_app;
GRANT SELECT, UPDATE (published_at, attempts) ON outbox_events TO flexa_relay;
GRANT USAGE ON SCHEMA app TO flexa_relay;
-- Outbox rows carry the segment of their record; readers of the outbox (relay, consumers) are trusted
-- services that apply authorization per recipient, so no segment policy here.

-- Inbound webhook trigger: the request has no user and no tenant context yet; this resolver returns only
-- what is needed to verify the token and open the rule's tenant (and whether the module is on).
CREATE FUNCTION app.find_hook_rule(p_rule uuid)
RETURNS TABLE (tenant_id uuid, resource_type text, token_hash bytea, enabled boolean, module_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.resource_type, r.hook_token_hash, r.enabled,
         EXISTS (SELECT 1 FROM tenant_modules m WHERE m.tenant_id = r.tenant_id AND m.module_id = 'automation_sla' AND m.enabled)
  FROM automation_rules r WHERE r.id = p_rule AND r.trigger_type = 'inbound_webhook'
$$;
REVOKE ALL ON FUNCTION app.find_hook_rule(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_hook_rule(uuid) TO flexa_app;

-- Schedules are registered at start-up for every tenant (the scheduler is global, rules are per tenant).
CREATE FUNCTION app.list_schedule_rules()
RETURNS TABLE (tenant_id uuid, rule_id uuid, definition jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT r.tenant_id, r.id, r.definition FROM automation_rules r WHERE r.trigger_type = 'schedule' AND r.enabled
$$;
REVOKE ALL ON FUNCTION app.list_schedule_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_schedule_rules() TO flexa_app;

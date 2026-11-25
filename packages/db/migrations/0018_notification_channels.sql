-- P8d (docs/p8-plan.md §17–20): channels beyond the app (web push, e-mail only), delivery measurements.

-- A person who turned the in-app channel off but chose e-mail or push still gets those: the notice exists, only
-- the notification centre leaves it out.
ALTER TABLE notifications ADD COLUMN in_app boolean NOT NULL DEFAULT true;

DROP FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid, text);
CREATE FUNCTION app.create_notifications(p_users uuid[], p_kind text, p_source_type text, p_source_id uuid, p_record_type text, p_record_id uuid, p_message text,
                                         p_in_app boolean DEFAULT true)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (
    INSERT INTO notifications (tenant_id, user_id, kind, source_type, source_id, record_type, record_id, actor_id, message, in_app)
    SELECT app.tenant_id(), m.user_id, p_kind, p_source_type, p_source_id, p_record_type, p_record_id, app.user_id(), p_message, p_in_app
    FROM memberships m
    WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (p_users) AND m.status = 'active'
    ON CONFLICT (tenant_id, user_id, kind, source_type, source_id) DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM r
$$;
REVOKE ALL ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid, text, boolean) TO flexa_app;

-- ---------------------------------------------------------------------------------------------
-- Web push subscriptions: one browser, its owner only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL,
  endpoint   text NOT NULL CHECK (length(endpoint) BETWEEN 10 AND 2000),
  p256dh     text NOT NULL CHECK (length(p256dh) BETWEEN 80 AND 100),
  auth       text NOT NULL CHECK (length(auth) BETWEEN 20 AND 30),
  user_agent text CHECK (length(user_agent) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  UNIQUE (tenant_id, user_id, endpoint),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX push_subscriptions_endpoint ON push_subscriptions (endpoint);

-- How long a notice took to reach a channel. No content, no record: for the p95 target and the failure alarm.
CREATE TABLE notification_deliveries (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('stream', 'client', 'push', 'email')),
  status     text NOT NULL CHECK (status IN ('delivered', 'failed', 'gone', 'quiet', 'no_access')),
  latency_ms integer CHECK (latency_ms >= 0),
  at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX notification_deliveries_at ON notification_deliveries (at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_subscriptions', 'notification_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY own_rows ON %I AS RESTRICTIVE USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO flexa_app;
GRANT SELECT, INSERT ON notification_deliveries TO flexa_app;

-- A browser delivers to whoever registered it last: someone else's registration of the same browser ends, so a
-- shared computer never shows one person's notices to the next. The endpoint is an unguessable capability URL.
CREATE FUNCTION app.claim_push_endpoint(p_endpoint text) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint AND user_id <> app.user_id()
$$;
-- Figures over every workspace: counts and percentiles only.
CREATE FUNCTION app.delivery_stats(p_minutes integer)
RETURNS TABLE (channel text, delivered bigint, failed bigint, p50 double precision, p95 double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.channel, count(*) FILTER (WHERE d.status = 'delivered'), count(*) FILTER (WHERE d.status = 'failed'),
    percentile_cont(0.5) WITHIN GROUP (ORDER BY d.latency_ms) FILTER (WHERE d.status = 'delivered'),
    percentile_cont(0.95) WITHIN GROUP (ORDER BY d.latency_ms) FILTER (WHERE d.status = 'delivered')
  FROM notification_deliveries d WHERE d.at > now() - make_interval(mins => p_minutes) GROUP BY d.channel ORDER BY d.channel
$$;
CREATE FUNCTION app.prune_deliveries(p_days integer) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH d AS (DELETE FROM notification_deliveries WHERE at < now() - make_interval(days => p_days) RETURNING 1) SELECT count(*)::int FROM d
$$;
REVOKE ALL ON FUNCTION app.claim_push_endpoint(text), app.delivery_stats(integer), app.prune_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_push_endpoint(text), app.delivery_stats(integer), app.prune_deliveries(integer) TO flexa_app;

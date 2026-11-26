-- P9a (docs/p9-plan.md §5): e-mail of a sent quote. Written in the transaction that marks the version as sent, so a
-- queue that is down cannot lose the mail: what was not queued is queued again every minute.
CREATE TABLE quote_deliveries (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  position         integer NOT NULL CHECK (position >= 0),
  -- The mail without its attachment; the document is read from storage.
  mail             jsonb NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  -- The request that sends the quote queues the mail itself; the job takes over after this time.
  next_attempt_at  timestamptz NOT NULL DEFAULT now() + interval '1 minute',
  queued_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_version_id, position),
  FOREIGN KEY (tenant_id, quote_version_id) REFERENCES quote_versions (tenant_id, id)
);
CREATE INDEX quote_deliveries_pending ON quote_deliveries (next_attempt_at) WHERE queued_at IS NULL;

ALTER TABLE quote_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quote_deliveries AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY tenant_access ON quote_deliveries USING (true) WITH CHECK (true);
CREATE POLICY version_visible ON quote_deliveries AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM quote_versions v WHERE v.tenant_id = quote_deliveries.tenant_id AND v.id = quote_deliveries.quote_version_id));
GRANT SELECT, INSERT, UPDATE (attempts, next_attempt_at, queued_at) ON quote_deliveries TO flexa_app;

CREATE FUNCTION app.due_quote_deliveries(p_limit integer) RETURNS TABLE (tenant_id uuid, quote_version_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT d.tenant_id, d.quote_version_id FROM quote_deliveries d JOIN tenants t ON t.id = d.tenant_id
  WHERE d.queued_at IS NULL AND d.next_attempt_at <= now() AND t.status IN ('trial', 'active')
  GROUP BY d.tenant_id, d.quote_version_id ORDER BY min(d.next_attempt_at) LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.due_quote_deliveries(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_quote_deliveries(integer) TO flexa_app;

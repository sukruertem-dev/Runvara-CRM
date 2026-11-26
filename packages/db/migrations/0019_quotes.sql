-- P9a (docs/p9-plan.md §1–6, ADR-0021): quotes with immutable versions. A quote belongs to a B2B opportunity and
-- is as visible as the opportunity.

-- Numbers are handed out per tenant and year, without gaps among committed quotes.
CREATE TABLE quote_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  year      integer NOT NULL,
  last      integer NOT NULL CHECK (last > 0),
  PRIMARY KEY (tenant_id, year)
);

CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  number          text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  opportunity_id  uuid NOT NULL,
  segment         segment NOT NULL DEFAULT 'b2b' CHECK (segment = 'b2b'),
  currency        char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'expired')),
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  outcome_reason  text CHECK (length(outcome_reason) <= 500),
  note            jsonb,
  note_text       text CHECK (length(note_text) <= 100000),
  version         integer NOT NULL DEFAULT 1,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX quotes_opportunity ON quotes (tenant_id, opportunity_id, id DESC);
CREATE INDEX quotes_sent ON quotes (tenant_id, id) WHERE status = 'sent';
CREATE TRIGGER quotes_touch BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE quote_versions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  quote_id         uuid NOT NULL,
  version          integer NOT NULL CHECK (version > 0),
  discount_percent numeric(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  valid_until      date NOT NULL,
  intro            text NOT NULL DEFAULT '' CHECK (length(intro) <= 4000),
  terms            text NOT NULL DEFAULT '' CHECK (length(terms) <= 8000),
  customer         jsonb NOT NULL DEFAULT '{}',
  totals           jsonb NOT NULL DEFAULT '{}',
  -- Highest discount of a line against its list price: what approval is asked for.
  approval_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (approval_percent BETWEEN 0 AND 100),
  -- Content is fixed while submitted; sent content is fixed for good.
  locked_at        timestamptz,
  sent_at          timestamptz,
  sent_by          uuid,
  sent_to          text[],
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quote_id, version),
  CHECK (sent_at IS NULL OR locked_at IS NOT NULL),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id)
);

CREATE TABLE quote_lines (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  position         integer NOT NULL CHECK (position >= 0),
  product_id       uuid NOT NULL,
  sku              text NOT NULL,
  name             text NOT NULL,
  unit             text NOT NULL,
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  quantity         numeric(14,3) NOT NULL CHECK (quantity > 0),
  list_price       numeric(18,4) CHECK (list_price >= 0),
  price_list_id    uuid,
  unit_price       numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  tax_percent      numeric(6,3) NOT NULL DEFAULT 0 CHECK (tax_percent BETWEEN 0 AND 100),
  gross            numeric(28,4) NOT NULL,
  net              numeric(28,4) NOT NULL,
  tax              numeric(28,4) NOT NULL,
  UNIQUE (tenant_id, quote_version_id, position),
  FOREIGN KEY (tenant_id, quote_version_id) REFERENCES quote_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id)
);

-- The PDF that was sent (append-only).
CREATE TABLE quote_documents (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  object_key       text NOT NULL,
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes       integer NOT NULL CHECK (size_bytes > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_version_id),
  FOREIGN KEY (tenant_id, quote_version_id) REFERENCES quote_versions (tenant_id, id)
);

CREATE FUNCTION app.quote_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.purge_tenant', true), '') <> '' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'quote versions are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'a sent quote version is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.quote_id, NEW.version, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.quote_id, OLD.version, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a quote version keeps its identity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Locked: only unlocking and sending change the row, never its content.
  IF OLD.locked_at IS NOT NULL AND (NEW.discount_percent, NEW.valid_until, NEW.intro, NEW.terms, NEW.customer, NEW.totals, NEW.approval_percent)
     IS DISTINCT FROM (OLD.discount_percent, OLD.valid_until, OLD.intro, OLD.terms, OLD.customer, OLD.totals, OLD.approval_percent) THEN
    RAISE EXCEPTION 'a submitted quote version is locked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_versions_guard BEFORE UPDATE OR DELETE ON quote_versions FOR EACH ROW EXECUTE FUNCTION app.quote_version_guard();

CREATE FUNCTION app.quote_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_tenant uuid;
  v_version uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'quote lines are replaced, not updated' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.purge_tenant', true), '') <> '' THEN RETURN OLD; END IF;
    v_tenant := OLD.tenant_id; v_version := OLD.quote_version_id;
  ELSE
    v_tenant := NEW.tenant_id; v_version := NEW.quote_version_id;
  END IF;
  -- The version row is locked, so submitting and editing cannot interleave.
  PERFORM 1 FROM quote_versions v WHERE v.tenant_id = v_tenant AND v.id = v_version AND v.locked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'a submitted quote version is locked' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON quote_lines FOR EACH ROW EXECUTE FUNCTION app.quote_line_guard();
CREATE TRIGGER quote_documents_immutable BEFORE UPDATE OR DELETE ON quote_documents FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_counters', 'quotes', 'quote_versions', 'quote_lines', 'quote_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON quote_counters, quotes, quote_versions TO flexa_app;
GRANT SELECT, INSERT, DELETE ON quote_lines TO flexa_app;
GRANT SELECT, INSERT ON quote_documents TO flexa_app;

CREATE POLICY segment_isolation ON quotes AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY quote_visible ON quote_versions AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM quotes q WHERE q.tenant_id = quote_versions.tenant_id AND q.id = quote_versions.quote_id));
CREATE POLICY version_visible ON quote_lines AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM quote_versions v WHERE v.tenant_id = quote_lines.tenant_id AND v.id = quote_lines.quote_version_id));
CREATE POLICY version_visible ON quote_documents AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM quote_versions v WHERE v.tenant_id = quote_documents.tenant_id AND v.id = quote_documents.quote_version_id));

-- Discount approval of a quote: the subject stays the opportunity (who sees it may decide); one pending request per
-- opportunity and quote.
ALTER TABLE approval_requests ADD COLUMN quote_id uuid, ADD COLUMN quote_version integer,
  ADD CHECK ((quote_id IS NULL) = (quote_version IS NULL)),
  ADD FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id);
DROP INDEX approval_requests_one_pending;
CREATE UNIQUE INDEX approval_requests_one_pending ON approval_requests (tenant_id, kind, subject_type, subject_id, quote_id) NULLS NOT DISTINCT WHERE state = 'pending';

-- Sent quotes past their validity (in the tenant's time zone).
CREATE FUNCTION app.expired_quotes(p_limit integer) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT q.tenant_id, q.id FROM quotes q JOIN tenants t ON t.id = q.tenant_id
  JOIN quote_versions v ON v.tenant_id = q.tenant_id AND v.quote_id = q.id AND v.version = q.current_version
  WHERE q.status = 'sent' AND v.valid_until < (now() AT TIME ZONE t.timezone)::date AND t.status IN ('trial', 'active')
  ORDER BY v.valid_until LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.expired_quotes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expired_quotes(integer) TO flexa_app;

ALTER TABLE mentions DROP CONSTRAINT mentions_source_type_check;
ALTER TABLE mentions ADD CONSTRAINT mentions_source_type_check CHECK (source_type IN ('comment', 'note', 'description', 'quote'));
ALTER TABLE activity_events DROP CONSTRAINT activity_events_kind_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_kind_check CHECK (kind IN ('created', 'field_changed', 'status_changed', 'assigned', 'deleted', 'restored',
  'converted', 'merged', 'comment', 'attachment', 'email_log', 'call_log', 'quote'));

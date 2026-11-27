-- P9b (docs/p9-plan.md §8–13): contracts with renewal, B2B orders. Both belong to a won B2B opportunity and are as
-- visible as it is. `orders` is shared with B2C (P9e adds its columns).

CREATE TABLE document_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind      text NOT NULL CHECK (kind IN ('contract', 'order')),
  year      integer NOT NULL,
  last      integer NOT NULL CHECK (last > 0),
  PRIMARY KEY (tenant_id, kind, year)
);

CREATE TABLE contracts (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  number              text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  opportunity_id      uuid NOT NULL,
  quote_id            uuid,
  segment             segment NOT NULL DEFAULT 'b2b' CHECK (segment = 'b2b'),
  title               text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  value               numeric(18,4) CHECK (value >= 0),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  auto_renew          boolean NOT NULL DEFAULT false,
  renewal_notice_days integer NOT NULL DEFAULT 30 CHECK (renewal_notice_days BETWEEN 0 AND 365),
  -- active → ended (term over) | renewed (a next term exists) | terminated (ended early, with a reason).
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'renewed', 'terminated')),
  terminated_on       date,
  termination_reason  text CHECK (length(termination_reason) <= 500),
  renewed_from_id     uuid,
  reminded_at         timestamptz,
  note                text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  version             integer NOT NULL DEFAULT 1,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (end_date >= start_date),
  CHECK ((status = 'terminated') = (terminated_on IS NOT NULL)),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, renewed_from_id) REFERENCES contracts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
);
-- A term is renewed once.
CREATE UNIQUE INDEX contracts_one_renewal ON contracts (tenant_id, renewed_from_id) WHERE renewed_from_id IS NOT NULL;
CREATE INDEX contracts_opportunity ON contracts (tenant_id, opportunity_id, id DESC);
CREATE INDEX contracts_active ON contracts (end_date) WHERE status = 'active';
CREATE TRIGGER contracts_touch BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  number         text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  segment        segment NOT NULL,
  opportunity_id uuid,
  quote_id       uuid,
  contract_id    uuid,
  currency       char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  totals         jsonb NOT NULL DEFAULT '{}',
  status_reason  text CHECK (length(status_reason) <= 500),
  note           text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  version        integer NOT NULL DEFAULT 1,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  -- A B2B order comes from a won opportunity's accepted quote.
  CHECK (segment <> 'b2b' OR (opportunity_id IS NOT NULL AND quote_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES contracts (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
);
-- One order per accepted quote.
CREATE UNIQUE INDEX orders_one_per_quote ON orders (tenant_id, quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX orders_opportunity ON orders (tenant_id, opportunity_id, id DESC) WHERE opportunity_id IS NOT NULL;
CREATE INDEX orders_list ON orders (tenant_id, id DESC);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- What was ordered, copied from the quote (the quote may be revised later; the order is not).
CREATE TABLE order_lines (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  order_id    uuid NOT NULL,
  position    integer NOT NULL CHECK (position >= 0),
  product_id  uuid NOT NULL,
  sku         text NOT NULL,
  name        text NOT NULL,
  unit        text NOT NULL,
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(6,3) NOT NULL DEFAULT 0,
  tax_percent numeric(6,3) NOT NULL DEFAULT 0,
  net         numeric(28,4) NOT NULL,
  tax         numeric(28,4) NOT NULL,
  UNIQUE (tenant_id, order_id, position),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE TRIGGER order_lines_immutable BEFORE UPDATE OR DELETE ON order_lines FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_counters', 'contracts', 'orders', 'order_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON document_counters, contracts, orders TO flexa_app;
GRANT SELECT, INSERT ON order_lines TO flexa_app;
CREATE POLICY segment_isolation ON contracts AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON orders AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY order_visible ON order_lines AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = order_lines.tenant_id AND o.id = order_lines.order_id));

-- Contracts whose renewal reminder is due, or whose term is over (in the tenant's time zone).
CREATE FUNCTION app.due_contracts(p_limit integer) RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.tenant_id, c.id FROM contracts c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.status = 'active' AND t.status IN ('trial', 'active')
    AND ((c.reminded_at IS NULL AND c.end_date - c.renewal_notice_days <= (now() AT TIME ZONE t.timezone)::date)
      OR c.end_date < (now() AT TIME ZONE t.timezone)::date)
  ORDER BY c.end_date LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION app.due_contracts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_contracts(integer) TO flexa_app;

ALTER TABLE activity_events DROP CONSTRAINT activity_events_kind_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_kind_check CHECK (kind IN ('created', 'field_changed', 'status_changed', 'assigned', 'deleted', 'restored',
  'converted', 'merged', 'comment', 'attachment', 'email_log', 'call_log', 'quote', 'contract', 'order'));

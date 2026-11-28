-- P9e (docs/p9-plan.md §30–37): B2C orders on the shared `orders` table, their history, returns and their approval;
-- anonymized B2C customers (KVKK).

ALTER TABLE document_counters DROP CONSTRAINT document_counters_kind_check;
ALTER TABLE document_counters ADD CONSTRAINT document_counters_kind_check CHECK (kind IN ('contract', 'order', 'return'));

ALTER TABLE orders
  ADD COLUMN customer_id      uuid,
  ADD COLUMN channel          text CHECK (channel IN ('web', 'store', 'phone', 'social')),
  ADD COLUMN payment_status   text CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
  ADD COLUMN shipping_address jsonb CHECK (shipping_address IS NULL OR jsonb_typeof(shipping_address) = 'object'),
  ADD COLUMN carrier          text CHECK (length(carrier) <= 80),
  ADD COLUMN tracking_number  text CHECK (length(tracking_number) <= 120),
  ADD CONSTRAINT orders_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES contacts (tenant_id, id);
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
-- B2B: open → fulfilled | cancelled. B2C: the workflow of B2C-03, with customer, channel and payment status.
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
  (segment = 'b2b' AND status IN ('open', 'fulfilled', 'cancelled'))
  OR (segment = 'b2c' AND status IN ('new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled', 'returned')
      AND customer_id IS NOT NULL AND channel IS NOT NULL AND payment_status IS NOT NULL));
CREATE INDEX orders_b2c_list ON orders (tenant_id, id DESC) WHERE segment = 'b2c';
CREATE INDEX orders_customer ON orders (tenant_id, customer_id, id DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX orders_b2c_status ON orders (tenant_id, status, id DESC) WHERE segment = 'b2c';

-- Every step of a B2C order (who, when, from what to what), never changed.
CREATE TABLE order_status_history (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  order_id    uuid NOT NULL,
  segment     segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  kind        text NOT NULL CHECK (kind IN ('status', 'payment')),
  from_value  text,
  to_value    text NOT NULL,
  note        text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  actor_id    uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX order_status_history_order ON order_status_history (tenant_id, order_id, at, id);
CREATE TRIGGER order_status_history_immutable BEFORE UPDATE ON order_status_history FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE TABLE returns (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  number        text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  order_id      uuid NOT NULL,
  segment       segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  reason_code   text NOT NULL CHECK (reason_code IN ('damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other')),
  reason        text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  amount        numeric(28,4) NOT NULL CHECK (amount >= 0),
  currency      char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid NOT NULL,
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK ((status IN ('requested', 'cancelled')) = (decided_at IS NULL)),
  -- Whoever asks does not decide (four eyes).
  CHECK (decided_by IS DISTINCT FROM requested_by),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX returns_order ON returns (tenant_id, order_id, id DESC);
CREATE INDEX returns_open ON returns (tenant_id, id DESC) WHERE status = 'requested';

CREATE TABLE return_lines (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  return_id     uuid NOT NULL,
  order_line_id uuid NOT NULL,
  quantity      numeric(14,3) NOT NULL CHECK (quantity > 0),
  amount        numeric(28,4) NOT NULL CHECK (amount >= 0),
  UNIQUE (tenant_id, return_id, order_line_id),
  FOREIGN KEY (tenant_id, return_id) REFERENCES returns (tenant_id, id) ON DELETE CASCADE
);
CREATE TRIGGER return_lines_immutable BEFORE UPDATE OR DELETE ON return_lines FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_status_history', 'returns', 'return_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON order_status_history, return_lines TO flexa_app;
GRANT SELECT, INSERT, UPDATE ON returns TO flexa_app;
CREATE POLICY segment_isolation ON order_status_history AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON returns AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY return_visible ON return_lines AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM returns r WHERE r.tenant_id = return_lines.tenant_id AND r.id = return_lines.return_id));

ALTER TABLE activity_events DROP CONSTRAINT activity_events_kind_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_kind_check CHECK (kind IN ('created', 'field_changed', 'status_changed', 'assigned', 'deleted', 'restored',
  'converted', 'merged', 'comment', 'attachment', 'email_log', 'call_log', 'quote', 'contract', 'order', 'consent', 'customer', 'return'));

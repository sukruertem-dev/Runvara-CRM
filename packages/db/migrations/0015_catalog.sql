-- P8a (docs/p8-plan.md §1): product catalogue, tax rates, price lists with quantity breaks, exchange rates.

CREATE TABLE tax_rates (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  rate       numeric(6,3) NOT NULL CHECK (rate BETWEEN 0 AND 100),
  active     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tax_rates_name ON tax_rates (tenant_id, lower(name));

CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  sku           text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description   text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  category      text CHECK (length(btrim(category)) BETWEEN 1 AND 80),
  unit          text NOT NULL DEFAULT 'adet' CHECK (length(btrim(unit)) BETWEEN 1 AND 20),
  tax_rate_id   uuid,
  segments      segment[] NOT NULL CHECK (cardinality(segments) BETWEEN 1 AND 2),
  unit_cost     numeric(18,4) CHECK (unit_cost >= 0),
  cost_currency char(3) CHECK (cost_currency ~ '^[A-Z]{3}$'),
  active        boolean NOT NULL DEFAULT true,
  version       integer NOT NULL DEFAULT 1,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((unit_cost IS NULL) = (cost_currency IS NULL)),
  FOREIGN KEY (tenant_id, tax_rate_id) REFERENCES tax_rates (tenant_id, id)
);
CREATE UNIQUE INDEX products_sku ON products (tenant_id, lower(sku));
CREATE INDEX products_list ON products (tenant_id, lower(name), id);

CREATE TABLE price_lists (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  currency   char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  segment    segment,
  account_id uuid,
  valid_from date,
  valid_to   date,
  active     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (valid_to >= valid_from),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);
CREATE INDEX price_lists_account ON price_lists (tenant_id, account_id) WHERE account_id IS NOT NULL;

CREATE TABLE price_list_items (
  tenant_id     uuid NOT NULL,
  price_list_id uuid NOT NULL,
  product_id    uuid NOT NULL,
  min_qty       numeric(14,3) NOT NULL DEFAULT 1 CHECK (min_qty > 0),
  unit_price    numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (tenant_id, price_list_id, product_id, min_qty),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products (tenant_id, id)
);
CREATE INDEX price_list_items_product ON price_list_items (tenant_id, product_id);

CREATE TABLE fx_rates (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  base       char(3) NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote      char(3) NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  valid_on   date NOT NULL,
  rate       numeric(18,8) NOT NULL CHECK (rate > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, base, quote, valid_on),
  CHECK (base <> quote)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_rates', 'products', 'price_lists', 'price_list_items', 'fx_rates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO flexa_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['tax_rates', 'products', 'price_lists'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t || '_touch', t);
  END LOOP;
END $$;
-- Catalogue rows are deactivated, not deleted (documents will refer to them); prices and rates are replaced.
GRANT DELETE ON price_list_items, fx_rates TO flexa_app;

CREATE POLICY segment_isolation ON products AS RESTRICTIVE
  USING (segments && app.segments()) WITH CHECK (segments && app.segments());
CREATE POLICY segment_isolation ON price_lists AS RESTRICTIVE
  USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
-- A price shows only when both its list and its product do.
CREATE POLICY parents_visible ON price_list_items AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM price_lists l WHERE l.tenant_id = price_list_items.tenant_id AND l.id = price_list_items.price_list_id)
  AND EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = price_list_items.tenant_id AND p.id = price_list_items.product_id));

-- Members who joined teams before primary teams were kept: their earliest team becomes primary.
UPDATE memberships m SET primary_team_id = (
  SELECT tm.team_id FROM team_members tm WHERE tm.tenant_id = m.tenant_id AND tm.user_id = m.user_id
  ORDER BY tm.added_at, tm.team_id LIMIT 1)
WHERE m.primary_team_id IS NULL;

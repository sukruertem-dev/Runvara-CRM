-- P9f (docs/p9-plan.md §39–46): B2C campaigns and coupons, campaign deliveries, RFM on the customer profile,
-- the built-in B2C automations (abandoned order, repeat purchase, win-back).

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  segment          segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  -- draft → pending_approval (Manager, A26 requires_approval) → active → ended | cancelled.
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'active', 'ended', 'cancelled')),
  starts_on        date NOT NULL,
  ends_on          date NOT NULL,
  -- Applied to the orders of matching customers while active; 0 = a message-only campaign.
  discount_percent numeric(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  -- Conflict rule: an exclusive discount never adds up with another one; the larger wins.
  exclusive        boolean NOT NULL DEFAULT false,
  -- Target customers: any of the tags and any of the RFM segments (empty = everyone).
  audience_tags    text[] NOT NULL DEFAULT '{}',
  audience_rfm     text[] NOT NULL DEFAULT '{}' CHECK (audience_rfm <@ ARRAY['champions', 'loyal', 'new', 'at_risk', 'hibernating', 'regular']),
  message_subject  text CHECK (length(message_subject) BETWEEN 1 AND 200),
  message_body     text CHECK (length(message_body) BETWEEN 1 AND 5000),
  sent_at          timestamptz,
  approved_by      uuid,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (starts_on <= ends_on),
  CHECK ((message_subject IS NULL) = (message_body IS NULL)),
  FOREIGN KEY (tenant_id, created_by) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX campaigns_active ON campaigns (tenant_id, starts_on, ends_on) WHERE status = 'active';
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE coupons (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  segment            segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  campaign_id        uuid NOT NULL,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  discount_percent   numeric(6,3) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  max_uses           integer CHECK (max_uses > 0),
  per_customer_limit integer NOT NULL DEFAULT 1 CHECK (per_customer_limit > 0),
  uses               integer NOT NULL DEFAULT 0 CHECK (uses >= 0 AND (max_uses IS NULL OR uses <= max_uses)),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE coupon_redemptions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  coupon_id   uuid NOT NULL,
  order_id    uuid NOT NULL,
  customer_id uuid NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, coupon_id) REFERENCES coupons (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX coupon_redemptions_customer ON coupon_redemptions (tenant_id, coupon_id, customer_id);

-- The B2C order list by channel (newest first), measured with 100 000 orders (docs/perf/p9-b2c-orders.md).
CREATE INDEX orders_b2c_channel ON orders (tenant_id, channel, id DESC) WHERE segment = 'b2c';

ALTER TABLE orders ADD COLUMN coupon_id uuid, ADD COLUMN campaign_id uuid,
  ADD COLUMN discount_percent numeric(6,3) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT orders_coupon_fk FOREIGN KEY (tenant_id, coupon_id) REFERENCES coupons (tenant_id, id),
  ADD CONSTRAINT orders_campaign_fk FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id);

-- Who a campaign message reached, and who it did not and why (consent, B2C-06).
CREATE TABLE campaign_deliveries (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  campaign_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('sent', 'blocked')),
  reason      text CHECK (reason IN ('not_b2c', 'no_consent', 'withdrawn', 'channel_disabled', 'no_contact_point')),
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, campaign_id, customer_id),
  CHECK ((outcome = 'blocked') = (reason IS NOT NULL)),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

-- RFM (B2C-07), recomputed nightly onto the customer profile.
ALTER TABLE customer_profiles
  ADD COLUMN rfm_recency   integer,
  ADD COLUMN rfm_frequency integer,
  ADD COLUMN rfm_monetary  numeric(28,4),
  ADD COLUMN rfm_score     text CHECK (rfm_score ~ '^[1-5]{3}$'),
  ADD COLUMN rfm_segment   text CHECK (rfm_segment IN ('champions', 'loyal', 'new', 'at_risk', 'hibernating', 'regular')),
  ADD COLUMN rfm_at        timestamptz,
  ADD COLUMN last_order_at timestamptz;
CREATE INDEX customer_profiles_rfm ON customer_profiles (tenant_id, rfm_segment) WHERE rfm_segment IS NOT NULL;

-- Each built-in automation acts once per subject (an order, a customer's entry into a segment).
CREATE TABLE b2c_automation_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  kind        text NOT NULL CHECK (kind IN ('abandoned_order', 'repeat_purchase', 'winback')),
  subject_key text NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 120),
  customer_id uuid NOT NULL,
  emailed     boolean NOT NULL,
  blocked     text,
  task_id     uuid,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, subject_key),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'coupons', 'coupon_redemptions', 'campaign_deliveries', 'b2c_automation_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
CREATE POLICY segment_isolation ON campaigns AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON coupons AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY campaign_visible ON campaign_deliveries AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM campaigns c WHERE c.tenant_id = campaign_deliveries.tenant_id AND c.id = campaign_deliveries.campaign_id));
CREATE POLICY coupon_visible ON coupon_redemptions AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM coupons c WHERE c.tenant_id = coupon_redemptions.tenant_id AND c.id = coupon_redemptions.coupon_id));
GRANT SELECT, INSERT, UPDATE ON campaigns, coupons TO flexa_app;
GRANT SELECT, INSERT ON coupon_redemptions, campaign_deliveries, b2c_automation_runs TO flexa_app;

-- Workspaces with B2C on (the nightly RFM job and the B2C automations).
CREATE FUNCTION app.b2c_tenants() RETURNS TABLE (tenant_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT t.id, t.timezone FROM tenants t JOIN tenant_modules m ON m.tenant_id = t.id AND m.module_id = 'sales_b2c' AND m.enabled
  WHERE t.status IN ('trial', 'active') ORDER BY t.id
$$;
REVOKE ALL ON FUNCTION app.b2c_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.b2c_tenants() TO flexa_app;

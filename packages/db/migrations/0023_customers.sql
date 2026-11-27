-- P9d (docs/p9-plan.md §22–28): B2C customer profile, addresses and channel consent. A B2C customer is a contact
-- whose segments contain `b2c` (requirements review C2); these tables hold what only B2C needs.

CREATE TABLE customer_profiles (
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  contact_id        uuid NOT NULL,
  segment           segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  preferred_channel text CHECK (preferred_channel IN ('email', 'sms', 'phone', 'whatsapp')),
  language          text CHECK (language IN ('tr', 'en')),
  tags              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  version           integer NOT NULL DEFAULT 1,
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_profiles_tags ON customer_profiles USING gin (tags);

CREATE TABLE customer_addresses (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  contact_id  uuid NOT NULL,
  segment     segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  label       text NOT NULL DEFAULT '' CHECK (length(label) <= 40),
  recipient   text NOT NULL DEFAULT '' CHECK (length(recipient) <= 200),
  line1       text NOT NULL CHECK (length(btrim(line1)) BETWEEN 1 AND 300),
  line2       text NOT NULL DEFAULT '' CHECK (length(line2) <= 300),
  district    text NOT NULL DEFAULT '' CHECK (length(district) <= 120),
  city        text NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 120),
  postal_code text NOT NULL DEFAULT '' CHECK (length(postal_code) <= 20),
  country     char(2) NOT NULL DEFAULT 'TR' CHECK (country ~ '^[A-Z]{2}$'),
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_addresses_contact ON customer_addresses (tenant_id, contact_id);
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (tenant_id, contact_id) WHERE is_default;
CREATE TRIGGER customer_addresses_touch BEFORE UPDATE ON customer_addresses FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The current consent of a customer for a channel (one row per channel) ...
CREATE TABLE consents (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  contact_id   uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'whatsapp')),
  segment      segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  status       text NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  source       text NOT NULL CHECK (source IN ('web_form', 'phone', 'store', 'email', 'import', 'api', 'other')),
  evidence     text NOT NULL DEFAULT '' CHECK (length(evidence) <= 500),
  -- Reference in an external consent registry (e.g. İYS), A11.
  external_ref text CHECK (length(external_ref) <= 200),
  occurred_at  timestamptz NOT NULL,
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, contact_id, channel),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);

-- ... and every change of it, never altered (who, when, from where).
CREATE TABLE consent_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  contact_id   uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'whatsapp')),
  segment      segment NOT NULL DEFAULT 'b2c' CHECK (segment = 'b2c'),
  status       text NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  source       text NOT NULL CHECK (source IN ('web_form', 'phone', 'store', 'email', 'import', 'api', 'other')),
  evidence     text NOT NULL DEFAULT '' CHECK (length(evidence) <= 500),
  external_ref text CHECK (length(external_ref) <= 200),
  occurred_at  timestamptz NOT NULL,
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX consent_events_contact ON consent_events (tenant_id, contact_id, recorded_at DESC, id DESC);
CREATE TRIGGER consent_events_immutable BEFORE UPDATE ON consent_events FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_profiles', 'customer_addresses', 'consents', 'consent_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY segment_isolation ON %I AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()))', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON customer_profiles, consents TO flexa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_addresses TO flexa_app;
GRANT SELECT, INSERT ON consent_events TO flexa_app;

ALTER TABLE activity_events DROP CONSTRAINT activity_events_kind_check;
ALTER TABLE activity_events ADD CONSTRAINT activity_events_kind_check CHECK (kind IN ('created', 'field_changed', 'status_changed', 'assigned', 'deleted', 'restored',
  'converted', 'merged', 'comment', 'attachment', 'email_log', 'call_log', 'quote', 'contract', 'order', 'consent', 'customer'));

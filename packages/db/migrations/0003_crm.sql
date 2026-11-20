-- 0003 CRM (Faz 3): accounts, contacts, roles, contact points, leads + conversion, pipelines, opportunities,
-- cases, notes, merges; segment row-level security (ADR-0010) switched on for CRM, tasks and the registry.
-- docs/p3-plan.md. All tables: tenant_id + FORCE RLS + RESTRICTIVE tenant_isolation.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Active segments of the request ('{b2b,b2c}'); missing → empty array → only segment-less rows visible.
CREATE FUNCTION app.segments() RETURNS segment[] LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT coalesce(nullif(current_setting('app.segments', true), '')::segment[], '{}'::segment[]) $$;
GRANT EXECUTE ON FUNCTION app.segments() TO flexa_app;

-- Identity records (accounts, contacts) belong to one or both segments.
ALTER TABLE record_registry ADD COLUMN segments segment[];

CREATE FUNCTION app.registry_sync_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO record_registry (tenant_id, record_type, record_id, segments, deleted_at)
    VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, NEW.segments, NEW.deleted_at);
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE record_registry SET segments = NEW.segments, deleted_at = NEW.deleted_at
    WHERE tenant_id = NEW.tenant_id AND record_type = TG_ARGV[0] AND record_id = NEW.id;
  ELSE
    DELETE FROM record_registry WHERE tenant_id = OLD.tenant_id AND record_type = TG_ARGV[0] AND record_id = OLD.id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Accounts and contacts (identity tables; segments[])
-- ---------------------------------------------------------------------------------------------
CREATE TABLE accounts (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  domain            citext CHECK (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  website           text CHECK (length(website) <= 500),
  industry          text CHECK (length(industry) <= 120),
  parent_account_id uuid,
  segments          segment[] NOT NULL CHECK (cardinality(segments) BETWEEN 1 AND 2),
  owner_user_id     uuid NOT NULL,
  description       jsonb,
  description_text  text CHECK (length(description_text) <= 100000),
  custom            jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  merged_into       uuid,
  version           integer NOT NULL DEFAULT 1,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (parent_account_id IS DISTINCT FROM id),
  FOREIGN KEY (tenant_id, parent_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, merged_into) REFERENCES accounts (tenant_id, id)
);
CREATE INDEX accounts_list ON accounts (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX accounts_owner ON accounts (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX accounts_domain ON accounts (tenant_id, domain) WHERE deleted_at IS NULL AND domain IS NOT NULL;
CREATE INDEX accounts_parent ON accounts (tenant_id, parent_account_id) WHERE parent_account_id IS NOT NULL;
CREATE INDEX accounts_segments ON accounts USING gin (segments);
CREATE INDEX accounts_name_trgm ON accounts USING gin (name gin_trgm_ops);
CREATE INDEX accounts_custom ON accounts USING gin (custom jsonb_path_ops);
CREATE TRIGGER accounts_touch BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER accounts_registry AFTER INSERT OR UPDATE OF segments, deleted_at OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync_identity('account');

-- Account hierarchy must stay acyclic.
CREATE FUNCTION app.accounts_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_account_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE up(id, parent) AS (
      SELECT id, parent_account_id FROM accounts WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_account_id
      UNION ALL
      SELECT a.id, a.parent_account_id FROM accounts a JOIN up ON a.tenant_id = NEW.tenant_id AND a.id = up.parent
    ) SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'ACCOUNT_HIERARCHY_CYCLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_hierarchy BEFORE INSERT OR UPDATE OF parent_account_id ON accounts FOR EACH ROW EXECUTE FUNCTION app.accounts_hierarchy();

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  first_name       text NOT NULL DEFAULT '' CHECK (length(first_name) <= 120),
  last_name        text NOT NULL DEFAULT '' CHECK (length(last_name) <= 120),
  full_name        text GENERATED ALWAYS AS (btrim(first_name || ' ' || last_name)) STORED,
  title            text CHECK (length(title) <= 120),
  segments         segment[] NOT NULL CHECK (cardinality(segments) BETWEEN 1 AND 2),
  owner_user_id    uuid NOT NULL,
  description      jsonb,
  description_text text CHECK (length(description_text) <= 100000),
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  merged_into      uuid,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  anonymized_at    timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (length(btrim(first_name || last_name)) >= 1),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, merged_into) REFERENCES contacts (tenant_id, id)
);
CREATE INDEX contacts_list ON contacts (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX contacts_owner ON contacts (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_segments ON contacts USING gin (segments);
CREATE INDEX contacts_name_trgm ON contacts USING gin (full_name gin_trgm_ops);
CREATE INDEX contacts_custom ON contacts USING gin (custom jsonb_path_ops);
CREATE TRIGGER contacts_touch BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER contacts_registry AFTER INSERT OR UPDATE OF segments, deleted_at OR DELETE ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync_identity('contact');

CREATE TABLE account_contact_roles (
  tenant_id  uuid NOT NULL,
  account_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  role       text NOT NULL DEFAULT 'other' CHECK (role IN ('decision_maker', 'influencer', 'user', 'approver', 'other')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, contact_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX account_contact_roles_contact ON account_contact_roles (tenant_id, contact_id);

-- ---------------------------------------------------------------------------------------------
-- Leads, pipelines, opportunities, cases (transactional; single segment)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  first_name       text NOT NULL DEFAULT '' CHECK (length(first_name) <= 120),
  last_name        text NOT NULL DEFAULT '' CHECK (length(last_name) <= 120),
  full_name        text GENERATED ALWAYS AS (btrim(first_name || ' ' || last_name)) STORED,
  company          text CHECK (length(company) <= 300),
  title            text CHECK (length(title) <= 120),
  segment          segment NOT NULL,
  workflow_id      uuid NOT NULL,
  status_id        uuid NOT NULL,
  source           text CHECK (length(source) <= 60),
  score            integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  owner_user_id    uuid,
  queue_id         uuid,
  description      jsonb,
  description_text text CHECK (length(description_text) <= 100000),
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  converted_at     timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (length(btrim(first_name || last_name || coalesce(company, ''))) >= 1),
  CHECK (owner_user_id IS NOT NULL OR queue_id IS NOT NULL),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, status_id) REFERENCES statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id)
);
CREATE INDEX leads_list ON leads (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_owner ON leads (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_status ON leads (tenant_id, status_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_name_trgm ON leads USING gin ((full_name || ' ' || coalesce(company, '')) gin_trgm_ops);
CREATE TRIGGER leads_touch BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER leads_registry AFTER INSERT OR UPDATE OF segment, deleted_at OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync('lead');

CREATE TABLE pipelines (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  segment     segment,
  workflow_id uuid NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id)
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (tenant_id) WHERE is_default;

CREATE TABLE pipeline_stages (
  tenant_id   uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  status_id   uuid NOT NULL,
  probability numeric(5, 2) NOT NULL CHECK (probability BETWEEN 0 AND 100),
  PRIMARY KEY (tenant_id, pipeline_id, status_id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, status_id) REFERENCES statuses (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE opportunities (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 300),
  account_id         uuid,
  primary_contact_id uuid,
  pipeline_id        uuid NOT NULL,
  workflow_id        uuid NOT NULL,
  status_id          uuid NOT NULL,
  segment            segment NOT NULL,
  amount             numeric(18, 4) CHECK (amount >= 0),
  currency           char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  probability        numeric(5, 2) NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  probability_manual boolean NOT NULL DEFAULT false,
  expected_close     date,
  competitor         text CHECK (length(competitor) <= 200),
  won_lost_reason    text CHECK (length(won_lost_reason) <= 500),
  owner_user_id      uuid NOT NULL,
  description        jsonb,
  description_text   text CHECK (length(description_text) <= 100000),
  custom             jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  closed_at          timestamptz,
  version            integer NOT NULL DEFAULT 1,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, status_id) REFERENCES statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX opportunities_list ON opportunities (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX opportunities_owner ON opportunities (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunities_account ON opportunities (tenant_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX opportunities_stage ON opportunities (tenant_id, pipeline_id, status_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunities_custom ON opportunities USING gin (custom jsonb_path_ops);
CREATE TRIGGER opportunities_touch BEFORE UPDATE ON opportunities FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER opportunities_registry AFTER INSERT OR UPDATE OF segment, deleted_at OR DELETE ON opportunities
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync('opportunity');

CREATE TABLE cases (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  subject          text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 300),
  account_id       uuid,
  contact_id       uuid,
  workflow_id      uuid NOT NULL,
  status_id        uuid NOT NULL,
  priority         smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  channel          text NOT NULL DEFAULT 'other' CHECK (channel IN ('email', 'phone', 'web', 'chat', 'social', 'other')),
  category         text CHECK (length(category) <= 60),
  queue_id         uuid,
  owner_user_id    uuid,
  segment          segment,
  description      jsonb,
  description_text text CHECK (length(description_text) <= 100000),
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  closed_at        timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (owner_user_id IS NOT NULL OR queue_id IS NOT NULL),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, status_id) REFERENCES statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX cases_list ON cases (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX cases_owner ON cases (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX cases_queue ON cases (tenant_id, queue_id) WHERE deleted_at IS NULL;
CREATE INDEX cases_account ON cases (tenant_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX cases_contact ON cases (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE TRIGGER cases_touch BEFORE UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER cases_registry AFTER INSERT OR UPDATE OF segment, deleted_at OR DELETE ON cases
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync('case');

CREATE TABLE lead_conversions (
  tenant_id      uuid NOT NULL,
  lead_id        uuid NOT NULL,
  account_id     uuid NOT NULL,
  contact_id     uuid NOT NULL,
  opportunity_id uuid,
  converted_by   uuid NOT NULL,
  converted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, id)
);

-- ---------------------------------------------------------------------------------------------
-- Contact points, notes, merges (polymorphic → record_registry)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE contact_points (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  owner_type text NOT NULL CHECK (owner_type IN ('contact', 'account', 'lead')),
  owner_id   uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('phone', 'email')),
  label      text CHECK (length(label) <= 40),
  value      text NOT NULL CHECK (length(value) BETWEEN 3 AND 254),
  e164       text CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK ((kind = 'phone') = (e164 IS NOT NULL)),
  CHECK (kind <> 'email' OR value = lower(value)),
  FOREIGN KEY (tenant_id, owner_type, owner_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX contact_points_owner ON contact_points (tenant_id, owner_type, owner_id);
CREATE INDEX contact_points_e164 ON contact_points (tenant_id, e164) WHERE e164 IS NOT NULL;
CREATE INDEX contact_points_email ON contact_points (tenant_id, value) WHERE kind = 'email';

CREATE TABLE notes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  related_type text NOT NULL,
  related_id   uuid NOT NULL,
  body         jsonb,
  body_text    text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 100000),
  visibility   text NOT NULL DEFAULT 'standard' CHECK (visibility IN ('standard', 'private')),
  segment      segment,
  author_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, related_type, related_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, author_id) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX notes_related ON notes (tenant_id, related_type, related_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER notes_touch BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE merges (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  record_type   text NOT NULL CHECK (record_type IN ('account', 'contact')),
  survivor_id   uuid NOT NULL,
  merged_ids    uuid[] NOT NULL CHECK (cardinality(merged_ids) BETWEEN 1 AND 10),
  field_choices jsonb NOT NULL DEFAULT '{}',
  moved         jsonb NOT NULL DEFAULT '{}',
  merged_by     uuid NOT NULL,
  merged_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merges_survivor ON merges (tenant_id, record_type, survivor_id);

-- ---------------------------------------------------------------------------------------------
-- RLS: tenant isolation on every new table + segment isolation (ADR-0010)
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'contacts', 'account_contact_roles', 'leads', 'pipelines', 'pipeline_stages',
                           'opportunities', 'cases', 'lead_conversions', 'contact_points', 'notes', 'merges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON merges FROM flexa_app;

CREATE POLICY segment_isolation ON accounts AS RESTRICTIVE USING (segments && app.segments()) WITH CHECK (segments && app.segments());
CREATE POLICY segment_isolation ON contacts AS RESTRICTIVE USING (segments && app.segments()) WITH CHECK (segments && app.segments());
CREATE POLICY segment_isolation ON leads AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON opportunities AS RESTRICTIVE USING (segment = ANY (app.segments())) WITH CHECK (segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON pipelines AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON cases AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON notes AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON tasks AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON record_registry AS RESTRICTIVE
  USING ((segment IS NULL OR segment = ANY (app.segments())) AND (segments IS NULL OR segments && app.segments()))
  WITH CHECK ((segment IS NULL OR segment = ANY (app.segments())) AND (segments IS NULL OR segments && app.segments()));
-- A phone number or e-mail is visible only when its owner record is (no leak through contact points).
CREATE POLICY owner_visible ON contact_points AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM record_registry r WHERE r.tenant_id = contact_points.tenant_id
          AND r.record_type = contact_points.owner_type AND r.record_id = contact_points.owner_id)
);
CREATE POLICY account_contact_visible ON account_contact_roles AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = account_contact_roles.tenant_id AND a.id = account_contact_roles.account_id)
  AND EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = account_contact_roles.tenant_id AND c.id = account_contact_roles.contact_id)
);

-- ---------------------------------------------------------------------------------------------
-- Default CRM workflows and pipeline (one source for migration + provisioning)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.seed_crm_workflows(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE wf uuid; p uuid;
  s_new uuid; s_working uuid; s_qualified uuid; s_unq uuid; s_conv uuid;
  s_pro uuid; s_qual uuid; s_prop uuid; s_neg uuid; s_won uuid; s_lost uuid;
  c_new uuid; c_prog uuid; c_wait uuid; c_res uuid; c_closed uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workflows WHERE tenant_id = p_tenant AND resource_type = 'lead' AND is_default) THEN
    INSERT INTO workflows (tenant_id, resource_type, key, name, is_default) VALUES (p_tenant, 'lead', 'lead_default', 'Aday akışı', true) RETURNING id INTO wf;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position, is_initial) VALUES
      (p_tenant, wf, 'new', '{"tr":"Yeni","en":"New"}', 'open', 'text-secondary', 'a0', true) RETURNING id INTO s_new;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'working', '{"tr":"Çalışılıyor","en":"Working"}', 'in_progress', 'info', 'a1') RETURNING id INTO s_working;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'qualified', '{"tr":"Nitelikli","en":"Qualified"}', 'in_progress', 'accent', 'a2') RETURNING id INTO s_qualified;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'unqualified', '{"tr":"Niteliksiz","en":"Unqualified"}', 'closed', 'text-secondary', 'a3') RETURNING id INTO s_unq;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'converted', '{"tr":"Dönüştürüldü","en":"Converted"}', 'closed', 'success', 'a4') RETURNING id INTO s_conv;
    INSERT INTO workflow_transitions (tenant_id, workflow_id, key, label_i18n, from_status_id, to_status_id) VALUES
      (p_tenant, wf, 'start', '{"tr":"Çalışmaya başla","en":"Start working"}', s_new, s_working),
      (p_tenant, wf, 'qualify', '{"tr":"Nitelikli işaretle","en":"Qualify"}', s_working, s_qualified),
      (p_tenant, wf, 'disqualify', '{"tr":"Niteliksiz","en":"Disqualify"}', NULL, s_unq),
      (p_tenant, wf, 'reopen', '{"tr":"Yeniden aç","en":"Reopen"}', s_unq, s_new);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM workflows WHERE tenant_id = p_tenant AND resource_type = 'opportunity' AND is_default) THEN
    INSERT INTO workflows (tenant_id, resource_type, key, name, is_default) VALUES (p_tenant, 'opportunity', 'sales_default', 'Satış süreci', true) RETURNING id INTO wf;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position, is_initial) VALUES
      (p_tenant, wf, 'prospecting', '{"tr":"Potansiyel","en":"Prospecting"}', 'open', 'text-secondary', 'a0', true) RETURNING id INTO s_pro;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'qualification', '{"tr":"Nitelendirme","en":"Qualification"}', 'in_progress', 'info', 'a1') RETURNING id INTO s_qual;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'proposal', '{"tr":"Teklif","en":"Proposal"}', 'in_progress', 'info', 'a2') RETURNING id INTO s_prop;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'negotiation', '{"tr":"Pazarlık","en":"Negotiation"}', 'in_progress', 'accent', 'a3') RETURNING id INTO s_neg;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'won', '{"tr":"Kazanıldı","en":"Won"}', 'closed', 'success', 'a4') RETURNING id INTO s_won;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'lost', '{"tr":"Kaybedildi","en":"Lost"}', 'closed', 'danger', 'a5') RETURNING id INTO s_lost;
    INSERT INTO workflow_transitions (tenant_id, workflow_id, key, label_i18n, from_status_id, to_status_id, validators) VALUES
      (p_tenant, wf, 'to_prospecting', '{"tr":"Potansiyel","en":"Prospecting"}', NULL, s_pro, '[]'),
      (p_tenant, wf, 'to_qualification', '{"tr":"Nitelendirme","en":"Qualification"}', NULL, s_qual, '[]'),
      (p_tenant, wf, 'to_proposal', '{"tr":"Teklif","en":"Proposal"}', NULL, s_prop, '[]'),
      (p_tenant, wf, 'to_negotiation', '{"tr":"Pazarlık","en":"Negotiation"}', NULL, s_neg, '[]'),
      (p_tenant, wf, 'win', '{"tr":"Kazan","en":"Win"}', NULL, s_won, '[{"kind":"required_fields","fields":["amount"]}]'),
      (p_tenant, wf, 'lose', '{"tr":"Kaybet","en":"Lose"}', NULL, s_lost, '[{"kind":"required_fields","fields":["won_lost_reason"]}]');
    INSERT INTO pipelines (tenant_id, key, name, segment, workflow_id, is_default) VALUES (p_tenant, 'default', 'Varsayılan satış hattı', NULL, wf, true) RETURNING id INTO p;
    INSERT INTO pipeline_stages (tenant_id, pipeline_id, status_id, probability) VALUES
      (p_tenant, p, s_pro, 10), (p_tenant, p, s_qual, 25), (p_tenant, p, s_prop, 50),
      (p_tenant, p, s_neg, 75), (p_tenant, p, s_won, 100), (p_tenant, p, s_lost, 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM workflows WHERE tenant_id = p_tenant AND resource_type = 'case' AND is_default) THEN
    INSERT INTO workflows (tenant_id, resource_type, key, name, is_default) VALUES (p_tenant, 'case', 'case_default', 'Destek talebi akışı', true) RETURNING id INTO wf;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position, is_initial) VALUES
      (p_tenant, wf, 'new', '{"tr":"Yeni","en":"New"}', 'open', 'text-secondary', 'a0', true) RETURNING id INTO c_new;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'in_progress', '{"tr":"İşlemde","en":"In progress"}', 'in_progress', 'info', 'a1') RETURNING id INTO c_prog;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'waiting', '{"tr":"Müşteri bekleniyor","en":"Waiting on customer"}', 'in_progress', 'warning', 'a2') RETURNING id INTO c_wait;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'resolved', '{"tr":"Çözüldü","en":"Resolved"}', 'closed', 'success', 'a3') RETURNING id INTO c_res;
    INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position) VALUES
      (p_tenant, wf, 'closed', '{"tr":"Kapandı","en":"Closed"}', 'closed', 'text-secondary', 'a4') RETURNING id INTO c_closed;
    INSERT INTO workflow_transitions (tenant_id, workflow_id, key, label_i18n, from_status_id, to_status_id) VALUES
      (p_tenant, wf, 'start', '{"tr":"Başla","en":"Start"}', c_new, c_prog),
      (p_tenant, wf, 'wait', '{"tr":"Müşteriyi bekle","en":"Wait on customer"}', c_prog, c_wait),
      (p_tenant, wf, 'resume', '{"tr":"Devam et","en":"Resume"}', c_wait, c_prog),
      (p_tenant, wf, 'resolve', '{"tr":"Çöz","en":"Resolve"}', c_prog, c_res),
      (p_tenant, wf, 'close', '{"tr":"Kapat","en":"Close"}', c_res, c_closed),
      (p_tenant, wf, 'reopen', '{"tr":"Yeniden aç","en":"Reopen"}', c_res, c_prog);
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.seed_crm_workflows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seed_crm_workflows(uuid) TO flexa_app;

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM app.seed_crm_workflows(t);
  END LOOP;
END $$;

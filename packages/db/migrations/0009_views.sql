-- 0009 saved views and dashboards (P6b, docs/p6-plan.md §7).

-- ---------------------------------------------------------------------------------------------
-- Saved views: a named RQL filter + sort + view type (+ view options) for one resource. Private views belong to
-- their owner; workspace views are visible to every member (who still only sees the records they may read).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE saved_views (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  owner_user_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('task', 'account', 'contact', 'lead', 'opportunity', 'case')),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  view_type     text NOT NULL CHECK (view_type IN ('list', 'board', 'table', 'calendar', 'gantt', 'pipeline')),
  query         text NOT NULL DEFAULT '' CHECK (length(query) <= 4000),
  sort          text CHECK (sort IS NULL OR length(sort) <= 200),
  config        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 16384),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id)
);
CREATE UNIQUE INDEX saved_views_owner_name ON saved_views (tenant_id, owner_user_id, resource_type, lower(name));
CREATE INDEX saved_views_list ON saved_views (tenant_id, resource_type, visibility);
CREATE TRIGGER saved_views_touch BEFORE UPDATE ON saved_views FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Personal dashboard layout (widgets and their grid positions); one row per user per tenant.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE user_dashboards (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid NOT NULL,
  layout     jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'array' AND pg_column_size(layout) <= 32768),
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id)
);

-- ---------------------------------------------------------------------------------------------
-- RLS: tenant isolation; rows are further limited to the owner (or workspace visibility for views).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_views', 'user_dashboards'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
-- Read: own views and workspace views. Write: own views only (the API additionally requires
-- tenant.config.manage to publish a workspace view).
CREATE POLICY view_read ON saved_views FOR SELECT USING (owner_user_id = app.user_id() OR visibility = 'workspace');
CREATE POLICY view_insert ON saved_views FOR INSERT WITH CHECK (owner_user_id = app.user_id());
CREATE POLICY view_update ON saved_views FOR UPDATE USING (owner_user_id = app.user_id()) WITH CHECK (owner_user_id = app.user_id());
CREATE POLICY view_delete ON saved_views FOR DELETE USING (owner_user_id = app.user_id());
CREATE POLICY own_dashboard ON user_dashboards USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id());

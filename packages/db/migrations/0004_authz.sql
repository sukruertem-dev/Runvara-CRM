-- 0004 authorization engine (P4a, docs/p4-plan.md, ADR-0004): user segment grants, teams (hierarchy),
-- role hierarchy, organisation-wide defaults, record shares, criteria-based sharing rules, field policies.
-- All tables: tenant_id + FORCE RLS + RESTRICTIVE tenant_isolation.

-- ---------------------------------------------------------------------------------------------
-- Segment grants per user (ADR-0010 §1, G2). Effective set = active grants ∩ tenant sales mode.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE user_segment_grants (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  segment     segment NOT NULL,
  valid_until timestamptz,
  granted_by  uuid,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, segment),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

-- Existing members keep what they had in P3 (segments = tenant sales mode).
INSERT INTO user_segment_grants (tenant_id, user_id, segment)
SELECT m.tenant_id, m.user_id, s.seg
FROM memberships m CROSS JOIN (VALUES ('b2b'::segment), ('b2c'::segment)) AS s (seg);

-- Invitations carry the segments (and, for Manager invitations, the team) the new member starts with.
ALTER TABLE invitations ADD COLUMN segments segment[] NOT NULL DEFAULT '{b2b,b2c}' CHECK (cardinality(segments) BETWEEN 1 AND 2);
ALTER TABLE invitations ADD COLUMN team_id uuid;

-- ---------------------------------------------------------------------------------------------
-- Teams (with optional parent) and members; a manager of a team also manages all its sub-teams.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE teams (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  parent_team_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (parent_team_id IS DISTINCT FROM id),
  FOREIGN KEY (tenant_id, parent_team_id) REFERENCES teams (tenant_id, id)
);
CREATE TRIGGER teams_touch BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE FUNCTION app.teams_acyclic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_team_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE up(id, parent) AS (
      SELECT id, parent_team_id FROM teams WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_team_id
      UNION ALL
      SELECT t.id, t.parent_team_id FROM teams t JOIN up ON t.tenant_id = NEW.tenant_id AND t.id = up.parent
    ) SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'TEAM_HIERARCHY_CYCLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teams_acyclic BEFORE INSERT OR UPDATE OF parent_team_id ON teams FOR EACH ROW EXECUTE FUNCTION app.teams_acyclic();

CREATE TABLE team_members (
  tenant_id  uuid NOT NULL,
  team_id    uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
  added_by   uuid,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, team_id, user_id),
  FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_members_user ON team_members (tenant_id, user_id);

ALTER TABLE invitations ADD CONSTRAINT invitations_team_fkey FOREIGN KEY (tenant_id, team_id) REFERENCES teams (tenant_id, id) ON DELETE SET NULL (team_id);
ALTER TABLE memberships ADD CONSTRAINT memberships_primary_team_fkey
  FOREIGN KEY (tenant_id, primary_team_id) REFERENCES teams (tenant_id, id) ON DELETE SET NULL (primary_team_id);

-- ---------------------------------------------------------------------------------------------
-- Role hierarchy (Faz 4): a role sees records owned by holders of its descendant roles.
-- System roles start flat; tenants arrange custom hierarchies.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN parent_role_id uuid;
ALTER TABLE roles ADD CONSTRAINT roles_parent_fkey FOREIGN KEY (tenant_id, parent_role_id) REFERENCES roles (tenant_id, id);
ALTER TABLE roles ADD CONSTRAINT roles_parent_not_self CHECK (parent_role_id IS DISTINCT FROM id);

CREATE FUNCTION app.roles_acyclic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_role_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE up(id, parent) AS (
      SELECT id, parent_role_id FROM roles WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_role_id
      UNION ALL
      SELECT r.id, r.parent_role_id FROM roles r JOIN up ON r.tenant_id = NEW.tenant_id AND r.id = up.parent
    ) SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'ROLE_HIERARCHY_CYCLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_acyclic BEFORE INSERT OR UPDATE OF parent_role_id ON roles FOR EACH ROW EXECUTE FUNCTION app.roles_acyclic();

-- ---------------------------------------------------------------------------------------------
-- Organisation-wide defaults, record shares, sharing rules
-- ---------------------------------------------------------------------------------------------
CREATE TABLE sharing_defaults (
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  resource_type text NOT NULL CHECK (resource_type IN ('task', 'account', 'contact', 'lead', 'opportunity', 'case')),
  access        text NOT NULL CHECK (access IN ('private', 'read', 'read_write')),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_type)
);

CREATE TABLE record_shares (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  record_type  text NOT NULL,
  record_id    uuid NOT NULL,
  grantee_type text NOT NULL CHECK (grantee_type IN ('user', 'team')),
  grantee_id   uuid NOT NULL,
  access       text NOT NULL CHECK (access IN ('read', 'edit')),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'mention')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, record_type, record_id, grantee_type, grantee_id),
  FOREIGN KEY (tenant_id, record_type, record_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX record_shares_grantee ON record_shares (tenant_id, grantee_type, grantee_id, record_type, record_id);

CREATE TABLE sharing_rules (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  resource_type   text NOT NULL CHECK (resource_type IN ('task', 'account', 'contact', 'lead', 'opportunity', 'case')),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  criteria        text NOT NULL CHECK (length(criteria) BETWEEN 1 AND 2000),
  grantee_team_id uuid NOT NULL,
  access          text NOT NULL CHECK (access IN ('read', 'edit')),
  enabled         boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, resource_type, name),
  FOREIGN KEY (tenant_id, grantee_team_id) REFERENCES teams (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Field-level security: no row = writable. A user's access is the widest over their roles.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE field_policies (
  tenant_id     uuid NOT NULL,
  role_id       uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('account', 'contact', 'lead', 'opportunity', 'case')),
  field         text NOT NULL CHECK (field ~ '^[a-zA-Z][a-zA-Z0-9]{0,47}$' OR field ~ '^custom\.cf_[a-z0-9_]{1,45}$'),
  access        text NOT NULL CHECK (access IN ('hidden', 'read')),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role_id, resource_type, field),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_segment_grants', 'teams', 'team_members', 'sharing_defaults', 'record_shares', 'sharing_rules', 'field_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
-- A share is visible only when its record is (no leak of hidden-segment record ids through shares).
CREATE POLICY record_visible ON record_shares AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM record_registry r WHERE r.tenant_id = record_shares.tenant_id
          AND r.record_type = record_shares.record_type AND r.record_id = record_shares.record_id)
);

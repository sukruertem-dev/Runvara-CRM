-- 0005 records around records (P4b, docs/p4-plan.md §10): activity timeline, comments (+ revisions),
-- mentions, notifications (+ preferences), attachments, delegations, access requests, tenant matrix overrides.
-- All tables: tenant_id + FORCE RLS + RESTRICTIVE tenant_isolation; contextual tables carry a segment.

-- ---------------------------------------------------------------------------------------------
-- Activity timeline: append-only (ADR-0005; er-diagram §8)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE activity_events (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  record_type text NOT NULL,
  record_id   uuid NOT NULL,
  segment     segment,
  kind        text NOT NULL CHECK (kind IN ('created', 'field_changed', 'status_changed', 'assigned', 'deleted', 'restored',
                                            'converted', 'merged', 'comment', 'attachment', 'email_log', 'call_log')),
  actor_id    uuid,
  diff        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(diff) = 'object'),
  data        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, record_type, record_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX activity_events_record ON activity_events (tenant_id, record_type, record_id, occurred_at DESC, id DESC);
CREATE TRIGGER activity_events_immutable BEFORE UPDATE OR TRUNCATE ON activity_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Comments with edit history
-- ---------------------------------------------------------------------------------------------
CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  record_type text NOT NULL,
  record_id   uuid NOT NULL,
  segment     segment,
  body        jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_html   text NOT NULL,
  body_text   text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 50000),
  author_id   uuid NOT NULL,
  revision    integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, record_type, record_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, author_id) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX comments_record ON comments (tenant_id, record_type, record_id, created_at, id) WHERE deleted_at IS NULL;

CREATE TABLE comment_revisions (
  tenant_id  uuid NOT NULL,
  comment_id uuid NOT NULL,
  revision   integer NOT NULL,
  body       jsonb NOT NULL,
  body_text  text NOT NULL,
  edited_by  uuid NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, comment_id, revision),
  FOREIGN KEY (tenant_id, comment_id) REFERENCES comments (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Mentions and notifications (ADR-0017)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE mentions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  source_type    text NOT NULL CHECK (source_type IN ('comment')),
  source_id      uuid NOT NULL,
  record_type    text NOT NULL,
  record_id      uuid NOT NULL,
  mentioned_user uuid NOT NULL,
  via_team_id    uuid,
  mentioned_by   uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  retracted_at   timestamptz,
  UNIQUE (tenant_id, source_type, source_id, mentioned_user),
  FOREIGN KEY (tenant_id, mentioned_user) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('mention', 'assigned')),
  source_type  text NOT NULL,
  source_id    uuid NOT NULL,
  record_type  text NOT NULL,
  record_id    uuid NOT NULL,
  actor_id     uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  retracted_at timestamptz,
  UNIQUE (tenant_id, user_id, kind, source_type, source_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX notifications_user ON notifications (tenant_id, user_id, created_at DESC, id DESC) WHERE retracted_at IS NULL;

CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('mention', 'assigned')),
  channels  text[] NOT NULL DEFAULT '{in_app}' CHECK (channels <@ ARRAY['in_app', 'email', 'push']),
  PRIMARY KEY (tenant_id, user_id, kind),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Attachments (ADR-0013 §2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  record_type  text NOT NULL,
  record_id    uuid NOT NULL,
  segment      segment,
  object_key   text NOT NULL UNIQUE,
  file_name    text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'quarantine', 'clean', 'infected', 'unscanned')),
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at   timestamptz,
  FOREIGN KEY (tenant_id, record_type, record_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX attachments_record ON attachments (tenant_id, record_type, record_id, created_at) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Delegations and access requests (A07, G2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE delegations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  delegator_id uuid NOT NULL,
  delegate_id  uuid NOT NULL,
  role_key     text,
  segments     segment[] NOT NULL DEFAULT '{}',
  reason       text CHECK (length(reason) <= 500),
  starts_at    timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (delegator_id <> delegate_id),
  CHECK (role_key IS NOT NULL OR cardinality(segments) > 0),
  FOREIGN KEY (tenant_id, delegator_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, delegate_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE access_requests (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  requester_id uuid NOT NULL,
  role_key     text,
  segments     segment[] NOT NULL DEFAULT '{}',
  reason       text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  valid_until  timestamptz,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by   uuid,
  decided_at   timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (role_key IS NOT NULL OR cardinality(segments) > 0),
  FOREIGN KEY (tenant_id, requester_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX access_requests_pending ON access_requests (tenant_id, created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------
-- Tenant matrix overrides (A03, AUTH-11): role × permission → grant (or removal); versioned snapshots
-- ---------------------------------------------------------------------------------------------
CREATE TABLE role_grant_overrides (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  role_key   text NOT NULL,
  permission text NOT NULL,
  grant_spec jsonb,
  PRIMARY KEY (tenant_id, role_key, permission),
  CHECK (grant_spec IS NULL OR jsonb_typeof(grant_spec) = 'object')
);

CREATE TABLE matrix_versions (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  version    integer NOT NULL CHECK (version > 0),
  overrides  jsonb NOT NULL CHECK (jsonb_typeof(overrides) = 'array'),
  note       text CHECK (length(note) <= 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activity_events', 'comments', 'comment_revisions', 'mentions', 'notifications', 'notification_preferences',
                           'attachments', 'delegations', 'access_requests', 'role_grant_overrides', 'matrix_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON activity_events, matrix_versions FROM flexa_app;

CREATE POLICY segment_isolation ON activity_events AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON comments AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
CREATE POLICY segment_isolation ON attachments AS RESTRICTIVE USING (segment IS NULL OR segment = ANY (app.segments())) WITH CHECK (segment IS NULL OR segment = ANY (app.segments()));
-- Notifications carry only a record reference; the record is re-authorized for the reader on every read
-- (MEN-09), so a notification row never needs a segment. A user reads only their own notifications.
CREATE POLICY own_rows ON notifications AS RESTRICTIVE FOR SELECT USING (user_id = app.user_id());

-- Retracting mentions withdraws the *unread* notifications of other users (ADR-0017 §2.5; read ones stay as
-- history). The writer cannot select those rows, so this narrowly scoped definer function removes them inside
-- the caller's tenant only; a later re-mention can then notify again.
CREATE FUNCTION app.retract_notifications(p_source_type text, p_source_id uuid, p_users uuid[]) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (
    DELETE FROM notifications
    WHERE tenant_id = app.tenant_id() AND source_type = p_source_type AND source_id = p_source_id
      AND user_id = ANY (p_users) AND read_at IS NULL
    RETURNING 1)
  SELECT count(*)::int FROM r
$$;
-- Creating notifications for other users runs into the same reader-only policy (INSERT … ON CONFLICT checks
-- the row against SELECT policies). Tenant and actor come from the session, never from arguments.
CREATE FUNCTION app.create_notifications(p_users uuid[], p_kind text, p_source_type text, p_source_id uuid, p_record_type text, p_record_id uuid)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH r AS (
    INSERT INTO notifications (tenant_id, user_id, kind, source_type, source_id, record_type, record_id, actor_id)
    SELECT app.tenant_id(), m.user_id, p_kind, p_source_type, p_source_id, p_record_type, p_record_id, app.user_id()
    FROM memberships m
    WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (p_users) AND m.status = 'active'
    ON CONFLICT (tenant_id, user_id, kind, source_type, source_id) DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM r
$$;
REVOKE ALL ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_notifications(uuid[], text, text, uuid, text, uuid) TO flexa_app;

REVOKE ALL ON FUNCTION app.retract_notifications(text, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.retract_notifications(text, uuid, uuid[]) TO flexa_app;

-- Revisions follow their comment's visibility.
CREATE POLICY comment_visible ON comment_revisions AS RESTRICTIVE USING (
  EXISTS (SELECT 1 FROM comments c WHERE c.tenant_id = comment_revisions.tenant_id AND c.id = comment_revisions.comment_id)
);

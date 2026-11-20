-- 0002 task core (Faz 2): record registry (polymorphic integrity), queues, workflows/statuses/transitions,
-- tasks, dependencies (DAG), tags, recurring series, custom field definitions.
-- ADR-0005 (registry, ownership, ordering), ADR-0010 (segment), ADR-0018 (custom fields), ADR-0019 (workflow),
-- ADR-0020 (recurrence). All tables: tenant_id + FORCE RLS + RESTRICTIVE tenant_isolation.

CREATE TYPE segment AS ENUM ('b2b', 'b2c');

-- ---------------------------------------------------------------------------------------------
-- Record registry: every linkable record has a row; polymorphic references FK into it (ADR-0005 §1)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE record_registry (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  record_type text NOT NULL CHECK (record_type ~ '^[a-z][a-z_]{1,31}$'),
  record_id   uuid NOT NULL,
  segment     segment,
  deleted_at  timestamptz,
  PRIMARY KEY (tenant_id, record_type, record_id)
);

-- ---------------------------------------------------------------------------------------------
-- Queues (work + call, one concept; ADR-0005 §3)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE queues (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  kind       text NOT NULL CHECK (kind IN ('work', 'call')),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  segment    segment,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, kind, name)
);
CREATE TRIGGER queues_touch BEFORE UPDATE ON queues FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE queue_members (
  tenant_id uuid NOT NULL,
  queue_id  uuid NOT NULL,
  user_id   uuid NOT NULL,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'supervisor')),
  PRIMARY KEY (tenant_id, queue_id, user_id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Workflows, statuses, transitions (ADR-0019) — configuration, not code
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflows (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z_]{1,31}$'),
  key           text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  name          text NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  version       integer NOT NULL DEFAULT 1,
  segment       segment,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, resource_type, key)
);
CREATE UNIQUE INDEX workflows_one_default ON workflows (tenant_id, resource_type) WHERE is_default;
CREATE TRIGGER workflows_touch BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE statuses (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  workflow_id uuid NOT NULL,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label_i18n  jsonb NOT NULL CHECK (jsonb_typeof(label_i18n) = 'object'),
  category    text NOT NULL CHECK (category IN ('open', 'in_progress', 'closed')),
  color_token text NOT NULL DEFAULT 'text-secondary' CHECK (color_token ~ '^[a-z][a-z0-9-]{1,31}$'),
  position    text COLLATE "C" NOT NULL,
  is_initial  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (workflow_id, key),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX statuses_one_initial ON statuses (workflow_id) WHERE is_initial;

CREATE TABLE workflow_transitions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  workflow_id    uuid NOT NULL,
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,47}$'),
  label_i18n     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(label_i18n) = 'object'),
  from_status_id uuid,
  to_status_id   uuid NOT NULL,
  conditions     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(conditions) = 'array'),
  validators     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validators) = 'array'),
  post_functions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(post_functions) = 'array'),
  UNIQUE (workflow_id, key),
  CHECK (from_status_id IS DISTINCT FROM to_status_id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_status_id) REFERENCES statuses (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_status_id) REFERENCES statuses (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Recurring series (ADR-0020) and custom fields (ADR-0018)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE task_series (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  rrule         text NOT NULL CHECK (length(rrule) BETWEEN 5 AND 500),
  dtstart_local text NOT NULL CHECK (dtstart_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  tzid          text NOT NULL,
  catch_up      text NOT NULL DEFAULT 'skip_missed' CHECK (catch_up IN ('skip_missed', 'create_next')),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE TRIGGER task_series_touch BEFORE UPDATE ON task_series FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE custom_field_definitions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  resource_type   text NOT NULL CHECK (resource_type ~ '^[a-z][a-z_]{1,31}$'),
  key             text NOT NULL CHECK (key ~ '^cf_[a-z0-9_]{1,45}$'),
  type            text NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multi_select', 'user', 'relation', 'formula')),
  label_i18n      jsonb NOT NULL CHECK (jsonb_typeof(label_i18n) = 'object'),
  required        boolean NOT NULL DEFAULT false,
  default_value   jsonb,
  options         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(options) = 'array'),
  relation_target text,
  formula         text,
  indexed         boolean NOT NULL DEFAULT false,
  position        text COLLATE "C" NOT NULL,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_type, key),
  CHECK ((type = 'formula') = (formula IS NOT NULL)),
  CHECK ((type = 'relation') = (relation_target IS NOT NULL)),
  CHECK (NOT (type = 'formula' AND required))
);
CREATE TRIGGER custom_field_definitions_touch BEFORE UPDATE ON custom_field_definitions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tasks (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  description      jsonb,
  description_text text CHECK (length(description_text) <= 100000),
  workflow_id      uuid NOT NULL,
  status_id        uuid NOT NULL,
  priority         smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
  owner_type       text NOT NULL CHECK (owner_type IN ('user', 'queue')),
  owner_id         uuid NOT NULL,
  owner_user_id    uuid,
  queue_id         uuid,
  assignee_user_id uuid,
  start_at         timestamptz,
  due_at           timestamptz,
  estimate_minutes integer CHECK (estimate_minutes BETWEEN 0 AND 10000000),
  parent_id        uuid,
  depth            smallint NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 5),
  position         text COLLATE "C" NOT NULL,
  related_type     text,
  related_id       uuid,
  segment          segment,
  series_id        uuid,
  occurrence_index integer CHECK (occurrence_index >= 0),
  custom           jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom) = 'object'),
  closed_at        timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  search           tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || coalesce(description_text, ''))) STORED,
  UNIQUE (tenant_id, id),
  -- ownership consistency: derived columns always match owner_type/owner_id (ADR-0005 §2)
  CHECK ((owner_type = 'user' AND owner_user_id = owner_id AND queue_id IS NULL)
      OR (owner_type = 'queue' AND queue_id = owner_id AND owner_user_id IS NULL)),
  CHECK ((related_type IS NULL) = (related_id IS NULL)),
  CHECK ((series_id IS NULL) = (occurrence_index IS NULL)),
  CHECK (start_at IS NULL OR due_at IS NULL OR start_at <= due_at),
  CHECK (parent_id IS DISTINCT FROM id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflows (tenant_id, id),
  FOREIGN KEY (tenant_id, status_id) REFERENCES statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES tasks (tenant_id, id),
  FOREIGN KEY (tenant_id, series_id) REFERENCES task_series (tenant_id, id),
  FOREIGN KEY (tenant_id, related_type, related_id) REFERENCES record_registry (tenant_id, record_type, record_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX tasks_series_occurrence ON tasks (tenant_id, series_id, occurrence_index) WHERE series_id IS NOT NULL;
CREATE INDEX tasks_list ON tasks (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX tasks_status_position ON tasks (tenant_id, status_id, position) WHERE deleted_at IS NULL;
CREATE INDEX tasks_owner ON tasks (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_assignee ON tasks (tenant_id, assignee_user_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_queue ON tasks (tenant_id, queue_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due ON tasks (tenant_id, due_at) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent ON tasks (tenant_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_related ON tasks (tenant_id, related_type, related_id) WHERE related_id IS NOT NULL;
CREATE INDEX tasks_created_by ON tasks (tenant_id, created_by) WHERE deleted_at IS NULL;
CREATE INDEX tasks_custom ON tasks USING gin (custom jsonb_path_ops);
CREATE INDEX tasks_search ON tasks USING gin (search);
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Sub-task depth (≤ 5) and no ancestry cycles: depth is always parent.depth + 1, computed here.
CREATE FUNCTION app.tasks_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_depth smallint;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.depth := 0;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  SELECT depth INTO parent_depth FROM tasks WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent task not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_depth + 1 > 5 THEN
    RAISE EXCEPTION 'SUBTASK_DEPTH_EXCEEDED' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM tasks WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id
      UNION ALL
      SELECT t.id, t.parent_id FROM tasks t JOIN up ON t.tenant_id = NEW.tenant_id AND t.id = up.parent_id
    ) SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'SUBTASK_CYCLE' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM tasks WHERE tenant_id = NEW.tenant_id AND parent_id = NEW.id) THEN
    -- Moving a task that has children would change their depth; keep the rule simple and explicit.
    RAISE EXCEPTION 'SUBTASK_MOVE_WITH_CHILDREN' USING ERRCODE = 'check_violation';
  END IF;
  NEW.depth := parent_depth + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_hierarchy BEFORE INSERT OR UPDATE OF parent_id ON tasks FOR EACH ROW EXECUTE FUNCTION app.tasks_hierarchy();

-- Registry maintenance: tasks are linkable records (activity, notes and other tasks may point at them).
CREATE FUNCTION app.registry_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO record_registry (tenant_id, record_type, record_id, segment, deleted_at)
    VALUES (NEW.tenant_id, TG_ARGV[0], NEW.id, NEW.segment, NEW.deleted_at);
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE record_registry SET segment = NEW.segment, deleted_at = NEW.deleted_at
    WHERE tenant_id = NEW.tenant_id AND record_type = TG_ARGV[0] AND record_id = NEW.id;
  ELSE
    DELETE FROM record_registry WHERE tenant_id = OLD.tenant_id AND record_type = TG_ARGV[0] AND record_id = OLD.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER tasks_registry AFTER INSERT OR UPDATE OF segment, deleted_at OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.registry_sync('task');

-- ---------------------------------------------------------------------------------------------
-- Dependencies (blocks / blocked-by) — DAG enforced in the database as the last line of defence
-- ---------------------------------------------------------------------------------------------
CREATE TABLE task_dependencies (
  tenant_id  uuid NOT NULL,
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id),
  FOREIGN KEY (tenant_id, blocker_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, blocked_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX task_dependencies_blocked ON task_dependencies (tenant_id, blocked_id);

CREATE FUNCTION app.task_dependencies_acyclic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialise dependency writes per tenant so two concurrent inserts cannot each miss the other's edge.
  PERFORM pg_advisory_xact_lock(hashtextextended('task_deps:' || NEW.tenant_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT blocked_id FROM task_dependencies WHERE tenant_id = NEW.tenant_id AND blocker_id = NEW.blocked_id
      UNION
      SELECT d.blocked_id FROM task_dependencies d JOIN reach r ON d.tenant_id = NEW.tenant_id AND d.blocker_id = r.id
    ) SELECT 1 FROM reach WHERE id = NEW.blocker_id
  ) THEN
    RAISE EXCEPTION 'DEPENDENCY_CYCLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_dependencies_acyclic BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION app.task_dependencies_acyclic();

-- ---------------------------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tags (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        citext NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color_token text NOT NULL DEFAULT 'text-secondary' CHECK (color_token ~ '^[a-z][a-z0-9-]{1,31}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE task_tags (
  tenant_id uuid NOT NULL,
  task_id   uuid NOT NULL,
  tag_id    uuid NOT NULL,
  PRIMARY KEY (tenant_id, task_id, tag_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX task_tags_tag ON task_tags (tenant_id, tag_id);

-- ---------------------------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['record_registry', 'queues', 'queue_members', 'workflows', 'statuses', 'workflow_transitions',
                           'task_series', 'custom_field_definitions', 'tasks', 'task_dependencies', 'tags', 'task_tags'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I AS RESTRICTIVE USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY tenant_access ON %I USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO flexa_app', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Default task workflow — one source for new tenants (called by provisioning in the tenant context)
-- and for tenants that existed before this migration (called below as owner).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.seed_task_workflow(p_tenant uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE wf uuid; s_todo uuid; s_doing uuid; s_done uuid; s_cancel uuid;
BEGIN
  SELECT id INTO wf FROM workflows WHERE tenant_id = p_tenant AND resource_type = 'task' AND is_default;
  IF FOUND THEN RETURN wf; END IF;
  INSERT INTO workflows (tenant_id, resource_type, key, name, is_default) VALUES (p_tenant, 'task', 'default', 'Görev akışı', true) RETURNING id INTO wf;
  INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position, is_initial)
    VALUES (p_tenant, wf, 'todo', '{"tr":"Yapılacak","en":"To do"}', 'open', 'text-secondary', 'a0', true) RETURNING id INTO s_todo;
  INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position)
    VALUES (p_tenant, wf, 'in_progress', '{"tr":"Devam ediyor","en":"In progress"}', 'in_progress', 'info', 'a1') RETURNING id INTO s_doing;
  INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position)
    VALUES (p_tenant, wf, 'done', '{"tr":"Tamamlandı","en":"Done"}', 'closed', 'success', 'a2') RETURNING id INTO s_done;
  INSERT INTO statuses (tenant_id, workflow_id, key, label_i18n, category, color_token, position)
    VALUES (p_tenant, wf, 'canceled', '{"tr":"İptal","en":"Canceled"}', 'closed', 'text-secondary', 'a3') RETURNING id INTO s_cancel;
  INSERT INTO workflow_transitions (tenant_id, workflow_id, key, label_i18n, from_status_id, to_status_id, validators) VALUES
    (p_tenant, wf, 'start',    '{"tr":"Başla","en":"Start"}',             s_todo,  s_doing, '[]'),
    (p_tenant, wf, 'complete', '{"tr":"Tamamla","en":"Complete"}',        s_doing, s_done,  '[{"kind":"subtasks_closed"}]'),
    (p_tenant, wf, 'finish',   '{"tr":"Doğrudan tamamla","en":"Finish"}', s_todo,  s_done,  '[{"kind":"subtasks_closed"}]'),
    (p_tenant, wf, 'pause',    '{"tr":"Beklemeye al","en":"Back to do"}', s_doing, s_todo,  '[]'),
    (p_tenant, wf, 'reopen',   '{"tr":"Yeniden aç","en":"Reopen"}',       s_done,  s_todo,  '[]'),
    (p_tenant, wf, 'cancel',   '{"tr":"İptal et","en":"Cancel"}',         NULL,    s_cancel, '[]'),
    (p_tenant, wf, 'restore',  '{"tr":"Geri al","en":"Restore"}',         s_cancel, s_todo, '[]');
  RETURN wf;
END $$;
REVOKE ALL ON FUNCTION app.seed_task_workflow(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seed_task_workflow(uuid) TO flexa_app;

DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM app.seed_task_workflow(t);
  END LOOP;
END $$;

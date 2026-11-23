-- 0010 settings screens (P6c, docs/p6-plan.md §9): optimistic concurrency for configuration that the settings
-- screens edit in place. Custom field definitions and SLA policies get a version (If-Match, ADR-0012); workflows
-- already have one.

ALTER TABLE custom_field_definitions
  ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE sla_policies
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER sla_policies_touch BEFORE UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

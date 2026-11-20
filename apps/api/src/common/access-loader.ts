import { sql, type Db } from '@flexa/db';
import type { Segment } from './request-context';
import type { AccessInfo, FieldAccess, OwdAccess, ShareType, SharingRuleInfo } from './record-access';

type Row = {
  segments: Segment[] | null;
  role_ids: string[] | null;
  team_ids: string[] | null;
  managed_team_ids: string[] | null;
  team_member_ids: string[] | null;
  managed_member_ids: string[] | null;
  queue_ids: string[] | null;
  subordinate_ids: string[] | null;
  owd: Record<string, OwdAccess> | null;
  rules: SharingRuleInfo[] | null;
  fields: { r: ShareType; f: string; a: FieldAccess; n: number }[] | null;
  role_count: number;
};

/** Everything the record-level engine needs about the caller, in one round trip (tenant RLS applies). */
export async function loadAccess(tx: Db, userId: string): Promise<{ grantedSegments: Segment[]; access: AccessInfo }> {
  const r = await tx.execute<Row>(sql`
    WITH RECURSIVE
      my_roles AS (SELECT role_id FROM user_roles WHERE user_id = ${userId} AND (valid_until IS NULL OR valid_until > now())),
      mine AS (SELECT team_id, role FROM team_members WHERE user_id = ${userId}),
      managed (id) AS (
        SELECT team_id FROM mine WHERE role = 'manager'
        UNION
        SELECT t.id FROM teams t JOIN managed m ON t.parent_team_id = m.id
      ),
      scope_teams AS (SELECT team_id AS id FROM mine UNION SELECT id FROM managed),
      sub_roles (id) AS (
        SELECT r.id FROM roles r WHERE r.parent_role_id IN (SELECT role_id FROM my_roles)
        UNION
        SELECT r.id FROM roles r JOIN sub_roles s ON r.parent_role_id = s.id
      )
    SELECT
      (SELECT array_agg(segment::text ORDER BY segment) FROM user_segment_grants
        WHERE user_id = ${userId} AND (valid_until IS NULL OR valid_until > now())) AS segments,
      (SELECT array_agg(role_id::text) FROM my_roles) AS role_ids,
      (SELECT count(*)::int FROM my_roles) AS role_count,
      (SELECT array_agg(team_id::text) FROM mine) AS team_ids,
      (SELECT array_agg(id::text) FROM managed) AS managed_team_ids,
      (SELECT array_agg(DISTINCT user_id::text) FROM team_members WHERE team_id IN (SELECT id FROM scope_teams)) AS team_member_ids,
      (SELECT array_agg(DISTINCT user_id::text) FROM team_members WHERE team_id IN (SELECT id FROM managed)) AS managed_member_ids,
      (SELECT array_agg(queue_id::text) FROM queue_members WHERE user_id = ${userId}) AS queue_ids,
      (SELECT array_agg(DISTINCT ur.user_id::text) FROM user_roles ur
        WHERE ur.role_id IN (SELECT id FROM sub_roles) AND ur.user_id <> ${userId}
          AND (ur.valid_until IS NULL OR ur.valid_until > now())) AS subordinate_ids,
      (SELECT jsonb_object_agg(resource_type, access) FROM sharing_defaults) AS owd,
      (SELECT jsonb_agg(jsonb_build_object('id', id, 'resourceType', resource_type, 'criteria', criteria, 'access', access))
        FROM sharing_rules WHERE enabled AND grantee_team_id IN (SELECT team_id FROM mine)) AS rules,
      (SELECT jsonb_agg(jsonb_build_object('r', resource_type, 'f', field, 'a', a, 'n', n)) FROM (
         SELECT resource_type, field, count(*)::int AS n,
                CASE WHEN bool_or(access = 'read') THEN 'read' ELSE 'hidden' END AS a
         FROM field_policies WHERE role_id IN (SELECT role_id FROM my_roles) GROUP BY resource_type, field) fp) AS fields`);
  const row = r.rows[0];
  const fields: AccessInfo['fields'] = {};
  // A field is restricted only when every role of the user restricts it (access = widest over roles).
  for (const f of row?.fields ?? []) {
    if (f.n < (row?.role_count ?? 0)) continue;
    (fields[f.r] ??= {})[f.f] = f.a;
  }
  return {
    grantedSegments: row?.segments ?? [],
    access: {
      roleIds: row?.role_ids ?? [],
      teamIds: row?.team_ids ?? [],
      managedTeamIds: row?.managed_team_ids ?? [],
      teamMemberIds: row?.team_member_ids ?? [],
      managedMemberIds: row?.managed_member_ids ?? [],
      queueIds: row?.queue_ids ?? [],
      subordinateUserIds: row?.subordinate_ids ?? [],
      owd: (row?.owd ?? {}),
      rules: row?.rules ?? [],
      fields,
    },
  };
}

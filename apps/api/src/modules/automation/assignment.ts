import { sql, type Db } from '@flexa/db';
import { ProblemError } from '../../common/problem';

/** Picks the next owner from an assignment policy (docs/p5-plan.md §2). The policy row is locked so that
 *  concurrent runs hand out distinct turns. Candidates are the active members of the policy's team or queue.
 *  - round_robin: the member after the previous pick (by user id), wrapping around;
 *  - load_balanced: the member with the fewest open tasks (owned or assigned) and open cases/leads they own;
 *  - nobody eligible: the fallback user, otherwise ASSIGNMENT_NO_CANDIDATE. */
export async function pickAssignee(tx: Db, policyId: string): Promise<string> {
  const p = await tx.execute<{ strategy: 'round_robin' | 'load_balanced'; team_id: string | null; queue_id: string | null; fallback_user_id: string | null; last_user_id: string | null }>(sql`
    SELECT strategy, team_id, queue_id, fallback_user_id, last_user_id FROM assignment_policies WHERE id = ${policyId} FOR UPDATE`);
  const policy = p.rows[0];
  if (!policy) throw new ProblemError('ASSIGNMENT_NO_CANDIDATE', 'assignment policy not found');
  const members = await tx.execute<{ user_id: string; load: number }>(sql`
    WITH c AS (
      SELECT m.user_id FROM memberships m
      WHERE m.status = 'active' AND m.user_id IN (
        ${policy.team_id ? sql`SELECT user_id FROM team_members WHERE team_id = ${policy.team_id}` : sql`SELECT user_id FROM queue_members WHERE queue_id = ${policy.queue_id}`})
    )
    SELECT c.user_id::text,
      (SELECT count(*)::int FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id
        WHERE t.deleted_at IS NULL AND s.category <> 'closed' AND (t.owner_user_id = c.user_id OR t.assignee_user_id = c.user_id))
      + (SELECT count(*)::int FROM cases x JOIN statuses s ON s.tenant_id = x.tenant_id AND s.id = x.status_id
        WHERE x.deleted_at IS NULL AND s.category <> 'closed' AND x.owner_user_id = c.user_id)
      + (SELECT count(*)::int FROM leads x JOIN statuses s ON s.tenant_id = x.tenant_id AND s.id = x.status_id
        WHERE x.deleted_at IS NULL AND s.category <> 'closed' AND x.owner_user_id = c.user_id) AS load
    FROM c ORDER BY c.user_id`);
  const candidates = members.rows;
  let pick: string | null = null;
  if (candidates.length > 0) {
    if (policy.strategy === 'round_robin') {
      const next = policy.last_user_id ? candidates.find((c) => c.user_id > (policy.last_user_id ?? '')) : undefined;
      pick = (next ?? candidates[0])?.user_id ?? null;
    } else {
      pick = [...candidates].sort((a, b) => a.load - b.load || (a.user_id < b.user_id ? -1 : 1))[0]?.user_id ?? null;
    }
  }
  pick ??= policy.fallback_user_id;
  if (!pick) throw new ProblemError('ASSIGNMENT_NO_CANDIDATE', 'no member of the team or queue can take the record and there is no fallback');
  await tx.execute(sql`UPDATE assignment_policies SET last_user_id = ${pick} WHERE id = ${policyId}`);
  return pick;
}

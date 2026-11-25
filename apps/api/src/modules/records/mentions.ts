import { can } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import { sql, type Db } from '@flexa/db';
import { contextForUser } from '../../common/access-loader';
import { audit } from '../../common/audit';
import { notify } from '../../common/notify';
import { ProblemError } from '../../common/problem';
import { hiddenFields, recordPredicate, uuidArray, type RecordShape, type ShareType } from '../../common/record-access';
import type { Segment, TenantRequestContext } from '../../common/request-context';
import { renderRichText, type RenderedRichText } from '../../common/rich-text';
import { CRM } from '../crm/crm-objects';
import { TASK_SHAPE, taskReadPredicate } from '../tasks/tasks.service';

// Mentions (ADR-0017 §2, docs/p8-plan.md §13–15), shared by comments, notes and descriptions. Plain functions:
// the task, CRM and note services all call them inside their own transaction.

export type MentionSource = 'comment' | 'note' | 'description';
type Mentions = RenderedRichText['mentions'];
interface Target { type: ShareType; id: string }

/** MEN-11: mentions an author may make in a minute, and the largest team that may be mentioned. */
export const MENTIONS_PER_MINUTE = 30;
export const MAX_TEAM_MEMBERS = 100;
/** People the picker examines per request; it returns the first matches among them. */
const PICKER_SCAN = 60;
const PICKER_SIZE = 8;

const shapeOf = (type: ShareType): RecordShape => (type === 'task' ? TASK_SHAPE : CRM[type].shape);
const none = (): Mentions => ({ users: new Set(), teams: new Set() });

async function segmentsOf(tx: Db, { type, id }: Target): Promise<{ any: Segment[] | null } | null> {
  const r = (await tx.execute<{ segment: Segment | null; segments: Segment[] | null }>(sql`
    SELECT segment, to_jsonb(segments) AS segments FROM record_registry WHERE record_type = ${type} AND record_id = ${id} AND deleted_at IS NULL`)).rows[0];
  if (!r) return null;
  return { any: r.segment ? [r.segment] : r.segments };
}

/** Could `ctx` (another member) read the record right now? Segment, tenant and record scope included. */
export async function canReadRecord(tx: Db, ctx: TenantRequestContext, type: ShareType, id: string): Promise<boolean> {
  const seg = await segmentsOf(tx, { type, id });
  if (!seg || (seg.any && !seg.any.some((s) => ctx.segments.includes(s)))) return false;
  const shape = shapeOf(type);
  const pred = type === 'task' ? await taskReadPredicate(tx, ctx) : await recordPredicate(tx, ctx, shape, 'read');
  const hit = await tx.execute(sql`SELECT 1 FROM ${shape.from} WHERE t.id = ${id} AND t.deleted_at IS NULL AND ${pred}`);
  return (hit.rowCount ?? 0) > 0;
}

/** Reads the record and, for a description, the field as well (MEN-03). */
async function canSeeSource(tx: Db, ctx: TenantRequestContext, target: Target, source: MentionSource): Promise<boolean> {
  if (source === 'description' && hiddenFields(ctx, target.type).has('description')) return false;
  return canReadRecord(tx, ctx, target.type, target.id);
}

/** "Mentioning grants access" (A12): off by default; only someone who may share the record grants it. */
async function grantPolicy(tx: Db, t: TenantRequestContext, target: Target): Promise<boolean> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT s.value FROM tenant_settings_head h JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${t.tenant.id} AND h.key = 'mentions'`);
  const def = configKey('mentions');
  if (!def) throw new Error('mentions config key is not registered');
  if (mergeLayer(def.default, r.rows[0]?.value ?? {}).grantAccess !== true || t.automation) return false;
  const shape = shapeOf(target.type);
  const may = await tx.execute(sql`SELECT 1 FROM ${shape.from} WHERE t.id = ${target.id} AND ${await recordPredicate(tx, t, shape, 'update')}`);
  return (may.rowCount ?? 0) > 0;
}

async function grantRead(tx: Db, t: TenantRequestContext, target: Target, userId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO record_shares (tenant_id, record_type, record_id, grantee_type, grantee_id, access, source, created_by)
    VALUES (${t.tenant.id}, ${target.type}, ${target.id}, 'user', ${userId}, 'read', 'mention', ${t.principal.userId})
    ON CONFLICT (tenant_id, record_type, record_id, grantee_type, grantee_id) DO NOTHING`);
  await audit(tx, t.tenant.id, { action: 'record.shared', actorId: t.principal.userId, targetType: target.type, targetId: target.id, details: { grantee: { type: 'user', id: userId }, access: 'read', source: 'mention' } });
}

/** Who a set of mentions reaches: user → via team. A person without access refuses the whole write (422, or
 *  gets read access under the policy); team members without access are skipped silently. */
async function resolve(tx: Db, t: TenantRequestContext, target: Target, source: MentionSource, m: Mentions): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (m.users.size === 0 && m.teams.size === 0) return out;
  if (!can(t.authz, 'mentions.create').allow) throw new ProblemError('FORBIDDEN', 'you may not mention people');
  await assertRate(tx, t, m.users.size + m.teams.size);
  const denied: string[] = [];
  let mayGrant: boolean | null = null;
  for (const u of m.users) {
    const ctx = await contextForUser(tx, t, u);
    let ok = ctx !== null && (await canSeeSource(tx, ctx, target, source));
    if (!ok && ctx !== null) {
      mayGrant ??= await grantPolicy(tx, t, target);
      if (mayGrant && (await wouldSeeWithShare(tx, ctx, target, source))) {
        await grantRead(tx, t, target, u);
        ok = true;
      }
    }
    if (ok) out.set(u, null);
    else denied.push(u);
  }
  if (denied.length) throw new ProblemError('MENTION_TARGET_NO_ACCESS', 'some mentioned people cannot see this record', { userIds: denied });
  if (m.teams.size) {
    const teams = await tx.execute<{ id: string; members: string[] | null }>(sql`
      SELECT tm.id::text, (SELECT array_agg(x.user_id::text) FROM team_members x WHERE x.team_id = tm.id) AS members FROM teams tm WHERE tm.id = ANY(${uuidArray([...m.teams])})`);
    if (teams.rows.length < m.teams.size) throw new ProblemError('VALIDATION_FAILED', 'body: unknown team mentioned');
    for (const team of teams.rows) {
      const members = team.members ?? [];
      if (members.length > MAX_TEAM_MEMBERS) throw new ProblemError('LIMIT_EXCEEDED', `teams of more than ${MAX_TEAM_MEMBERS} people cannot be mentioned`);
      for (const u of members) {
        if (out.has(u)) continue;
        const ctx = await contextForUser(tx, t, u);
        if (ctx && (await canSeeSource(tx, ctx, target, source))) out.set(u, team.id);
      }
    }
  }
  out.delete(t.principal.userId);
  return out;
}

/** A read share opens the record to `ctx` unless something else hides it (segment, role without any read scope,
 *  the field). */
async function wouldSeeWithShare(tx: Db, ctx: TenantRequestContext, target: Target, source: MentionSource): Promise<boolean> {
  if (source === 'description' && hiddenFields(ctx, target.type).has('description')) return false;
  const seg = await segmentsOf(tx, target);
  if (!seg || (seg.any && !seg.any.some((s) => ctx.segments.includes(s)))) return false;
  // Tried for real: the share is added, read with the target's own predicate, and taken back.
  await tx.execute(sql`SAVEPOINT mention_share`);
  await tx.execute(sql`
    INSERT INTO record_shares (tenant_id, record_type, record_id, grantee_type, grantee_id, access, source)
    VALUES (${ctx.tenant.id}, ${target.type}, ${target.id}, 'user', ${ctx.principal.userId}, 'read', 'mention')
    ON CONFLICT (tenant_id, record_type, record_id, grantee_type, grantee_id) DO NOTHING`);
  const ok = await canReadRecord(tx, ctx, target.type, target.id);
  await tx.execute(sql`ROLLBACK TO SAVEPOINT mention_share`);
  return ok;
}

/** MEN-11: one author, one minute. A team counts once, however many people it reaches. */
async function assertRate(tx: Db, t: TenantRequestContext, adding: number): Promise<void> {
  const r = await tx.execute<{ n: number }>(sql`
    SELECT count(DISTINCT (source_id, coalesce(via_team_id, mentioned_user)))::int AS n FROM mentions
    WHERE mentioned_by = ${t.principal.userId} AND created_at > now() - interval '1 minute'`);
  if ((r.rows[0]?.n ?? 0) + adding > MENTIONS_PER_MINUTE) {
    throw new ProblemError('RATE_LIMITED', `at most ${MENTIONS_PER_MINUTE} mentions a minute`, {}, { 'retry-after': '60' });
  }
}

/** Mentions of a stored document; one written before its content was validated counts as having none. */
function mentionsOf(doc: unknown): Mentions {
  if (doc === null || doc === undefined) return none();
  try {
    return renderRichText(doc).mentions;
  } catch {
    return none();
  }
}

/** Brings the stored mentions of a source in line with its new content (MEN-08): only people and teams that were
 *  not in the previous document are checked and notified; removed ones lose the mention and the unread notice.
 *  `next` null = the source is gone or empty. Validates the content and returns it rendered. */
export async function syncMentions(tx: Db, t: TenantRequestContext, target: Target, source: MentionSource, sourceId: string, previous: unknown, next: unknown): Promise<RenderedRichText | null> {
  const rendered = next === null || next === undefined ? null : renderRichText(next);
  const now = rendered?.mentions ?? none();
  const before = mentionsOf(previous);
  const added: Mentions = { users: new Set([...now.users].filter((u) => !before.users.has(u))), teams: new Set([...now.teams].filter((x) => !before.teams.has(x))) };
  const reached = await resolve(tx, t, target, source, added);

  const stored = await tx.execute<{ u: string; via: string | null; still: boolean }>(sql`
    SELECT m.mentioned_user::text AS u, m.via_team_id::text AS via,
      EXISTS (SELECT 1 FROM team_members x WHERE x.user_id = m.mentioned_user AND x.team_id = ANY(${uuidArray([...now.teams])})) AS still
    FROM mentions m WHERE m.source_type = ${source} AND m.source_id = ${sourceId} AND m.retracted_at IS NULL`);
  const current = new Set(stored.rows.map((r) => r.u));
  const removed = stored.rows.filter((r) => !now.users.has(r.u) && !(r.via && now.teams.has(r.via)) && !r.still && !reached.has(r.u)).map((r) => r.u);
  if (removed.length) {
    await tx.execute(sql`UPDATE mentions SET retracted_at = now() WHERE source_type = ${source} AND source_id = ${sourceId} AND mentioned_user = ANY(${uuidArray(removed)})`);
    await tx.execute(sql`SELECT app.retract_notifications(${source}, ${sourceId}::uuid, ${uuidArray(removed)})`);
  }
  const fresh = [...reached].filter(([u]) => !current.has(u));
  for (const [u, via] of fresh) {
    await tx.execute(sql`INSERT INTO mentions (tenant_id, source_type, source_id, record_type, record_id, mentioned_user, via_team_id, mentioned_by)
      VALUES (${t.tenant.id}, ${source}, ${sourceId}, ${target.type}, ${target.id}, ${u}, ${via}, ${t.principal.userId})
      ON CONFLICT (tenant_id, source_type, source_id, mentioned_user)
      DO UPDATE SET retracted_at = NULL, via_team_id = EXCLUDED.via_team_id, mentioned_by = EXCLUDED.mentioned_by, created_at = now()`);
  }
  if (fresh.length) await notify(tx, t, { users: fresh.map(([u]) => u), kind: 'mention', sourceType: source, sourceId, recordType: target.type, recordId: target.id });
  return rendered;
}

/** The `@` picker: people who can read the record (and the field), then teams. With the policy on, people whom
 *  mentioning would give access are offered too, marked. */
export async function mentionable(tx: Db, t: TenantRequestContext, target: Target, source: MentionSource, q: string) {
  if (!can(t.authz, 'mentions.create').allow) throw new ProblemError('FORBIDDEN', 'you may not mention people');
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const people = await tx.execute<{ id: string; name: string }>(sql`
    SELECT u.id::text, u.display_name AS name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.status = 'active' AND m.user_id <> ${t.principal.userId} AND u.display_name ILIKE ${like}
    ORDER BY (u.display_name ILIKE ${like.slice(1)}) DESC, u.display_name, u.id LIMIT ${PICKER_SCAN}`);
  const users: { id: string; displayName: string; grantsAccess: boolean }[] = [];
  let mayGrant: boolean | null = null;
  for (const p of people.rows) {
    if (users.length >= PICKER_SIZE) break;
    const ctx = await contextForUser(tx, t, p.id);
    if (!ctx) continue;
    if (await canSeeSource(tx, ctx, target, source)) users.push({ id: p.id, displayName: p.name, grantsAccess: false });
    else {
      mayGrant ??= await grantPolicy(tx, t, target);
      if (mayGrant && (await wouldSeeWithShare(tx, ctx, target, source))) users.push({ id: p.id, displayName: p.name, grantsAccess: true });
    }
  }
  const teams = await tx.execute<{ id: string; name: string; n: number }>(sql`
    SELECT tm.id::text, tm.name, (SELECT count(*)::int FROM team_members x WHERE x.team_id = tm.id) AS n FROM teams tm
    WHERE tm.name ILIKE ${like} ORDER BY tm.name, tm.id LIMIT 5`);
  return { users, teams: teams.rows.filter((x) => x.n > 0 && x.n <= MAX_TEAM_MEMBERS).map((x) => ({ id: x.id, name: x.name, memberCount: x.n })) };
}

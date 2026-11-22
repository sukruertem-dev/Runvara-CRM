import { Inject, Injectable } from '@nestjs/common';
import type { CustomFieldPatch, WorkflowUpdate, z } from '@flexa/contracts';
import { asc, eq, schema, sql, type Db, type DbHandle } from '@flexa/db';
import { assertNoCycles, FormulaError } from '@flexa/formula';
import { keyBetween, validateWorkflow, type Workflow } from '@flexa/workflow';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { compileDefFormula, loadFieldDefs, type FieldDefRow, type ResourceType } from './task-fields';

type Update = z.infer<typeof WorkflowUpdate>;
type FieldPatch = z.infer<typeof CustomFieldPatch>;

/** Record tables that carry a workflow status, and whether they keep `closed_at`. */
const STATUS_TABLES: Readonly<Record<string, { table: string; closedAt: boolean }>> = {
  task: { table: 'tasks', closedAt: true },
  lead: { table: 'leads', closedAt: false },
  opportunity: { table: 'opportunities', closedAt: true },
  case: { table: 'cases', closedAt: true },
};

const RECORD_TABLES: Readonly<Record<ResourceType, string>> = {
  task: 'tasks', account: 'accounts', contact: 'contacts', lead: 'leads', opportunity: 'opportunities', case: 'cases',
};

interface Plan {
  ids: Map<string, string>;
  engine: Workflow;
  added: string[];
  removed: { statusId: string; key: string; records: number; mappedTo: string | null }[];
  applicable: boolean;
}

export const workflowView = async (tx: Db, id: string) => {
  const wf = (await tx.select().from(schema.workflows).where(eq(schema.workflows.id, id)))[0];
  if (!wf) throw new ProblemError('NOT_FOUND');
  const st = await tx.select().from(schema.statuses).where(eq(schema.statuses.workflowId, id)).orderBy(asc(schema.statuses.position));
  const tr = await tx.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, id));
  return {
    id: wf.id, key: wf.key, name: wf.name, resourceType: wf.resourceType, isDefault: wf.isDefault, version: wf.version,
    statuses: st.map((s) => ({ id: s.id, key: s.key, category: s.category, label: s.labelI18n, colorToken: s.colorToken, isInitial: s.isInitial, position: s.position, wipLimit: s.wipLimit })),
    transitions: tr.map((x) => ({ id: x.id, key: x.key, label: x.labelI18n, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId, conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions })),
  };
};

/**
 * Editing workflows and custom-field definitions from the settings screens (P6c, docs/p6-plan.md §9).
 * Both are tenant configuration (Matrix A A02: `tenant.config.manage`).
 */
@Injectable()
export class ConfigEditService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  // ------------------------------------------------------------------ workflows
  async previewWorkflow(t: TenantRequestContext, id: string, body: Update) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const p = await this.plan(tx, id, body);
      return { added: p.added, removed: p.removed, applicable: p.applicable };
    });
  }

  async updateWorkflow(t: TenantRequestContext, id: string, version: number, body: Update, ip: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Version check and row lock in one statement: concurrent editors serialise here; the loser gets 412.
      const bumped = await tx.execute<{ id: string; resource_type: string }>(sql`
        UPDATE workflows SET version = version + 1, name = ${body.name} WHERE id = ${id} AND version = ${version} RETURNING id, resource_type`);
      const wf = bumped.rows[0];
      if (!wf) {
        const exists = await tx.execute(sql`SELECT 1 FROM workflows WHERE id = ${id}`);
        throw exists.rows.length > 0 ? new ProblemError('PRECONDITION_FAILED', 'the workflow was changed by someone else') : new ProblemError('NOT_FOUND');
      }
      const p = await this.plan(tx, id, body);
      if (!p.applicable) {
        throw new ProblemError('WORKFLOW_STATUS_IN_USE', 'records sit in statuses being removed; map them to a remaining status', { removed: p.removed });
      }
      const target = STATUS_TABLES[wf.resource_type];
      const categoryOf = new Map(body.statuses.map((s) => [s.key, s.category]));
      try {
        // 1. Transitions are replaced wholesale (rules refer to them by key, which the editor keeps).
        await tx.execute(sql`DELETE FROM workflow_transitions WHERE workflow_id = ${id}`);
        // 2. Removed statuses step aside: their key is freed (a new status may reuse it) until they are deleted.
        for (const r of p.removed) await tx.execute(sql`UPDATE statuses SET key = 'r' || replace(id::text, '-', ''), is_initial = false WHERE id = ${r.statusId}`);
        // 3. Upsert statuses in the given order; the single-initial index needs the flag cleared first.
        await tx.execute(sql`UPDATE statuses SET is_initial = false WHERE workflow_id = ${id} AND is_initial`);
        let pos: string | null = null;
        for (const s of body.statuses) {
          pos = keyBetween(pos, null);
          const sid = p.ids.get(s.key) ?? randomUUID();
          if (s.id) {
            await tx.execute(sql`UPDATE statuses SET label_i18n = ${JSON.stringify(s.label)}::jsonb, category = ${s.category}, color_token = ${s.colorToken},
              position = ${pos}, is_initial = ${s.isInitial}, wip_limit = ${s.wipLimit} WHERE id = ${sid}`);
          } else {
            await tx.execute(sql`INSERT INTO statuses (id, tenant_id, workflow_id, key, label_i18n, category, color_token, position, is_initial, wip_limit)
              VALUES (${sid}, ${t.tenant.id}, ${id}, ${s.key}, ${JSON.stringify(s.label)}::jsonb, ${s.category}, ${s.colorToken}, ${pos}, ${s.isInitial}, ${s.wipLimit})`);
          }
          // Opportunity stages: every pipeline on this workflow gets the stage; probability is set when given.
          if (wf.resource_type === 'opportunity') {
            await tx.execute(sql`INSERT INTO pipeline_stages (tenant_id, pipeline_id, status_id, probability)
              SELECT ${t.tenant.id}, p.id, ${sid}, ${s.probability ?? 0} FROM pipelines p WHERE p.workflow_id = ${id}
              ON CONFLICT (tenant_id, pipeline_id, status_id) DO UPDATE SET probability = ${s.probability === undefined ? sql`pipeline_stages.probability` : sql`EXCLUDED.probability`}`);
          }
        }
        // 4. Move records out of removed statuses (closed_at follows the target category).
        for (const r of p.removed) {
          if (r.records === 0 || r.mappedTo === null || !target) continue;
          const to = p.ids.get(r.mappedTo);
          if (!to) throw new ProblemError('WORKFLOW_INVALID', `unknown status "${r.mappedTo}"`);
          const closed = categoryOf.get(r.mappedTo) === 'closed';
          await tx.execute(sql`UPDATE ${sql.identifier(target.table)} SET status_id = ${to}, version = version + 1
            ${target.closedAt ? sql`, closed_at = CASE WHEN ${closed} THEN COALESCE(closed_at, now()) ELSE NULL END` : sql``}
            WHERE workflow_id = ${id} AND status_id = ${r.statusId}`);
        }
        // 5. Removed statuses go (a record hidden from this caller by segment still holds one → FK violation below).
        for (const r of p.removed) await tx.execute(sql`DELETE FROM statuses WHERE id = ${r.statusId}`);
        // 6. Transitions.
        for (const [i, x] of p.engine.transitions.entries()) {
          const src = body.transitions[i];
          await tx.execute(sql`INSERT INTO workflow_transitions (id, tenant_id, workflow_id, key, label_i18n, from_status_id, to_status_id, conditions, validators, post_functions)
            VALUES (${x.id}, ${t.tenant.id}, ${id}, ${x.key}, ${JSON.stringify(src?.label ?? {})}::jsonb, ${x.fromStatusId}, ${x.toStatusId},
              ${JSON.stringify(x.conditions)}::jsonb, ${JSON.stringify(x.validators)}::jsonb, ${JSON.stringify(x.postFunctions)}::jsonb)`);
        }
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        const code = (e as { cause?: { code?: string } }).cause?.code;
        if (code === '23503') throw new ProblemError('WORKFLOW_STATUS_IN_USE', 'a removed status still holds records you cannot see (segment); ask an Admin with every segment', { removed: p.removed });
        if (isUniqueViolation(e)) throw new ProblemError('WORKFLOW_INVALID', 'duplicate status or transition key');
        throw e;
      }
      await audit(tx, t.tenant.id, {
        action: 'workflow.updated', actorId: t.principal.userId, targetType: 'workflow', targetId: id, ip,
        details: { added: p.added, removed: p.removed.map((r) => ({ key: r.key, records: r.records, mappedTo: r.mappedTo })) },
      });
      return workflowView(tx, id);
    });
  }

  /** Validates the new definition against the stored one and counts the records each removal would move. */
  private async plan(tx: Db, id: string, body: Update): Promise<Plan> {
    const wf = (await tx.select().from(schema.workflows).where(eq(schema.workflows.id, id)))[0];
    if (!wf) throw new ProblemError('NOT_FOUND');
    const current = await tx.select().from(schema.statuses).where(eq(schema.statuses.workflowId, id));
    const byId = new Map(current.map((s) => [s.id, s]));
    for (const s of body.statuses) {
      if (s.id === undefined) continue;
      const c = byId.get(s.id);
      if (!c) throw new ProblemError('WORKFLOW_INVALID', `status ${s.id} does not belong to this workflow`);
      // Keys are references (saved views, rule conditions, SLA pause lists): they never change.
      if (c.key !== s.key) throw new ProblemError('WORKFLOW_INVALID', `status key "${c.key}" cannot be changed`);
    }
    if (body.statuses.some((s) => s.probability !== undefined) && wf.resourceType !== 'opportunity') {
      throw new ProblemError('WORKFLOW_INVALID', 'probability applies to opportunity workflows only');
    }
    const ids = new Map(body.statuses.map((s) => [s.key, s.id ?? randomUUID()]));
    const idOf = (key: string): string => {
      const v = ids.get(key);
      if (!v) throw new ProblemError('WORKFLOW_INVALID', `unknown status "${key}"`);
      return v;
    };
    const engine: Workflow = {
      statuses: body.statuses.map((s) => ({ id: idOf(s.key), key: s.key, category: s.category, isInitial: s.isInitial })),
      transitions: body.transitions.map((x) => ({
        id: randomUUID(), key: x.key, fromStatusId: x.from === null ? null : idOf(x.from), toStatusId: idOf(x.to),
        conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions,
      })),
    };
    try {
      validateWorkflow(engine);
    } catch (e) {
      throw new ProblemError('WORKFLOW_INVALID', (e as Error).message);
    }
    const kept = new Set(body.statuses.flatMap((s) => (s.id ? [s.id] : [])));
    const removedRows = current.filter((s) => !kept.has(s.id));
    for (const [from, to] of Object.entries(body.statusMap)) {
      if (!removedRows.some((r) => r.id === from)) throw new ProblemError('WORKFLOW_INVALID', `statusMap: ${from} is not a removed status`);
      if (!ids.has(to)) throw new ProblemError('WORKFLOW_INVALID', `statusMap: unknown target status "${to}"`);
    }
    const counts = new Map<string, number>();
    const target = STATUS_TABLES[wf.resourceType];
    if (target && removedRows.length > 0) {
      const r = await tx.execute<{ status_id: string; n: number }>(sql`
        SELECT status_id, count(*)::int AS n FROM ${sql.identifier(target.table)}
        WHERE workflow_id = ${id} AND status_id IN (${sql.join(removedRows.map((s) => sql`${s.id}::uuid`), sql`, `)}) GROUP BY status_id`);
      for (const row of r.rows) counts.set(row.status_id, row.n);
    }
    const removed = removedRows.map((s) => ({ statusId: s.id, key: s.key, records: counts.get(s.id) ?? 0, mappedTo: body.statusMap[s.id] ?? null }));
    return {
      ids, engine, removed,
      added: body.statuses.filter((s) => s.id === undefined).map((s) => s.key),
      applicable: removed.every((r) => r.records === 0 || r.mappedTo !== null),
    };
  }

  // ------------------------------------------------------------------ custom fields
  async patchField(t: TenantRequestContext, id: string, version: number, body: FieldPatch, ip: string): Promise<FieldDefRow> {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = (await tx.execute<{ id: string; resource_type: string; version: number }>(sql`
        SELECT id, resource_type, version FROM custom_field_definitions WHERE id = ${id} FOR UPDATE`)).rows[0];
      if (!cur) throw new ProblemError('NOT_FOUND');
      if (cur.version !== version) throw new ProblemError('PRECONDITION_FAILED', 'the field was changed by someone else');
      const defs = await loadFieldDefs(tx, cur.resource_type as ResourceType);
      const def = defs.find((d) => d.id === id);
      if (!def) throw new ProblemError('NOT_FOUND');
      if (def.type === 'formula' && body.required) throw new ProblemError('VALIDATION_FAILED', 'formula fields cannot be required');
      const isSelect = def.type === 'select' || def.type === 'multi_select';
      if (body.options !== undefined) {
        if (!isSelect) throw new ProblemError('VALIDATION_FAILED', 'options apply to select fields only');
        if (body.options.length === 0) throw new ProblemError('VALIDATION_FAILED', 'options are required for select fields');
        if (new Set(body.options.map((o) => o.id)).size !== body.options.length) throw new ProblemError('VALIDATION_FAILED', 'duplicate option id');
        const gone = def.options.filter((o) => !body.options?.some((n) => n.id === o.id)).map((o) => o.id);
        const table = RECORD_TABLES[def.resourceType as ResourceType];
        for (const optionId of gone) {
          const used = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
            WHERE custom -> ${def.key} = to_jsonb(${optionId}::text) OR (jsonb_typeof(custom -> ${def.key}) = 'array' AND custom -> ${def.key} ? ${optionId})`);
          const n = used.rows[0]?.n ?? 0;
          if (n > 0) throw new ProblemError('CUSTOM_FIELD_OPTION_IN_USE', `option "${optionId}" is used by ${String(n)} record(s)`, { optionId, records: n });
        }
      }
      let position = def.position;
      if (body.moveAfter !== undefined) {
        const others = defs.filter((d) => d.id !== id);
        const idx = body.moveAfter === null ? -1 : others.findIndex((d) => d.id === body.moveAfter);
        if (body.moveAfter !== null && idx < 0) throw new ProblemError('VALIDATION_FAILED', 'moveAfter: unknown field');
        position = keyBetween(idx < 0 ? null : (others[idx]?.position ?? null), others[idx + 1]?.position ?? null);
      }
      const r = await tx.execute<{ id: string }>(sql`UPDATE custom_field_definitions SET
          label_i18n = ${JSON.stringify(body.label ?? def.labelI18n)}::jsonb,
          required = ${body.required ?? def.required},
          default_value = ${body.defaultValue === undefined ? sql`default_value` : sql`${body.defaultValue === null ? null : JSON.stringify(body.defaultValue)}::jsonb`},
          options = ${JSON.stringify(body.options ?? def.options)}::jsonb,
          indexed = ${body.indexed ?? def.indexed},
          position = ${position},
          version = version + 1
        WHERE id = ${id} RETURNING id`);
      if (r.rows.length === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'custom_field.updated', actorId: t.principal.userId, targetType: 'custom_field', targetId: id, ip, details: { changed: Object.keys(body) } });
      const after = (await tx.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id)))[0];
      if (!after) throw new ProblemError('NOT_FOUND');
      return after;
    });
  }

  async restoreField(t: TenantRequestContext, id: string, ip: string): Promise<FieldDefRow> {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = (await tx.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id)))[0];
      if (!cur) throw new ProblemError('NOT_FOUND');
      // Formulas created while this one was archived may reference it in a loop: check before it counts again.
      if (cur.type === 'formula' && cur.formula) {
        const rt = cur.resourceType as ResourceType;
        const defs = await loadFieldDefs(tx, rt);
        const active = defs.filter((d) => d.type === 'formula' && d.formula && (d.archivedAt === null || d.id === id));
        try {
          assertNoCycles(active.map((d) => ({ key: `custom.${d.key}`, formula: compileDefFormula(d.formula ?? '', defs, rt) })));
        } catch (e) {
          if (e instanceof FormulaError) throw new ProblemError('FORMULA_INVALID', e.message, { formulaCode: e.code });
          throw e;
        }
      }
      const r = await tx.update(schema.customFieldDefinitions).set({ archivedAt: null, version: sql`${schema.customFieldDefinitions.version} + 1` })
        .where(eq(schema.customFieldDefinitions.id, id)).returning();
      const row = r[0];
      if (!row) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'custom_field.restored', actorId: t.principal.userId, targetType: 'custom_field', targetId: id, ip });
      return row;
    });
  }
}

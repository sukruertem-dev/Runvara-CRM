import type { CustomFieldCreate, WorkflowCreate, z } from '@flexa/contracts';
import { one, schema, type Db } from '@flexa/db';
import { assertNoCycles, FormulaError } from '@flexa/formula';
import { keyBetween, validateWorkflow, type Workflow } from '@flexa/workflow';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import type { TenantRequestContext } from '../../common/request-context';
import { compileDefFormula, loadFieldDefs, type FieldDefRow } from './task-fields';

// Creating custom-field definitions and task workflows inside the caller's transaction. The settings
// endpoints and the configuration import (P7b) share these, so both apply the same validation.

type FieldCreate = z.infer<typeof CustomFieldCreate>;
type WorkflowInput = z.infer<typeof WorkflowCreate>;

/** Checks that do not need the database. Throws VALIDATION_FAILED. */
export function checkCustomField(body: FieldCreate): void {
  if ((body.type === 'select' || body.type === 'multi_select') && body.options.length === 0) throw new ProblemError('VALIDATION_FAILED', 'options are required for select fields');
  if ((body.type === 'relation') !== (body.relationTarget !== undefined)) throw new ProblemError('VALIDATION_FAILED', 'relationTarget is required for (and only for) relation fields');
  if ((body.type === 'formula') !== (body.formula !== undefined)) throw new ProblemError('VALIDATION_FAILED', 'formula is required for (and only for) formula fields');
  if (body.type === 'formula' && body.required) throw new ProblemError('VALIDATION_FAILED', 'formula fields cannot be required');
}

export async function insertCustomField(tx: Db, t: TenantRequestContext, body: FieldCreate, ip: string): Promise<FieldDefRow> {
  checkCustomField(body);
  const defs = await loadFieldDefs(tx, body.resourceType);
  if (body.formula) {
    const f = compileDefFormula(body.formula, defs, body.resourceType);
    const others = defs.filter((d) => d.type === 'formula' && d.formula && !d.archivedAt).map((d) => ({ key: `custom.${d.key}`, formula: compileDefFormula(d.formula ?? '', defs, body.resourceType) }));
    try {
      assertNoCycles([...others, { key: `custom.${body.key}`, formula: f }]);
    } catch (e) {
      if (e instanceof FormulaError) throw new ProblemError('FORMULA_INVALID', e.message, { formulaCode: e.code });
      throw e;
    }
  }
  const last = defs.at(-1)?.position ?? null;
  try {
    const row = one(await tx.insert(schema.customFieldDefinitions).values({
      tenantId: t.tenant.id, resourceType: body.resourceType, key: body.key, type: body.type, labelI18n: body.label, required: body.required,
      defaultValue: body.defaultValue ?? null, options: body.options, relationTarget: body.relationTarget ?? null, formula: body.formula ?? null,
      indexed: body.indexed, position: keyBetween(last, null),
    }).returning(), 'custom field');
    await audit(tx, t.tenant.id, { action: 'custom_field.created', actorId: t.principal.userId, targetType: 'custom_field', targetId: row.id, ip, details: { key: body.key, type: body.type } });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `custom field "${body.key}" already exists`);
    throw e;
  }
}

/** Builds the state machine with fresh ids and validates it (WORKFLOW_INVALID). */
export function buildTaskWorkflow(body: WorkflowInput): { ids: Map<string, string>; engine: Workflow } {
  const ids = new Map(body.statuses.map((s) => [s.key, randomUUID()]));
  const idOf = (key: string): string => {
    const v = ids.get(key);
    if (!v) throw new ProblemError('WORKFLOW_INVALID', `unknown status "${key}"`);
    return v;
  };
  const engine: Workflow = {
    statuses: body.statuses.map((s) => ({ id: idOf(s.key), key: s.key, category: s.category, isInitial: s.isInitial })),
    transitions: body.transitions.map((x) => ({ id: randomUUID(), key: x.key, fromStatusId: x.from === null ? null : idOf(x.from), toStatusId: idOf(x.to), conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions })),
  };
  try {
    validateWorkflow(engine);
  } catch (e) {
    throw new ProblemError('WORKFLOW_INVALID', (e as Error).message);
  }
  return { ids, engine };
}

export async function insertTaskWorkflow(tx: Db, t: TenantRequestContext, body: WorkflowInput, ip: string): Promise<string> {
  const { ids, engine } = buildTaskWorkflow(body);
  try {
    const wf = one(await tx.insert(schema.workflows).values({ tenantId: t.tenant.id, resourceType: 'task', key: body.key, name: body.name, isDefault: false, version: 1 }).returning(), 'workflow');
    let pos: string | null = null;
    for (const s of body.statuses) {
      pos = keyBetween(pos, null);
      await tx.insert(schema.statuses).values({ id: ids.get(s.key) ?? randomUUID(), tenantId: t.tenant.id, workflowId: wf.id, key: s.key, labelI18n: s.label, category: s.category, colorToken: s.colorToken, position: pos, isInitial: s.isInitial, wipLimit: s.wipLimit });
    }
    for (const [i, x] of engine.transitions.entries()) {
      const src = body.transitions[i];
      await tx.insert(schema.workflowTransitions).values({
        id: x.id, tenantId: t.tenant.id, workflowId: wf.id, key: x.key, labelI18n: src?.label ?? {}, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId,
        conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions,
      });
    }
    await audit(tx, t.tenant.id, { action: 'workflow.created', actorId: t.principal.userId, targetType: 'workflow', targetId: wf.id, ip, details: { key: body.key } });
    return wf.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `workflow "${body.key}" already exists`);
    throw e;
  }
}

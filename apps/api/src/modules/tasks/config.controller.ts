import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CustomFieldCreate, WorkflowCreate, type z } from '@flexa/contracts';
import { and, eq, isNull, one, schema, type DbHandle } from '@flexa/db';
import { FormulaError, assertNoCycles } from '@flexa/formula';
import { keyBetween, validateWorkflow, type Workflow } from '@flexa/workflow';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { compileDefFormula, loadFieldDefs, RESOURCE_TYPES, type FieldDefRow, type ResourceType } from './task-fields';

type DefRow = FieldDefRow;
const defView = (d: DefRow) => ({
  id: d.id, resourceType: d.resourceType, key: d.key, type: d.type, label: d.labelI18n, required: d.required, defaultValue: d.defaultValue ?? null,
  options: d.options, relationTarget: d.relationTarget, formula: d.formula, indexed: d.indexed, archived: d.archivedAt !== null,
});

/** Workflow and custom-field configuration (ADR-0018, ADR-0019). Reading needs only membership; changing it
 *  is tenant configuration (Matrix A A02: Admin). */
@Controller('v1')
@UseGuards(TenantGuard)
export class TaskConfigController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get('workflows')
  async workflows(@CurrentTenant() t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const wfs = await tx.select().from(schema.workflows);
      const st = await tx.select().from(schema.statuses);
      const tr = await tx.select().from(schema.workflowTransitions);
      return {
        data: wfs.map((w) => ({
          id: w.id, key: w.key, name: w.name, resourceType: w.resourceType, isDefault: w.isDefault,
          statuses: st.filter((s) => s.workflowId === w.id).sort((a, b) => (a.position < b.position ? -1 : 1))
            .map((s) => ({ id: s.id, key: s.key, category: s.category, label: s.labelI18n, colorToken: s.colorToken, isInitial: s.isInitial, position: s.position })),
          transitions: tr.filter((x) => x.workflowId === w.id)
            .map((x) => ({ id: x.id, key: x.key, label: x.labelI18n, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId, conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions })),
        })),
      };
    });
  }

  @Post('workflows')
  async createWorkflow(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(WorkflowCreate)) body: z.infer<typeof WorkflowCreate>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    // Validate the state machine before touching the database (ids are generated up front).
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
    return this.db.withTenant(dbCtx(t), async (tx) => {
      try {
        const wf = one(await tx.insert(schema.workflows).values({ tenantId: t.tenant.id, resourceType: 'task', key: body.key, name: body.name, isDefault: false, version: 1 }).returning(), 'workflow');
        let pos: string | null = null;
        for (const s of body.statuses) {
          pos = keyBetween(pos, null);
          await tx.insert(schema.statuses).values({ id: idOf(s.key), tenantId: t.tenant.id, workflowId: wf.id, key: s.key, labelI18n: s.label, category: s.category, colorToken: s.colorToken, position: pos, isInitial: s.isInitial });
        }
        for (const [i, x] of engine.transitions.entries()) {
          const src = body.transitions[i];
          await tx.insert(schema.workflowTransitions).values({
            id: x.id, tenantId: t.tenant.id, workflowId: wf.id, key: x.key, labelI18n: src?.label ?? {}, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId,
            conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions,
          });
        }
        await audit(tx, t.tenant.id, { action: 'workflow.created', actorId: t.principal.userId, targetType: 'workflow', targetId: wf.id, ip: c.ip, details: { key: body.key } });
        const statuses = await tx.select().from(schema.statuses).where(eq(schema.statuses.workflowId, wf.id));
        const transitions = await tx.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, wf.id));
        return {
          id: wf.id, key: wf.key, name: wf.name, resourceType: wf.resourceType, isDefault: wf.isDefault,
          statuses: statuses.map((s) => ({ id: s.id, key: s.key, category: s.category, label: s.labelI18n, colorToken: s.colorToken, isInitial: s.isInitial, position: s.position })),
          transitions: transitions.map((x) => ({ id: x.id, key: x.key, label: x.labelI18n, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId, conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions })),
        };
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `workflow "${body.key}" already exists`);
        throw e;
      }
    });
  }

  @Get('custom-fields')
  async customFields(@CurrentTenant() t: TenantRequestContext, @Query('resourceType') resourceType: string | undefined) {
    const rt = resourceType ?? 'task';
    if (!(RESOURCE_TYPES as readonly string[]).includes(rt)) throw new ProblemError('VALIDATION_FAILED', `resourceType must be one of ${RESOURCE_TYPES.join(', ')}`);
    const defs = await this.db.withTenant(dbCtx(t), (tx) => loadFieldDefs(tx, rt as ResourceType));
    return { data: defs.map(defView) };
  }

  @Post('custom-fields')
  async createCustomField(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CustomFieldCreate)) body: z.infer<typeof CustomFieldCreate>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    if ((body.type === 'select' || body.type === 'multi_select') && body.options.length === 0) throw new ProblemError('VALIDATION_FAILED', 'options are required for select fields');
    if ((body.type === 'relation') !== (body.relationTarget !== undefined)) throw new ProblemError('VALIDATION_FAILED', 'relationTarget is required for (and only for) relation fields');
    if ((body.type === 'formula') !== (body.formula !== undefined)) throw new ProblemError('VALIDATION_FAILED', 'formula is required for (and only for) formula fields');
    if (body.type === 'formula' && body.required) throw new ProblemError('VALIDATION_FAILED', 'formula fields cannot be required');
    return this.db.withTenant(dbCtx(t), async (tx) => {
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
        await audit(tx, t.tenant.id, { action: 'custom_field.created', actorId: t.principal.userId, targetType: 'custom_field', targetId: row.id, ip: c.ip, details: { key: body.key, type: body.type } });
        return defView(row);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `custom field "${body.key}" already exists`);
        throw e;
      }
    });
  }

  @Post('custom-fields/:id/archive')
  @HttpCode(204)
  async archive(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.update(schema.customFieldDefinitions).set({ archivedAt: new Date() })
        .where(and(eq(schema.customFieldDefinitions.id, id), isNull(schema.customFieldDefinitions.archivedAt))).returning({ id: schema.customFieldDefinitions.id });
      if (r.length === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'custom_field.archived', actorId: t.principal.userId, targetType: 'custom_field', targetId: id, ip: c.ip });
    });
  }
}

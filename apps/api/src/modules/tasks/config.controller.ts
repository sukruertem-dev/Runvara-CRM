import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CustomFieldCreate, CustomFieldPatch, WorkflowCreate, WorkflowUpdate, type z } from '@flexa/contracts';
import { and, asc, eq, isNull, schema, type DbHandle } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { requireIfMatch } from '../../common/http-helpers';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { buildTaskWorkflow, checkCustomField, insertCustomField, insertTaskWorkflow } from './config-defs';
import { ConfigEditService, workflowView } from './config-edit.service';
import { loadFieldDefs, RESOURCE_TYPES, type FieldDefRow, type ResourceType } from './task-fields';

type DefRow = FieldDefRow;
const defView = (d: DefRow) => ({
  id: d.id, resourceType: d.resourceType, key: d.key, type: d.type, label: d.labelI18n, required: d.required, defaultValue: d.defaultValue ?? null,
  options: d.options, relationTarget: d.relationTarget, formula: d.formula, indexed: d.indexed, archived: d.archivedAt !== null, version: d.version,
});

/** Workflow and custom-field configuration (ADR-0018, ADR-0019). Reading needs only membership; changing it
 *  is tenant configuration (Matrix A A02: Admin). */
@Controller('v1')
@UseGuards(TenantGuard)
export class TaskConfigController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly edit: ConfigEditService,
  ) {}

  @Get('workflows')
  async workflows(@CurrentTenant() t: TenantRequestContext) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Stable order: by resource type, then creation (uuidv7).
      const wfs = await tx.select().from(schema.workflows).orderBy(asc(schema.workflows.resourceType), asc(schema.workflows.id));
      const st = await tx.select().from(schema.statuses);
      const tr = await tx.select().from(schema.workflowTransitions);
      return {
        data: wfs.map((w) => ({
          id: w.id, key: w.key, name: w.name, resourceType: w.resourceType, isDefault: w.isDefault, version: w.version,
          statuses: st.filter((s) => s.workflowId === w.id).sort((a, b) => (a.position < b.position ? -1 : 1))
            .map((s) => ({ id: s.id, key: s.key, category: s.category, label: s.labelI18n, colorToken: s.colorToken, isInitial: s.isInitial, position: s.position, wipLimit: s.wipLimit })),
          transitions: tr.filter((x) => x.workflowId === w.id)
            .map((x) => ({ id: x.id, key: x.key, label: x.labelI18n, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId, conditions: x.conditions, validators: x.validators, postFunctions: x.postFunctions })),
        })),
      };
    });
  }

  @Post('workflows')
  async createWorkflow(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(WorkflowCreate)) body: z.infer<typeof WorkflowCreate>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    // The state machine is validated before the database is touched (ids are generated up front).
    buildTaskWorkflow(body);
    return this.db.withTenant(dbCtx(t), async (tx) => workflowView(tx, await insertTaskWorkflow(tx, t, body, c.ip)));
  }

  @Post('workflows/:id/preview')
  @HttpCode(200)
  previewWorkflow(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(WorkflowUpdate)) body: z.infer<typeof WorkflowUpdate>) {
    return this.edit.previewWorkflow(t, id, body);
  }

  @Put('workflows/:id')
  updateWorkflow(
    @CurrentTenant() t: TenantRequestContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(WorkflowUpdate)) body: z.infer<typeof WorkflowUpdate>,
    @Client() c: ClientInfo,
  ) {
    return this.edit.updateWorkflow(t, id, requireIfMatch(ifMatch), body, c.ip);
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
    checkCustomField(body);
    return defView(await this.db.withTenant(dbCtx(t), (tx) => insertCustomField(tx, t, body, c.ip)));
  }

  @Patch('custom-fields/:id')
  async patchCustomField(
    @CurrentTenant() t: TenantRequestContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(CustomFieldPatch)) body: z.infer<typeof CustomFieldPatch>,
    @Client() c: ClientInfo,
  ) {
    return defView(await this.edit.patchField(t, id, requireIfMatch(ifMatch), body, c.ip));
  }

  @Post('custom-fields/:id/restore')
  @HttpCode(200)
  async restoreCustomField(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo) {
    return defView(await this.edit.restoreField(t, id, c.ip));
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

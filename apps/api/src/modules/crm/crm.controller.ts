import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards, type Type } from '@nestjs/common';
import { AccountRoleSet, ContactPointInput, LeadConvertRequest, MergeRequest, NoteCreate, NotePatch, RecordTransitionRequest, type z } from '@flexa/contracts';
import type { FastifyReply } from 'fastify';
import { TenantGuard } from '../../common/guards';
import { etag, requireIfMatch } from '../../common/http-helpers';
import type { ListQuery } from '../../common/keyset-list';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import type { CrmType } from './crm-objects';
import { CrmOpsService } from './crm-ops.service';
import { CREATE_SCHEMAS, CrmService, PATCH_SCHEMAS } from './crm.service';
import { NotesService } from './notes.service';

const Id = new ParseUUIDPipe();

/** Status changes go through the workflow engine only (ADR-0019). */
function rejectStatusInPatch(body: unknown, path: string): unknown {
  if (body && typeof body === 'object' && ('statusId' in body || 'status_id' in body || 'status' in body)) {
    throw new ProblemError('USE_TRANSITION_ENDPOINT', `change status with POST /v1/${path}/{id}/transition`);
  }
  return body;
}

/** The shared record endpoints of one CRM object (list/create/get/patch/delete/restore/related tasks). */
function recordController(path: string, type: CrmType): Type {
  @Controller(`v1/${path}`)
  @UseGuards(TenantGuard)
  class RecordController {
    constructor(readonly crm: CrmService) {}

    @Get()
    list(@CurrentTenant() t: TenantRequestContext, @Query() q: ListQuery) {
      return this.crm.list(t, type, q);
    }

    @Post()
    create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CREATE_SCHEMAS[type])) body: unknown) {
      return this.crm.create(t, type, body);
    }

    @Get(':id')
    async get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
      const view = await this.crm.get(t, type, id);
      void reply.header('etag', etag(view.version as number));
      return view;
    }

    @Patch(':id')
    async patch(
      @CurrentTenant() t: TenantRequestContext,
      @Param('id', Id) id: string,
      @Headers('if-match') ifMatch: string | undefined,
      @Body() raw: unknown,
      @Res({ passthrough: true }) reply: FastifyReply,
    ) {
      const body = PATCH_SCHEMAS[type].parse(rejectStatusInPatch(raw, path)) as Record<string, unknown>;
      const view = await this.crm.patch(t, type, id, requireIfMatch(ifMatch), body);
      void reply.header('etag', etag(view.version as number));
      return view;
    }

    @Delete(':id')
    @HttpCode(204)
    async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') ifMatch: string | undefined): Promise<void> {
      await this.crm.remove(t, type, id, requireIfMatch(ifMatch));
    }

    @Post(':id/restore')
    @HttpCode(200)
    restore(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
      return this.crm.restore(t, type, id);
    }

    @Get(':id/tasks')
    tasks(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query() q: ListQuery) {
      return this.crm.relatedTasks(t, type, id, q);
    }
  }
  Object.defineProperty(RecordController, 'name', { value: `${type[0]?.toUpperCase() ?? ''}${type.slice(1)}RecordController` });
  return RecordController;
}

export const AccountsController = recordController('accounts', 'account');
export const ContactsController = recordController('contacts', 'contact');
export const LeadsController = recordController('leads', 'lead');
export const OpportunitiesController = recordController('opportunities', 'opportunity');
export const CasesController = recordController('cases', 'case');

/** Object-specific operations: workflow transitions, contact points, account roles, convert, merge, duplicates. */
@Controller('v1')
@UseGuards(TenantGuard)
export class CrmOperationsController {
  constructor(private readonly crm: CrmService, private readonly ops: CrmOpsService) {}

  @Post('leads/:id/transition')
  @HttpCode(200)
  leadTransition(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(RecordTransitionRequest)) body: z.infer<typeof RecordTransitionRequest>) {
    return this.crm.transition(t, 'lead', id, body);
  }

  @Post('opportunities/:id/transition')
  @HttpCode(200)
  opportunityTransition(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(RecordTransitionRequest)) body: z.infer<typeof RecordTransitionRequest>) {
    return this.crm.transition(t, 'opportunity', id, body);
  }

  @Post('cases/:id/transition')
  @HttpCode(200)
  caseTransition(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(RecordTransitionRequest)) body: z.infer<typeof RecordTransitionRequest>) {
    return this.crm.transition(t, 'case', id, body);
  }

  @Post('leads/:id/convert')
  @HttpCode(200)
  convert(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(LeadConvertRequest)) body: z.infer<typeof LeadConvertRequest>, @Client() c: ClientInfo) {
    return this.ops.convert(t, id, body, c.ip);
  }

  @Get('pipelines')
  pipelines(@CurrentTenant() t: TenantRequestContext) {
    return this.crm.pipelines(t);
  }

  @Post('accounts/:id/contact-points')
  accountPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ContactPointInput)) body: z.infer<typeof ContactPointInput>) {
    return this.crm.addContactPoint(t, 'account', id, body);
  }

  @Post('contacts/:id/contact-points')
  contactPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ContactPointInput)) body: z.infer<typeof ContactPointInput>) {
    return this.crm.addContactPoint(t, 'contact', id, body);
  }

  @Post('leads/:id/contact-points')
  leadPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ContactPointInput)) body: z.infer<typeof ContactPointInput>) {
    return this.crm.addContactPoint(t, 'lead', id, body);
  }

  @Delete('accounts/:id/contact-points/:pointId')
  @HttpCode(204)
  async removeAccountPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('pointId', Id) pointId: string): Promise<void> {
    await this.crm.removeContactPoint(t, 'account', id, pointId);
  }

  @Delete('contacts/:id/contact-points/:pointId')
  @HttpCode(204)
  async removeContactPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('pointId', Id) pointId: string): Promise<void> {
    await this.crm.removeContactPoint(t, 'contact', id, pointId);
  }

  @Delete('leads/:id/contact-points/:pointId')
  @HttpCode(204)
  async removeLeadPoint(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('pointId', Id) pointId: string): Promise<void> {
    await this.crm.removeContactPoint(t, 'lead', id, pointId);
  }

  @Put('contacts/:id/accounts/:accountId')
  link(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('accountId', Id) accountId: string, @Body(new ZodPipe(AccountRoleSet)) body: z.infer<typeof AccountRoleSet>) {
    return this.crm.linkAccount(t, id, accountId, body.role, body.isPrimary);
  }

  @Delete('contacts/:id/accounts/:accountId')
  @HttpCode(204)
  async unlink(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('accountId', Id) accountId: string): Promise<void> {
    await this.crm.unlinkAccount(t, id, accountId);
  }

  @Get('accounts/:id/duplicates')
  accountDuplicates(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.ops.duplicates(t, 'account', id);
  }

  @Get('contacts/:id/duplicates')
  contactDuplicates(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.ops.duplicates(t, 'contact', id);
  }

  @Post('accounts/merge')
  @HttpCode(200)
  mergeAccounts(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(MergeRequest)) body: z.infer<typeof MergeRequest>, @Client() c: ClientInfo) {
    return this.ops.merge(t, 'account', body, c.ip);
  }

  @Post('contacts/merge')
  @HttpCode(200)
  mergeContacts(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(MergeRequest)) body: z.infer<typeof MergeRequest>, @Client() c: ClientInfo) {
    return this.ops.merge(t, 'contact', body, c.ip);
  }
}

@Controller('v1/notes')
@UseGuards(TenantGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  list(@CurrentTenant() t: TenantRequestContext, @Query('relatedType') relatedType: string | undefined, @Query('relatedId') relatedId: string | undefined) {
    return this.notes.list(t, relatedType, relatedId);
  }

  @Post()
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(NoteCreate)) body: z.infer<typeof NoteCreate>) {
    return this.notes.create(t, body);
  }

  @Patch(':id')
  patch(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(NotePatch)) body: z.infer<typeof NotePatch>) {
    return this.notes.patch(t, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string): Promise<void> {
    await this.notes.remove(t, id);
  }
}

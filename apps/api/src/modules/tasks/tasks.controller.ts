import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  DependencyCreate,
  TaskBulkRequest,
  TaskCreate,
  TaskMoveRequest,
  TaskPatch,
  TaskSeriesCreate,
  TaskTransitionRequest,
  type z,
} from '@flexa/contracts';
import type { FastifyReply } from 'fastify';
import { TenantGuard } from '../../common/guards';
import { etag, requireIfMatch } from '../../common/http-helpers';
import { ProblemError } from '../../common/problem';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { TaskListService, type ListQuery } from './task-list.service';
import { TasksService } from './tasks.service';

const Id = new ParseUUIDPipe();

/** Status changes go through the workflow engine only (ADR-0019): reject them on PATCH explicitly. */
function rejectStatusInPatch(body: unknown): unknown {
  if (body && typeof body === 'object' && ('statusId' in body || 'status_id' in body || 'status' in body)) {
    throw new ProblemError('USE_TRANSITION_ENDPOINT', 'change status with POST /v1/tasks/{id}/transition');
  }
  return body;
}

@Controller('v1')
@UseGuards(TenantGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService, private readonly list: TaskListService) {}

  @Get('tasks')
  listTasks(@CurrentTenant() t: TenantRequestContext, @Query() q: ListQuery) {
    return this.list.list(t, q);
  }

  @Post('tasks')
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TaskCreate)) body: z.infer<typeof TaskCreate>) {
    return this.tasks.create(t, body);
  }

  @Post('tasks/bulk')
  @HttpCode(200)
  bulk(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TaskBulkRequest)) body: z.infer<typeof TaskBulkRequest>) {
    return this.tasks.bulk(t, body);
  }

  @Get('tasks/:id')
  async get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const view = await this.tasks.get(t, id);
    void reply.header('etag', etag(view.version as number));
    return view;
  }

  @Patch('tasks/:id')
  async patch(
    @CurrentTenant() t: TenantRequestContext,
    @Param('id', Id) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() raw: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const body = TaskPatch.parse(rejectStatusInPatch(raw));
    const version = requireIfMatch(ifMatch);
    const view = await this.tasks.patch(t, id, version, body);
    void reply.header('etag', etag(view.version as number));
    return view;
  }

  @Delete('tasks/:id')
  @HttpCode(204)
  async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') ifMatch: string | undefined): Promise<void> {
    await this.tasks.remove(t, id, requireIfMatch(ifMatch));
  }

  @Post('tasks/:id/restore')
  @HttpCode(200)
  restore(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.tasks.restore(t, id);
  }

  @Post('tasks/:id/transition')
  @HttpCode(200)
  transition(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(TaskTransitionRequest)) body: z.infer<typeof TaskTransitionRequest>) {
    return this.tasks.transition(t, id, body);
  }

  @Post('tasks/:id/move')
  @HttpCode(200)
  move(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(TaskMoveRequest)) body: z.infer<typeof TaskMoveRequest>) {
    return this.tasks.move(t, id, body);
  }

  @Get('tasks/:id/subtasks')
  subtasks(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.tasks.subtasks(t, id);
  }

  @Get('tasks/:id/dependencies')
  dependencies(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.tasks.dependencies(t, id);
  }

  @Post('tasks/:id/dependencies')
  addDependency(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(DependencyCreate)) body: z.infer<typeof DependencyCreate>) {
    return this.tasks.addDependency(t, id, body.blockerId);
  }

  @Delete('tasks/:id/dependencies/:blockerId')
  @HttpCode(204)
  async removeDependency(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('blockerId', Id) blockerId: string): Promise<void> {
    await this.tasks.removeDependency(t, id, blockerId);
  }

  @Post('task-series')
  createSeries(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TaskSeriesCreate)) body: z.infer<typeof TaskSeriesCreate>) {
    return this.tasks.createSeries(t, body);
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards, type Type } from '@nestjs/common';
import { ActivityLogCreate, AttachmentInitiate, CommentCreate, CommentPatch, MentionableQuery, NotificationPreferencesSet, PushSubscribe, PushUnsubscribe, type z } from '@flexa/contracts';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import type { ShareType } from '../../common/record-access';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { AttachmentsService } from './attachments.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { RecordsService } from './records.service';

const Id = new ParseUUIDPipe();

/** `/v1/{collection}/{id}/timeline|activities|comments|attachments` for every record type. */
function recordExtrasController(path: string, type: ShareType): Type {
  @Controller(`v1/${path}/:id`)
  @UseGuards(TenantGuard)
  class RecordExtrasController {
    constructor(readonly records: RecordsService, readonly files: AttachmentsService) {}

    @Get('timeline')
    timeline(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query() q: { before?: string; limit?: string }) {
      return this.records.timeline(t, type, id, q);
    }

    @Post('activities')
    log(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ActivityLogCreate)) body: z.infer<typeof ActivityLogCreate>) {
      return this.records.logActivity(t, type, id, body);
    }

    @Get('comments')
    comments(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
      return this.records.listComments(t, type, id);
    }

    @Post('comments')
    comment(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CommentCreate)) body: z.infer<typeof CommentCreate>) {
      return this.records.createComment(t, type, id, body);
    }

    @Get('mentionable')
    mentionable(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query(new ZodPipe(MentionableQuery)) q: z.infer<typeof MentionableQuery>) {
      return this.records.mentionable(t, type, id, q.source, q.q);
    }

    @Get('attachments')
    attachments(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
      return this.files.list(t, type, id);
    }

    @Post('attachments')
    upload(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(AttachmentInitiate)) body: z.infer<typeof AttachmentInitiate>) {
      return this.files.initiate(t, type, id, body);
    }
  }
  Object.defineProperty(RecordExtrasController, 'name', { value: `${path}ExtrasController` });
  return RecordExtrasController;
}

export const RECORD_EXTRAS_CONTROLLERS: Type[] = [
  recordExtrasController('tasks', 'task'),
  recordExtrasController('accounts', 'account'),
  recordExtrasController('contacts', 'contact'),
  recordExtrasController('leads', 'lead'),
  recordExtrasController('opportunities', 'opportunity'),
  recordExtrasController('cases', 'case'),
];

@Controller('v1')
@UseGuards(TenantGuard)
export class RecordItemsController {
  constructor(private readonly records: RecordsService, private readonly files: AttachmentsService, private readonly notifications: NotificationsService, private readonly push: PushService) {}

  @Patch('comments/:id')
  editComment(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CommentPatch)) body: z.infer<typeof CommentPatch>) {
    return this.records.editComment(t, id, body);
  }

  @Delete('comments/:id')
  @HttpCode(204)
  async deleteComment(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string): Promise<void> {
    await this.records.deleteComment(t, id);
  }

  @Get('comments/:id/revisions')
  revisions(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.records.revisions(t, id);
  }

  @Post('attachments/:id/complete')
  @HttpCode(200)
  complete(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.files.complete(t, id);
  }

  @Get('attachments/:id/download')
  download(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.files.download(t, id);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  async removeAttachment(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string): Promise<void> {
    await this.files.remove(t, id);
  }

  @Get('notifications')
  list(@CurrentTenant() t: TenantRequestContext, @Query() q: { unread?: string; limit?: string; before?: string }) {
    return this.notifications.list(t, q);
  }

  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@CurrentTenant() t: TenantRequestContext) {
    return this.notifications.markRead(t, null);
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  read(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.notifications.markRead(t, id);
  }

  @Get('notifications/preferences')
  preferences(@CurrentTenant() t: TenantRequestContext) {
    return this.notifications.preferences(t);
  }

  @Get('notifications/:id')
  notification(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.notifications.get(t, id);
  }

  @Get('push/config')
  pushConfig() {
    return this.push.config();
  }

  @Post('push/subscriptions')
  @HttpCode(204)
  async subscribe(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(PushSubscribe)) body: z.infer<typeof PushSubscribe>, @Client() c: ClientInfo): Promise<void> {
    await this.push.subscribe(t, body, c.userAgent);
  }

  @Post('push/unsubscribe')
  @HttpCode(204)
  async unsubscribe(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(PushUnsubscribe)) body: z.infer<typeof PushUnsubscribe>): Promise<void> {
    await this.push.unsubscribe(t, body.endpoint);
  }

  @Put('notifications/preferences')
  setPreferences(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(NotificationPreferencesSet)) body: z.infer<typeof NotificationPreferencesSet>) {
    authorize(t, 'notifications.preferences.manage');
    return this.notifications.setPreferences(t, body.preferences);
  }
}

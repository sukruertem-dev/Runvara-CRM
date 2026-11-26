import { Body, Controller, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { QuoteCreate, QuoteDraft, QuoteListQuery, QuoteNote, QuoteOutcome, QuoteSend, QuoteSubmit, type z } from '@flexa/contracts';
import type { FastifyReply } from 'fastify';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { contentDisposition } from '../../infra/storage';
import { QuotesService } from './quotes.service';

const Id = new ParseUUIDPipe();
const Int = new ParseIntPipe();

@Controller('v1/sales/b2b/quotes')
@UseGuards(TenantGuard)
export class QuotesController {
  constructor(private readonly svc: QuotesService) {}

  @Get()
  list(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(QuoteListQuery)) q: z.infer<typeof QuoteListQuery>) {
    return this.svc.list(t, q);
  }

  @Post()
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(QuoteCreate)) body: z.infer<typeof QuoteCreate>) {
    return this.svc.create(t, body);
  }

  @Get(':id')
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.get(t, id);
  }

  @Put(':id/draft')
  saveDraft(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(QuoteDraft)) body: z.infer<typeof QuoteDraft>) {
    return this.svc.saveDraft(t, id, requireIfMatch(im), body);
  }

  @Put(':id/note')
  setNote(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(QuoteNote)) body: z.infer<typeof QuoteNote>) {
    return this.svc.setNote(t, id, body.note);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(QuoteSubmit)) body: z.infer<typeof QuoteSubmit>, @Client() c: ClientInfo) {
    return this.svc.submit(t, id, body, c.ip);
  }

  @Post(':id/versions')
  revise(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.revise(t, id);
  }

  @Get(':id/versions/:version')
  getVersion(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('version', Int) version: number) {
    return this.svc.getVersion(t, id, version);
  }

  @Get(':id/versions/:version/pdf')
  async pdf(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('version', Int) version: number, @Res() reply: FastifyReply): Promise<void> {
    const { bytes, fileName } = await this.svc.pdf(t, id, version);
    await reply.header('content-type', 'application/pdf').header('content-disposition', contentDisposition(fileName)).header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff').send(bytes);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(QuoteSend)) body: z.infer<typeof QuoteSend>) {
    return this.svc.send(t, id, body);
  }

  @Post(':id/outcome')
  @HttpCode(200)
  outcome(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(QuoteOutcome)) body: z.infer<typeof QuoteOutcome>) {
    return this.svc.outcome(t, id, body);
  }
}

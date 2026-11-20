import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  EmailOnlyRequest,
  LoginRequest,
  MfaVerifyRequest,
  ResetPasswordRequest,
  SelectTenantRequest,
  SignupRequest,
  TokenRequest,
  type z,
} from '@runvara/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessGuard } from '../../common/guards';
import { Client, CurrentPrincipal, type ClientInfo, type Principal } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

/** Marks unauthenticated auth endpoints; app.ts applies AUTH_RATE_LIMIT_PER_MINUTE per IP to them. */
const AUTH_RATE = { authRateLimit: true };

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly sessions: SessionService) {}

  @Post('signup')
  @HttpCode(202)
  @RouteConfig(AUTH_RATE)
  async signup(@Body(new ZodPipe(SignupRequest)) body: z.infer<typeof SignupRequest>, @Client() client: ClientInfo) {
    await this.auth.signup(body, client);
    return { status: 'accepted' as const };
  }

  @Post('email/verify')
  @HttpCode(204)
  @RouteConfig(AUTH_RATE)
  async verifyEmail(@Body(new ZodPipe(TokenRequest)) body: z.infer<typeof TokenRequest>): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  @Post('email/resend')
  @HttpCode(202)
  @RouteConfig(AUTH_RATE)
  async resend(@Body(new ZodPipe(EmailOnlyRequest)) body: z.infer<typeof EmailOnlyRequest>) {
    await this.auth.resendVerification(body.email);
    return { status: 'accepted' as const };
  }

  @Post('login')
  @HttpCode(200)
  @RouteConfig(AUTH_RATE)
  login(@Body(new ZodPipe(LoginRequest)) body: z.infer<typeof LoginRequest>, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.login(body.email, body.password, client, reply);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @RouteConfig(AUTH_RATE)
  verifyMfa(@Body(new ZodPipe(MfaVerifyRequest)) body: z.infer<typeof MfaVerifyRequest>, @Client() client: ClientInfo, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.verifyMfa(body, client, reply);
  }

  @Post('tenant')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  selectTenant(@Body(new ZodPipe(SelectTenantRequest)) body: z.infer<typeof SelectTenantRequest>, @CurrentPrincipal() p: Principal, @Req() req: FastifyRequest) {
    return this.sessions.selectTenant(p.userId, p.sessionId, p.amr, body.tenantId, req);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Client() client: ClientInfo) {
    return this.sessions.refresh(req, reply, client);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.sessions.logout(req, reply);
  }

  @Post('password/forgot')
  @HttpCode(202)
  @RouteConfig(AUTH_RATE)
  async forgot(@Body(new ZodPipe(EmailOnlyRequest)) body: z.infer<typeof EmailOnlyRequest>) {
    await this.auth.forgotPassword(body.email);
    return { status: 'accepted' as const };
  }

  @Post('password/reset')
  @HttpCode(204)
  @RouteConfig(AUTH_RATE)
  async reset(@Body(new ZodPipe(ResetPasswordRequest)) body: z.infer<typeof ResetPasswordRequest>, @Client() client: ClientInfo): Promise<void> {
    await this.auth.resetPassword(body.token, body.password, client);
  }
}

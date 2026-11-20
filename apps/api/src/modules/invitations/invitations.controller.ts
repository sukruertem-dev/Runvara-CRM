import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { AcceptInvitationRequest, CreateInvitationRequest, TokenRequest, type z } from '@flexa/contracts';
import { and, desc, eq, isNull, one, schema, sql, type DbHandle } from '@flexa/db';
import { hashPassword, randomToken, sha256, type TokenSigner } from '@flexa/security';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { authenticate, TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB, ENV, MAILER, SIGNER, type Mailer } from '../../infra/tokens';
import { assertPassword } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';

const INVITATION_TTL_MS = 7 * 86_400_000;

type InvitationRow = typeof schema.invitations.$inferSelect;
const view = (i: InvitationRow) => ({
  id: i.id, email: i.email, roleKey: i.roleKey, expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt?.toISOString() ?? null, revokedAt: i.revokedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString(),
});

@Controller('v1/invitations')
export class InvitationsController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SIGNER) private readonly signer: TokenSigner,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  @UseGuards(TenantGuard)
  async list(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'users.invite');
    const rows = await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, (tx) =>
      tx.select().from(schema.invitations).orderBy(desc(schema.invitations.createdAt)).limit(200));
    return { data: rows.map(view) };
  }

  @Post()
  @UseGuards(TenantGuard)
  async create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CreateInvitationRequest)) body: z.infer<typeof CreateInvitationRequest>, @Client() c: ClientInfo) {
    const d = authorize(t, 'users.invite');
    // A04: a Manager may invite only into teams they manage, without exceeding their own rights.
    // Teams arrive in P4; until then only tenant-wide (Admin) grants can invite.
    if (d.grant.scope !== 'all') throw new ProblemError('MANAGER_LIMIT', 'team-scoped invitations require team management (P4)');
    if (body.roleKey === 'admin' && !t.authz.roleKeys.includes('admin')) throw new ProblemError('MANAGER_LIMIT', 'cannot assign the Admin role');
    const token = randomToken();
    const inviter = await this.sessions.userSummary(t.principal.userId);
    const row = await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, async (tx) => {
      const existing = await tx.execute(sql`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${body.email}`);
      if ((existing.rowCount ?? 0) > 0) throw new ProblemError('CONFLICT', 'already a member');
      // One open invitation per address: re-inviting revokes the previous token.
      await tx.update(schema.invitations).set({ revokedAt: new Date() })
        .where(and(eq(schema.invitations.email, body.email), isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt)));
      const inv = one(await tx.insert(schema.invitations).values({
        tenantId: t.tenant.id, email: body.email, roleKey: body.roleKey, tokenHash: sha256(token), invitedBy: t.principal.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      }).returning(), 'invitation');
      await audit(tx, t.tenant.id, { action: 'user.invited', actorId: t.principal.userId, targetType: 'invitation', targetId: inv.id, ip: c.ip, details: { email: body.email, roleKey: body.roleKey } });
      return inv;
    });
    await this.mailer.send({
      template: 'invitation', to: body.email, locale: t.tenant.locale === 'en-US' ? 'en-US' : 'tr-TR',
      vars: { tenantName: t.tenant.name, inviterName: inviter.displayName, url: new URL(`/invite?token=${token}`, this.env.WEB_BASE_URL).toString() },
    });
    return view(row);
  }

  @Post(':id/revoke')
  @HttpCode(204)
  @UseGuards(TenantGuard)
  async revoke(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo): Promise<void> {
    authorize(t, 'users.invite');
    await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, async (tx) => {
      const r = await tx.update(schema.invitations).set({ revokedAt: new Date() })
        .where(and(eq(schema.invitations.id, id), isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt))).returning({ id: schema.invitations.id });
      if (r.length === 0) throw new ProblemError('NOT_FOUND');
      await audit(tx, t.tenant.id, { action: 'user.invitation_revoked', actorId: t.principal.userId, targetType: 'invitation', targetId: id, ip: c.ip });
    });
  }

  @Post('preview')
  @HttpCode(200)
  async preview(@Body(new ZodPipe(TokenRequest)) body: z.infer<typeof TokenRequest>) {
    const inv = await this.findValid(body.token);
    const exists = await this.db.withAnonymous(async (tx) => (await tx.execute<{ ok: boolean }>(sql`SELECT app.email_registered(${inv.email}) AS ok`)).rows[0]?.ok === true);
    return { tenantName: inv.tenant_name, email: inv.email, roleKey: inv.role_key, accountExists: exists };
  }

  /** New address → creates the account (the link proves mailbox control). Existing account → caller must be
   *  signed in as that account (Bearer), so a leaked link cannot attach someone else's account. */
  @Post('accept')
  @HttpCode(200)
  async accept(@Body(new ZodPipe(AcceptInvitationRequest)) body: z.infer<typeof AcceptInvitationRequest>, @Req() req: FastifyRequest, @Client() c: ClientInfo) {
    const inv = await this.findValid(body.token);
    const existing = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ user_id: string }>(sql`SELECT user_id FROM app.find_user_for_login(${inv.email})`)).rows[0]?.user_id ?? null);

    let userId: string;
    let created = false;
    if (existing) {
      const principal = await authenticate(req, this.signer, this.db).catch(() => null);
      if (!principal) throw new ProblemError('UNAUTHENTICATED', 'sign in as the invited account to accept');
      if (principal.userId !== existing) throw new ProblemError('INVITATION_EMAIL_MISMATCH');
      userId = existing;
    } else {
      if (!body.password || !body.displayName) throw new ProblemError('VALIDATION_FAILED', 'password and displayName are required for a new account');
      assertPassword(body.password, inv.email);
      userId = randomUUID();
      created = true;
    }
    const passwordHash = created && body.password ? await hashPassword(body.password) : null;

    await this.db.withTenant({ tenantId: inv.tenant_id, userId }, async (tx) => {
      // The user row must exist before invitations.accepted_by references it; a failed claim rolls both back.
      if (created && passwordHash && body.displayName) {
        await tx.insert(schema.users).values({ id: userId, email: inv.email, displayName: body.displayName, locale: 'tr-TR', timezone: 'Europe/Istanbul', status: 'active', emailVerifiedAt: new Date() });
        await tx.insert(schema.userCredentials).values({ userId, passwordHash });
      }
      const claimed = await tx.update(schema.invitations).set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(and(eq(schema.invitations.id, inv.invitation_id), isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt))).returning({ id: schema.invitations.id });
      if (claimed.length === 0) throw new ProblemError('INVITATION_INVALID');
      await tx.insert(schema.memberships).values({ tenantId: inv.tenant_id, userId, status: 'active', authzVersion: 0, density: 'comfortable' }).onConflictDoNothing();
      const [role] = await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, inv.role_key));
      if (!role) throw new ProblemError('ROLE_UNKNOWN');
      await tx.insert(schema.userRoles).values({ tenantId: inv.tenant_id, userId, roleId: role.id, grantedBy: null }).onConflictDoNothing();
      await audit(tx, inv.tenant_id, { action: 'user.joined', actorId: userId, targetType: 'user', targetId: userId, ip: c.ip, details: { invitationId: inv.invitation_id, roleKey: inv.role_key } });
    });
    return { tenantId: inv.tenant_id, userCreated: created };
  }

  private async findValid(token: string) {
    const inv = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ invitation_id: string; tenant_id: string; tenant_name: string; email: string; role_key: string; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null }>(
        sql`SELECT * FROM app.find_invitation(${sha256(token)})`)).rows[0]);
    if (!inv || inv.accepted_at || inv.revoked_at || new Date(inv.expires_at).getTime() <= Date.now()) throw new ProblemError('INVITATION_INVALID');
    return inv;
  }
}

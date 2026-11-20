import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { KeyRing, TokenSigner } from '@runvara/security';
import { ProblemFilter } from './common/problem.filter';
import { AccessGuard, TenantGuard } from './common/guards';
import { DB, ENV, KEYRING, MAILER, REDIS, SIGNER, type ApiDeps } from './infra/tokens';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { SessionService } from './modules/auth/session.service';
import { HealthController } from './modules/health/health.controller';
import { InvitationsController } from './modules/invitations/invitations.controller';
import { MeController } from './modules/me/me.controller';
import { OidcService } from './modules/sso/oidc.service';
import { SsoController } from './modules/sso/sso.controller';
import { ProvisioningService } from './modules/tenancy/provisioning.service';
import { TenancyController } from './modules/tenancy/tenancy.controller';

@Module({})
export class AppModule {
  static forRoot(deps: ApiDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, TenancyController, InvitationsController, SsoController],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: DB, useValue: deps.db },
        { provide: REDIS, useValue: deps.redis },
        { provide: MAILER, useValue: deps.mailer },
        { provide: SIGNER, useValue: TokenSigner.fromBase64(deps.env.JWT_PRIVATE_KEY_B64, deps.env.JWT_ISSUER) },
        { provide: KEYRING, useValue: new KeyRing(deps.env.RUNVARA_MASTER_KEY) },
        { provide: APP_FILTER, useClass: ProblemFilter },
        AccessGuard,
        TenantGuard,
        SessionService,
        ProvisioningService,
        AuthService,
        OidcService,
      ],
    };
  }
}

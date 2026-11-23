import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { KeyRing, TokenSigner } from '@flexa/security';
import { ProblemFilter } from './common/problem.filter';
import { AccessGuard, TenantGuard } from './common/guards';
import { DB, ENV, KEYRING, MAILER, REDIS, SCANNER, SIGNER, STORAGE, type ApiDeps } from './infra/tokens';
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
import { TaskConfigController } from './modules/tasks/config.controller';
import { ConfigEditService } from './modules/tasks/config-edit.service';
import { RqlController } from './modules/tasks/rql.controller';
import { TaskListService } from './modules/tasks/task-list.service';
import { TasksController } from './modules/tasks/tasks.controller';
import { TasksService } from './modules/tasks/tasks.service';
import { AccountsController, CasesController, ContactsController, CrmOperationsController, LeadsController, NotesController, OpportunitiesController } from './modules/crm/crm.controller';
import { CrmOpsService } from './modules/crm/crm-ops.service';
import { CrmService } from './modules/crm/crm.service';
import { NotesService } from './modules/crm/notes.service';
import { AccessAdminController, SHARES_CONTROLLERS } from './modules/access/access-admin.controller';
import { AccessAdminService } from './modules/access/access-admin.service';
import { GovernanceController } from './modules/access/governance.controller';
import { GovernanceService } from './modules/access/governance.service';
import { AttachmentsService } from './modules/records/attachments.service';
import { NotificationsService } from './modules/records/notifications.service';
import { RECORD_EXTRAS_CONTROLLERS, RecordItemsController } from './modules/records/records.controller';
import { RecordsService } from './modules/records/records.service';
import { AutomationController } from './modules/automation/automation.controller';
import { AutomationService } from './modules/automation/automation.service';
import { AutomationQueues } from './modules/automation/queues';
import { AutomationRunner } from './modules/automation/runner.service';
import { ApiKeysService } from './modules/integrations/api-keys.service';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { SlaService } from './modules/integrations/sla.service';
import { WebhooksService } from './modules/integrations/webhooks.service';
import { ViewsController } from './modules/views/views.controller';
import { ViewsService } from './modules/views/views.service';
import { ConfigController } from './modules/config/config.controller';
import { ConfigService } from './modules/config/config.service';
import { DigestService } from './modules/records/digest.service';
import { StreamService } from './modules/records/stream.service';
import { BundleController } from './modules/config/bundle.controller';
import { BundleService } from './modules/config/bundle.service';
import { QuotaService } from './modules/usage/quota.service';
import { UsageController } from './modules/usage/usage.controller';
import { UsageService } from './modules/usage/usage.service';
import { IdempotencyInterceptor } from './common/idempotency';
import { ClamdScanner } from './infra/scanner';
import { storageFromEnv } from './infra/storage';

@Module({})
export class AppModule {
  static forRoot(deps: ApiDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, TenancyController, InvitationsController, SsoController, TasksController, TaskConfigController, RqlController, ViewsController, ConfigController,
        // Operation routes first: Fastify matches static segments before parameters either way, but keep it explicit.
        CrmOperationsController, AccountsController, ContactsController, LeadsController, OpportunitiesController, CasesController, NotesController,
        AccessAdminController, ...SHARES_CONTROLLERS,
        GovernanceController, RecordItemsController, ...RECORD_EXTRAS_CONTROLLERS, AutomationController, IntegrationsController, BundleController, UsageController],
      providers: [
        { provide: ENV, useValue: deps.env },
        { provide: DB, useValue: deps.db },
        { provide: REDIS, useValue: deps.redis },
        { provide: MAILER, useValue: deps.mailer },
        { provide: SIGNER, useValue: TokenSigner.fromBase64(deps.env.JWT_PRIVATE_KEY_B64, deps.env.JWT_ISSUER) },
        { provide: KEYRING, useValue: new KeyRing(deps.env.FLEXA_MASTER_KEY) },
        { provide: APP_FILTER, useClass: ProblemFilter },
        AccessGuard,
        TenantGuard,
        SessionService,
        QuotaService,
        UsageService,
        BundleService,
        ProvisioningService,
        AuthService,
        OidcService,
        TasksService,
        TaskListService,
        ConfigEditService,
        CrmService,
        CrmOpsService,
        NotesService,
        AccessAdminService,
        GovernanceService,
        RecordsService,
        AttachmentsService,
        NotificationsService,
        AutomationRunner,
        AutomationQueues,
        AutomationService,
        SlaService,
        ViewsService,
        ConfigService,
        WebhooksService,
        ApiKeysService,
        StreamService,
        DigestService,
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: STORAGE, useValue: deps.storage !== undefined ? deps.storage : storageFromEnv(deps.env) },
        { provide: SCANNER, useValue: deps.scanner !== undefined ? deps.scanner : deps.env.CLAMAV_HOST ? new ClamdScanner(deps.env.CLAMAV_HOST, deps.env.CLAMAV_PORT) : null },
      ],
    };
  }
}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OrganizationController } from './controllers/organization.controller';
import { RoleController } from './controllers/role.controller';
import { UserController } from './controllers/user.controller';
import { OrganizationService } from './services/organization.service';
import { RoleService } from './services/role.service';
import { UserService } from './services/user.service';
import { IdentityClientService } from './services/identity-client.service';
import { PrismaService } from './services/prisma.service';
import { PermissionGuard } from './guards/permission.guard';
import { HealthController } from './controllers/health.controller';
import { SupportController } from './controllers/support.controller';
import { AuditLogController } from './controllers/audit-log.controller';
import { AuditService } from './services/audit.service';
import { PlatformConfigController } from './controllers/platform-config.controller';
import { PlatformConfigService } from './services/platform-config.service';
import { CmsAdminController, CmsPublicController } from './controllers/cms.controller';
import { CmsService } from './services/cms.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env'
    })
  ],
  controllers: [
    HealthController,
    OrganizationController,
    RoleController,
    UserController,
    SupportController,
    AuditLogController,
    PlatformConfigController,
    CmsAdminController,
    CmsPublicController
  ],
  providers: [
    OrganizationService,
    RoleService,
    UserService,
    IdentityClientService,
    PrismaService,
    PermissionGuard,
    AuditService,
    PlatformConfigService,
    CmsService
  ],
  exports: [
    OrganizationService,
    RoleService,
    UserService,
    IdentityClientService,
    PrismaService,
    AuditService,
    PlatformConfigService,
    CmsService
  ]
})
export class AppModule { }

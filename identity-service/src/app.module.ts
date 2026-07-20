import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { PermissionController } from './permissions/permission.controller';
import { PermissionService } from './permissions/permission.service';
import { UsersController } from './users/users.controller';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';
import { SuperAdminModule } from './super-admin/super-admin.module';
import { AuditModule } from './audit/audit.module';
import { TranslationModule } from './translation/translation.module';
import { AdminRolesModule } from './admin-roles/admin-roles.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env'
    }),
    AuthModule,
    PrismaModule,
    SuperAdminModule,
    AuditModule,
    TranslationModule,
    AdminRolesModule,
  ],
  controllers: [
    HealthController,
    PermissionController,
    UsersController,
    InternalController
  ],
  providers: [
    PermissionService,
  ],
  exports: []
})
export class AppModule { }

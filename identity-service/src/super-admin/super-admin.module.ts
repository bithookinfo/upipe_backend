import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SuperAdminController } from './super-admin.controller';
import { SuperAdminAuthController } from './super-admin-auth.controller';
import { PlatformController } from './platform.controller';
import { SuperAdminService } from './super-admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { SuperAdminGuard } from '../guards/super-admin.guard';

@Module({
    imports: [
        ConfigModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            useFactory: async (configService: ConfigService) => ({
                secret: configService.get('JWT_SECRET'),
                signOptions: { expiresIn: '24h' },
            }),
            inject: [ConfigService],
        }),
        AuditModule,
    ],
    controllers: [SuperAdminController, SuperAdminAuthController, PlatformController],
    providers: [SuperAdminService, PrismaService, SuperAdminGuard],
    exports: [SuperAdminService],
})
export class SuperAdminModule { }

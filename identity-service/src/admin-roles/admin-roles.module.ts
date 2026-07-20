import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRolesService } from './admin-roles.service';
import { PrismaService } from '../prisma/prisma.service';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { JwtModule, JwtService } from '@nestjs/jwt';

@Module({
    imports: [ConfigModule],
    controllers: [AdminRolesController],
    providers: [AdminRolesService, PrismaService, SuperAdminGuard, JwtService],
    exports: [AdminRolesService],
})
export class AdminRolesModule { }

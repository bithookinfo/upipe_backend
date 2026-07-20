import {
    Controller,
    Post,
    Body,
    HttpCode,
    HttpStatus,
    UnauthorizedException,
    Req,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBadRequestResponse,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { SuperAdminService } from './super-admin.service';
import { AdminLoginDto } from '../dto/auth.dto';
import { AuditService } from '../audit/audit.service';

@Controller('super-admins')
@ApiTags('super-admin')
export class SuperAdminAuthController {
    constructor(
        private readonly superAdminService: SuperAdminService,
        private readonly auditService: AuditService,
    ) { }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Super admin login' })
    @ApiResponse({
        status: 200,
        description: 'Login successful',
        schema: {
            properties: {
                access_token: { type: 'string' },
                user: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        email: { type: 'string' },
                        role: { type: 'string' },
                    },
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: 'MFA required',
        schema: {
            properties: {
                requireMfa: { type: 'boolean' },
            },
        },
    })
    @ApiUnauthorizedResponse({ description: 'Invalid credentials or MFA code' })
    @ApiBadRequestResponse({ description: 'Invalid request body' })
    async login(@Body() loginDto: AdminLoginDto, @Req() req: Request) {
        // 1. Validate credentials
        const superAdmin = await this.superAdminService.validateCredentials(
            loginDto.email,
            loginDto.password,
        );

        if (!superAdmin) {
            throw new UnauthorizedException('Invalid credentials');
        }

        // 2. Check MFA if enabled (DISABLED FOR NOW)
        /*
        if (superAdmin.mfaEnabled) {
            if (!loginDto.mfaCode) {
                return { requireMfa: true };
            }

            const mfaValid = await this.superAdminService.verifyMfaCode(
                superAdmin.id,
                loginDto.mfaCode,
            );

            if (!mfaValid) {
                throw new UnauthorizedException('Invalid MFA code');
            }
        }
        */

        // 3. Generate JWT token
        const { token, resolvedPermissions } = await this.superAdminService.generateToken(superAdmin);

        // 4. Create session
        const ipAddress = req.ip;
        const userAgent = req.headers['user-agent'];

        await this.superAdminService.createSession(
            superAdmin.id,
            token,
            ipAddress,
            userAgent,
        );

        // 5. Update last login
        await this.superAdminService.updateLastLogin(superAdmin.id);

        // 6. Log audit
        await this.auditService.log({
            superAdminId: superAdmin.id,
            action: 'SUPER_ADMIN_LOGIN',
            entityType: 'super_admin',
            entityId: superAdmin.id,
            details: { email: superAdmin.email },
            ipAddress,
            userAgent,
        });

        return {
            access_token: token,
            user: {
                id: superAdmin.id,
                name: superAdmin.name,
                email: superAdmin.email,
                role: superAdmin.role,
                permissions: resolvedPermissions,
                organizationId: superAdmin.organizationId,
            },
        };
    }

    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Super admin logout' })
    @ApiResponse({ status: 200, description: 'Logout successful' })
    async logout(@Req() req: Request) {
        // TODO: Implement session invalidation
        const userId = req.headers['x-user-id'] as string;

        if (userId) {
            await this.auditService.log({
                superAdminId: userId,
                action: 'SUPER_ADMIN_LOGOUT',
                entityType: 'super_admin',
                entityId: userId,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent'],
            });
        }

        return { message: 'Logged out successfully' };
    }
}

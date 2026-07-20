import { Controller, Get, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiQuery } from '@nestjs/swagger';
import { PermissionService } from './permission.service';

@ApiTags('Permissions')
@Controller('permissions')
export class PermissionController {
    constructor(private readonly permissionService: PermissionService) { }

    @Post('seed')
    @ApiOperation({
        summary: 'Seed all permissions',
        description: 'Initialize all 51 permissions in the database'
    })
    @ApiResponse({ status: 201, description: 'Permissions seeded successfully' })
    async seedPermissions() {
        return this.permissionService.seedPermissions();
    }

    @Get()
    @ApiOperation({ summary: 'Get all permissions' })
    @ApiResponse({ status: 200, description: 'Permissions retrieved successfully' })
    @ApiQuery({ name: 'category', required: false })
    @ApiQuery({ name: 'service', required: false })
    async getAllPermissions(
        @Query('category') category?: string,
        @Query('service') service?: string
    ) {
        return this.permissionService.getAllPermissions({ category, service });
    }

    @Post('check')
    @ApiOperation({
        summary: 'Check if user has permission',
        description: 'Validate if a user has specific permission in an organization'
    })
    @ApiResponse({ status: 200, description: 'Permission check result' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string' },
                organizationId: { type: 'string' },
                permission: { type: 'string', example: 'merchant:create' }
            }
        }
    })
    async checkPermission(@Body() body: {
        userId: string;
        organizationId: string;
        permission: string;
    }) {
        const hasPermission = await this.permissionService.checkPermission(
            body.userId,
            body.organizationId,
            body.permission
        );

        return {
            success: true,
            hasPermission,
            userId: body.userId,
            organizationId: body.organizationId,
            permission: body.permission
        };
    }

    @Post('grant')
    @ApiOperation({
        summary: 'Grant permission to user',
        description: 'Grant a specific permission to user in organization'
    })
    @ApiResponse({ status: 201, description: 'Permission granted successfully' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string' },
                organizationId: { type: 'string' },
                permissionCode: { type: 'string', example: 'merchant:create' },
                grantedBy: { type: 'string' },
                roleId: { type: 'string' }
            }
        }
    })
    async grantPermission(@Body() body: {
        userId: string;
        organizationId: string;
        permissionCode: string;
        grantedBy?: string;
        roleId?: string;
    }) {
        return this.permissionService.grantPermission(body);
    }

    @Post('grant-multiple')
    @ApiOperation({
        summary: 'Grant multiple permissions to user',
        description: 'Grant multiple permissions at once (used when assigning roles)'
    })
    @ApiResponse({ status: 201, description: 'Permissions granted successfully' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string' },
                organizationId: { type: 'string' },
                permissionCodes: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['merchant:create', 'merchant:view', 'payment:view']
                },
                grantedBy: { type: 'string' },
                roleId: { type: 'string' }
            }
        }
    })
    async grantMultiplePermissions(@Body() body: {
        userId: string;
        organizationId: string;
        permissionCodes: string[];
        grantedBy?: string;
        roleId?: string;
    }) {
        return this.permissionService.grantMultiplePermissions(body);
    }

    @Delete('revoke')
    @ApiOperation({
        summary: 'Revoke permission from user',
        description: 'Remove a specific permission from user'
    })
    @ApiResponse({ status: 200, description: 'Permission revoked successfully' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string' },
                organizationId: { type: 'string' },
                permissionCode: { type: 'string', example: 'merchant:create' }
            }
        }
    })
    async revokePermission(@Body() body: {
        userId: string;
        organizationId: string;
        permissionCode: string;
    }) {
        return this.permissionService.revokePermission(
            body.userId,
            body.organizationId,
            body.permissionCode
        );
    }

    @Get('user/:userId/organization/:organizationId')
    @ApiOperation({
        summary: 'Get user permissions',
        description: 'Get all permissions for a user in an organization'
    })
    @ApiResponse({ status: 200, description: 'User permissions retrieved successfully' })
    @ApiParam({ name: 'userId', description: 'User ID' })
    @ApiParam({ name: 'organizationId', description: 'Organization ID' })
    async getUserPermissions(
        @Param('userId') userId: string,
        @Param('organizationId') organizationId: string
    ) {
        return this.permissionService.getUserPermissions(userId, organizationId);
    }

    @Delete('user/:userId/organization/:organizationId')
    @ApiOperation({
        summary: 'Revoke all user permissions',
        description: 'Remove all permissions for a user in an organization'
    })
    @ApiResponse({ status: 200, description: 'All permissions revoked successfully' })
    @ApiParam({ name: 'userId', description: 'User ID' })
    @ApiParam({ name: 'organizationId', description: 'Organization ID' })
    async revokeAllUserPermissions(
        @Param('userId') userId: string,
        @Param('organizationId') organizationId: string
    ) {
        return this.permissionService.revokeAllUserPermissions(userId, organizationId);
    }
}

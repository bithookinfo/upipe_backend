import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    UseGuards,
    Query,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiParam,
    ApiBody,
    ApiQuery,
} from '@nestjs/swagger';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { AdminRolesService } from './admin-roles.service';
import { RequirePermissions } from '../decorators/permissions.decorator';

@Controller('admin-roles')
@ApiTags('admin-roles')
@UseGuards(SuperAdminGuard)
@ApiBearerAuth()
export class AdminRolesController {
    constructor(private readonly adminRolesService: AdminRolesService) { }

    @Post('seed')
    @RequirePermissions('role:create', 'role:update')
    @ApiOperation({
        summary: 'Seed system admin roles',
        description: 'Initialize built-in system roles (Super Admin, Admin, Support, Finance, Analytics, Viewer)'
    })
    @ApiResponse({ status: 201, description: 'System roles seeded successfully' })
    async seedSystemRoles() {
        return this.adminRolesService.seedSystemRoles();
    }

    @Get()
    @RequirePermissions('role:view')
    @ApiOperation({
        summary: 'Get all admin roles',
        description: 'Retrieve all admin roles (system + custom). Returns only active roles by default.'
    })
    @ApiResponse({ status: 200, description: 'Roles retrieved successfully' })
    @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
    async getAllRoles(@Query('includeInactive') includeInactive?: string) {
        return this.adminRolesService.getAllRoles(includeInactive === 'true');
    }

    @Get(':id')
    @RequirePermissions('role:view')
    @ApiOperation({ summary: 'Get admin role details' })
    @ApiResponse({ status: 200, description: 'Role retrieved successfully' })
    @ApiResponse({ status: 404, description: 'Role not found' })
    @ApiParam({ name: 'id', description: 'Role ID' })
    async getRoleById(@Param('id') id: string) {
        return this.adminRolesService.getRoleById(id);
    }

    @Post()
    @RequirePermissions('role:create')
    @ApiOperation({
        summary: 'Create custom admin role',
        description: 'Create a new custom admin role with specific permissions'
    })
    @ApiResponse({ status: 201, description: 'Role created successfully' })
    @ApiResponse({ status: 409, description: 'Role name or key already exists' })
    @ApiBody({
        schema: {
            type: 'object',
            required: ['name', 'key', 'permissions'],
            properties: {
                name: { type: 'string', example: 'Content Manager' },
                key: { type: 'string', example: 'content_manager' },
                description: { type: 'string', example: 'Manages content and merchant onboarding' },
                permissions: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['merchant:view', 'merchant:create', 'merchant:update']
                }
            }
        }
    })
    async createRole(@Body() body: {
        name: string;
        key: string;
        description?: string;
        permissions: string[];
    }) {
        return this.adminRolesService.createRole(body);
    }

    @Put(':id')
    @RequirePermissions('role:update')
    @ApiOperation({
        summary: 'Update admin role',
        description: 'Update an admin role. System role names cannot be changed.'
    })
    @ApiResponse({ status: 200, description: 'Role updated successfully' })
    @ApiResponse({ status: 404, description: 'Role not found' })
    @ApiResponse({ status: 400, description: 'Cannot rename system roles' })
    @ApiParam({ name: 'id', description: 'Role ID' })
    async updateRole(
        @Param('id') id: string,
        @Body() body: {
            name?: string;
            description?: string;
            permissions?: string[];
        }
    ) {
        return this.adminRolesService.updateRole(id, body);
    }

    @Delete(':id')
    @RequirePermissions('role:delete')
    @ApiOperation({
        summary: 'Delete custom admin role',
        description: 'Soft-delete a custom admin role. Cannot delete system roles or roles with assigned admins.'
    })
    @ApiResponse({ status: 200, description: 'Role deleted successfully' })
    @ApiResponse({ status: 400, description: 'Cannot delete system roles' })
    @ApiResponse({ status: 409, description: 'Role has assigned admins' })
    @ApiParam({ name: 'id', description: 'Role ID' })
    async deleteRole(@Param('id') id: string) {
        return this.adminRolesService.deleteRole(id);
    }
}

import { Controller, Get, Post, Put, Delete, Body, Param, Query, Headers, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { UserService } from '../services/user.service';

@ApiTags('Organization Users')
@Controller('organizations/:organizationId/users')
export class UserController {
  constructor(private readonly userService: UserService) { }

  private validateAccess(id: string, reqOrgId: string, userType: string) {
    if (userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    if (id !== reqOrgId) throw new ForbiddenException("Tenant Isolation Violation");
  }

  @Post()
  @ApiOperation({
    summary: 'Add user to organization',
    description: 'Assign user to organization with a role and sync permissions'
  })
  @ApiResponse({ status: 201, description: 'User added successfully' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID from Identity Service' },
        roleId: { type: 'string', description: 'Role ID to assign' },
        invitedBy: { type: 'string', description: 'User ID who is inviting' },
        password: { type: 'string', description: 'Optional initial password for the user' }
      }
    }
  })
  async addUserToOrganization(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
    @Body() body: {
      userId: string;
      roleId: string;
      invitedBy?: string;
      password?: string;
    }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.userService.addUserToOrganization({
      organizationId,
      ...body
    });
  }

  @Get()
  @ApiOperation({
    summary: 'Get organization users',
    description: 'Get users in the organization with optional status filter'
  })
  @ApiResponse({ status: 200, description: 'Users retrieved successfully' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['all', 'active', 'inactive'],
    description: 'Filter users by status (defaults to active)'
  })
  async getOrganizationUsers(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
    @Query('status') status?: 'all' | 'active' | 'inactive'
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    console.log('🔍 [CONTROLLER] Received status query param:', status, 'Type:', typeof status);
    const finalStatus = status || 'active';
    console.log('🔍 [CONTROLLER] Using final status:', finalStatus);
    return this.userService.getOrganizationUsers(organizationId, finalStatus);
  }

  @Put(':orgUserId/role')
  @ApiOperation({
    summary: 'Update user role',
    description: 'Change user role and sync new permissions to Identity Service'
  })
  @ApiResponse({ status: 200, description: 'User role updated successfully' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiParam({ name: 'orgUserId', description: 'Organization User ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        roleId: { type: 'string', description: 'New role ID' },
        updatedBy: { type: 'string', description: 'User ID making the change' }
      }
    }
  })
  async updateUserRole(
    @Param('organizationId') organizationId: string,
    @Param('orgUserId') orgUserId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
    @Body() body: {
      roleId: string;
      updatedBy?: string;
    }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.userService.updateUserRole(orgUserId, organizationId, body.roleId, body.updatedBy);
  }

  @Put(':orgUserId/status')
  @ApiOperation({
    summary: 'Update user status',
    description: 'Activate or deactivate a user in the organization'
  })
  @ApiResponse({ status: 200, description: 'User status updated successfully' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiParam({ name: 'orgUserId', description: 'Organization User ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        isActive: { type: 'boolean', description: 'User active status' },
        reason: { type: 'string', description: 'Optional reason for status change' }
      }
    }
  })
  async updateUserStatus(
    @Param('organizationId') organizationId: string,
    @Param('orgUserId') orgUserId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
    @Body() body: {
      isActive: boolean;
      reason?: string;
    }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.userService.updateUserStatus(organizationId, orgUserId, body.isActive, body.reason);
  }

  @Delete(':orgUserId')
  @ApiOperation({
    summary: 'Remove user from organization',
    description: 'Deactivate user and revoke all permissions from Identity Service'
  })
  @ApiResponse({ status: 200, description: 'User removed successfully' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiParam({ name: 'orgUserId', description: 'Organization User ID' })
  async removeUserFromOrganization(
    @Param('organizationId') organizationId: string,
    @Param('orgUserId') orgUserId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.userService.removeUserFromOrganization(orgUserId, organizationId);
  }

  @Post('check-permission')
  @ApiOperation({
    summary: 'Check user permission',
    description: 'Validate if user has specific permission via Identity Service'
  })
  @ApiResponse({ status: 200, description: 'Permission check result' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        permission: { type: 'string', example: 'merchant:create' }
      }
    }
  })
  async checkUserPermission(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId: string,
    @Headers('x-user-type') userType: string,
    @Body() body: { userId: string; permission: string }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    const hasPermission = await this.userService.checkUserPermission(
      body.userId,
      organizationId,
      body.permission
    );
    return {
      success: true,
      hasPermission,
      userId: body.userId,
      organizationId,
      permission: body.permission
    };
  }
}

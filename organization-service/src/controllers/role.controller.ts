import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
  ForbiddenException
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { RoleService } from "../services/role.service";
import { Permission } from "../constants/permissions";
import {
  PermissionGuard,
  RequirePermissions,
} from "../guards/permission.guard";

@ApiTags("Roles & Permissions")
@Controller("organizations/:organizationId/roles")
export class RoleController {
  constructor(private readonly roleService: RoleService) { }

  private validateAccess(id: string, reqOrgId: string, userType: string) {
    if (userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    if (id !== reqOrgId) throw new ForbiddenException("Tenant Isolation Violation");
  }

  @Post("initialize")
  @ApiOperation({
    summary: "Initialize default roles for organization",
    description:
      "Creates Owner, Admin, Manager, Operator, Viewer, Accountant roles",
  })
  @ApiResponse({ status: 201, description: "Default roles initialized" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  async initializeDefaultRoles(
    @Param("organizationId") organizationId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.initializeDefaultRoles(organizationId);
  }

  @Post("migrate-permissions")
  @ApiOperation({
    summary: "Migrate permissions to table",
    description: "One-time migration: moves JSON permissions to role_permissions table"
  })
  async migratePermissions() {
    return this.roleService.migratePermissionsToTable();
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermissions("role:create")
  @ApiOperation({
    summary: "Create custom role",
    description:
      "Create a custom role with specific permissions. Requires role:create permission.",
  })
  @ApiResponse({ status: 201, description: "Role created successfully" })
  @ApiResponse({
    status: 403,
    description: "Missing required permission: role:create",
  })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        name: { type: "string", example: "Support Agent" },
        description: { type: "string", example: "Customer support role" },
        permissions: {
          type: "array",
          items: { type: "string" },
          example: ["merchant:view", "payment:view"],
        },
      },
    },
  })
  async createRole(
    @Param("organizationId") organizationId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Body()
    createRoleDto: {
      name: string;
      description?: string;
      permissions: Permission[];
    }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.createRole(organizationId, createRoleDto);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermissions("role:view")
  @ApiOperation({
    summary: "Get all roles for organization",
    description:
      "Get all active roles with optional user counts. Requires role:view permission.",
  })
  @ApiResponse({ status: 200, description: "Roles retrieved successfully" })
  @ApiResponse({
    status: 403,
    description: "Missing required permission: role:view",
  })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiQuery({ name: "includeUserCount", required: false, type: Boolean })
  async getRoles(
    @Param("organizationId") organizationId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Query("includeUserCount") includeUserCount?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.getRoles(
      organizationId,
      includeUserCount === "true"
    );
  }

  @Get("permissions")
  @ApiOperation({
    summary: "Get all available permissions",
    description: "Get list of all permissions grouped by category",
  })
  @ApiResponse({
    status: 200,
    description: "Permissions retrieved successfully",
  })
  async getAllPermissions() {
    return this.roleService.getAllPermissions();
  }

  @Get("templates")
  @ApiOperation({
    summary: "Get role templates",
    description: "Get predefined role templates (Owner, Admin, Manager, etc.) with their permissions",
  })
  @ApiResponse({
    status: 200,
    description: "Role templates retrieved successfully",
  })
  async getRoleTemplates() {
    return this.roleService.getRoleTemplates();
  }

  @Get("by-name/:roleName")
  @ApiOperation({
    summary: "Get role by name (no permission check)",
    description:
      "Get role by name - used during registration to avoid permission issues",
  })
  @ApiResponse({ status: 200, description: "Role retrieved successfully" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "roleName", description: "Role name (e.g., OWNER, ADMIN)" })
  async getRoleByName(
    @Param("organizationId") organizationId: string,
    @Param("roleName") roleName: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.getRoleByName(organizationId, roleName);
  }

  @Get(":roleId")
  @ApiOperation({
    summary: "Get role details",
    description: "Get role with permissions and assigned users",
  })
  @ApiResponse({ status: 200, description: "Role retrieved successfully" })
  @ApiResponse({ status: 404, description: "Role not found" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "roleId", description: "Role ID" })
  async getRole(
    @Param("organizationId") organizationId: string,
    @Param("roleId") roleId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.getRole(roleId, organizationId);
  }

  @Put(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermissions("role:update")
  @ApiOperation({
    summary: "Update role",
    description:
      "Update role name, description, or permissions. Requires role:update permission.",
  })
  @ApiResponse({ status: 200, description: "Role updated successfully" })
  @ApiResponse({
    status: 403,
    description: "Missing required permission: role:update",
  })
  @ApiResponse({ status: 404, description: "Role not found" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "roleId", description: "Role ID" })
  async updateRole(
    @Param("organizationId") organizationId: string,
    @Param("roleId") roleId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Body()
    updateRoleDto: {
      name?: string;
      description?: string;
      permissions?: Permission[];
    }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.updateRole(roleId, organizationId, updateRoleDto);
  }

  @Delete(":roleId")
  @UseGuards(PermissionGuard)
  @RequirePermissions("role:delete")
  @ApiOperation({
    summary: "Delete role",
    description:
      "Soft delete a custom role (cannot delete default roles). Requires role:delete permission.",
  })
  @ApiResponse({ status: 200, description: "Role deleted successfully" })
  @ApiResponse({ status: 400, description: "Cannot delete default role" })
  @ApiResponse({
    status: 403,
    description: "Missing required permission: role:delete",
  })
  @ApiResponse({ status: 409, description: "Role has active users" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiParam({ name: "roleId", description: "Role ID" })
  async deleteRole(
    @Param("organizationId") organizationId: string,
    @Param("roleId") roleId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    return this.roleService.deleteRole(roleId, organizationId);
  }

  @Post("check-permission")
  @ApiOperation({
    summary: "Check if user has permission",
    description:
      "Validate if a user has a specific permission in the organization",
  })
  @ApiResponse({ status: 200, description: "Permission check result" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        permission: { type: "string", example: "merchant:create" },
      },
    },
  })
  async checkPermission(
    @Param("organizationId") organizationId: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Body() body: { userId: string; permission: Permission }
  ) {
    this.validateAccess(organizationId, reqOrgId, userType);
    const hasPermission = await this.roleService.checkPermission(
      body.userId,
      organizationId,
      body.permission
    );
    return {
      success: true,
      hasPermission,
      userId: body.userId,
      permission: body.permission,
    };
  }
}

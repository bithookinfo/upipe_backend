import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Query,
  Param,
  Body,
  BadRequestException,
  Headers,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { OrganizationService } from "../services/organization.service";
import { UserService } from "../services/user.service";
import { AuditService } from "../services/audit.service";

@ApiTags("organizations")
@Controller("organizations")
export class OrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly userService: UserService,
    private readonly auditService: AuditService,
  ) {}

  private validateAccess(id: string, reqOrgId?: string, userType?: string) {
    const type = userType?.toUpperCase();
    if (type === "SUPER_ADMIN" || type === "SUPERADMIN") return;
    if (reqOrgId && reqOrgId === id) return;
    throw new ForbiddenException("Access denied");
  }

  @Post()
  @ApiOperation({ summary: "Create a new organization" })
  @ApiResponse({
    status: 201,
    description: "Organization created successfully",
  })
  async createOrganization(
    @Body() createData: { name: string; email?: string; phone?: string; address?: string; pincode?: string; pan?: string },
  ) {
    if (!createData || !createData.name) {
      throw new BadRequestException("Name is required");
    }
    const slug = createData.name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    const uniqueSuffix = Math.random().toString(36).substring(7);

    // Generate a unique 5-char order prefix
    const orderPrefix =
      await this.organizationService.generateUniqueOrderPrefix();

    return this.organizationService.createOrganization({
      ...createData,
      slug: `${slug}-${Date.now()}-${uniqueSuffix}`,
      ownerUserId: "system-created",
      orderPrefix,
    });
  }

  @Get()
  @ApiOperation({ summary: "Get all organizations" })
  @ApiResponse({
    status: 200,
    description: "Organizations retrieved successfully",
  })
  async getOrganizations(
    @Query("page") page?: number,
    @Query("limit") limit?: number,
    @Query("search") search?: string,
  ) {
    const result = await this.organizationService.findAll({
      page: page ? parseInt(page.toString()) : 1,
      limit: limit ? parseInt(limit.toString()) : 10,
      search,
    });

    return {
      success: true,
      data: result.organizations,
      pagination: result.pagination,
    };
  }

  @Get("stats")
  @ApiOperation({ summary: "Get organization statistics" })
  @ApiResponse({ status: 200, description: "Stats retrieved successfully" })
  async getStats(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    const stats = await this.organizationService.getStats(fromDate, toDate);
    return stats;
  }

  @Get(":id/details")
  @ApiOperation({
    summary: "Get full organization details with stats for super admin",
  })
  @ApiResponse({
    status: 200,
    description: "Organization details retrieved successfully",
  })
  async getOrganizationDetailsForSuperAdmin(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    const details =
      await this.organizationService.getOrganizationDetailsForSuperAdmin(id);
    return {
      success: true,
      data: details,
    };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get organization by ID" })
  @ApiResponse({
    status: 200,
    description: "Organization retrieved successfully",
  })
  @ApiResponse({ status: 404, description: "Organization not found" })
  async getOrganization(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    const organization = await this.organizationService.findOne(id);
    return {
      success: true,
      data: organization,
    };
  }

  @Put(":id")
  @ApiOperation({ summary: "Update organization profile" })
  @ApiResponse({
    status: 200,
    description: "Organization updated successfully",
  })
  async updateOrganization(
    @Param("id") id: string,
    @Body() updateData: any,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Headers("x-user-id") userId: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.organizationService.updateOrganization(id, userId, userType, updateData);
  }

  @Get("users/:userId/organizations")
  @ApiOperation({ summary: "Get organizations for a user" })
  async getUserOrganizations(@Param("userId") userId: string) {
    return this.userService.getUserOrganizations(userId);
  }

  @Get(":id/audit-logs")
  @ApiOperation({ summary: "Get audit logs for organization" })
  async getOrganizationAuditLogs(
    @Param("id") id: string,
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
    @Query("action") action?: string,
    @Headers("x-organization-id") reqOrgId?: string,
    @Headers("x-user-type") userType?: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.auditService.getOrganizationLogs(id, {
      limit: limit ? parseInt(limit.toString()) : 50,
      offset: offset ? parseInt(offset.toString()) : 0,
      action,
    });
  }

  @Patch(":id/activate")
  @ApiOperation({ summary: "Activate organization (super admin)" })
  @ApiResponse({
    status: 200,
    description: "Organization activated successfully",
  })
  async activateOrganization(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Headers("x-user-id") userId: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    await this.organizationService.activateOrganization(id, userId, userType);
    return {
      success: true,
      message: "Organization activated successfully",
    };
  }

  @Patch(":id/suspend")
  @ApiOperation({ summary: "Suspend organization (super admin)" })
  @ApiResponse({
    status: 200,
    description: "Organization suspended successfully",
  })
  async suspendOrganization(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
    @Headers("x-user-id") userId: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    await this.organizationService.suspendOrganization(id, userId, userType, body.reason);
    return {
      success: true,
      message: "Organization suspended successfully",
    };
  }

  @Get(":id/settings")
  @ApiOperation({ summary: "Get organization settings" })
  @ApiResponse({ status: 200, description: "Settings retrieved successfully" })
  async getOrganizationSettings(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    const settings = await this.organizationService.getSettings(id);
    return {
      success: true,
      data: settings,
    };
  }

  @Put(":id/settings")
  @ApiOperation({ summary: "Update organization settings (e.g. notification preferences)" })
  @ApiResponse({ status: 200, description: "Settings updated successfully" })
  async updateOrganizationSettings(
    @Param("id") id: string,
    @Body() body: { notifications?: { orderCompletionEmail?: boolean } },
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.organizationService.updateSettings(id, body);
  }

  @Get(":id/api-key")
  @ApiOperation({ summary: "Get API key for organization" })
  @ApiResponse({ status: 200, description: "API key retrieved successfully" })
  async getApiKey(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.organizationService.getApiKey(id);
  }

  @Post(":id/api-key/regenerate")
  @ApiOperation({ summary: "Regenerate API key for organization" })
  @ApiResponse({ status: 200, description: "API key regenerated successfully" })
  async regenerateApiKey(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.organizationService.regenerateApiKey(id);
  }

  @Post("validate-api-key")
  @ApiOperation({ summary: "Validate an API key (internal use)" })
  @ApiResponse({ status: 200, description: "API key validation result" })
  async validateApiKey(@Body() body: { apiKey: string }) {
    if (!body.apiKey) {
      throw new BadRequestException("API key is required");
    }
    return this.organizationService.validateApiKey(body.apiKey);
  }

  @Get(":id/webhook")
  @ApiOperation({ summary: "Get webhook URL for organization" })
  @ApiResponse({
    status: 200,
    description: "Webhook URL retrieved successfully",
  })
  async getWebhookUrl(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    return this.organizationService.getWebhookUrl(id);
  }

  @Put(":id/webhook")
  @ApiOperation({ summary: "Update webhook URL for organization" })
  @ApiResponse({ status: 200, description: "Webhook URL updated successfully" })
  async updateWebhookUrl(
    @Param("id") id: string,
    @Body() body: { webhookUrl: string },
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    if (!body.webhookUrl) {
      throw new BadRequestException("webhookUrl is required");
    }
    return this.organizationService.updateWebhookUrl(id, body.webhookUrl);
  }
  
  @Delete(":id")
  @ApiOperation({ summary: "Delete organization (super admin)" })
  @ApiResponse({ status: 200, description: "Organization deleted successfully" })
  async deleteOrganization(
    @Param("id") id: string,
    @Headers("x-organization-id") reqOrgId: string,
    @Headers("x-user-type") userType: string,
  ) {
    this.validateAccess(id, reqOrgId, userType);
    await this.organizationService.deleteOrganization(id);
    return {
      success: true,
      message: "Organization deleted successfully",
    };
  }
}

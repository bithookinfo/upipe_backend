import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { ConfigTemplateService } from "./config-template.service";

@ApiTags("Config Templates")
@Controller("config-templates")
export class ConfigTemplateController {
  constructor(private readonly templateService: ConfigTemplateService) {}

  @Get()
  @ApiOperation({ summary: "Get all available config templates" })
  @ApiQuery({
    name: "organizationId",
    required: false,
    description: "Filter by organization",
  })
  @ApiResponse({ status: 200, description: "Templates retrieved successfully" })
  async getTemplates(
    @Query("organizationId") organizationId?: string,
    @Headers("x-organization-id") headerOrgId?: string,
  ) {
    const orgId = organizationId || headerOrgId;
    return this.templateService.getTemplates(orgId);
  }

  @Get(":templateId")
  @ApiOperation({ summary: "Get a specific template" })
  @ApiParam({ name: "templateId", description: "Template ID" })
  @ApiResponse({ status: 200, description: "Template retrieved successfully" })
  @ApiResponse({ status: 404, description: "Template not found" })
  async getTemplate(@Param("templateId") templateId: string) {
    return this.templateService.getTemplate(templateId);
  }

  @Post()
  @ApiOperation({ summary: "Create a new config template" })
  @ApiResponse({ status: 201, description: "Template created successfully" })
  async createTemplate(
    @Body()
    createDto: {
      organizationId?: string;
      name: string;
      description?: string;
      openTime?: string;
      closeTime?: string;
      dailyMaxAmount?: number;
      dailyMaxTxnCount?: number;
      monthlyMaxAmount?: number;
      monthlyMaxTxnCount?: number;
      minTxnAmount?: number;
      maxTxnAmount?: number;
      isGlobal?: boolean;
    },
    @Headers("x-organization-id") headerOrgId?: string,
  ) {
    // If isGlobal is true, organizationId should be null
    // Otherwise, use provided organizationId or fallback to header
    const organizationId = createDto.isGlobal
      ? null
      : createDto.organizationId || headerOrgId || null;

    const data = {
      ...createDto,
      organizationId,
    };
    return this.templateService.createTemplate(data);
  }

  @Put(":templateId")
  @ApiOperation({ summary: "Update a config template" })
  @ApiParam({ name: "templateId", description: "Template ID" })
  @ApiResponse({ status: 200, description: "Template updated successfully" })
  @ApiResponse({ status: 404, description: "Template not found" })
  async updateTemplate(
    @Param("templateId") templateId: string,
    @Body()
    updateDto: {
      name?: string;
      description?: string;
      openTime?: string;
      closeTime?: string;
      dailyMaxAmount?: number;
      dailyMaxTxnCount?: number;
      monthlyMaxAmount?: number;
      monthlyMaxTxnCount?: number;
      minTxnAmount?: number;
      maxTxnAmount?: number;
      isGlobal?: boolean;
    },
  ) {
    return this.templateService.updateTemplate(templateId, updateDto);
  }

  @Delete(":templateId")
  @ApiOperation({ summary: "Delete a config template" })
  @ApiParam({ name: "templateId", description: "Template ID" })
  @ApiResponse({ status: 200, description: "Template deleted successfully" })
  async deleteTemplate(@Param("templateId") templateId: string) {
    return this.templateService.deleteTemplate(templateId);
  }

  @Post("apply/:templateId/merchant/:merchantId")
  @ApiOperation({ summary: "Apply a template to a merchant" })
  @ApiParam({ name: "templateId", description: "Template ID to apply" })
  @ApiParam({
    name: "merchantId",
    description: "Merchant ID to apply template to",
  })
  @ApiResponse({ status: 200, description: "Template applied successfully" })
  async applyTemplate(
    @Param("templateId") templateId: string,
    @Param("merchantId") merchantId: string,
  ) {
    return this.templateService.applyTemplate(merchantId, templateId);
  }
}

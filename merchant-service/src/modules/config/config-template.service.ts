import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

interface CreateTemplateDto {
  organizationId?: string;
  name: string;
  description?: string;
  openTime?: string;
  closeTime?: string;
  // NEW: Multiple time slots support
  operatingSlots?: Array<{ open: string; close: string }>;
  // NEW: Weekly holidays (0=Sunday, 6=Saturday)
  weeklyHolidays?: number[];
  dailyMaxAmount?: number;
  dailyMaxTxnCount?: number;
  monthlyMaxAmount?: number;
  monthlyMaxTxnCount?: number;
  minTxnAmount?: number;
  maxTxnAmount?: number;
  isGlobal?: boolean;
}

@Injectable()
export class ConfigTemplateService {
  private readonly logger = new Logger(ConfigTemplateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all templates available to an organization
   * Returns:
   * - Global templates (isGlobal: true, organizationId: null)
   * - Org-specific templates (organizationId matches)
   * - Orphaned/shared templates (organizationId: null, isGlobal: false) - visible to all orgs
   */
  async getTemplates(organizationId?: string) {
    try {
      this.logger.log(
        `Fetching templates for organizationId: ${organizationId || "none"}`,
      );

      const templates = await this.prisma.configTemplate.findMany({
        where: {
          isActive: true,
          OR: [
            { isGlobal: true },
            ...(organizationId ? [{ organizationId }] : []),
            // Include templates with null organizationId that are not global (orphaned/shared templates)
            // These are visible to all organizations
            {
              AND: [{ organizationId: null }, { isGlobal: false }],
            },
          ],
        },
        orderBy: [
          { isGlobal: "desc" }, // Global templates first
          { name: "asc" },
        ],
      });

      this.logger.log(
        `Found ${templates.length} templates (${templates.filter((t) => t.isGlobal).length} global, ${templates.filter((t) => t.organizationId === organizationId).length} org-specific, ${templates.filter((t) => !t.organizationId && !t.isGlobal).length} orphaned)`,
      );

      return {
        success: true,
        templates,
        total: templates.length,
      };
    } catch (error) {
      this.logger.error("Failed to fetch templates:", error);
      throw new InternalServerErrorException("Failed to retrieve templates");
    }
  }

  /**
   * Get a single template by ID
   */
  async getTemplate(templateId: string) {
    try {
      const template = await this.prisma.configTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new NotFoundException(`Template ${templateId} not found`);
      }

      return {
        success: true,
        template,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch template ${templateId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to retrieve template");
    }
  }

  /**
   * Create a new config template
   */
  async createTemplate(data: CreateTemplateDto) {
    try {
      this.logger.log(
        `Creating template: ${data.name} (orgId: ${data.organizationId || "null"}, isGlobal: ${data.isGlobal || false})`,
      );

      const template = await this.prisma.configTemplate.create({
        data: {
          organizationId: data.organizationId || null,
          name: data.name,
          description: data.description,
          openTime: data.openTime || "09:00",
          closeTime: data.closeTime || "21:00",
          operatingSlots: data.operatingSlots || null,
          weeklyHolidays: data.weeklyHolidays || null,
          dailyMaxAmount: data.dailyMaxAmount || 50000,
          dailyMaxTxnCount: data.dailyMaxTxnCount || 100,
          monthlyMaxAmount: data.monthlyMaxAmount || 1000000,
          monthlyMaxTxnCount: data.monthlyMaxTxnCount || 2000,
          minTxnAmount: data.minTxnAmount,
          maxTxnAmount: data.maxTxnAmount,
          isGlobal: data.isGlobal || false,
        },
      });

      this.logger.log(
        `✅ Template created: ${template.id} (orgId: ${template.organizationId || "null"}, isGlobal: ${template.isGlobal})`,
      );
      return {
        success: true,
        template,
        message: "Template created successfully",
      };
    } catch (error) {
      this.logger.error("Failed to create template:", error);
      throw new InternalServerErrorException("Failed to create template");
    }
  }

  /**
   * Update an existing template
   */
  async updateTemplate(templateId: string, data: Partial<CreateTemplateDto>) {
    try {
      const existing = await this.prisma.configTemplate.findUnique({
        where: { id: templateId },
      });

      if (!existing) {
        throw new NotFoundException(`Template ${templateId} not found`);
      }

      const template = await this.prisma.configTemplate.update({
        where: { id: templateId },
        data: {
          name: data.name,
          description: data.description,
          openTime: data.openTime,
          closeTime: data.closeTime,
          operatingSlots: data.operatingSlots,
          weeklyHolidays: data.weeklyHolidays,
          dailyMaxAmount: data.dailyMaxAmount,
          dailyMaxTxnCount: data.dailyMaxTxnCount,
          monthlyMaxAmount: data.monthlyMaxAmount,
          monthlyMaxTxnCount: data.monthlyMaxTxnCount,
          minTxnAmount: data.minTxnAmount,
          maxTxnAmount: data.maxTxnAmount,
          isGlobal: data.isGlobal,
        },
      });

      return {
        success: true,
        template,
        message: "Template updated successfully",
      };
    } catch (error) {
      this.logger.error(`Failed to update template ${templateId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to update template");
    }
  }

  /**
   * Delete a template (soft delete by setting isActive = false)
   */
  async deleteTemplate(templateId: string) {
    try {
      await this.prisma.configTemplate.update({
        where: { id: templateId },
        data: { isActive: false },
      });

      return {
        success: true,
        message: "Template deleted successfully",
      };
    } catch (error) {
      this.logger.error(`Failed to delete template ${templateId}:`, error);
      throw new InternalServerErrorException("Failed to delete template");
    }
  }

  /**
   * Apply a template to a merchant's configuration
   */
  async applyTemplate(merchantId: string, templateId: string) {
    try {
      this.logger.log(
        `Applying template ${templateId} to merchant ${merchantId}`,
      );

      const template = await this.prisma.configTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new NotFoundException(`Template ${templateId} not found`);
      }

      // Upsert merchant config with template values
      const config = await this.prisma.merchantConfig.upsert({
        where: { merchantId },
        create: {
          merchantId,
          openTime: template.openTime,
          closeTime: template.closeTime,
          operatingSlots: template.operatingSlots || null,
          timezone: "Asia/Kolkata",
          weeklyHolidays: template.weeklyHolidays || [],
          dailyMaxAmount: template.dailyMaxAmount,
          dailyMaxTxnCount: template.dailyMaxTxnCount,
          dailyMinAmount: 0,
          dailyMinTxnCount: 0,
          monthlyMaxAmount: template.monthlyMaxAmount,
          monthlyMaxTxnCount:
            template.monthlyMaxTxnCount || template.dailyMaxTxnCount * 30,
          monthlyMinAmount: 0,
          monthlyMinTxnCount: 0,
          minTxnAmount: template.minTxnAmount,
          maxTxnAmount: template.maxTxnAmount,
          currentDailyAmount: 0,
          currentDailyTxnCount: 0,
          lastDailyReset: new Date(),
          currentMonthlyAmount: 0,
          currentMonthlyTxnCount: 0,
          lastMonthlyReset: new Date(),
        },
        update: {
          openTime: template.openTime,
          closeTime: template.closeTime,
          operatingSlots: template.operatingSlots || null,
          weeklyHolidays: template.weeklyHolidays || [],
          dailyMaxAmount: template.dailyMaxAmount,
          dailyMaxTxnCount: template.dailyMaxTxnCount,
          monthlyMaxAmount: template.monthlyMaxAmount,
          monthlyMaxTxnCount:
            template.monthlyMaxTxnCount || template.dailyMaxTxnCount * 30,
          minTxnAmount: template.minTxnAmount,
          maxTxnAmount: template.maxTxnAmount,
        },
      });

      this.logger.log(`✅ Template applied to merchant ${merchantId}`);
      return {
        success: true,
        config,
        templateApplied: template.name,
        message: "Template applied successfully",
      };
    } catch (error) {
      this.logger.error(
        `Failed to apply template to merchant ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to apply template");
    }
  }
}

import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { PrismaService } from "./prisma.service";
import { AuditService } from "./audit.service";
import { randomUUID, randomBytes } from "crypto";

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async createOrganization(data: {
    name: string;
    slug: string;
    ownerUserId: string;
    orderPrefix?: string;
    email?: string;
    phone?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    gstin?: string;
    pan?: string;
  }) {
    try {
      this.logger.log(`🏢 Creating organization: ${data.name}`);

      const existing = await this.prisma.organizations.findUnique({
        where: { slug: data.slug },
      });

      if (existing) {
        throw new ConflictException(
          `Organization with slug '${data.slug}' already exists`,
        );
      }

      const organization = await this.prisma.organizations.create({
        data: {
          id: randomUUID(),
          name: data.name,
          slug: data.slug,
          order_prefix: data.orderPrefix || null,
          owner_user_id: data.ownerUserId,
          email: data.email,
          phone: data.phone,
          address: data.address,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          gstin: data.gstin?.toUpperCase(),
          pan: data.pan?.toUpperCase(),
          status: "ACTIVE",
          is_active: true,
          updated_at: new Date(),
        },
      });

      this.logger.log(`✅ Organization created: ${organization.id}`);
      
      try {
        await this.auditService.log({
          organizationId: organization.id,
          action: 'ORGANIZATION_CREATED',
          performedBy: data.ownerUserId,
          performedByType: 'USER',
          entityId: organization.id,
          entityType: 'ORGANIZATION',
          metadata: { name: data.name, slug: data.slug }
        });
      } catch (err) {
        this.logger.warn(`Failed to log organization creation: ${err.message}`);
      }

      return {
        success: true,
        organization,
        message: "Organization created successfully",
      };
    } catch (error) {
      console.error("FULL ERROR:", error); // DEBUG LOG
      this.logger.error(`❌ Failed to create organization:`, error);
      if (error instanceof ConflictException) throw error;
      throw new InternalServerErrorException(
        error.message || "Failed to create organization",
      );
    }
  }

  async findAll(filters?: any) {
    try {
      const { page = 1, limit = 10, search, status } = filters || {};

      const where: any = {
        slug: { not: 'upipe' } // Exclude internal platform organization
      };

      if (search) {
        where.OR = [
          { name: { contains: search } },
          { slug: { contains: search } },
          { email: { contains: search } },
        ];
      }

      if (status) {
        where.status = status;
        if (status === 'inactive') {
          where.status = { in: ['INACTIVE', 'SUSPENDED'] };
        } else {
          where.status = status;
        }
      }

      const [organizations, total] = await Promise.all([
        this.prisma.organizations.findMany({
          where,
          include: {
            org_users: {
              select: { id: true },
              where: { is_active: true },
            },
            org_subscriptions: {
              select: {
                status: true,
                end_date: true,
              },
              orderBy: { created_at: "desc" },
              take: 1,
            },
          },
          orderBy: { created_at: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.organizations.count({ where }),
      ]);

      const result = organizations.map((org: any) => ({
        ...org,
        userCount: org.org_users?.length || 0,
        subscription: org.org_subscriptions?.[0] || null,
        org_users: undefined,
        org_subscriptions: undefined,
      }));

      return {
        success: true,
        organizations: result,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error("❌ Failed to retrieve organizations:", error);
      throw new InternalServerErrorException(
        "Failed to retrieve organizations",
      );
    }
  }

  async findOne(id: string) {
    try {
      const organization = await this.prisma.organizations.findUnique({
        where: { id },
        include: {
          org_users: {
            where: { is_active: true },
            include: {
              org_roles: true,
            },
          },
          org_subscriptions: {
            orderBy: { created_at: "desc" },
            take: 1,
          },
          org_roles: true,
        },
      });

      if (!organization) {
        throw new NotFoundException(`Organization ${id} not found`);
      }

      return {
        success: true,
        organization: {
          ...organization,
          userCount: organization.org_users.length,
          roleCount: organization.org_roles.length,
          subscription: organization.org_subscriptions[0] || null,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to retrieve organization ${id}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to retrieve organization");
    }
  }

  async updateOrganization(
    id: string,
    userId: string,
    userType: string,
    updateData: {
      name?: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      gstin?: string;
      pan?: string;
      website?: string;
      logoUrl?: string; // Add this
    },
  ) {
    try {
      const existing = await this.findOne(id);
      
      let newSettings = existing.organization.settings;
      if (updateData.logoUrl !== undefined) {
        const currentSettings = newSettings ? JSON.parse(newSettings as string) : {};
        currentSettings.logoUrl = updateData.logoUrl;
        newSettings = JSON.stringify(currentSettings);
      }

      const updatedOrg = await this.prisma.organizations.update({
        where: { id },
        data: {
          name: updateData.name,
          email: updateData.email,
          phone: updateData.phone,
          address: updateData.address,
          city: updateData.city,
          state: updateData.state,
          website: updateData.website,
          gstin: updateData.gstin?.toUpperCase(),
          pan: updateData.pan?.toUpperCase(),
          settings: newSettings,
          updated_at: new Date(),
        },
      });

      try {
        await this.auditService.log({
          organizationId: id,
          action: 'ORGANIZATION_UPDATED',
          performedBy: userId || 'SYSTEM',
          performedByType: userType || 'SUPER_ADMIN',
          entityId: id,
          entityType: 'ORGANIZATION',
        });
      } catch (err) {
        this.logger.warn(`Failed to log organization update: ${err.message}`);
      }

      return {
        success: true,
        message: "Organization updated successfully",
        organization: updatedOrg,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update organization ${id}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to update organization");
    }
  }

  async getOrganizationUsers(orgId: string) {
    try {
      const users = await this.prisma.org_users.findMany({
        where: {
          organization_id: orgId,
          is_active: true,
        },
        include: {
          org_roles: true,
        },
        orderBy: { joined_at: "desc" },
      });

      return {
        success: true,
        users,
        total: users.length,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to retrieve users for organization ${orgId}:`,
        error,
      );
      throw new InternalServerErrorException(
        "Failed to retrieve organization users",
      );
    }
  }

  async getSettings(orgId: string) {
    try {
      const result = await this.findOne(orgId);
      const organization = result.organization;

      return {
        success: true,
        settings: {
          organizationId: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          customSettings: organization.settings
            ? JSON.parse(organization.settings as string)
            : {},
          contact: {
            email: organization.email,
            phone: organization.phone,
          },
          address: {
            address: organization.address,
            city: organization.city,
            state: organization.state,
            pincode: organization.pincode,
          },
          business: {
            gstin: organization.gstin,
            pan: organization.pan,
          },
        },
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to retrieve settings for organization ${orgId}:`,
        error,
      );
      throw new InternalServerErrorException("Failed to retrieve settings");
    }
  }

  /**
   * Update organization settings (merges with existing customSettings).
   * Use for notification prefs e.g. { notifications: { orderCompletionEmail: true } }
   */
  async updateSettings(
    orgId: string,
    updates: { notifications?: { orderCompletionEmail?: boolean } },
  ) {
    try {
      const result = await this.findOne(orgId);
      const organization = result.organization;
      const current = organization.settings
        ? JSON.parse(organization.settings as string)
        : {};
      const merged = {
        ...current,
        ...(updates.notifications !== undefined
          ? { notifications: { ...(current.notifications || {}), ...updates.notifications } }
          : {}),
      };
      await this.prisma.organizations.update({
        where: { id: orgId },
        data: { settings: JSON.stringify(merged), updated_at: new Date() },
      });
      return {
        success: true,
        message: "Settings updated",
        settings: merged,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to update settings for organization ${orgId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to update settings");
    }
  }

  async getStats(fromDate?: string, toDate?: string) {
    try {
      this.logger.log("📊 Retrieving organization stats...");

      let dateFilter: any = undefined;
      if (fromDate || toDate) {
          dateFilter = {};
          if (fromDate) {
              const start = new Date(fromDate);
              start.setHours(0, 0, 0, 0);
              dateFilter.gte = start;
          }
          if (toDate) {
              const end = new Date(toDate);
              end.setHours(23, 59, 59, 999);
              dateFilter.lte = end;
          }
      }

      const [total, active] = await Promise.all([
        this.prisma.organizations.count({
          where: fromDate || toDate ? { created_at: dateFilter } : { slug: { not: 'upipe' } }
        }),
        this.prisma.organizations.count({
          where: { 
            is_active: true,
            ...(fromDate || toDate ? { created_at: dateFilter } : { slug: { not: 'upipe' } })
          },
        }),
      ]);

      const stats = { total, active };
      this.logger.log(
        `📊 Organization stats calculated: ${JSON.stringify(stats)}`,
      );
      return stats;
    } catch (error) {
      this.logger.error("❌ Failed to retrieve organization stats:", error);
      throw new InternalServerErrorException("Failed to retrieve stats");
    }
  }

  async getOrganizationDetailsForSuperAdmin(id: string) {
    try {
      this.logger.log(
        `📊 Fetching organization details for super admin: ${id}`,
      );

      const organization = await this.prisma.organizations.findUnique({
        where: { id },
      });

      if (!organization) {
        throw new NotFoundException(`Organization not found`);
      }

      // Fetch related stats
      const [userCount, merchantCount] = await Promise.all([
        this.prisma.org_users.count({
          where: { organization_id: id, is_active: true },
        }),
        // Fetch merchant count from merchant-service
        (async () => {
          try {
            const merchantServiceUrl = this.configService.get(
              "MERCHANT_SERVICE_URL",
            );
            const response = await axios.get(
              `${merchantServiceUrl}/merchants/internal/organizations/${id}/count`,
            );
            return response.data.count || 0;
          } catch (error) {
            this.logger.warn(
              `Failed to fetch merchant count: ${error.message}`,
            );
            return 0;
          }
        })(),
      ]);

      return {
        ...organization,
        stats: {
          userCount,
          merchantCount,
          transactionCount: 0, // From payment-service
          revenue: 0, // From payment-service
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error("❌ Failed to get organization details:", error);
      throw new InternalServerErrorException(
        "Failed to get organization details",
      );
    }
  }

  async activateOrganization(id: string, userId: string, userType: string) {
    try {
      this.logger.log(`✅ Activating organization: ${id}`);

      const organization = await this.prisma.organizations.findUnique({
        where: { id },
      });

      if (!organization) {
        throw new NotFoundException(`Organization not found`);
      }

      await this.prisma.organizations.update({
        where: { id },
        data: {
          is_active: true,
          status: "ACTIVE",
          updated_at: new Date(),
        },
      });

      try {
        await this.auditService.log({
          organizationId: id,
          action: 'ORGANIZATION_ACTIVATED',
          performedBy: userId,
          performedByType: userType || 'SUPER_ADMIN',
          entityId: id,
          entityType: 'ORGANIZATION',
          metadata: { name: organization.name }
        });
      } catch (err) {
        this.logger.warn(`Failed to log organization activation: ${err.message}`);
      }

      this.logger.log(`✅ Organization activated successfully`);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error("❌ Failed to activate organization:", error);
      throw new InternalServerErrorException("Failed to activate organization");
    }
  }

  async suspendOrganization(id: string, userId: string, userType: string, reason?: string) {
    try {
      this.logger.log(`⛔ Suspending organization: ${id}`);

      const organization = await this.prisma.organizations.findUnique({
        where: { id },
      });

      if (!organization) {
        throw new NotFoundException(`Organization not found`);
      }

      await this.prisma.organizations.update({
        where: { id },
        data: {
          is_active: false,
          status: "SUSPENDED",
          updated_at: new Date(),
          // Add suspension reason to metadata if you have a field for it
        },
      });

      try {
        await this.auditService.log({
          organizationId: id,
          action: 'ORGANIZATION_SUSPENDED',
          performedBy: userId,
          performedByType: userType || 'SUPER_ADMIN',
          entityId: id,
          entityType: 'ORGANIZATION',
          reason: reason,
          metadata: { name: organization.name }
        });
      } catch (err) {
        this.logger.warn(`Failed to log organization suspension: ${err.message}`);
      }

      this.logger.log(`⛔ Organization suspended successfully`);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error("❌ Failed to suspend organization:", error);
      throw new InternalServerErrorException("Failed to suspend organization");
    }
  }

  /**
   * Generate a new API key for an organization
   */
  private generateApiKey(): string {
    const prefix = "gp_live_";
    const randomPart = randomBytes(24).toString("hex");
    return `${prefix}${randomPart}`;
  }

  /**
   * Get API key for an organization (masked for security)
   */
  async getApiKey(orgId: string) {
    try {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
        select: { api_key: true },
      });

      if (!organization) {
        throw new NotFoundException("Organization not found");
      }

      // If no API key exists, generate one
      if (!organization.api_key) {
        const newApiKey = this.generateApiKey();
        await this.prisma.organizations.update({
          where: { id: orgId },
          data: { api_key: newApiKey, updated_at: new Date() },
        });

        return {
          success: true,
          apiKey: newApiKey,
          isNew: true,
        };
      }

      return {
        success: true,
        apiKey: organization.api_key,
        isNew: false,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get API key for organization ${orgId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to get API key");
    }
  }

  /**
   * Regenerate API key for an organization
   */
  async regenerateApiKey(orgId: string) {
    try {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
      });

      if (!organization) {
        throw new NotFoundException("Organization not found");
      }

      const newApiKey = this.generateApiKey();

      await this.prisma.organizations.update({
        where: { id: orgId },
        data: { api_key: newApiKey, updated_at: new Date() },
      });

      this.logger.log(`🔑 API key regenerated for organization ${orgId}`);

      return {
        success: true,
        apiKey: newApiKey,
        message:
          "API key regenerated successfully. Please update your integrations.",
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to regenerate API key for organization ${orgId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to regenerate API key");
    }
  }

  /**
   * Validate an API key and return the associated organization
   */
  async validateApiKey(apiKey: string) {
    try {
      const organization = await this.prisma.organizations.findFirst({
        where: {
          api_key: apiKey,
          is_active: true,
          status: "ACTIVE",
        },
        select: {
          id: true,
          name: true,
          slug: true,
          order_prefix: true,
          owner_user_id: true,
          webhook_url: true,
        },
      });

      if (!organization) {
        return { valid: false, organization: null };
      }

      return { valid: true, organization };
    } catch (error) {
      this.logger.error("❌ Failed to validate API key:", error);
      return { valid: false, organization: null };
    }
  }

  /**
   * Generate a unique 5-character alphanumeric order prefix
   */
  async generateUniqueOrderPrefix(): Promise<string> {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No I/O/0/1 to avoid confusion
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let prefix = "";
      const bytes = randomBytes(5);
      for (let i = 0; i < 5; i++) {
        prefix += chars[bytes[i] % chars.length];
      }

      // Check uniqueness
      const existing = await this.prisma.organizations.findFirst({
        where: { order_prefix: prefix },
      });

      if (!existing) {
        this.logger.log(`🔑 Generated unique order prefix: ${prefix}`);
        return prefix;
      }

      this.logger.warn(
        `⚠️ Prefix collision on attempt ${attempt + 1}: ${prefix}, retrying...`,
      );
    }

    // Fallback: use 7 chars for even lower collision chance
    const fallbackBytes = randomBytes(7);
    let fallback = "";
    for (let i = 0; i < 7; i++) {
      fallback += chars[fallbackBytes[i] % chars.length];
    }
    this.logger.log(`🔑 Generated fallback order prefix: ${fallback}`);
    return fallback;
  }

  /**
   * Update webhook URL for an organization
   */
  async updateWebhookUrl(orgId: string, webhookUrl: string) {
    try {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
      });

      if (!organization) {
        throw new NotFoundException("Organization not found");
      }

      await this.prisma.organizations.update({
        where: { id: orgId },
        data: { webhook_url: webhookUrl, updated_at: new Date() },
      });

      this.logger.log(`📡 Webhook URL updated for organization ${orgId}`);

      return {
        success: true,
        message: "Webhook URL updated successfully",
        webhookUrl,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to update webhook URL for organization ${orgId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to update webhook URL");
    }
  }

  /**
   * Get webhook URL for an organization
   */
  async getWebhookUrl(orgId: string) {
    try {
      const organization = await this.prisma.organizations.findUnique({
        where: { id: orgId },
        select: { webhook_url: true },
      });

      if (!organization) {
        throw new NotFoundException("Organization not found");
      }

      return {
        success: true,
        webhookUrl: organization.webhook_url,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get webhook URL for organization ${orgId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to get webhook URL");
    }
  }

  async deleteOrganization(id: string) {
    try {
      this.logger.log(`🗑️ Deleting organization: ${id}`);

      const organization = await this.prisma.organizations.findUnique({
        where: { id },
      });

      if (!organization) {
        throw new NotFoundException(`Organization not found`);
      }

      // Hard delete (adjust to soft delete if business logic requires it later)
      await this.prisma.organizations.delete({
        where: { id },
      });

      this.logger.log(`✅ Organization deleted successfully`);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error("❌ Failed to delete organization:", error);
      throw new InternalServerErrorException("Failed to delete organization");
    }
  }
}

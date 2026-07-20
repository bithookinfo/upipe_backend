import { Controller, Get, Query, Param, Patch, Body, Delete, Headers, Ip, Logger, ForbiddenException } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { PrismaService } from "../prisma/prisma.service";

@Controller("merchants")
@ApiTags("merchants")
export class MerchantsController {
  private readonly logger = new Logger(MerchantsController.name);

  constructor(private prisma: PrismaService) {}

  private validateSuperAdmin(isSuperAdmin?: string, userType?: string) {
    if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    throw new ForbiddenException("Super admin access required");
  }

  private async logAuditActivity(
    action: string,
    merchantId: string,
    userId: string,
    organizationId: string,
    userType: string,
    ipAddress: string,
    userAgent: string,
    metadata?: any
  ) {
    if (!userId) return; // Cannot log if we don't know who did it
    const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
    if (!orgServiceUrl) return;

    try {
      const axios = require("axios");
      await axios.post(`${orgServiceUrl}/audit-logs`, {
        organizationId: organizationId || null,
        action,
        performedBy: userId,
        performedByType: userType || 'USER',
        entityId: merchantId,
        entityType: 'MERCHANT',
        ipAddress: ipAddress || null,
        metadata: {
          ...metadata,
          userAgent: userAgent || null,
        },
      }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
    } catch (err) {
      this.logger.warn(`Failed to log audit activity '${action}' for merchant ${merchantId}: ${err.message}`);
    }
  }

  @Get("stats")
  @ApiOperation({ summary: "Get merchant statistics for super admin" })
  @ApiResponse({
    status: 200,
    description: "Merchant stats retrieved successfully",
  })
  async getStats(
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
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
      this.prisma.merchant.count({ 
        where: { 
          isPlatform: false, 
          deletedAt: null,
          ...(fromDate || toDate ? { createdAt: dateFilter } : {})
        } 
      }),
      this.prisma.merchant.count({ 
        where: { 
          isPlatform: false, 
          isActive: true, 
          deletedAt: null,
          ...(fromDate || toDate ? { createdAt: dateFilter } : {})
        } 
      }),
    ]);

    return {
      total,
      active,
    };
  }

  @Get("users")
  @ApiOperation({ summary: "Get all merchants for super admin" })
  @ApiResponse({ status: 200, description: "Merchants retrieved successfully" })
  async getAllMerchants(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const pageNum = page ? parseInt(page) : 1;
    const limitNum = limit ? parseInt(limit) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search } },
        { businessName: { contains: search } },
        { email: { contains: search } },
      ];
    }

    if (status && status !== "all") {
      where.isActive = status === "active";
    }

    if (type === "all") {
    } else if (type === "regular") {
      where.isPlatform = false;
    } else {
      where.isPlatform = true;
    }
    
    where.deletedAt = null;

    const [merchants, total] = await Promise.all([
      this.prisma.merchant.findMany({
        where,
        include: {
          providers: {
            select: {
              id: true,
              providerType: true,
              status: true,
              lastSyncedAt: true,
              accountIdentifier: true,
              metadata: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      this.prisma.merchant.count({ where }),
    ]);

    return {
      success: true,
      data: merchants,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
  }

  @Get("users/:id")
  @ApiOperation({ summary: "Get merchant details" })
  async getMerchantDetails(
    @Param("id") id: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
      include: {
        config: true,
        providers: {
          select: {
            id: true,
            providerType: true,
            status: true,
            lastSyncedAt: true,
            accountIdentifier: true,
            metadata: true,
          },
        },
      },
    });

    if (!merchant || merchant.deletedAt) {
      return {
        success: false,
        message: "Merchant not found",
      };
    }

    return {
      success: true,
      data: merchant,
    };
  }

  @Patch("users/:id/activate")
  @ApiOperation({ summary: "Activate merchant" })
  async activateMerchant(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType: string,
    @Headers("user-agent") userAgent: string,
    @Ip() ipAddress: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    await this.prisma.merchant.update({
      where: { id },
      data: { isActive: true },
    });

    await this.logAuditActivity("MERCHANT_CONNECT", id, userId, organizationId, userType, ipAddress, userAgent);

    return {
      success: true,
      message: "Merchant activated successfully",
    };
  }

  @Patch("users/:id/deactivate")
  @ApiOperation({ summary: "Deactivate merchant" })
  async deactivateMerchant(
    @Param("id") id: string,
    @Body() body: { reason?: string },
    @Headers("x-user-id") userId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType: string,
    @Headers("user-agent") userAgent: string,
    @Ip() ipAddress: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    await this.prisma.merchant.update({
      where: { id },
      data: {
        isActive: false,
        statusReason: body.reason,
      },
    });

    await this.logAuditActivity("MERCHANT_DISCONNECT", id, userId, organizationId, userType, ipAddress, userAgent, { reason: body.reason });

    return {
      success: true,
      message: "Merchant deactivated successfully",
    };
  }
  @Get("users/:id/stats")
  @ApiOperation({ summary: "Get merchant specific stats" })
  async getMerchantStats(@Param("id") id: string) {
    const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
    try {
      const axios = require("axios");
      const response = await axios.get(`${paymentServiceUrl}/stats/merchant/${id}`, {
        timeout: 5000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
    });
      console.log(`[MerchantsController] Stats response for ${id}:`, JSON.stringify(response.data));
      return response.data;
    } catch (error) {
      console.error(`❌ [MerchantsController] Failed to fetch stats from ${paymentServiceUrl}/stats/merchant/${id}:`, error.message);
      console.error('❌ [MerchantsController] Error Stack:', error.stack);
      if (error.response) {
          console.error('❌ [MerchantsController] Payment Service Error Response:', error.response.status, error.response.data);
      }
      return {
        success: true,
        data: {
          totalRevenue: 0,
          totalOrders: 0,
          successRate: 0,
          avgOrderValue: 0,
        },
      };
    }
  }

  @Get("users/:id/actions")
  @ApiOperation({ summary: "Get merchant specific actions/audit logs" })
  async getMerchantActions(@Param("id") id: string) {
    // Placeholder: Fetch from audit logs or local history
    return {
      success: true,
      actions: [], // Return empty array for now
    };
  }

  @Delete("users/:id")
  @ApiOperation({ summary: "Delete merchant (Super Admin)" })
  async deleteMerchant(
    @Param("id") id: string,
    @Headers("x-user-id") userId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType: string,
    @Headers("user-agent") userAgent: string,
    @Ip() ipAddress: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    await this.prisma.merchant.update({
      where: { id },
      data: { 
        deletedAt: new Date(),
        isActive: false 
      },
    });

    return {
      success: true,
      message: "Merchant deleted successfully",
    };
  }

  @Get("internal/organizations/:id/count")
  @ApiOperation({ summary: "Get merchant count for organization (Internal)" })
  async getOrganizationMerchantCount(@Param("id") id: string) {
    const count = await this.prisma.merchant.count({
      where: { organizationId: id, isActive: true },
    });
    return { count };
  }

  @Get("categories-distribution")
  @ApiOperation({ summary: "Get merchant distribution by business category" })
  async getCategoriesDistribution() {
    const merchants = await this.prisma.merchant.findMany({
      where: { 
        isActive: true, 
        deletedAt: null, 
        isPlatform: false 
      },
      include: {
        category: true
      }
    });

    const categoryCounts: Record<string, number> = {};
    let total = 0;

    merchants.forEach((m) => {
      const categoryName = m.category?.name || "Uncategorized";
      categoryCounts[categoryName] = (categoryCounts[categoryName] || 0) + 1;
      total++;
    });

    const data = Object.entries(categoryCounts).map(([name, count]) => ({
      name,
      value: count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0
    }));

    // Sort by value descending
    data.sort((a, b) => b.value - a.value);

    return {
      success: true,
      total,
      data
    };
  }

  @Patch("users/:id/limits")
  @ApiOperation({ summary: "Update merchant processing limits" })
  async updateMerchantLimits(
    @Param("id") id: string,
    @Body() body: { dailyLimit?: number, monthlyLimit?: number },
    @Headers("x-user-id") userId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType: string,
    @Headers("user-agent") userAgent: string,
    @Ip() ipAddress: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const config = await this.prisma.merchantConfig.upsert({
      where: { merchantId: id },
      update: {
        ...(body.dailyLimit !== undefined && { dailyMaxAmount: body.dailyLimit }),
        ...(body.monthlyLimit !== undefined && { monthlyMaxAmount: body.monthlyLimit }),
      },
      create: {
        merchantId: id,
        dailyMaxAmount: body.dailyLimit || 100000,
        monthlyMaxAmount: body.monthlyLimit || 1000000,
        dailyMaxTxnCount: 1000,
        dailyMinAmount: 0,
        dailyMinTxnCount: 0,
        monthlyMinAmount: 0,
        openTime: "00:00",
        closeTime: "23:59",
      }
    });

    await this.logAuditActivity("LIMIT_CHANGE", id, userId, organizationId, userType, ipAddress, userAgent, { newLimits: { dailyLimit: body.dailyLimit, monthlyLimit: body.monthlyLimit } });

    return {
      success: true,
      message: "Limits updated successfully",
      config
    };
  }

  @Patch("users/:id/providers/:providerId/disconnect")
  @ApiOperation({ summary: "Disconnect a merchant payment provider" })
  async disconnectProvider(
    @Param("id") id: string,
    @Param("providerId") providerId: string,
    @Headers("x-user-id") userId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType: string,
    @Headers("user-agent") userAgent: string,
    @Ip() ipAddress: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    await this.prisma.merchantProvider.update({
      where: { 
        id: providerId,
        merchantId: id
      },
      data: {
        status: 'EXPIRED'
      }
    });

    await this.logAuditActivity("PROVIDER_DISCONNECTED", id, userId, organizationId, userType, ipAddress, userAgent, { providerId, type: "PROVIDER_DISCONNECT" });

    return {
      success: true,
      message: "Provider disconnected successfully"
    };
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Logger,
  UseGuards,
  Ip,
} from "@nestjs/common";
import { logAuditActivity } from "../../utils/audit.util";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";
import { MerchantService } from "./merchant.service";
import { InternalAuthGuard } from "../../guards/internal-auth.guard";

@ApiTags("Merchants")
@Controller("merchant")
export class MerchantController {
  private readonly logger = new Logger(MerchantController.name);

  constructor(private readonly merchantService: MerchantService) {}

  @Post("internal/batch")
  @UseGuards(InternalAuthGuard)
  @ApiOperation({ summary: "Internal: Get merchants in batch by IDs" })
  @ApiResponse({ status: 200, description: "Merchants retrieved successfully" })
  async getMerchantsBatch(@Body() body: { merchantIds: string[] }) {
    if (!body.merchantIds || !body.merchantIds.length) {
      return { success: true, data: [] };
    }
    const merchants = await this.merchantService['prisma'].merchant.findMany({
      where: { id: { in: body.merchantIds } },
      select: { id: true, name: true }
    });
    return { success: true, data: merchants };
  }

  @Get("list")
  @ApiOperation({ summary: "Get all merchants for the current organization" })
  @ApiResponse({ status: 200, description: "Merchants retrieved successfully" })
  async getMerchantList(@Headers("x-organization-id") organizationId?: string) {
    this.logger.debug(
      `GET /merchant/list x-organization-id: ${organizationId ?? "(missing)"}`,
    );
    if (!organizationId) {
      return {
        success: true,
        merchants: [],
        message: "Select an organization to view merchants.",
      };
    }
    try {
      const result =
        await this.merchantService.getMerchantsByOrganization(organizationId);
      const merchants = result?.merchants ?? [];
      return {
        success: true,
        merchants,
        message: merchants.length
          ? `Found ${merchants.length} merchants`
          : "No merchants found. Create your first merchant to get started.",
      };
    } catch (error) {
      return {
        success: false,
        merchants: [],
        error: "Failed to fetch merchants",
      };
    }
  }

  @Get("dev-check-gpay")
  async devCheckGpay() {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    const providers = await prisma.merchantProvider.findMany({ where: { providerType: 'GPAY' }});
    return providers;
  }

  @Get("connectors")
  @ApiOperation({ summary: "Get available payment connectors" })
  @ApiResponse({
    status: 200,
    description: "Connectors retrieved successfully",
  })
  async getConnectors(@Headers("x-organization-id") organizationId?: string) {
    try {
      const merchants = organizationId
        ? ((
            await this.merchantService.getMerchantsByOrganization(
              organizationId,
            )
          )?.merchants ?? [])
        : [];

      const allConnectors: any[] = [];
      type MerchantWithProviders = (typeof merchants)[number] & {
        providers?: Array<{
          id: string;
          isActive: boolean;
          providerType?: string;
          accountIdentifier?: string;
          metadata?: any;
          credentials?: any;
          updatedAt?: Date;
        }>;
      };
      for (const merchant of merchants as MerchantWithProviders[]) {
        if (!merchant.isActive) continue; // Skip inactive merchants
        if (merchant.providers && merchant.providers.length > 0) {
          for (const provider of merchant.providers) {
            if (provider.isActive) {
              const metadata = (provider.metadata as any) || {};
              const credentials = (provider.credentials as any) || {};
              const extractedMerchantName =
                merchant.businessName ||
                merchant.name ||
                metadata?.merchantName ||
                metadata?.storeName ||
                credentials?.merchantName ||
                credentials?.storeName ||
                null;

              const upiFromMeta =
                metadata?.upiId ||
                credentials?.merchantUpiId ||
                credentials?.upiId ||
                null;
              const effectiveUpi =
                upiFromMeta && upiFromMeta !== "Not configured"
                  ? upiFromMeta
                  : provider.accountIdentifier || "Not configured";

              allConnectors.push({
                id: provider.id,
                providerCode: provider.providerType?.toLowerCase(),
                providerType: provider.providerType,
                displayName: (
                  extractedMerchantName || `${provider.providerType} Account`
                )
                  .replace(/Dashboard for transactions on QR\s*/i, "")
                  .replace(/MID:.*$/i, "")
                  .trim(),
                merchantName: extractedMerchantName
                  ? extractedMerchantName
                      .replace(/Dashboard for transactions on QR\s*/i, "")
                      .replace(/MID:.*$/i, "")
                      .trim()
                  : null,
                upiId: effectiveUpi,
                isActive: provider.isActive,
                merchantId: merchant.id,
                lastSync: provider.lastSyncedAt || provider.updatedAt,
              });
            }
          }
        }
      }

      // If no connectors found, return fallback static list
      if (allConnectors.length === 0) {
        return {
          success: true,
          connectors: [
            {
              id: "phonepe",
              providerCode: "phonepe",
              name: "PhonePe",
              type: "UPI",
              isActive: true,
              logo: "/gateways/PhonePe.png",
            },
            {
              id: "paytm",
              providerCode: "paytm",
              name: "Paytm",
              type: "UPI",
              isActive: true,
              logo: "/gateways/paytm.png",
            },
          ],
          message: "No connected providers found. Showing available gateways.",
        };
      }

      return {
        success: true,
        connectors: allConnectors,
        total: allConnectors.length,
      };
    } catch (error) {
      console.error("Error fetching connectors:", error);
      // Fallback to static list on error
      return {
        success: true,
        connectors: [
          {
            id: "phonepe",
            providerCode: "phonepe",
            name: "PhonePe",
            type: "UPI",
            isActive: true,
            logo: "/gateways/PhonePe.png",
          },
        ],
      };
    }
  }

  // Merchants endpoint (plural)
  @Get("merchants")
  @ApiOperation({ summary: "Get all merchants" })
  @ApiResponse({ status: 200, description: "Merchants retrieved successfully" })
  async getMerchants() {
    return {
      success: true,
      merchants: [],
      message: "No merchants found. Please select an organization first.",
    };
  }

  @Post("organizations/:organizationId/merchants")
  @ApiOperation({ summary: "Create a new merchant" })
  @ApiResponse({ status: 201, description: "Merchant created successfully" })
  async createMerchant(
    @Param("organizationId") organizationId: string,
    @Body()
    createMerchantDto: {
      name: string;
      businessName?: string;
      categoryId?: string;
      email?: string;
      phone?: string;
      address?: string;
      city?: string;
      state?: string;
      pincode?: string;
      status?: string;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const isSuperAdmin = userType === 'superadmin' || userType === 'SUPER_ADMIN';
    const merchant = await this.merchantService.createMerchant({
      organizationId,
      ...createMerchantDto,
      isSuperAdmin,
    });

    if (userId) {
      await logAuditActivity(
        "MERCHANT_CREATED",
        merchant.merchant.id,
        "MERCHANT",
        userId,
        userType || "USER",
        organizationId,
        ipAddress,
        userAgent,
        { merchantName: createMerchantDto.name }
      );
    }

    return merchant;
  }

  @Get("organization/:organizationId")
  @ApiOperation({ summary: "Get all merchants for an organization" })
  @ApiResponse({ status: 200, description: "Merchants retrieved successfully" })
  @ApiParam({ name: "organizationId", description: "Organization ID" })
  async getMerchantsByOrganization(
    @Param("organizationId") organizationId: string,
  ) {
    return this.merchantService.getMerchantsByOrganization(organizationId);
  }

  @Get("profile")
  @ApiOperation({ summary: "Get current merchant profile" })
  @ApiResponse({
    status: 200,
    description: "Merchant profile retrieved successfully",
  })
  async getProfile(@Headers("x-organization-id") organizationId: string) {
    // If no header, we can't contextually resolve (unless user token has it, but lets try header first)
    if (!organizationId) {
      // Fallback: try to see if it's passed in query (not typical) or return error
      return {
        success: false,
        message: "Organization context missing",
        merchant: null,
      };
    }

    const result =
      await this.merchantService.getMerchantsByOrganization(organizationId);
    if (result.success && result.merchants.length > 0) {
      // Return the first merchant (User usually has 1 business per org context in this app)
      return { success: true, merchant: result.merchants[0] };
    }

    return {
      success: false,
      message: "No merchant profile found",
      merchant: null,
    };
  }

  @Get(":merchantId")
  @ApiOperation({ summary: "Get merchant details" })
  @ApiResponse({ status: 200, description: "Merchant retrieved successfully" })
  @ApiResponse({ status: 404, description: "Merchant not found" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchant(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("includeDeleted") includeDeleted?: string,
  ) {
    return this.merchantService.getMerchant(
      merchantId,
      organizationId,
      includeDeleted === "true",
    );
  }

  @Put(":merchantId/configure")
  @ApiOperation({
    summary: "Configure merchant business settings",
    description:
      "Set daily/monthly limits, operating hours, and merchant details",
  })
  @ApiResponse({ status: 200, description: "Merchant configured successfully" })
  @ApiResponse({ status: 404, description: "Merchant not found" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async configureMerchant(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body()
    config: {
      name?: string;
      businessName?: string;
      email?: string;
      phone?: string;
      categoryId?: string;
      address?: string;
      city?: string;
      state?: string;
      pincode?: string;
      gstin?: string;
      pan?: string;
      openTime: string;
      closeTime: string;
      dailyMaxAmount: number;
      dailyMaxTxnCount: number;
      dailyMinAmount?: number;
      dailyMinTxnCount?: number;
      monthlyMaxAmount: number;
      monthlyMaxTxnCount?: number;
      monthlyMinAmount?: number;
      monthlyMinTxnCount?: number;
      minTxnAmount?: number;
      maxTxnAmount?: number;
      perMinuteMaxTxn?: number;
      isFallback?: boolean;
      operatingSlots?: Array<{ open: string; close: string }>;
      weeklyHolidays?: number[];
    },
    @Headers("x-user-id") userId?: string,
    @Headers("x-user-type") userType?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.merchantService.configureMerchant(merchantId, organizationId, config);
    if (userId) {
      await logAuditActivity(
        "MERCHANT_UPDATED",
        merchantId,
        "MERCHANT",
        userId,
        userType || "USER",
        organizationId,
        ipAddress,
        userAgent,
        { merchantName: config.name || config.businessName || merchantId }
      );
    }
    return result;
  }

  @Get(":merchantId/profile")
  @ApiOperation({
    summary: "Get merchant profile details",
    description: "Get complete merchant profile with all details",
  })
  @ApiResponse({
    status: 200,
    description: "Merchant profile retrieved successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchantProfile(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    return this.merchantService.getMerchant(merchantId, organizationId);
  }

  @Get(":merchantId/providers")
  @ApiOperation({
    summary: "Get merchant payment providers",
    description: "Get all connected payment providers for a merchant",
  })
  @ApiResponse({
    status: 200,
    description: "Providers retrieved successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchantProviders(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    return this.merchantService.getMerchantProviders(merchantId, organizationId);
  }

  @Get(":merchantId/connectors")
  @ApiOperation({
    summary: "Get merchant connectors (legacy endpoint)",
    description:
      "Get all connected payment connectors for a merchant - legacy format",
  })
  @ApiResponse({
    status: 200,
    description: "Connectors retrieved successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchantConnectors(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    return this.merchantService.getMerchantConnectors(merchantId, organizationId);
  }

  @Get(":merchantId/stats")
  @ApiOperation({
    summary: "Get merchant statistics and usage",
    description: "Get merchant stats including limits and current usage",
  })
  @ApiResponse({
    status: 200,
    description: "Merchant stats retrieved successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchantStats(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    return this.merchantService.getMerchantStats(merchantId, organizationId);
  }

  @Post(":merchantId/validate-transaction")
  @ApiOperation({
    summary: "Validate merchant for transaction processing",
    description:
      "Check if merchant can process a transaction (status, limits, operating hours)",
  })
  @ApiResponse({ status: 200, description: "Validation result" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async validateTransaction(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body() body: { amount: number; bypass?: boolean },
  ) {
    return this.merchantService.validateMerchantForTransaction(
      merchantId,
      organizationId,
      body.amount,
      body.bypass,
    );
  }

  @Post(":merchantId/update-usage")
  @ApiOperation({
    summary: "Update merchant usage and check for limit exhaustion",
    description:
      "Update daily/monthly usage and auto-block merchant if limits exceeded",
  })
  @ApiResponse({ status: 200, description: "Usage updated successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async updateUsage(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body() body: { amount: number },
  ) {
    return this.merchantService.updateUsageAndCheckLimits(
      merchantId,
      organizationId,
      body.amount,
    );
  }

  @Get(":merchantId/can-generate-qr")
  @ApiOperation({
    summary: "Check if merchant can generate QR codes and payment links",
    description: "Validate merchant status for payment asset generation",
  })
  @ApiResponse({ status: 200, description: "QR generation validation result" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async canGenerateQR(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("bypass") bypass?: string,
  ) {
    return this.merchantService.canGeneratePaymentAssets(
      merchantId,
      organizationId,
      bypass === "true",
    );
  }

  @Post(":merchantId/verify")
  @ApiOperation({
    summary: "Verify merchant after provider connection",
    description:
      "Mark merchant as verified and active after successful provider setup",
  })
  @ApiResponse({ status: 200, description: "Merchant verified successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async verifyMerchant(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body()
    verificationData: {
      mobile?: string;
      otp?: string;
      providerConnected?: boolean;
    },
  ) {
    return this.merchantService.verifyMerchant(merchantId, organizationId, verificationData);
  }

  @Delete(":merchantId")
  @ApiOperation({
    summary: "Delete merchant and all related data",
    description:
      "Soft-delete merchant (sets deletedAt, deactivates). Providers and config are retained for audit. Orders and transactions in payment-service are unaffected.",
  })
  @ApiResponse({ status: 200, description: "Merchant deleted successfully" })
  @ApiResponse({ status: 404, description: "Merchant not found" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async deleteMerchant(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.merchantService.deleteMerchant(merchantId, organizationId);
    if (userId) {
      await logAuditActivity(
        "MERCHANT_DELETED",
        merchantId,
        "MERCHANT",
        userId,
        userType || "USER",
        organizationId,
        ipAddress,
        userAgent,
        `Deleted merchant: ${result.deletedData?.merchant || merchantId}`
      );
    }
    return result;
  }

  @Patch(":merchantId/status")
  @ApiOperation({
    summary: "Update merchant active status",
    description: "Enable or disable a merchant for the organization",
  })
  @ApiResponse({ status: 200, description: "Merchant status updated successfully" })
  @ApiResponse({ status: 404, description: "Merchant not found" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async updateMerchantStatus(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body() body: { isActive: boolean; reason?: string },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.merchantService.updateMerchantActiveStatus(
      merchantId,
      organizationId,
      body?.isActive,
      body?.reason,
    );

    if (userId) {
      await logAuditActivity(
        body?.isActive ? "MERCHANT_ACTIVATED" : "MERCHANT_DEACTIVATED",
        merchantId,
        "MERCHANT",
        userId,
        userType || "USER",
        organizationId,
        ipAddress,
        userAgent,
        { reason: body?.reason }
      );
    }

    return result;
  }

  @Post(":merchantId/credentials")
  @UseGuards(InternalAuthGuard)
  @ApiOperation({
    summary: "Get merchant provider credentials (Internal)",
    description:
      "Get credentials for a specific provider type. Internal use only.",
  })
  @ApiResponse({
    status: 200,
    description: "Credentials retrieved successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getMerchantCredentials(
    @Param("merchantId") merchantId: string,
    @Body() body: { providerType?: string },
  ) {
    return this.merchantService.getMerchantProviderCredentials(
      merchantId,
      body.providerType,
    );
  }
}

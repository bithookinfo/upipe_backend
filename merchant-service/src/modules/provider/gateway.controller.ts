import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  Logger,
  BadRequestException,
  UnauthorizedException,
  Headers,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../guards/jwt-auth.guard";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
} from "@nestjs/swagger";
import { ProviderConnectionService } from "./provider-connection.service";
import { PrismaService } from "../../prisma/prisma.service";
import { GpayService } from "../gpay/gpay.service";
import { TransactionService } from "../transaction/transaction.service";
import { PhonePeSimpleService } from "./phonepe-simple.service";

import { MerchantService } from "../merchant/merchant.service";

@ApiTags("Gateway")
@Controller("gateway")
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);
  private availableGatewaysCache:
    | { expiresAt: number; payload: { data: any[] } }
    | null = null;

  constructor(
    private readonly providerService: ProviderConnectionService,
    private readonly prisma: PrismaService,
    private readonly gpayService: GpayService,
    private readonly transactionService: TransactionService,
    private readonly phonepeSimpleService: PhonePeSimpleService,
    private readonly merchantService: MerchantService,
  ) { }

  @Get("gpay/metrics")
  @ApiOperation({
    summary: "Get internal GPay memory and browser metrics",
    description: "Internal debug endpoint for GPay resource leaks",
  })
  @UseGuards(JwtAuthGuard)
  async getGpayMetrics(@Req() req: any) {
    const userRole = req.user?.role || req.user?.type || "";
    const isSuperAdmin =
      userRole.toUpperCase() === "SUPERADMIN" ||
      userRole.toUpperCase() === "SUPER_ADMIN" ||
      userRole.toUpperCase() === "ADMIN";

    if (!isSuperAdmin) {
      this.logger.warn(`Unauthorized access attempt to /gpay/metrics by user: ${req.user?.id || 'unknown'}`);
      throw new UnauthorizedException("Only administrators can access internal metrics");
    }

    return this.gpayService.getGpayMetrics();
  }

  @Get("available")
  @ApiOperation({
    summary: "Get available payment gateways",
    description: "Get list of supported payment gateways from database",
  })
  @ApiResponse({ status: 200, description: "Available gateways retrieved" })
  async getAvailableGateways() {
    const ttlMs = (() => {
      const raw = process.env.GATEWAY_AVAILABLE_CACHE_TTL_MS;
      const parsed = raw ? Number(raw) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000; // default 10 min
    })();

    const now = Date.now();
    const cache = this.availableGatewaysCache;
    if (cache && cache.expiresAt > now) {
      return cache.payload;
    }

    this.logger.log("📋 Getting available gateways from database");

    try {
      // Fetch from database
      const gateways = await this.prisma.paymentGateway.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      const payload = {
        data: gateways.map((g) => ({
          id: g.id,
          code: g.code,
          name: g.name,
          type: g.type,
          provider_type: g.type.toLowerCase(),
          description: g.description,
          supported: true,
          isActive: g.isActive,
          logo: g.logo, // Use logo from DB directly
          metadata: g.metadata,
        })),
      };

      this.availableGatewaysCache = { expiresAt: now + ttlMs, payload };
      return payload;
    } catch (error) {
      this.logger.error("Failed to fetch gateways from DB:", error);
      return { data: [] };
    }
  }

  @Get("connected")
  @ApiOperation({
    summary: "Get connected payment gateways",
    description: "Get list of connected payment gateway accounts",
  })
  @ApiResponse({ status: 200, description: "Connected gateways retrieved" })
  async getConnectedGateways(@Req() req: any) {
    this.logger.log("📋 Getting connected gateways");

    const organizationId = req.headers["x-organization-id"];

    if (!organizationId) {
      this.logger.warn("⚠️ No organization ID in request headers");
      return { data: [] };
    }

    const merchants = await this.prisma.merchant.findMany({
      where: {
        organizationId: organizationId,
        deletedAt: null,
      } as any,
    });

    if (merchants.length === 0) {
      this.logger.warn(
        `⚠️ No merchants found for org ${organizationId}`,
      );
      return { data: [] };
    }

    this.logger.log(
      `📊 Found ${merchants.length} merchants for org ${organizationId}`,
    );

    const allProviders: any[] = [];
    for (const merchant of merchants) {
      const result = await this.providerService.getConnectedProviders(
        merchant.id,
      );
      if (result.providers && result.providers.length > 0) {
        const enrichedProviders = result.providers.map((p: any) => ({
          ...p,
          merchantId: merchant.id,
          merchantName: merchant.name,
        }));
        allProviders.push(...enrichedProviders);
      }
    }

    this.logger.log(`✅ Found ${allProviders.length} total providers`);
    return { data: allProviders };
  }

  @Post(":providerId/send-otp")
  @ApiOperation({
    summary: "Send OTP for provider connection",
    description: "Send OTP to mobile number for provider account connection",
  })
  @ApiParam({
    name: "providerId",
    description: "Provider ID (phonepe, paytm, gpay)",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        phoneNumber: { type: "string", example: "9876543210" },
        merchantId: { type: "string", description: "Optional merchant ID" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "OTP sent successfully" })
  async sendOtp(
    @Param("providerId") providerId: string,
    @Body()
    body: {
      phoneNumber?: string;
      merchantId?: string;
      username?: string;
      password?: string;
      organizationId?: string;
    },
    @Req() req: any,
  ) {
    const userType = req.headers["x-user-type"];
    const isSuperAdmin = userType === "super_admin";

    this.logger.log(`📱 Sending OTP for provider: ${providerId}`);

    if (!body.phoneNumber && body.username && /^[6-9]\d{9}$/.test(body.username)) {
      this.logger.log(`🔄 Using username "${body.username}" as phoneNumber`);
      body.phoneNumber = body.username;
    }

    const providerCode = providerId.toLowerCase();

    // merchantId is optional for send-otp (only needed for verify-otp to save connection)
    switch (providerCode) {
      case "phonepe":
        if (!body.phoneNumber) {
          return { success: false, message: "Phone number is required" };
        }
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required"); // Should enforce it
        }
        return this.providerService.sendPhonePeOtp(
          null,
          body.phoneNumber,
          body.organizationId,
          isSuperAdmin,
        );
      case "paytm":
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.sendPaytmOtp(
          body.username || "",
          body.password || "",
          body.organizationId,
          isSuperAdmin,
        );
      case "bharatpe":
        if (!body.phoneNumber) {
          return { success: false, message: "Phone number is required" };
        }
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.sendBharatPeOtp(
          body.merchantId || null,
          body.phoneNumber,
          body.organizationId,
          isSuperAdmin,
        );
      case "quintus":
      case "quintuspay":
        if (!body.phoneNumber) {
          return { success: false, message: "Phone number is required" };
        }
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.sendQuintusOtp(
          body.merchantId || null,
          body.phoneNumber,
          body.organizationId,
          isSuperAdmin,
        );
      case "hdfc":
        if (!body.phoneNumber) {
          return { success: false, message: "Phone number is required" };
        }
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.sendHdfcOtp(
          body.merchantId || null,
          body.phoneNumber,
          body.organizationId,
          isSuperAdmin,
        );
      default:
        return {
          success: false,
          message: `Provider ${providerCode} not supported for OTP`,
        };
    }
  }

  @Post(":providerId/complete-otp-with-captcha")
  @ApiOperation({
    summary: "Complete OTP send with user-provided captcha token",
    description:
      "Phase 2 of web fallback: user solved hCaptcha in UI, send the token to complete OTP",
  })
  @ApiParam({
    name: "providerId",
    description: "Provider ID (phonepe)",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Web session ID from Phase 1",
        },
        captchaToken: {
          type: "string",
          description: "hCaptcha token solved by user",
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: "OTP sent successfully after captcha",
  })
  async completeOtpWithCaptcha(
    @Param("providerId") providerId: string,
    @Body()
    body: {
      sessionId: string;
      captchaToken: string;
    },
  ) {
    this.logger.log(
      `🔐 Completing OTP with captcha for provider: ${providerId}, session: ${body.sessionId}`,
    );

    if (!body.sessionId || !body.captchaToken) {
      throw new BadRequestException("sessionId and captchaToken are required");
    }

    return this.providerService.completePhonePeOtpWithCaptcha(
      body.sessionId,
      body.captchaToken,
    );
  }

  @Post(":providerId/verify-otp")
  @ApiOperation({
    summary: "Verify OTP and connect provider",
    description: "Verify OTP and connect provider account",
  })
  @ApiParam({ name: "providerId", description: "Provider ID" })
  @ApiResponse({ status: 200, description: "Provider connected successfully" })
  async verifyOtp(
    @Param("providerId") providerId: string,
    @Body()
    body: {
      phoneNumber?: string;
      username?: string;
      otp: string;
      token?: string;
      fingerprint?: string;
      merchantId?: string;
      sessionId?: string;
      deviceId?: string;
      deviceFingerprint?: string;
      mPin?: string;
      method?: string;
      organizationId?: string;
    },
    @Req() req: any,
  ) {
    this.logger.log(`✅ Verifying OTP for provider: ${providerId}`);

    const userType = req.headers["x-user-type"];
    const isSuperAdmin = userType === "super_admin";

    const providerCode = providerId.toLowerCase();
    const merchantId = body.merchantId || "temp-" + Date.now();

    switch (providerCode) {
      case "phonepe":
        if (!body.organizationId) {
          throw new BadRequestException(
            "Organization ID is required. Please ensure you are logged in and have selected an organization.",
          );
        }
        return this.providerService.connectPhonePe(merchantId, {
          phoneNumber: body.phoneNumber || "",
          otp: body.otp,
          otpToken: body.token || "",
          deviceFingerprint: body.deviceFingerprint || "",
          fingerprint: body.fingerprint,
          sessionId: body.sessionId,
          method: body.method,
          organizationId: body.organizationId,
          isSuperAdmin,
        });
      case "paytm":
        if (!body.organizationId) {
          throw new BadRequestException(
            "Organization ID is required. Please ensure you are logged in and have selected an organization.",
          );
        }
        return this.providerService.connectPaytm(merchantId, {
          username: body.username?.trim() || "",
          password: "",
          otp: body.otp,
          sessionId: body.sessionId || "",
          organizationId: body.organizationId,
        });
      case "bharatpe":
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        // Note: BharatPe requires tokens and uuid from sendOtp
        // @ts-ignore - Extended body params for BharatPe
        return this.providerService.connectBharatPe(merchantId, {
          phoneNumber: body.phoneNumber || "",
          otp: body.otp,
          uuid: (body as any).uuid || "",
          tokens: (body as any).tokens || {},
          organizationId: body.organizationId,
        });
      case "quintus":
      case "quintuspay":
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.connectQuintus(merchantId, {
          phoneNumber: body.phoneNumber || "",
          otp: body.otp,
          organizationId: body.organizationId,
        });
      case "hdfc":
        if (!body.organizationId) {
          throw new BadRequestException("Organization ID is required");
        }
        return this.providerService.connectHdfc(merchantId, {
          phoneNumber: body.phoneNumber || "",
          otp: body.otp,
          mPin: body.mPin,
          sessionId: body.sessionId || "",
          deviceId: body.deviceId || body.deviceFingerprint || "",
          organizationId: body.organizationId,
        });
      default:
        return {
          success: false,
          message: `Provider ${providerCode} not supported`,
        };
    }
  }

  @Post("phonepe/select-group")
  @ApiOperation({
    summary: "Select PhonePe merchant group",
    description: "Complete PhonePe onboarding by selecting merchant group",
  })
  @ApiResponse({ status: 200, description: "Group selected successfully" })
  async selectPhonePeGroup(
    @Body()
    body: {
      groupId: number;
      phoneNumber: string;
      accountData: any;
      merchantId?: string;
      organizationId?: string;
    },
    @Req() req: any,
  ) {
    const userType = req.headers["x-user-type"];
    const isSuperAdmin = userType === "super_admin";

    this.logger.log(`🏪 Selecting PhonePe group: ${body.groupId}`);
    this.logger.debug(`Select Group Body: ${JSON.stringify(body)}`);

    if (!body.organizationId) {
      throw new BadRequestException("Organization ID is required.");
    }

    const merchantId = body.merchantId || "temp-" + Date.now();

    // Call service to connect with selected group
    return this.providerService.connectPhonePeWithGroup(merchantId, {
      phoneNumber: body.phoneNumber,
      accountData: {
        ...body.accountData,
        groupId: body.groupId, // Ensure selected group is in account data
      },
      organizationId: body.organizationId,
      isSuperAdmin,
    });
  }

  @Post("phonepe/save-connection")
  @ApiOperation({
    summary: "Save PhonePe connection from direct browser auth",
    description:
      "Save PhonePe connection details after successful OTP verification in browser",
  })
  @ApiResponse({ status: 200, description: "Connection saved successfully" })
  async savePhonePeConnection(
    @Body()
    body: {
      phoneNumber: string;
      accountDetails: any;
      organizationId: string;
      merchantId?: string;
    },
    @Req() req: any,
  ) {
    const userType = req.headers["x-user-type"];
    const isSuperAdmin = userType === "super_admin";

    this.logger.log(`💾 Saving PhonePe connection for: ${body.phoneNumber}`);
    this.logger.debug(`Save Connection Body: ${JSON.stringify(body, null, 2)}`);

    if (!body.organizationId) {
      throw new BadRequestException("Organization ID is required.");
    }

    const merchantId = body.merchantId || "temp-" + Date.now();

    // Call service to save the connection
    return this.providerService.connectPhonePeWithGroup(merchantId, {
      phoneNumber: body.phoneNumber,
      accountData: body.accountDetails,
      organizationId: body.organizationId,
      isSuperAdmin,
    });
  }

  @Post(":providerId/connect-gpay")
  @ApiOperation({
    summary: "Connect GPay account",
    description:
      "Connect GPay For Business. User must verify with Google (incl. 'Confirm it's you' on phone) before this step.",
  })
  @ApiParam({ name: "providerId", description: "Provider ID (gpay)" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["username", "organizationId"],
      properties: {
        username: { type: "string", description: "Gmail for GPay" },
        password: { type: "string" },
        displayName: { type: "string" },
        organizationId: { type: "string" },
        merchantId: { type: "string" },
        businessId: {
          type: "string",
          description:
            "Optional. GPay business ID (e.g. BCR2DN5T5DT2LRA6) for reconnect - use activity URL when known",
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: "GPay connected successfully" })
  async connectGPay(
    @Param("providerId") providerId: string,
    @Body()
    body: {
      username: string;
      password?: string;
      displayName?: string;
      organizationId?: string;
      merchantId?: string;
      sessionId?: string;
      businessId?: string;
      upiId?: string;
      recoveryPhoneNumber?: string;
      googleVerificationCode?: string;
    },
  ) {
    if (body.username && body.organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.username, "GPAY", body.organizationId);
    }
    this.logger.log(`🟢 Connecting GPay for: ${body.username} (UPI: ${body.upiId || 'not provided'})`);

    if (providerId.toLowerCase() !== "gpay") {
      throw new BadRequestException(
        "connect-gpay is only supported for GPay provider",
      );
    }

    const merchantId = body.merchantId || "temp-" + Date.now();
    return this.gpayService.connectGPay(merchantId, {
      email: body.username,
      password: body.password,
      organizationId: body.organizationId,
      sessionId: body.sessionId,
      businessId: body.businessId,
      upiId: body.upiId,
      recoveryPhoneNumber: body.recoveryPhoneNumber,
      googleVerificationCode: body.googleVerificationCode,
    });
  }

  @Post(":providerId/update-gpay-upi")
  @ApiOperation({
    summary: "Update GPay UPI ID",
    description: "Save the merchant's GPay UPI ID (e.g. yourname@gpay)",
  })
  @ApiParam({ name: "providerId", description: "Provider ID (gpay)" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["upiId", "organizationId"],
      properties: {
        upiId: { type: "string", example: "yourname@gpay" },
        organizationId: { type: "string" },
        email: { type: "string", description: "Gmail used for connect" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "UPI ID saved successfully" })
  async updateGpayUpi(
    @Param("providerId") providerId: string,
    @Body()
    body: {
      upiId: string;
      organizationId: string;
      email?: string;
    },
  ) {
    if (providerId.toLowerCase() !== "gpay") {
      throw new BadRequestException(
        "update-gpay-upi is only supported for GPay provider",
      );
    }
    return this.gpayService.updateGpayUpi(body);
  }

  @Post(":providerId/sync-transactions")
  @ApiOperation({
    summary: "Sync transactions for a specific provider",
    description: "Force immediate transaction synchronization from the payment provider",
  })
  @ApiParam({ name: "providerId", description: "Provider ID (e.g., gpay, paytm)" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["merchantId"],
      properties: {
        merchantId: { type: "string" },
        fromDate: { type: "string", format: "date-time" },
        toDate: { type: "string", format: "date-time" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "Sync triggered successfully" })
  async syncProviderTransactions(
    @Param("providerId") providerId: string,
    @Headers("x-organization-id") organizationId: string,
    @Body()
    body: {
      merchantId: string;
      fromDate?: string;
      toDate?: string;
    },
  ) {
    this.logger.log(`🔄 Manual sync triggered for provider: ${providerId}, merchant: ${body.merchantId}`);

    if (!body.merchantId) {
      throw new BadRequestException("merchantId is required for sync");
    }

    const from = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = body.toDate ? new Date(body.toDate) : new Date();

    return this.transactionService.syncTransactions(
      body.merchantId,
      organizationId,
      from,
      to,
      providerId.toUpperCase(),
    );
  }

  @Post("providers")
  @ApiOperation({
    summary: "Create new payment provider",
    description: "Super admin only - Add a new payment provider to the system",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["code", "name", "type"],
      properties: {
        code: { type: "string", example: "razorpay" },
        name: { type: "string", example: "Razorpay" },
        type: { type: "string", example: "CARD" },
        description: { type: "string", example: "Accept card payments" },
        logo: { type: "string", example: "/gateways/razorpay.svg" },
        metadata: { type: "object", example: {} },
      },
    },
  })
  @ApiResponse({ status: 201, description: "Provider created successfully" })
  async createProvider(
    @Body()
    body: {
      code: string;
      name: string;
      type: string;
      description?: string;
      logo?: string;
      metadata?: any;
    },
  ) {
    this.logger.log(`➕ Creating new provider: ${body.name}`);

    try {
      const provider = await this.prisma.paymentGateway.create({
        data: {
          id: body.code.toLowerCase(),
          code: body.code.toLowerCase(),
          name: body.name,
          type: body.type,
          description: body.description || null,
          logo: body.logo || null,
          isActive: true,
          sortOrder: 999,
          metadata: body.metadata || null,
        },
      });

      return {
        success: true,
        data: provider,
        message: "Provider created successfully",
      };
    } catch (error) {
      this.logger.error("Failed to create provider:", error);
      throw new BadRequestException(
        "Failed to create provider. Code might already exist.",
      );
    }
  }

  @Post("providers/:id")
  @ApiOperation({
    summary: "Update payment provider",
    description: "Super admin only - Update existing payment provider",
  })
  @ApiParam({ name: "id", description: "Provider ID" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        logo: { type: "string" },
        isActive: { type: "boolean" },
        metadata: { type: "object" },
      },
    },
  })
  @ApiResponse({ status: 200, description: "Provider updated successfully" })
  async updateProvider(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      logo?: string;
      isActive?: boolean;
      metadata?: any;
    },
  ) {
    this.logger.log(`✏️ Updating provider: ${id}`);

    try {
      const updateData: any = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.description !== undefined)
        updateData.description = body.description;
      if (body.logo !== undefined) updateData.logo = body.logo;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;
      if (body.metadata !== undefined) updateData.metadata = body.metadata;

      const provider = await this.prisma.paymentGateway.update({
        where: { id },
        data: updateData,
      });

      return {
        success: true,
        data: provider,
        message: "Provider updated successfully",
      };
    } catch (error) {
      this.logger.error("Failed to update provider:", error);
      throw new BadRequestException("Failed to update provider");
    }
  }
}

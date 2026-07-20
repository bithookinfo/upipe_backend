import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MerchantStatus } from "@prisma/client";

@Injectable()
export class MerchantService {
  private readonly logger = new Logger(MerchantService.name);

  constructor(private readonly prisma: PrismaService) {}

  private cleanName(name: string) {
    if (!name) return name;
    return name
      .replace(/Dashboard for transactions on QR\s*/i, "")
      .replace(/MID:.*$/i, "")
      .trim();
  }

  async getAllMerchants() {
    try {
      const merchants = await this.prisma.merchant.findMany({
        where: { deletedAt: null },
        include: {
          config: true,
          category: true,
          providers: true,
        },
        orderBy: { createdAt: "desc" },
      });

      this.logger.log(`✅ Found ${merchants.length} merchants`);

      const cleanedMerchants = merchants.map((m) => ({
        ...m,
        name: this.cleanName(m.name),
        businessName: m.businessName
          ? this.cleanName(m.businessName)
          : m.businessName,
      }));

      return cleanedMerchants;
    } catch (error) {
      this.logger.error(`❌ Failed to fetch all merchants:`, error);
      throw new InternalServerErrorException("Failed to fetch merchants");
    }
  }

  async createMerchant(data: {
    organizationId: string;
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
    isSuperAdmin?: boolean;
  }) {
    try {
      this.logger.log(
        `Creating merchant: ${data.name} for org: ${data.organizationId}`,
      );

      // Check if there are available subscription slots
      await this.checkSubscriptionSlotAvailable(data.organizationId);

      const merchant = await this.prisma.merchant.create({
        data: {
          organizationId: data.organizationId,
          name: data.name,
          businessName: data.businessName,
          categoryId: data.categoryId,
          email: data.email,
          phone: data.phone,
          address: data.address,
          city: data.city,
          state: data.state,
          pincode: data.pincode,
          status: (data.status as MerchantStatus) || MerchantStatus.PENDING,
          isPlatform: !!data.isSuperAdmin,
        },
      });

      // Assign a subscription slot to this merchant
      await this.assignSubscriptionSlot(
        data.organizationId,
        merchant.id,
      ).catch((err) => {
        this.logger.warn(`Failed to assign subscription slot: ${err.message}`);
      });

      this.logger.log(
        `✅ Merchant created: ${merchant.id} with status: ${merchant.status}`,
      );
      return {
        success: true,
        merchant,
        message: "Merchant created successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create merchant:`, error);
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException("Failed to create merchant");
    }
  }

  private async checkSubscriptionSlotAvailable(organizationId: string) {
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      const response = await axios.get(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/can-connect`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );

      if (response.data && !response.data.allowed) {
        throw new BadRequestException(
          response.data.message || "No available subscription slots. Please purchase a plan to connect more merchants.",
        );
      }

      return true;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;

      this.logger.error(
        `Failed to check subscription slots: ${error.message}`,
      );
      if (error.response?.data?.message) {
        throw new BadRequestException(error.response.data.message);
      }
      if (error.response?.status === 400 || error.response?.status === 403) {
        throw new BadRequestException(
          error.response?.data?.message ||
            "Subscription slot validation failed",
        );
      }
    }
  }

  private async assignSubscriptionSlot(
    organizationId: string,
    merchantId: string,
  ) {
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      await axios.post(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/assign-slot`,
        { merchantId }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );
    } catch (error) {
      this.logger.warn(
        `Failed to assign subscription slot: ${error.message}`,
      );
    }
  }

  private async unassignSubscriptionSlot(
    organizationId: string,
    merchantId: string,
  ) {
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      await axios.post(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/unassign-slot`,
        { merchantId }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );
      this.logger.log(`♻️ Freed subscription slot for merchant ${merchantId}`);
    } catch (error) {
      this.logger.error(
        `Failed to update subscription usage: ${error.message}`,
      );
    }
  }

  async getMerchantsByOrganization(organizationId: string) {
    try {
      const merchants = await this.prisma.merchant.findMany({
        where: { 
          organizationId, 
          deletedAt: null,
          isPlatform: false
        },
        include: {
          config: true,
          category: true,
          providers: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const cleanedMerchants = merchants.map((m) => ({
        ...m,
        name: this.cleanName(m.name),
        businessName: m.businessName
          ? this.cleanName(m.businessName)
          : m.businessName,
      }));

      return {
        success: true,
        merchants: cleanedMerchants,
        total: merchants.length,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get merchants for org ${organizationId}:`,
        error,
      );
      throw new InternalServerErrorException("Failed to retrieve merchants");
    }
  }

  async getMerchant(merchantId: string, organizationId: string, includeDeleted = false) {
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          config: true,
          category: true,
          providers: true,
        },
      });

      if (!merchant || (!includeDeleted && merchant.deletedAt)) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      return {
        success: true,
        merchant: {
          ...merchant,
          name: this.cleanName(merchant.name),
          businessName: merchant.businessName
            ? this.cleanName(merchant.businessName)
            : merchant.businessName,
          isDeleted: !!merchant.deletedAt,
        },
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`❌ Failed to get merchant ${merchantId}:`, error);
      throw new InternalServerErrorException("Failed to retrieve merchant");
    }
  }

  async updateMerchantActiveStatus(
    merchantId: string,
    organizationId: string,
    isActive: boolean,
    reason?: string,
  ) {
    if (typeof isActive !== "boolean") {
      throw new BadRequestException("isActive must be a boolean");
    }

    try {
      // Ensure merchant belongs to organization
      const merchantExists = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
      });
      if (!merchantExists) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      const updated = await this.prisma.merchant.update({
        where: { id: merchantId },
        data: {
          isActive,
          statusReason: isActive ? null : reason ?? null,
        },
        include: {
          config: true,
          category: true,
          providers: true,
        },
      });

      return {
        success: true,
        merchant: {
          ...updated,
          name: this.cleanName(updated.name),
          businessName: updated.businessName
            ? this.cleanName(updated.businessName)
            : updated.businessName,
        },
        message: `Merchant is now ${isActive ? "Active" : "Inactive"}`,
      };
    } catch (error) {
      if (error?.code === "P2025") {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }
      this.logger.error(
        `❌ Failed to update merchant status for ${merchantId}:`,
        error,
      );
      throw new InternalServerErrorException("Failed to update merchant status");
    }
  }

  async getMerchantProviders(merchantId: string, organizationId: string) {
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          providers: true,
        },
      });

      if (!merchant) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      const paymentGateways = await this.prisma.paymentGateway.findMany();
      const gatewayMap = new Map(
        paymentGateways.map((g) => [g.code.toLowerCase(), g.logo]),
      );

      const providersWithLogos =
        merchant.providers?.map((provider) => ({
          ...provider,
          logo:
            gatewayMap.get(provider.providerType.toString().toLowerCase()) ||
            null,
        })) || [];

      return {
        success: true,
        providers: providersWithLogos,
        total: providersWithLogos.length,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get providers for merchant ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        "Failed to retrieve merchant providers",
      );
    }
  }

  async getMerchantProviderCredentials(
    merchantId: string,
    providerType?: string,
  ) {
    try {
      const merchant = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        include: {
          providers: true,
        },
      });

      if (!merchant) {
        return null;
      }

      if (!merchant.providers || merchant.providers.length === 0) {
        return null;
      }

      // Filter by provider type if specified
      const providers = providerType
        ? merchant.providers.filter(
            (p) => p.providerType.toLowerCase() === providerType.toLowerCase(),
          )
        : merchant.providers;

      if (providers.length === 0) {
        return {
          success: false,
          message: `Provider ${providerType} not found for merchant ${merchantId}`,
        };
      }

      // Return credentials (only for internal use)
      return {
        success: true,
        credentials: providers.map((p) => ({
          providerType: p.providerType,
          isActive: p.isActive,
          credentials: p.credentials,
          metadata: p.metadata,
        })),
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get credentials for merchant ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to retrieve credentials");
    }
  }

  async getMerchantConnectors(merchantId: string, organizationId: string) {
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          providers: true,
        },
      });

      if (!merchant) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      // Fetch all payment gateways to get logos
      const paymentGateways = await this.prisma.paymentGateway.findMany();
      const gatewayMap = new Map(
        paymentGateways.map((g) => [g.code.toLowerCase(), g.logo]),
      );

      // Format providers as legacy connectors format
      const connectors =
        merchant.providers?.map((provider) => {
          // Try to extract merchant name from metadata or credentials
          const metadata = (provider.metadata as any) || {};
          const credentials = (provider.credentials as any) || {};
          const extractedMerchantName =
            merchant.businessName ||
            merchant.name ||
            metadata?.merchantName ||
            metadata?.storeName ||
            metadata?.displayName ||
            credentials?.merchantName ||
            credentials?.storeName ||
            credentials?.displayName ||
            null;

          // Prefer real UPI/VPA from metadata/credentials; fall back to accountIdentifier
          const upiFromMeta =
            metadata?.upiId ||
            credentials?.merchantUpiId ||
            credentials?.upiId ||
            null;
          const effectiveUpi =
            upiFromMeta && upiFromMeta !== "Not configured"
              ? upiFromMeta
              : provider.accountIdentifier || "Not configured";

          return {
            id: provider.id,
            providerCode: provider.providerType?.toLowerCase(),
            providerType: provider.providerType,
            displayName: this.cleanName(
              extractedMerchantName || `${provider.providerType} Account`,
            ),
            merchantName: extractedMerchantName
              ? this.cleanName(extractedMerchantName)
              : null,
            upiId: effectiveUpi,
            isActive: provider.isActive,
            logo:
              gatewayMap.get(provider.providerType.toString().toLowerCase()) ||
              null,
            lastSync: provider.updatedAt,
          };
        }) || [];

      return {
        success: true,
        connectors,
        total: connectors.length,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get connectors for merchant ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        "Failed to retrieve merchant connectors",
      );
    }
  }

  async configureMerchant(
    merchantId: string,
    organizationId: string,
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
      operatingSlots?: Array<{ open: string; close: string }>;
      weeklyHolidays?: number[];
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
    },
  ) {
    try {
      this.logger.log(`🔧 Configuring merchant: ${merchantId}`);

      await this.getMerchant(merchantId, organizationId);

      const merchantUpdateData: any = {
        status: "ACTIVE",
        isActive: true,
        verified: true,
        verifiedAt: new Date(),
      };

      if (config.name) merchantUpdateData.name = config.name;
      if (config.businessName) merchantUpdateData.businessName = config.businessName;
      if (config.email) merchantUpdateData.email = config.email;
      if (config.phone) merchantUpdateData.phone = config.phone;
      if (config.categoryId) merchantUpdateData.categoryId = config.categoryId;
      if (config.address) merchantUpdateData.address = config.address;
      if (config.city) merchantUpdateData.city = config.city;
      if (config.state) merchantUpdateData.state = config.state;
      if (config.pincode) merchantUpdateData.pincode = config.pincode;
      if (config.gstin) merchantUpdateData.gstin = config.gstin;
      if (config.pan) merchantUpdateData.pan = config.pan;
      if (typeof config.isFallback === "boolean") {
        merchantUpdateData.isFallback = config.isFallback;
      }

      await this.prisma.merchant.update({
        where: { id: merchantId },
        data: merchantUpdateData,
      });

      const merchantConfig = await this.prisma.merchantConfig.upsert({
        where: { merchantId },
        create: {
          merchantId,
          openTime: config.openTime,
          closeTime: config.closeTime,
          operatingSlots: config.operatingSlots || null,
          timezone: "Asia/Kolkata",
          weeklyHolidays: config.weeklyHolidays || [],

          dailyMaxAmount: config.dailyMaxAmount,
          dailyMaxTxnCount: config.dailyMaxTxnCount,
          dailyMinAmount: config.dailyMinAmount || 0,
          dailyMinTxnCount: config.dailyMinTxnCount || 0,

          monthlyMaxAmount: config.monthlyMaxAmount,
          monthlyMaxTxnCount:
            config.monthlyMaxTxnCount || config.dailyMaxTxnCount * 30,
          monthlyMinAmount: config.monthlyMinAmount || 0,
          monthlyMinTxnCount: config.monthlyMinTxnCount || 0,

          minTxnAmount: config.minTxnAmount,
          maxTxnAmount: config.maxTxnAmount,
          perMinuteMaxTxn:
            typeof config.perMinuteMaxTxn === "number"
              ? config.perMinuteMaxTxn
              : null,

          currentDailyAmount: 0,
          currentDailyTxnCount: 0,
          lastDailyReset: new Date(),
          currentMonthlyAmount: 0,
          currentMonthlyTxnCount: 0,
          lastMonthlyReset: new Date(),
        },
        update: {
          openTime: config.openTime,
          closeTime: config.closeTime,
          operatingSlots: config.operatingSlots || null,
          weeklyHolidays: config.weeklyHolidays || [],
          dailyMaxAmount: config.dailyMaxAmount,
          dailyMaxTxnCount: config.dailyMaxTxnCount,
          dailyMinAmount: config.dailyMinAmount || 0,
          dailyMinTxnCount: config.dailyMinTxnCount || 0,
          monthlyMaxAmount: config.monthlyMaxAmount,
          monthlyMaxTxnCount:
            config.monthlyMaxTxnCount || config.dailyMaxTxnCount * 30,
          monthlyMinAmount: config.monthlyMinAmount || 0,
          monthlyMinTxnCount: config.monthlyMinTxnCount || 0,
          minTxnAmount: config.minTxnAmount,
          maxTxnAmount: config.maxTxnAmount,
          perMinuteMaxTxn:
            typeof config.perMinuteMaxTxn === "number"
              ? config.perMinuteMaxTxn
              : null,
        },
      });

      this.logger.log(`✅ Merchant configured and activated: ${merchantId}`);

      this.triggerInitialTransactionSync(merchantId).catch((err) => {
        this.logger.error(
          `Failed to trigger initial sync for merchant ${merchantId}:`,
          err,
        );
      });

      return {
        success: true,
        config: merchantConfig,
        message:
          "Merchant configured successfully and is now active. Initial transaction sync started.",
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to configure merchant ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to configure merchant");
    }
  }

  private async triggerInitialTransactionSync(merchantId: string) {
    try {
      this.logger.log(
        `🔄 Triggering initial transaction sync for merchant: ${merchantId}`,
      );

      const axios = require("axios");
      const serviceUrl = process.env.MERCHANT_SERVICE_URL;

      axios
        // Keep initial sync lightweight; BharatPe (and some providers) have tighter date-range limits
        // Full backfill can be triggered manually by calling sync-all with a larger months value.
        // Include GPay too so newly connected merchants persist recent transactions immediately.
        .get(`${serviceUrl}/merchant/${merchantId}/transactions/sync-all?months=1`)
        .then((response) => {
          this.logger.log(
            `✅ Initial sync completed for ${merchantId}: ${JSON.stringify(response.data)}`,
          );
        })
        .catch((err) => {
          this.logger.warn(
            `⚠️ Initial sync failed for ${merchantId}:`,
            err.message,
          );
        });
    } catch (error) {
      this.logger.error(
        `Failed to trigger initial sync for ${merchantId}:`,
        error,
      );
    }
  }

  /**
   * Helper method to check if current time is within operating hours
   * Supports:
   * - Multiple time slots (e.g., morning + evening with lunch break)
   * - Weekly holidays (store closed on specific days of week)
   * - Backward compatibility with simple openTime/closeTime
   */
  private isWithinOperatingHours(config: any): {
    isOpen: boolean;
    message: string;
    currentTime: string;
    currentDay: number;
    slots: Array<{ open: string; close: string }>;
    nextOpenTime?: string;
  } {
    const now = new Date();
    const merchantTimezone = config.timezone || "Asia/Kolkata";
    const currentTime = now.toLocaleTimeString("en-GB", {
      timeZone: merchantTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const currentDay = new Date(
      now.toLocaleString("en-US", { timeZone: merchantTimezone }),
    ).getDay(); // 0-6
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    // Check weekly holidays first
    const holidays = (config.weeklyHolidays || []) as number[];
    if (holidays.includes(currentDay)) {
      return {
        isOpen: false,
        message: `Store is closed on ${dayNames[currentDay]}`,
        currentTime,
        currentDay,
        slots: [],
      };
    }

    // Get operating slots (new format) or create slot from openTime/closeTime (legacy)
    let slots: Array<{ open: string; close: string }> = [];

    if (
      config.operatingSlots &&
      Array.isArray(config.operatingSlots) &&
      config.operatingSlots.length > 0
    ) {
      slots = config.operatingSlots;
    } else if (config.openTime && config.closeTime) {
      // Legacy format: single slot from openTime/closeTime
      slots = [{ open: config.openTime, close: config.closeTime }];
    } else {
      // No hours configured - assume 24/7
      return {
        isOpen: true,
        message: "",
        currentTime,
        currentDay,
        slots: [{ open: "00:00", close: "23:59" }],
      };
    }

    const toMinutes = (hhmm: string): number => {
      const [hStr, mStr] = String(hhmm || "00:00").split(":");
      const h = Number(hStr);
      const m = Number(mStr);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
      return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
    };

    const currentMinutes = toMinutes(currentTime);

    for (const slot of slots) {
      const openMinutes = toMinutes(slot.open);
      let closeMinutes = toMinutes(slot.close);

      if (closeMinutes === 0 && openMinutes > 0) {
        closeMinutes = 24 * 60;
      }

      const isOpenNow =
        openMinutes <= closeMinutes
          ? currentMinutes >= openMinutes && currentMinutes <= closeMinutes
          : currentMinutes >= openMinutes || currentMinutes <= closeMinutes;

      if (isOpenNow) {
        return {
          isOpen: true,
          message: "",
          currentTime,
          currentDay,
          slots,
        };
      }
    }

    // Find next opening time
    let nextOpenTime: string | undefined;
    for (const slot of slots) {
      if (slot.open > currentTime) {
        nextOpenTime = slot.open;
        break;
      }
    }
    if (!nextOpenTime && slots.length > 0) {
      // All slots for today are past, next opening is tomorrow's first slot
      nextOpenTime = slots[0].open + " (tomorrow)";
    }

    // Format operating hours message
    const hoursStr = slots.map((s) => `${s.open}-${s.close}`).join(", ");
    return {
      isOpen: false,
      message: `Store is closed. Operating hours: ${hoursStr}`,
      currentTime,
      currentDay,
      slots,
      nextOpenTime,
    };
  }

  async validateMerchantForTransaction(
    merchantId: string,
    organizationId: string,
    amount: number,
    bypass: boolean = false,
    prefetchedMerchant?: any,
  ) {
    if (bypass) {
      this.logger.log(`🛡️ Bypassing merchant validation for ${merchantId} (Platform Internal)`);
      return { canProcess: true };
    }
    try {
      this.logger.log(
        `🔍 Validating merchant ${merchantId} for transaction: ₹${amount}`,
      );

      let merchant = prefetchedMerchant;
      if (!merchant) {
        merchant = await this.prisma.merchant.findFirst({
          where: { id: merchantId, organizationId },
          include: { config: true, category: true, providers: true },
        });
      }

      if (!merchant) {
        return {
          canProcess: false,
          reason: "MERCHANT_NOT_FOUND",
          message: "Merchant not found",
        };
      }

      // Reject merchants whose providers are all EXPIRED — order-status cron skips
      // them, so orders would stay PENDING forever.
      const hasActiveProvider = (merchant.providers || []).some((p) => {
        if (!p.isActive || p.status !== "ACTIVE") return false;
        const meta = (p.metadata as any) || {};
        const cred = (p.credentials as any) || {};
        const upiId =
          meta.upiId || cred.merchantUpiId || cred.upiId || p.accountIdentifier;
        return upiId && upiId !== "Not configured";
      });
      if (!hasActiveProvider) {
        return {
          canProcess: false,
          reason: "PROVIDER_SESSION_EXPIRED",
          message:
            "No active payment provider. Reconnect provider before accepting orders.",
        };
      }

      const config = merchant.config;
      const now = new Date();

      // CRITICAL FIX: Use merchant's timezone for operating hours check
      // The server may run in UTC, but merchants operate in their local timezone
      const merchantTimezone = config?.timezone || "Asia/Kolkata";
      const currentTimeInMerchantTz = now.toLocaleTimeString("en-GB", {
        timeZone: merchantTimezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const currentTime = currentTimeInMerchantTz;

      const lastReset = config ? new Date(config.lastDailyReset) : new Date();
      const isNewDay = config
        ? now.getDate() !== lastReset.getDate() ||
          now.getMonth() !== lastReset.getMonth() ||
          now.getFullYear() !== lastReset.getFullYear()
        : true;

      const lastMonthlyReset = config
        ? new Date(config.lastMonthlyReset)
        : new Date();
      const isNewMonth = config
        ? now.getMonth() !== lastMonthlyReset.getMonth() ||
          now.getFullYear() !== lastMonthlyReset.getFullYear()
        : true;

      if (!merchant.isActive) {
        return {
          canProcess: false,
          reason: "MERCHANT_INACTIVE",
          message:
            "This merchant account is currently deactivated. Please contact support.",
        };
      }

      const isLimitBlock = merchant.status === "LIMIT_EXCEEDED";
      const shouldBypassLimitBlock = isLimitBlock && (isNewDay || isNewMonth);

      if (shouldBypassLimitBlock) {
        this.logger.log(
          `🔄 Resetting merchant ${merchantId} status from LIMIT_EXCEEDED to ACTIVE (${isNewDay ? "new day" : "new month"})`,
        );

        await this.prisma.merchant.update({
          where: { id: merchantId },
          data: {
            status: "ACTIVE",
            statusReason: null,
          },
        });

        const configUpdateData: any = {};
        if (isNewDay) {
          configUpdateData.currentDailyAmount = 0;
          configUpdateData.currentDailyTxnCount = 0;
          configUpdateData.lastDailyReset = new Date();
        }
        if (isNewMonth) {
          configUpdateData.currentMonthlyAmount = 0;
          configUpdateData.currentMonthlyTxnCount = 0;
          configUpdateData.lastMonthlyReset = new Date();
        }

        if (Object.keys(configUpdateData).length > 0) {
          await this.prisma.merchantConfig.update({
            where: { merchantId },
            data: configUpdateData,
          });
        }

        this.logger.log(
          `✅ Merchant ${merchantId} status reset to ACTIVE, usage counters cleared`,
        );
      }

      if (merchant.status !== "ACTIVE" && !shouldBypassLimitBlock) {
        let limitMessage =
          "Transaction limits have been reached. Please try again tomorrow or contact support.";
        if (merchant.status === "LIMIT_EXCEEDED" && merchant.statusReason) {
          limitMessage = `Limit exceeded: ${merchant.statusReason}. Resets at midnight for daily limits or 1st of month for monthly limits.`;
        }

        const statusMessages: Record<string, string> = {
          LIMIT_EXCEEDED: limitMessage,
          SUSPENDED:
            "This merchant is temporarily suspended. Please contact support.",
          PENDING:
            "Merchant setup is not complete. Please complete onboarding.",
        };
        return {
          canProcess: false,
          reason: "MERCHANT_NOT_ACTIVE",
          message:
            statusMessages[merchant.status] ||
            `Merchant is currently ${merchant.status}. Cannot process transactions.`,
          currentStatus: merchant.status,
          statusReason: merchant.statusReason,
        };
      }

      if (!merchant.verified) {
        return {
          canProcess: false,
          reason: "MERCHANT_NOT_VERIFIED",
          message:
            "Merchant verification is pending. Please wait for approval.",
        };
      }

      if (!merchant.config) {
        return {
          canProcess: false,
          reason: "CONFIGURATION_MISSING",
          message:
            "Merchant configuration not found. Please configure business limits.",
        };
      }

      const currentDailyAmount = isNewDay
        ? 0
        : Number(config.currentDailyAmount);
      const currentDailyTxnCount = isNewDay ? 0 : config.currentDailyTxnCount;

      const currentMonthlyAmount = isNewMonth
        ? 0
        : Number(config.currentMonthlyAmount);
      const currentMonthlyTxnCount = isNewMonth
        ? 0
        : config.currentMonthlyTxnCount;

      // Check operating hours using the new helper (supports multiple slots + weekly holidays)
      const hoursCheck = this.isWithinOperatingHours(config);
      if (!hoursCheck.isOpen) {
        return {
          canProcess: false,
          reason: "OUTSIDE_OPERATING_HOURS",
          message: hoursCheck.message,
          operatingHours: {
            slots: hoursCheck.slots,
            currentTime: hoursCheck.currentTime,
            currentDay: hoursCheck.currentDay,
            nextOpenTime: hoursCheck.nextOpenTime,
            weeklyHolidays: config.weeklyHolidays || [],
          },
        };
      }

      const newDailyAmount = currentDailyAmount + amount;
      const newDailyCount = currentDailyTxnCount + 1;

      if (newDailyAmount > Number(config.dailyMaxAmount)) {
        const remaining = Number(config.dailyMaxAmount) - currentDailyAmount;
        return {
          canProcess: false,
          reason: "DAILY_AMOUNT_LIMIT_EXCEEDED",
          message: `Cannot process ₹${amount.toLocaleString("en-IN")}. Daily limit is ₹${Number(config.dailyMaxAmount).toLocaleString("en-IN")} (₹${remaining > 0 ? remaining.toLocaleString("en-IN") : 0} remaining today).`,
          limits: {
            dailyMaxAmount: config.dailyMaxAmount,
            currentDailyAmount: currentDailyAmount,
            transactionAmount: amount,
            remainingToday: remaining > 0 ? remaining : 0,
            wouldExceedBy: newDailyAmount - Number(config.dailyMaxAmount),
          },
        };
      }

      if (newDailyCount > config.dailyMaxTxnCount) {
        const remaining = config.dailyMaxTxnCount - currentDailyTxnCount;
        return {
          canProcess: false,
          reason: "DAILY_TRANSACTION_LIMIT_EXCEEDED",
          message: `Daily transaction limit reached. Maximum ${config.dailyMaxTxnCount} transactions/day (${remaining > 0 ? remaining : 0} remaining today).`,
          limits: {
            dailyMaxTxnCount: config.dailyMaxTxnCount,
            currentDailyTxnCount: currentDailyTxnCount,
            remainingToday: remaining > 0 ? remaining : 0,
          },
        };
      }

      const newMonthlyAmount = currentMonthlyAmount + amount;
      const newMonthlyCount = currentMonthlyTxnCount + 1;

      if (newMonthlyAmount > Number(config.monthlyMaxAmount)) {
        const remaining =
          Number(config.monthlyMaxAmount) - Number(config.currentMonthlyAmount);
        return {
          canProcess: false,
          reason: "MONTHLY_AMOUNT_LIMIT_EXCEEDED",
          message: `Cannot process ₹${amount.toLocaleString("en-IN")}. Monthly limit is ₹${Number(config.monthlyMaxAmount).toLocaleString("en-IN")} (₹${remaining > 0 ? remaining.toLocaleString("en-IN") : 0} remaining this month).`,
          limits: {
            monthlyMaxAmount: config.monthlyMaxAmount,
            currentMonthlyAmount: config.currentMonthlyAmount,
            transactionAmount: amount,
            remainingThisMonth: remaining > 0 ? remaining : 0,
            wouldExceedBy: newMonthlyAmount - Number(config.monthlyMaxAmount),
          },
        };
      }

      if (
        config.monthlyMaxTxnCount &&
        newMonthlyCount > config.monthlyMaxTxnCount
      ) {
        const remaining =
          config.monthlyMaxTxnCount - config.currentMonthlyTxnCount;
        return {
          canProcess: false,
          reason: "MONTHLY_TRANSACTION_LIMIT_EXCEEDED",
          message: `Monthly transaction limit reached. Maximum ${config.monthlyMaxTxnCount} transactions/month (${remaining > 0 ? remaining : 0} remaining this month).`,
          limits: {
            monthlyMaxTxnCount: config.monthlyMaxTxnCount,
            currentMonthlyTxnCount: config.currentMonthlyTxnCount,
            remainingThisMonth: remaining > 0 ? remaining : 0,
          },
        };
      }

      // Check per-transaction minimum (minTxnAmount)
      if (config.minTxnAmount && amount < Number(config.minTxnAmount)) {
        return {
          canProcess: false,
          reason: "BELOW_MINIMUM_AMOUNT",
          message: `Amount too low. Minimum transaction is ₹${Number(config.minTxnAmount).toLocaleString("en-IN")}. You entered ₹${amount.toLocaleString("en-IN")}.`,
        };
      }

      if (
        config.dailyMinAmount &&
        Number(config.dailyMinAmount) > 0 &&
        amount < Number(config.dailyMinAmount)
      ) {
        return {
          canProcess: false,
          reason: "BELOW_MINIMUM_AMOUNT",
          message: `Amount too low. Minimum transaction is ₹${Number(config.dailyMinAmount).toLocaleString("en-IN")}. You entered ₹${amount.toLocaleString("en-IN")}.`,
        };
      }

      if (config.maxTxnAmount && amount > Number(config.maxTxnAmount)) {
        return {
          canProcess: false,
          reason: "ABOVE_MAXIMUM_AMOUNT",
          message: `Amount too high. Maximum transaction is ₹${Number(config.maxTxnAmount).toLocaleString("en-IN")}. You entered ₹${amount.toLocaleString("en-IN")}.`,
        };
      }

      this.logger.log(
        `✅ Merchant ${merchantId} validated successfully for ₹${amount} transaction`,
      );
      return {
        canProcess: true,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          businessName: merchant.businessName,
          category: merchant.category?.name,
        },
        limits: {
          dailyRemaining:
            Number(config.dailyMaxAmount) - Number(config.currentDailyAmount),
          monthlyRemaining:
            Number(config.monthlyMaxAmount) -
            Number(config.currentMonthlyAmount),
          transactionCountRemaining: {
            daily: config.dailyMaxTxnCount - config.currentDailyTxnCount,
            monthly: config.monthlyMaxTxnCount
              ? config.monthlyMaxTxnCount - config.currentMonthlyTxnCount
              : null,
          },
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to validate merchant ${merchantId}:`, error);
      return {
        canProcess: false,
        reason: "VALIDATION_ERROR",
        message: "Failed to validate merchant",
      };
    }
  }

  async updateUsageAndCheckLimits(merchantId: string, organizationId: string, amount: number) {
    try {
      console.log(
        `\n⚠️ HTTP update-usage ENDPOINT CALLED for ${merchantId}: ₹${amount}`,
      );
      console.log(
        `   This should NOT be called - usage is updated by order-status-cron.service.ts!`,
      );
      this.logger.log(
        `📊 Updating usage for merchant ${merchantId}: ₹${amount}`,
      );

      // We must fetch the merchant first to ensure organizationId matches, because config only has merchantId
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
      });
      if (!merchant) throw new NotFoundException(`Merchant ${merchantId} not found`);

      const config = await this.prisma.merchantConfig.findUnique({
        where: { merchantId },
      });

      if (!config) {
        throw new NotFoundException("Merchant configuration not found");
      }

      const now = new Date();

      // Reset logic (same as before)
      const lastReset = new Date(config.lastDailyReset);
      const shouldResetDaily =
        now.getDate() !== lastReset.getDate() ||
        now.getMonth() !== lastReset.getMonth() ||
        now.getFullYear() !== lastReset.getFullYear();

      const shouldResetMonthly =
        now.getMonth() !== lastReset.getMonth() ||
        now.getFullYear() !== lastReset.getFullYear();

      const updateData: any = {};

      if (shouldResetDaily) {
        updateData.currentDailyAmount = amount;
        updateData.currentDailyTxnCount = 1;
        updateData.lastDailyReset = now;
      } else {
        updateData.currentDailyAmount = config.currentDailyAmount.plus(amount);
        updateData.currentDailyTxnCount = config.currentDailyTxnCount + 1;
      }

      if (shouldResetMonthly) {
        updateData.currentMonthlyAmount = amount;
        updateData.currentMonthlyTxnCount = 1;
        updateData.lastMonthlyReset = now;
      } else {
        updateData.currentMonthlyAmount =
          config.currentMonthlyAmount.plus(amount);
        updateData.currentMonthlyTxnCount = config.currentMonthlyTxnCount + 1;
      }

      // AUTO-UNBLOCK if resetting
      if (shouldResetDaily || shouldResetMonthly) {
        // If merchant was blocked due to limits, unblock them now
        const merchant = await this.prisma.merchant.findUnique({
          where: { id: merchantId },
          select: { status: true },
        });

        if (merchant?.status === "LIMIT_EXCEEDED") {
          this.logger.log(
            `🔓 Merchant ${merchantId} limits reset (New Day/Month). Setting status to ACTIVE.`,
          );
          await this.prisma.merchant.update({
            where: { id: merchantId },
            data: {
              status: "ACTIVE",
              statusReason: null,
            },
          });
        }
      }

      const updatedConfig = await this.prisma.merchantConfig.update({
        where: { merchantId },
        data: updateData,
      });

      // CHECK IF LIMITS ARE NOW EXCEEDED
      const dailyLimitExceeded =
        updatedConfig.currentDailyAmount.gte(config.dailyMaxAmount) ||
        updatedConfig.currentDailyTxnCount >= config.dailyMaxTxnCount;

      const monthlyLimitExceeded =
        updatedConfig.currentMonthlyAmount.gte(config.monthlyMaxAmount) ||
        (config.monthlyMaxTxnCount &&
          updatedConfig.currentMonthlyTxnCount >= config.monthlyMaxTxnCount);

      // 🚨 AUTO-BLOCK MERCHANT IF LIMITS EXCEEDED
      if (dailyLimitExceeded || monthlyLimitExceeded) {
        const blockReason = dailyLimitExceeded
          ? "Daily limit reached"
          : "Monthly limit reached";

        await this.prisma.merchant.update({
          where: { id: merchantId },
          data: {
            status: "LIMIT_EXCEEDED",
            statusReason: blockReason,
          },
        });

        this.logger.warn(`🚨 MERCHANT BLOCKED: ${merchantId} - ${blockReason}`);

        return {
          success: true,
          usage: updatedConfig,
          merchantBlocked: true,
          blockReason,
          message: `Transaction processed but merchant is now blocked due to limit exhaustion: ${blockReason}`,
        };
      }

      return {
        success: true,
        usage: updatedConfig,
        merchantBlocked: false,
        limits: {
          dailyUsagePercent:
            (Number(updatedConfig.currentDailyAmount) /
              Number(config.dailyMaxAmount)) *
            100,
          monthlyUsagePercent:
            (Number(updatedConfig.currentMonthlyAmount) /
              Number(config.monthlyMaxAmount)) *
            100,
        },
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to update usage for merchant ${merchantId}:`,
        error,
      );
      throw new InternalServerErrorException("Failed to update usage");
    }
  }

  async canGeneratePaymentAssets(merchantId: string, organizationId: string, bypass: boolean = false) {
    if (bypass) {
      this.logger.log(`🛡️ Bypassing payment asset validation for ${merchantId} (Platform Internal)`);
      return { canGenerate: true };
    }
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: { config: true },
      });

      if (!merchant) {
        return {
          canGenerate: false,
          reason: "MERCHANT_NOT_FOUND",
          message: "Merchant not found",
        };
      }

      // Same validations as transaction but without amount
      if (!merchant.isActive) {
        return {
          canGenerate: false,
          reason: "MERCHANT_INACTIVE",
          message:
            "Merchant account is deactivated. Cannot generate QR codes or payment links.",
        };
      }

      if (merchant.status !== "ACTIVE") {
        // For LIMIT_EXCEEDED, include detailed usage information
        let detailedMessage = `Merchant status is ${merchant.status}. Cannot generate payment assets.`;
        let usageDetails: any = {};

        if (merchant.status === "LIMIT_EXCEEDED" && merchant.config) {
          const config = merchant.config;
          const dailyUsed = config.currentDailyTxnCount || 0;
          const dailyMax = config.dailyMaxTxnCount || 0;
          const dailyAmountUsed = Number(config.currentDailyAmount) || 0;
          const dailyAmountMax = Number(config.dailyMaxAmount) || 0;
          const monthlyUsed = config.currentMonthlyTxnCount || 0;
          const monthlyMax = config.monthlyMaxTxnCount || 0;
          const monthlyAmountUsed = Number(config.currentMonthlyAmount) || 0;
          const monthlyAmountMax = Number(config.monthlyMaxAmount) || 0;

          // Build specific reason
          const reasons: string[] = [];
          if (dailyUsed >= dailyMax && dailyMax > 0) {
            reasons.push(
              `Daily transaction limit reached (${dailyUsed}/${dailyMax} used)`,
            );
          }
          if (dailyAmountUsed >= dailyAmountMax && dailyAmountMax > 0) {
            reasons.push(
              `Daily amount limit reached (₹${dailyAmountUsed.toLocaleString("en-IN")} / ₹${dailyAmountMax.toLocaleString("en-IN")})`,
            );
          }
          if (monthlyUsed >= monthlyMax && monthlyMax > 0) {
            reasons.push(
              `Monthly transaction limit reached (${monthlyUsed}/${monthlyMax} used)`,
            );
          }
          if (monthlyAmountUsed >= monthlyAmountMax && monthlyAmountMax > 0) {
            reasons.push(
              `Monthly amount limit reached (₹${monthlyAmountUsed.toLocaleString("en-IN")} / ₹${monthlyAmountMax.toLocaleString("en-IN")})`,
            );
          }

          if (reasons.length > 0) {
            detailedMessage =
              reasons.join(". ") +
              ". Limits reset at midnight (daily) or 1st of month (monthly).";
          } else if (merchant.statusReason) {
            detailedMessage =
              merchant.statusReason +
              ". Limits reset at midnight (daily) or 1st of month (monthly).";
          }

          usageDetails = {
            dailyTransactions: { used: dailyUsed, max: dailyMax },
            dailyAmount: { used: dailyAmountUsed, max: dailyAmountMax },
            monthlyTransactions: { used: monthlyUsed, max: monthlyMax },
            monthlyAmount: { used: monthlyAmountUsed, max: monthlyAmountMax },
          };
        }

        return {
          canGenerate: false,
          reason: "MERCHANT_NOT_ACTIVE",
          message: detailedMessage,
          currentStatus: merchant.status,
          statusReason: merchant.statusReason,
          usageDetails,
        };
      }

      if (!merchant.verified) {
        return {
          canGenerate: false,
          reason: "MERCHANT_NOT_VERIFIED",
          message:
            "Merchant verification pending. Cannot generate payment assets.",
        };
      }

      if (!merchant.config) {
        return {
          canGenerate: false,
          reason: "CONFIGURATION_MISSING",
          message:
            "Merchant configuration missing. Please configure business limits first.",
        };
      }

      // **CRITICAL CHECKS** - Verify merchant has at least one healthy UPI provider
      const merchantWithProviders = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        include: { providers: true },
      });

      let hasUpiId = false;
      let hasUsableProvider = false;

      if (
        merchantWithProviders?.providers &&
        merchantWithProviders.providers.length > 0
      ) {
        for (const provider of merchantWithProviders.providers) {
          if (!provider.isActive) continue;

          const metadata = (provider.metadata as any) || {};
          const credentials = (provider.credentials as any) || {};

          const upiId =
            metadata.upiId ||
            credentials.merchantUpiId ||
            credentials.upiId ||
            provider.accountIdentifier;

          if (upiId && upiId !== "Not configured") {
            hasUpiId = true;
            // Usable = has UPI and not session-expired (credentials or status)
            const isExpired =
              credentials.sessionExpired === true ||
              provider.status === "EXPIRED";
            if (!isExpired) hasUsableProvider = true;
          }
        }
      }

      if (!hasUpiId) {
        return {
          canGenerate: false,
          reason: "UPI_ID_NOT_CONFIGURED",
          message:
            "Merchant UPI ID not configured. Please complete merchant configuration before generating payment assets.",
        };
      }

      // If UPI is configured but no provider is usable (all expired),
      // block QR/payment link generation until the provider is reconnected.
      if (!hasUsableProvider) {
        return {
          canGenerate: false,
          reason: "PROVIDER_SESSION_EXPIRED",
          message:
            "Primary payment provider session has expired. Please reconnect the provider before creating new orders.",
        };
      }

      return {
        canGenerate: true,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          businessName: merchant.businessName,
          status: merchant.status,
        },
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to check payment asset generation for merchant ${merchantId}:`,
        error,
      );
      return {
        canGenerate: false,
        reason: "VALIDATION_ERROR",
        message: "Failed to validate merchant for payment asset generation",
      };
    }
  }

  async getMerchantStats(merchantId: string, organizationId: string) {
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: { config: true },
      });

      if (!merchant) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      const config = merchant.config;
      const now = new Date();

      let currentDailyAmount = 0;
      let currentDailyTxnCount = 0;
      let currentMonthlyAmount = 0;
      let currentMonthlyTxnCount = 0;

      if (config) {
        const lastDailyReset = new Date(config.lastDailyReset);
        const isNewDay =
          now.getDate() !== lastDailyReset.getDate() ||
          now.getMonth() !== lastDailyReset.getMonth() ||
          now.getFullYear() !== lastDailyReset.getFullYear();

        if (!isNewDay) {
          currentDailyAmount = Number(config.currentDailyAmount);
          currentDailyTxnCount = config.currentDailyTxnCount;
        }

        const lastMonthlyReset = new Date(config.lastMonthlyReset);
        const isNewMonth =
          now.getMonth() !== lastMonthlyReset.getMonth() ||
          now.getFullYear() !== lastMonthlyReset.getFullYear();

        if (!isNewMonth) {
          currentMonthlyAmount = Number(config.currentMonthlyAmount);
          currentMonthlyTxnCount = config.currentMonthlyTxnCount;
        }
      }

      return {
        success: true,
        merchant: {
          id: merchant.id,
          name: merchant.name,
          businessName: merchant.businessName,
          status: merchant.status,
          isActive: merchant.isActive,
          verified: merchant.verified,
        },
        limits: config
          ? {
              daily: {
                maxAmount: config.dailyMaxAmount,
                maxTxnCount: config.dailyMaxTxnCount,
                currentAmount: currentDailyAmount,
                currentTxnCount: currentDailyTxnCount,
                usagePercentage:
                  (currentDailyAmount /
                    Number(config.dailyMaxAmount)) *
                  100,
              },
              monthly: {
                maxAmount: config.monthlyMaxAmount,
                maxTxnCount: config.monthlyMaxTxnCount,
                currentAmount: currentMonthlyAmount,
                currentTxnCount: currentMonthlyTxnCount,
                usagePercentage:
                  (currentMonthlyAmount /
                    Number(config.monthlyMaxAmount)) *
                  100,
              },
            }
          : null,
        operatingHours: config
          ? {
              openTime: config.openTime,
              closeTime: config.closeTime,
              timezone: config.timezone,
            }
          : null,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get merchant stats ${merchantId}:`,
        error,
      );
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(
        "Failed to retrieve merchant stats",
      );
    }
  }

  async verifyMerchant(
    merchantId: string,
    organizationId: string,
    verificationData: {
      mobile?: string;
      otp?: string;
      providerConnected?: boolean;
    },
  ) {
    try {
      this.logger.log(`✅ Verifying merchant: ${merchantId}`);

      // Get current merchant
      const merchant = await this.getMerchant(merchantId, organizationId);

      if (merchant.merchant.verified) {
        return {
          success: true,
          message: "Merchant is already verified",
          merchant: merchant.merchant,
        };
      }

      // Update merchant to verified status
      const updatedMerchant = await this.prisma.merchant.update({
        where: { id: merchantId },
        data: {
          verified: true,
          verifiedAt: new Date(),
          status: MerchantStatus.ACTIVE, // Change from PENDING to ACTIVE
        },
        include: {
          config: true,
          category: true,
        },
      });

      this.logger.log(`✅ Merchant verified successfully: ${merchantId}`);

      return {
        success: true,
        merchant: updatedMerchant,
        message: "Merchant verified and activated successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to verify merchant ${merchantId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to verify merchant");
    }
  }

  async deleteMerchant(merchantId: string, organizationId: string) {
    try {
      this.logger.log(`🗑️  Soft-deleting merchant: ${merchantId}`);

      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          providers: true,
          config: true,
        },
      });

      if (!merchant) {
        throw new NotFoundException(`Merchant ${merchantId} not found`);
      }

      if (merchant.deletedAt) {
        return {
          success: true,
          message: `Merchant "${merchant.name}" is already deleted`,
          deletedData: {
            merchant: merchant.name,
            providers: merchant.providers.length,
            config: merchant.config ? "retained" : "none",
          },
        };
      }

      // Soft delete: set deletedAt and deactivate; do NOT delete providers or config
      // so that transaction history and reconnect data remain valid
      await this.prisma.merchant.update({
        where: { id: merchantId },
        data: {
          deletedAt: new Date(),
          isActive: false,
          status: MerchantStatus.DEACTIVATED,
        },
      });

      // Free the subscription slot so it can be reassigned
      await this.unassignSubscriptionSlot(
        merchant.organizationId,
        merchantId,
      ).catch((err) => {
        this.logger.warn(`Failed to unassign subscription slot: ${err.message}`);
      });

      this.logger.log(
        `✅ Merchant soft-deleted: ${merchantId} (providers and config retained for audit, subscription slot freed)`,
      );

      return {
        success: true,
        message: `Merchant "${merchant.name}" has been deactivated. Transaction and order history are preserved.`,
        deletedData: {
          merchant: merchant.name,
          providers: merchant.providers.length,
          config: merchant.config ? "retained" : "none",
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to delete merchant ${merchantId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to delete merchant");
    }
  }
}

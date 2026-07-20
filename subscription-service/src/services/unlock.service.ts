import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import axios from "axios";

const DEFAULT_UNLOCKED_TYPES = ["PHONEPE", "PAYTM", "SBI", "HDFC", "QUINTUS", "QUINTUSPAY"];
const PREMIUM_GATEWAY_TYPES = ["BHARATPE", "GPAY"];

@Injectable()
export class UnlockService {
  private readonly logger = new Logger(UnlockService.name);

  constructor(private readonly prisma: PrismaService) { }


  async getUnlockProducts() {
    const products = await this.prisma.merchantUnlockProduct.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    return {
      success: true,
      data: {
        products,
        defaultUnlocked: DEFAULT_UNLOCKED_TYPES,
      },
    };
  }

  async getAllUnlockProducts() {
    const products = await this.prisma.merchantUnlockProduct.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return { success: true, data: products };
  }

  async updateUnlockProduct(
    id: string,
    data: { price?: number; displayName?: string; description?: string; isActive?: boolean; sortOrder?: number },
  ) {
    const product = await this.prisma.merchantUnlockProduct.findUnique({ where: { id } });
    if (!product) throw new NotFoundException("Unlock product not found");

    const updated = await this.prisma.merchantUnlockProduct.update({
      where: { id },
      data: {
        ...(data.price != null && { price: data.price }),
        ...(data.displayName != null && { displayName: data.displayName }),
        ...(data.description != null && { description: data.description }),
        ...(data.isActive != null && { isActive: data.isActive }),
        ...(data.sortOrder != null && { sortOrder: data.sortOrder }),
      },
    });

    return { success: true, product: updated };
  }

  // ─── ORGANIZATION UNLOCKS ───────────────────────────────

  async getOrganizationUnlocks(organizationId: string, isSuperAdmin: boolean = false) {
    const unlocks = await this.prisma.merchantUnlock.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: { unlockedAt: "desc" },
    });

    const unlockedTypes = unlocks.map((u) => u.merchantType.toUpperCase());

    if (isSuperAdmin) {
      return {
        success: true,
        data: {
          unlocks,
          unlockedTypes: [...new Set([...DEFAULT_UNLOCKED_TYPES, ...PREMIUM_GATEWAY_TYPES, ...unlockedTypes])],
          defaultUnlocked: DEFAULT_UNLOCKED_TYPES,
        },
      };
    }

    const allUnlocked = [
      ...new Set([...DEFAULT_UNLOCKED_TYPES, ...unlockedTypes]),
    ];

    return {
      success: true,
      data: {
        unlocks,
        unlockedTypes: allUnlocked,
        defaultUnlocked: DEFAULT_UNLOCKED_TYPES,
      },
    };
  }

  async checkMerchantTypeUnlocked(
    organizationId: string,
    merchantType: string,
    isSuperAdmin: boolean = false,
  ) {
    // Platform bypass
    if (isSuperAdmin) {
      return { unlocked: true, reason: "Super Admin bypass" };
    }

    const type = merchantType.toUpperCase();

    if (DEFAULT_UNLOCKED_TYPES.includes(type)) {
      return { unlocked: true, reason: "Default merchant type" };
    }

    if (PREMIUM_GATEWAY_TYPES.includes(type)) {
      const premiumUnlock = await this.prisma.merchantUnlock.findUnique({
        where: {
          organizationId_merchantType: { organizationId, merchantType: "PREMIUM_GATEWAY_ACCESS" },
        },
      });

      if (premiumUnlock && premiumUnlock.status === "ACTIVE") {
        return { unlocked: true, reason: "Premium Gateway Access active", unlockId: premiumUnlock.id };
      }

      const product = await this.prisma.merchantUnlockProduct.findUnique({
        where: { merchantType: "PREMIUM_GATEWAY_ACCESS" },
      });

      return {
        unlocked: false,
        reason: `${type} requires Premium Gateway Access. Please purchase the one-time unlock to proceed.`,
        product: product
          ? {
            id: product.id,
            merchantType: product.merchantType,
            displayName: product.displayName,
            price: product.price,
            currency: product.currency,
          }
          : null,
      };
    }

    const unlock = await this.prisma.merchantUnlock.findUnique({
      where: {
        organizationId_merchantType: { organizationId, merchantType: type },
      },
    });

    if (unlock && unlock.status === "ACTIVE") {
      return { unlocked: true, reason: "Lifetime unlock active", unlockId: unlock.id };
    }

    const product = await this.prisma.merchantUnlockProduct.findUnique({
      where: { merchantType: type },
    });

    return {
      unlocked: false,
      reason: `${type} requires a one-time unlock purchase`,
      product: product
        ? {
          id: product.id,
          merchantType: product.merchantType,
          displayName: product.displayName,
          price: product.price,
          currency: product.currency,
        }
        : null,
    };
  }


  async purchaseUnlock(organizationId: string, merchantType: string) {
    const type = merchantType.toUpperCase();

    const existing = await this.prisma.merchantUnlock.findUnique({
      where: {
        organizationId_merchantType: { organizationId, merchantType: type },
      },
    });

    if (existing && existing.status === "ACTIVE") {
      throw new BadRequestException(`${type} is already unlocked for this organization`);
    }

    // Get the product pricing
    const product = await this.prisma.merchantUnlockProduct.findUnique({
      where: { merchantType: type },
    });

    if (!product || !product.isActive) {
      throw new NotFoundException(`No unlock product found for ${type}`);
    }

    const totalAmount = Number(product.price);

    const purchase = await this.prisma.merchantUnlockPurchase.create({
      data: {
        organizationId,
        merchantType: type,
        totalAmount,
        status: "PENDING",
      },
    });

    // Create payment order via payment-service
    let qrData: any = null;
    try {
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const platformConfig = await this.getPlatformConfig("subscription_payment_merchant");

      if (!platformConfig?.merchantId) {
        throw new BadRequestException({
          success: false,
          redirectUrl: '/customer-care', // Custom parameter handled by frontend
          message: "Platform payment merchant not configured. Redirecting to support..."
        });
      }

      const orderResponse = await axios.post(
        `${paymentServiceUrl}/orders`,
        {
          merchantId: platformConfig.merchantId,
          connectorId: platformConfig.connectorId || undefined,
          organizationId: platformConfig.organizationId || organizationId,
          amount: totalAmount.toString(),
          description: `Merchant Unlock: ${product.displayName}`,
          customerName: `Org-${organizationId}`,
          callbackUrl: `${process.env.SUBSCRIPTION_SERVICE_URL}/merchant-unlocks/payment-callback`,
          isPlatform: true,
        },
        {
          headers: {
            "x-organization-id": platformConfig.organizationId || organizationId,
            "x-internal-token": process.env.INTERNAL_TOKEN,
          },
        },
      );

      const orderResult = orderResponse.data;
      // Robust extraction of order IDs from payment-service response
      const orderId = orderResult.data?.id || orderResult.data?.session_id || orderResult.order?.id || orderResult.id;
      const externalOrderId = orderResult.data?.order_id || orderResult.data?.externalOrderId || orderResult.order?.externalOrderId || orderResult.externalOrderId;

      if (!externalOrderId) {
        this.logger.error(`❌ Payment service did not return an externalOrderId. Response: ${JSON.stringify(orderResult)}`);
      }

      await this.prisma.merchantUnlockPurchase.update({
        where: { id: purchase.id },
        data: { paymentOrderId: orderId, paymentExternalId: externalOrderId },
      });

      qrData = orderResult.data?.upi_intent || orderResult.data;

      return {
        success: true,
        purchase: {
          id: purchase.id,
          paymentExternalId: externalOrderId,
          merchantType: type,
          displayName: product.displayName,
          totalAmount,
          status: "PENDING",
        },
        qrCode: qrData?.qrCode || null,
        paymentUrl: qrData?.payment_url || null,
        order: orderResult,
      };
    } catch (error: any) {
      this.logger.error("Failed to create unlock payment order:", error.message);
      throw new BadRequestException(error.response?.data?.message || "Failed to initiate unlock payment");
    }
  }

  async handleUnlockPaymentCallback(body: any) {
    // payment-service sends standard webhook payload:
    // id: order.externalOrderId
    // client_txn_id: order.clientReferenceId
    // status: "success" | "failure"
    // upi_txn_id: UTR

    const orderId = body.orderId; // Internal ID if present
    const externalOrderId = body.id || body.externalOrderId || body.client_txn_id;
    const status = body.status;
    const utr = body.upi_txn_id || body.utr;

    this.logger.log(`🔓 Unlock payment callback: order=${externalOrderId}, status=${status}, utr=${utr}`);

    // status is "success" in standard webhook, or "COMPLETED"/"SUCCESS" in some flows
    const isSuccess = status === "success" || status === "COMPLETED" || status === "SUCCESS" || status === "PAID";

    if (!isSuccess) {
      return { success: false, message: "Payment not completed" };
    }

    // Find the purchase
    const purchase = await this.prisma.merchantUnlockPurchase.findFirst({
      where: {
        OR: [
          { paymentOrderId: orderId },
          { paymentExternalId: externalOrderId },
        ],
        status: "PENDING",
      },
    });

    if (!purchase) {
      this.logger.warn("No pending unlock purchase found for callback");
      return { success: false, message: "Purchase not found" };
    }

    const merchantType = purchase.merchantType;

    // Create the unlock record
    await this.prisma.$transaction(async (tx) => {
      // Update purchase status
      await tx.merchantUnlockPurchase.update({
        where: { id: purchase.id },
        data: {
          status: "COMPLETED",
          paymentUtr: utr || null,
        },
      });

      // Create or update unlock
      await tx.merchantUnlock.upsert({
        where: {
          organizationId_merchantType: {
            organizationId: purchase.organizationId,
            merchantType,
          },
        },
        create: {
          organizationId: purchase.organizationId,
          merchantType,
          unlockType: "LIFETIME",
          status: "ACTIVE",
          purchaseId: purchase.id,
          pricePaid: purchase.totalAmount,
          currency: "INR",
          grantedBy: "PURCHASE",
        },
        update: {
          status: "ACTIVE",
          purchaseId: purchase.id,
          pricePaid: purchase.totalAmount,
          grantedBy: "PURCHASE",
          revokedAt: null,
          unlockedAt: new Date(),
        },
      });
    });

    this.logger.log(`✅ Merchant unlock activated: ${merchantType} for org ${purchase.organizationId}`);

    return {
      success: true,
      message: `${merchantType} unlocked successfully`,
      merchantType,
      organizationId: purchase.organizationId,
    };
  }

  // ─── SUPER-ADMIN: GRANT / REVOKE ───────────────────────

  async grantUnlock(organizationId: string, merchantType: string) {
    const type = merchantType.toUpperCase();

    const unlock = await this.prisma.merchantUnlock.upsert({
      where: {
        organizationId_merchantType: { organizationId, merchantType: type },
      },
      create: {
        organizationId,
        merchantType: type,
        unlockType: "LIFETIME",
        status: "ACTIVE",
        grantedBy: "SUPER_ADMIN",
      },
      update: {
        status: "ACTIVE",
        grantedBy: "SUPER_ADMIN",
        revokedAt: null,
        unlockedAt: new Date(),
      },
    });

    this.logger.log(`🎁 Super-admin granted ${type} unlock to org ${organizationId}`);
    return { success: true, unlock };
  }

  async revokeUnlock(organizationId: string, merchantType: string) {
    const type = merchantType.toUpperCase();

    const existing = await this.prisma.merchantUnlock.findUnique({
      where: {
        organizationId_merchantType: { organizationId, merchantType: type },
      },
    });

    if (!existing) {
      throw new NotFoundException(`No unlock found for ${type}`);
    }

    const updated = await this.prisma.merchantUnlock.update({
      where: { id: existing.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    this.logger.log(`🚫 Revoked ${type} unlock for org ${organizationId}`);
    return { success: true, unlock: updated };
  }

  // ─── METRICS (SUPER-ADMIN) ─────────────────────────────

  async getUnlockMetrics() {
    // Count unlocks by type
    const unlocksByType = await this.prisma.merchantUnlock.groupBy({
      by: ["merchantType"],
      where: { status: "ACTIVE" },
      _count: { id: true },
    });

    // Total revenue from unlock purchases
    const purchases = await this.prisma.merchantUnlockPurchase.findMany({
      where: {
        status: "COMPLETED",
      },
      select: { totalAmount: true, merchantType: true },
    });

    const totalRevenue = purchases.reduce(
      (sum, p) => sum + Number(p.totalAmount),
      0,
    );

    const revenueByType: Record<string, number> = {};
    for (const p of purchases) {
      const type = p.merchantType || "UNKNOWN";
      revenueByType[type] = (revenueByType[type] || 0) + Number(p.totalAmount);
    }

    // All unlocks list
    const allUnlocks = await this.prisma.merchantUnlock.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return {
      success: true,
      data: {
        metrics: {
          unlocksByType: unlocksByType.map((u) => ({
            merchantType: u.merchantType,
            count: u._count.id,
          })),
          totalRevenue,
          revenueByType,
          totalActiveUnlocks: unlocksByType.reduce((sum, u) => sum + u._count.id, 0),
        },
        unlocks: allUnlocks,
      },
    };
  }

  async seedUnlockProducts() {
    const existingCount = await this.prisma.merchantUnlockProduct.count();
    if (existingCount > 0) {
      this.logger.log("Unlock products already exist, skipping seed");
      return;
    }

    this.logger.log("Seeding merchant unlock products...");

    const products = [
      {
        merchantType: "PREMIUM_GATEWAY_ACCESS",
        displayName: "Premium Gateway Access",
        description: "Lifetime access to all premium gateways including BharatPe and Google Pay.",
        price: 1999,
        currency: "INR",
        sortOrder: 10,
      },
    ];

    await this.prisma.merchantUnlockProduct.createMany({ data: products });
    this.logger.log("✅ Merchant unlock products seeded successfully");
  }

  private async getPlatformConfig(key: string) {
    // 1. Try explicit DB config first
    const config = await this.prisma.platformConfig.findUnique({
      where: { key },
    });
    if (config?.value && (config.value as any)?.merchantId) {
      return config.value as any;
    }

    // 2. Auto-discover: query merchant-service for any merchant with isPlatform: true
    try {
      this.logger.log("🔍 Platform merchant not in DB config. Auto-discovering...");
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
      if (!merchantServiceUrl) {
        this.logger.error("❌ MERCHANT_SERVICE_URL not set in env");
        return null;
      }

      const response = await axios.get(`${merchantServiceUrl}/merchants/users`, {
        params: { limit: 1 },
        timeout: 5000,
        headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-user-type": "SUPER_ADMIN" }
      });

      const merchants = response.data?.data || response.data?.merchants || [];
      const platformMerchant = merchants.find((m: any) => m.isActive) || merchants[0];

      if (platformMerchant) {
        this.logger.log(`✅ Auto-discovered platform merchant: ${platformMerchant.id} (${platformMerchant.name})`);
        return {
          merchantId: platformMerchant.id,
          organizationId: platformMerchant.organizationId,
        };
      }
    } catch (error: any) {
      this.logger.error("❌ Auto-discovery failed:", error.message);
    }

    return null;
  }
}

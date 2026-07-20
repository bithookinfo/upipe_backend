import { Injectable, Logger } from "@nestjs/common";
import { MerchantService } from "../merchant/merchant.service";
import { PrismaService } from "../../prisma/prisma.service";
import Redis from "ioredis";

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private redis: Redis;

  constructor(
    private readonly merchantService: MerchantService,
    private readonly prisma: PrismaService,
  ) {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || "",
    });
  }

  async routeTransaction(organizationId: string, amount: number) {
    this.logger.log(
      `Routing transaction for Org: ${organizationId}, Amount: ${amount}`,
    );

    if (
      !organizationId ||
      typeof organizationId !== "string" ||
      organizationId.trim() === ""
    ) {
      return {
        success: false,
        message: "organizationId is required",
        reason: "INVALID_INPUT",
      };
    }

    if (amount === undefined || amount === null || typeof amount !== "number") {
      return {
        success: false,
        message: "amount is required and must be a number",
        reason: "INVALID_INPUT",
      };
    }

    if (amount <= 0) {
      return {
        success: false,
        message: "amount must be greater than zero",
        reason: "INVALID_AMOUNT",
      };
    }

    if (amount > 10000000) {
      // 1 crore max
      return {
        success: false,
        message: "amount exceeds maximum allowed (1,00,00,000)",
        reason: "AMOUNT_TOO_HIGH",
      };
    }

    // UUID format validation (simple check)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(organizationId)) {
      return {
        success: false,
        message: "Invalid organization ID format",
        reason: "INVALID_ORG_ID",
      };
    }

    const merchants = await this.prisma.merchant.findMany({
      where: {
        organizationId,
        isActive: true,
        status: "ACTIVE",
        deletedAt: null,
      },
      include: {
        config: true,
        category: true,
        providers: true,
      },
      orderBy: [{ createdAt: "asc" }],
    });

    if (!merchants || merchants.length === 0) {
      return {
        success: false,
        message: "No active merchants found for this organization.",
        reason: "NO_MERCHANTS",
      };
    }

    const candidates = [];
    let fallbackMerchant = null;

    for (const merchant of merchants) {
      if (merchant.isFallback) {
        fallbackMerchant = merchant;
      }

      if (merchant.isFallback) continue;

      const validation =
        await this.merchantService.validateMerchantForTransaction(
          merchant.id,
          merchant.organizationId,
          amount,
          false,
          merchant,
        );
      if (validation.canProcess) {
        const isRateLimitExceeded = await this.isRateLimitExceeded(
          merchant.id,
          merchant.config?.perMinuteMaxTxn,
        );
        if (!isRateLimitExceeded) {
          candidates.push(merchant);
        } else {
          this.logger.warn(`Merchant ${merchant.id} rate limited.`);
        }
      }
    }

    let selectedMerchant = null;

    if (candidates.length > 0) {
      const randomIndex = Math.floor(Math.random() * candidates.length);
      selectedMerchant = candidates[randomIndex];
      
      // Consume rate limit for the actual selected merchant
      await this.consumeRateLimit(selectedMerchant.id, selectedMerchant.config?.perMinuteMaxTxn);

      this.logger.log(
        `Selected Merchant (Randomized): ${selectedMerchant.name} (Priority Ignored)`,
      );
    } else {
      if (fallbackMerchant) {
        this.logger.warn(
          `No valid candidates. Attempting Fallback: ${fallbackMerchant.name}`,
        );
        const fallbackValidation =
          await this.merchantService.validateMerchantForTransaction(
            fallbackMerchant.id,
            fallbackMerchant.organizationId,
            amount,
            false,
            fallbackMerchant,
          );
        if (fallbackValidation.canProcess) {
          const isFallbackLimited = await this.isRateLimitExceeded(
            fallbackMerchant.id,
            fallbackMerchant.config?.perMinuteMaxTxn,
          );
          if (!isFallbackLimited) {
            selectedMerchant = fallbackMerchant;
            await this.consumeRateLimit(selectedMerchant.id, selectedMerchant.config?.perMinuteMaxTxn);
          }
        }
      }
    }

    if (!selectedMerchant) {
      return {
        success: false,
        message: "No suitable merchant found to process this transaction.",
      };
    }

    return {
      success: true,
      merchantId: selectedMerchant.id,
      merchantName: selectedMerchant.name,
      reason: "Routing successful",
    };
  }

  private async isRateLimitExceeded(
    merchantId: string,
    limit: number | null,
  ): Promise<boolean> {
    if (!limit || limit <= 0) return false;

    const key = `rate_limit:${merchantId}:${Math.floor(Date.now() / 60000)}`;
    const current = await this.redis.get(key);
    
    if (current) {
      return parseInt(current, 10) >= limit;
    }
    return false;
  }

  private async consumeRateLimit(
    merchantId: string,
    limit: number | null,
  ): Promise<void> {
    if (!limit || limit <= 0) return;

    const key = `rate_limit:${merchantId}:${Math.floor(Date.now() / 60000)}`;
    const current = await this.redis.incr(key);

    if (current === 1) {
      await this.redis.expire(key, 65);
    }
  }
}

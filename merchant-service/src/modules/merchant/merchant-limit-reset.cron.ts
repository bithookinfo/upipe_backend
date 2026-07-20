import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class MerchantLimitResetCron {
  private readonly logger = new Logger(MerchantLimitResetCron.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs exactly at midnight every day to reset the daily transaction usage
   * for all merchants and unblock those who hit their daily limits.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { name: "reset-merchant-daily-limits", timeZone: "Asia/Kolkata" })
  async resetDailyLimits() {
    this.logger.log("🔄 Starting midnight daily limit reset for all merchants...");
    try {
      const now = new Date();
      
      // Update the merchant config for all merchants:
      // Reset current daily amount and count to 0 and set the last reset time to now.
      const result = await this.prisma.merchantConfig.updateMany({
        data: {
          currentDailyAmount: 0,
          currentDailyTxnCount: 0,
          lastDailyReset: now,
        },
      });
      
      this.logger.log(`✅ Successfully reset daily limits for ${result.count} merchant configs.`);

      // Also reset limits for merchants who were blocked explicitly because of daily limits.
      // The lazy evaluation in checkCanReceiveTransaction also resets them, but since we are doing 
      // a global cron, we proactively reset their status so the frontend shows them as ACTIVE immediately.
      
      const blockedMerchants = await this.prisma.merchant.findMany({
        where: { status: "LIMIT_EXCEEDED" },
        select: { id: true, statusReason: true },
      });

      if (blockedMerchants.length > 0) {
        // Only unblock if it was a DAILY limit block (or if we can't tell, we just unblock and let the next transaction check re-block if monthly)
        // A safer approach: the lazy logic in order-status-cron or merchant.service re-checks monthly anyway.
        const updateCount = await this.prisma.merchant.updateMany({
          where: { status: "LIMIT_EXCEEDED" },
          data: { status: "ACTIVE" },
        });
        this.logger.log(`🔓 Successfully unblocked ${updateCount.count} merchants whose limits were exceeded.`);
      }
      
    } catch (error: any) {
      this.logger.error(`❌ Failed to reset merchant daily limits: ${error?.message}`, error?.stack);
    }
  }
}

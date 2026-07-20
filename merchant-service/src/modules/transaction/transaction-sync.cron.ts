import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TransactionService } from "./transaction.service";
import { PrismaService } from "../../prisma/prisma.service";
import { PhonePeSimpleService } from "../provider/phonepe-simple.service";

@Injectable()
export class TransactionSyncCron {
  private readonly logger = new Logger(TransactionSyncCron.name);

  constructor(
    private readonly transactionService: TransactionService,
    private readonly prisma: PrismaService,
    private readonly phonePeService: PhonePeSimpleService,
  ) {}

  // Offset 2 min from keepalive to avoid simultaneous PhonePe hits
  // Excludes Paytm: handled by syncPaytmFast (5 min) + syncPaytmHistorical (24h)
  @Cron("0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *")
  async syncRecentTransactions() {
    this.logger.log("🔄 Starting recent transaction sync (5 min, PhonePe/BharatPe only)...");

    try {
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
        },
        include: {
          providers: {
          },
        },
      });

      this.logger.log(`Found ${merchants.length} active merchants to sync`);

      const syncableMerchants = merchants.filter(m => 
        m.providers.some(p => p.providerType === "PHONEPE" || p.providerType === "BHARATPE" || p.providerType === "HDFC" || p.providerType === "QUINTUS")
      );

      const CONCURRENCY_LIMIT = 5;
      for (let i = 0; i < syncableMerchants.length; i += CONCURRENCY_LIMIT) {
        const chunk = syncableMerchants.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(
          chunk.map(async (merchant) => {
            try {
              const fromDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
              const toDate = new Date();

              const result = await this.transactionService.syncTransactions(
                merchant.id,
                merchant.organizationId,
                fromDate,
                toDate,
                undefined,
                ["PAYTM", "GPAY"],
              );

              if (result.results.some((r) => r.fetched > 0)) {
                this.logger.log(
                  `✅ Synced recent transactions for merchant ${merchant.id}: ${JSON.stringify(result.results)}`,
                );
              }
            } catch (error) {
              this.logger.error(
                `❌ Failed to sync recent transactions for merchant ${merchant.id}: ${error.message}`,
              );
            }
          })
        );

        if (i + CONCURRENCY_LIMIT < syncableMerchants.length) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }

      this.logger.log("✅ Recent transaction sync completed");
    } catch (error) {
      this.logger.error(`❌ Recent transaction sync failed: ${error.message}`);
    }
  }

  // Every 60s (was 10s) - reduces 429 rate-limit risk from Paytm
  @Cron("0 * * * * *")
  async syncPaytmFast() {
    try {
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
          providers: {
            some: {
              providerType: "PAYTM",
            },
          },
        },
      });

      for (const merchant of merchants) {
        try {
          const fromDate = new Date(Date.now() - 5 * 60 * 1000);
          const toDate = new Date();

          await this.transactionService.syncTransactions(
            merchant.id,
            merchant.organizationId,
            fromDate,
            toDate,
            "PAYTM",
          );
        } catch (error) {
          if (!error.message?.includes("No transactions")) {
            this.logger.error(
              `Failed fast sync for merchant ${merchant.id}: ${error.message}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(`❌ Paytm fast sync failed: ${error.message}`);
    }
  }

  // Every 30 min (5-field: minute */30 = every 30 min)
  @Cron("*/30 * * * *")
  async syncPaytmHistorical() {
    this.logger.log("🕒 Starting Paytm historical sync (30 mins)...");
    try {
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
          providers: {
            some: {
              providerType: "PAYTM",
            },
          },
        },
      });

      for (const merchant of merchants) {
        try {
          const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours
          const toDate = new Date();

          await this.transactionService.syncTransactions(
            merchant.id,
            merchant.organizationId,
            fromDate,
            toDate,
            "PAYTM",
          );
        } catch (error) {
          this.logger.error(
            `Failed historical sync for merchant ${merchant.id}: ${error.message}`,
          );
        }
      }
      this.logger.log("✅ Paytm historical sync completed");
    } catch (error) {
      this.logger.error(`❌ Paytm historical sync failed: ${error.message}`);
    }
  }

  // Excludes Paytm: handled by syncPaytmHistorical (24h every 30 min)
  @Cron(CronExpression.EVERY_HOUR)
  async syncDailyTransactions() {
    this.logger.log("🔄 Starting daily transaction sync (hourly, PhonePe/BharatPe only)...");

    try {
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
        },
        include: {
          providers: {
          },
        },
      });

      for (const merchant of merchants) {
        const hasSyncable = merchant.providers.some(
          (p) => p.providerType === "PHONEPE" || p.providerType === "BHARATPE",
        );
        if (!hasSyncable) continue;

        try {
          const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const toDate = new Date();

          const result = await this.transactionService.syncTransactions(
            merchant.id,
            merchant.organizationId,
            fromDate,
            toDate,
            undefined,
            ["PAYTM", "GPAY"],
          );

          if (result.results.some((r) => r.fetched > 0)) {
            this.logger.log(
              `✅ Daily sync for merchant ${merchant.id}: ${JSON.stringify(result.results)}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `❌ Failed daily sync for merchant ${merchant.id}: ${error.message}`,
          );
        }

        if (merchants.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }

      this.logger.log("✅ Daily transaction sync completed");
    } catch (error) {
      this.logger.error(`❌ Daily transaction sync failed: ${error.message}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async syncFullHistory() {
    this.logger.log("🔄 Starting full history sync (daily at 2 AM)...");

    try {
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
        },
        include: {
          providers: {
          },
        },
      });

      for (const merchant of merchants) {
        const hasSyncable = merchant.providers.some(
          (p) => p.providerType === "PHONEPE" || p.providerType === "BHARATPE",
        );
        if (!hasSyncable) continue;

        try {
          const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          const toDate = new Date();

          const result = await this.transactionService.syncAllTransactions(
            merchant.id,
            merchant.organizationId,
            fromDate,
            toDate,
            ["PAYTM", "GPAY"],
          );

          this.logger.log(
            `✅ Full history sync for merchant ${merchant.id}: fetched ${result.totalFetched}, saved ${result.totalSaved}`,
          );

          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          this.logger.error(
            `❌ Failed full history sync for merchant ${merchant.id}: ${error.message}`,
          );
        }
      }

      this.logger.log("✅ Full history sync completed");
    } catch (error) {
      this.logger.error(`❌ Full history sync failed: ${error.message}`);
    }
  }

  @Cron(CronExpression.EVERY_2_HOURS)
  async checkProviderHealth() {
    this.logger.log("🔍 Starting provider health check (Paytm, PhonePe, BharatPe)...");

    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          merchant: { deletedAt: null },
        },
        include: { merchant: true },
      });

      for (const provider of providers) {
        try {
          const testDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

          if (provider.providerType === "PAYTM") {
            const credentials = provider.credentials as any;
            if (
              !credentials?.merchant_session ||
              !credentials?.merchant_csrftoken
            ) {
              continue;
            }
            try {
              await this.transactionService.syncTransactions(
                provider.merchantId,
                provider.merchant.organizationId,
                testDate,
                new Date(),
                "PAYTM",
              );
              this.logger.log(
                `✅ Paytm session healthy for merchant ${provider.merchantId}`,
              );
            } catch (error) {
              if (
                error.message?.includes("401") ||
                error.message?.includes("403")
              ) {
                this.logger.warn(
                  `⚠️ Paytm session expired for merchant ${provider.merchantId}`,
                );
                await this.prisma.merchantProvider.update({
                  where: { id: provider.id },
                  data: { isActive: false },
                });
              }
            }
          } else if (provider.providerType === "PHONEPE") {
            try {
              await this.transactionService.syncTransactions(
                provider.merchantId,
                provider.merchant.organizationId,
                testDate,
                new Date(),
                "PHONEPE",
              );
              this.logger.log(
                `✅ PhonePe session healthy for merchant ${provider.merchantId}`,
              );
            } catch (error) {
              this.logger.warn(
                `⚠️ PhonePe health check failed for merchant ${provider.merchantId}: ${error.message}`,
              );
            }
          } else if (provider.providerType === "BHARATPE") {
            try {
              await this.transactionService.syncTransactions(
                provider.merchantId,
                provider.merchant.organizationId,
                testDate,
                new Date(),
                "BHARATPE",
              );
              this.logger.log(
                `✅ BharatPe session healthy for merchant ${provider.merchantId}`,
              );
            } catch (error) {
              this.logger.warn(
                `⚠️ BharatPe auth may have expired for merchant ${provider.merchantId}: ${error.message}`,
              );
            }
          }
        } catch (error) {
          this.logger.error(
            `❌ Health check failed for provider ${provider.id}: ${error.message}`,
          );
        }
      }

      this.logger.log("✅ Provider health check completed");
    } catch (error) {
      this.logger.error(`❌ Provider health check failed: ${error.message}`);
    }
  }

  @Cron(CronExpression.EVERY_WEEK)
  async cleanupOldData() {
    this.logger.log("🧹 Starting data cleanup...");

    try {
      this.logger.log("📊 Data cleanup completed (placeholder)");
    } catch (error) {
      this.logger.error(`❌ Data cleanup failed: ${error.message}`);
    }
  }

  // Offset 4 min from syncRecent to stagger PhonePe load
  @Cron("0 4,14,24,34,44,54 * * * *")
  async syncPhonePeUpiIds() {
    this.logger.log("🔄 Starting PhonePe UPI ID sync...");

    try {
      // Get all active merchants with ACTIVE PhonePe providers (exclude EXPIRED — can't sync)
      const merchants = await this.prisma.merchant.findMany({
        where: {
          deletedAt: null,
          providers: {
            some: {
              providerType: "PHONEPE",
              status: "ACTIVE",
            },
          },
        },
        include: {
          providers: {
            where: {
              providerType: "PHONEPE",
              status: "ACTIVE",
            },
          },
        },
        take: 50,
      });

      this.logger.log(`Found ${merchants.length} merchants to sync UPI IDs`);

      for (const merchant of merchants) {
        for (const provider of merchant.providers) {
          try {
            const credentials = provider.credentials as any;

            // Skip if already has UPI ID
            if (credentials?.upiId && provider.accountIdentifier) {
              continue;
            }

            if (!credentials?.token || !credentials?.deviceFingerprint) {
              continue;
            }

            const method = credentials?.method || credentials?.authMethod;
            const csrfToken = credentials?.csrfToken;
            const cookiesString = credentials?.cookiesString;

            this.logger.log(
              `🔍 Fetching UPI ID for merchant ${merchant.id} (${merchant.name})...`,
            );

            const response = await this.phonePeService.fetchMerchantUpiId(
              credentials.token,
              credentials.deviceFingerprint,
              credentials.groupValue,
              credentials.unitId,
              credentials.refreshToken,
              credentials.fingerprint,
              credentials.groupId,
              cookiesString,
              csrfToken,
              method,
            );

            const {
              upiId,
              transactions,
              refreshedToken,
              refreshedRefreshToken,
              csrfToken: newCsrf,
              cookiesString: newCookies,
            } = response;

            const hasSessionUpdate =
              refreshedToken ||
              (newCsrf && newCsrf !== csrfToken) ||
              (newCookies && newCookies !== cookiesString);

            if (hasSessionUpdate) {
              try {
                const latestProvider = await this.prisma.merchantProvider.findUnique({
                  where: { id: provider.id },
                  select: { credentials: true }
                });
                const latestCreds: any = latestProvider?.credentials || credentials;

                const dbChangedAuth = latestCreds.token !== credentials.token || latestCreds.refreshToken !== credentials.refreshToken;

                const newToken = refreshedToken || latestCreds.token;
                const newRefreshToken = refreshedRefreshToken || latestCreds.refreshToken;
                const newCsrfToken = newCsrf || latestCreds.csrfToken;
                
                let newCookiesString = latestCreds.cookiesString;
                if (refreshedToken || refreshedRefreshToken) {
                    newCookiesString = newCookies || latestCreds.cookiesString;
                } else if (!dbChangedAuth && newCookies && newCookies !== credentials.cookiesString) {
                    newCookiesString = newCookies;
                }

                await this.prisma.merchantProvider.update({
                  where: { id: provider.id },
                  data: {
                    credentials: {
                      ...latestCreds,
                      token: newToken,
                      refreshToken: newRefreshToken,
                      csrfToken: newCsrfToken,
                      cookiesString: newCookiesString,
                      credentials: {
                        ...(latestCreds.credentials || {}),
                        token: newToken,
                        refreshToken: newRefreshToken,
                        csrfToken: newCsrfToken,
                        cookiesString: newCookiesString,
                      },
                      verifiedAt: new Date(),
                    },
                  },
                });
                this.logger.log(
                  `🔄 Persisted updated PhonePe session metadata during UPI ID sync for provider ${provider.id}`,
                );
              } catch (e) {
                this.logger.warn(
                  `Could not persist updated PhonePe session metadata during UPI ID sync: ${e?.message}`,
                );
              }
            }

            if (transactions && transactions.length > 0) {
              try {
                this.logger.log(
                  `💾 Saving ${transactions.length} initial transactions for merchant ${merchant.id}...`,
                );
                const savedCount =
                  await this.transactionService.processAndSavePhonePeTransactions(
                    merchant.id,
                    provider.id,
                    transactions,
                  );
                this.logger.log(
                  `✅ Saved ${savedCount} initial transactions for merchant ${merchant.id}`,
                );
              } catch (saveError) {
                this.logger.error(
                  `Failed to save initial transactions: ${saveError.message}`,
                );
              }
            }

            if (upiId && upiId !== provider.accountIdentifier) {
              // Update provider with fetched UPI ID
              const latestProvider = await this.prisma.merchantProvider.findUnique({
                where: { id: provider.id },
                select: { credentials: true },
              });
              const latestCreds = (latestProvider?.credentials as any) || credentials;

              await this.prisma.merchantProvider.update({
                where: { id: provider.id },
                data: {
                  accountIdentifier: upiId,
                  credentials: {
                    ...latestCreds,
                    upiId: upiId,
                  },
                },
              });

              this.logger.log(
                `✅ Updated merchant ${merchant.id} PhonePe UPI ID: ${upiId}`,
              );
            } else if (!upiId) {
              this.logger.warn(
                `⚠️ No UPI ID found for merchant ${merchant.id}, will retry later`,
              );
            }
          } catch (error: any) {
            this.logger.error(
              `Failed to sync UPI ID for merchant ${merchant.id}:`,
              error.message,
            );
          }
        }
      }

      this.logger.log("✅ PhonePe UPI ID sync completed");
    } catch (error: any) {
      if (error.message?.includes("400") || error.message?.includes("412")) {
        this.logger.warn(
          `⚠️ PhonePe UPI ID sync partial failure (likely missing checksum): ${error.message}`,
        );
      } else {
        this.logger.error(`❌ PhonePe UPI ID sync failed: ${error.message}`);
      }
    }
  }

  // Removed: warmPhonePeSessionsHeartbeat - redundant with PhonePeKeepaliveCron (every 5 min)
}

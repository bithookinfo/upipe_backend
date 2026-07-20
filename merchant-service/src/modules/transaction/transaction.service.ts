import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PaytmSimpleService } from "../provider/paytm-simple.service";
import { PhonePeSimpleService } from "../provider/phonepe-simple.service";
import { BharatPeSimpleService } from "../provider/bharatpe-simple.service";
import { QuintusPaySimpleService } from "../provider/quintuspay-simple.service";
import { GpayService } from "../gpay/gpay.service";
import { HdfcVyaparService } from "../provider/hdfc-vyapar.service";
import {
  formatPhonePeSessionSignals,
  generateDeterministicPhonePeFingerprint,
  getPhonePeSessionSignals,
  shouldTreatAsTransientPhonePeSessionDrift,
} from "../provider/phonepe-session.util";

const SYNC_BUFFER_MS = 30 * 60 * 1000;
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);
  private readonly paytmSessionExpireThreshold = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paytmService: PaytmSimpleService,
    private readonly phonepeService: PhonePeSimpleService,
    private readonly bharatpeService: BharatPeSimpleService,
    private readonly quintusPayService: QuintusPaySimpleService,
    private readonly gpayService: GpayService,
    private readonly hdfcService: HdfcVyaparService,
  ) {}

  async getTransactions(
    merchantId: string,
    organizationId: string,
    page: number = 1,
    limit: number = 50,
    fromDate?: Date,
    toDate?: Date,
    status?: string,
  ) {
    try {
      // Verify merchant exists, belongs to organization, and is not soft-deleted
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
      });

      if (!merchant || merchant.deletedAt) {
        throw new NotFoundException("Merchant not found");
      }

      this.logger.log(`Fetching transactions for merchant ${merchantId}`);

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const axios = require("axios");

      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
        merchantId: merchantId,
      });

      if (fromDate) params.append("fromDate", fromDate.toISOString());
      if (toDate) params.append("toDate", toDate.toISOString());
      if (status) params.append("status", status);

      const response = await axios.get(
        `${paymentServiceUrl}/transactions?${params.toString()}`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
      );

      if (response.data && response.data.success) {
        return response.data;
      }

      return {
        success: true,
        transactions: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
        message: "No transactions found",
      };
    } catch (error) {
      this.logger.error(`Failed to fetch transactions: ${error.message}`);
      throw error;
    }
  }

  async syncTransactions(
    merchantId: string,
    organizationId: string,
    fromDate: Date,
    toDate: Date,
    providerType?: string,
    excludeProviderTypes?: string[],
  ) {
    try {
      this.logger.log(
        `Syncing transactions for merchant ${merchantId}${providerType ? ` (Provider: ${providerType})` : ""}${excludeProviderTypes?.length ? ` (excluding: ${excludeProviderTypes.join(", ")})` : ""}`,
      );

      // Get merchant with providers (exclude EXPIRED — can't sync)
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          providers: {
            where: {
              status: "ACTIVE",
              ...(providerType
                ? { providerType: providerType as any }
                : excludeProviderTypes?.length
                  ? { providerType: { notIn: excludeProviderTypes as any[] } }
                  : {}),
            },
          },
        },
      });

      if (!merchant || merchant.deletedAt) {
        throw new NotFoundException("Merchant not found");
      }

      const results: any[] = [];

      await Promise.all(merchant.providers.map(async (provider) => {
        const meta = (provider.metadata as any) || {};

        // Skip BharatPe provider if we previously marked auth as unauthorized
        if (
          provider.providerType === "BHARATPE" &&
          meta?.authError === "UNAUTHORIZED"
        ) {
          this.logger.warn(
            `Skipping BharatPe provider ${provider.id} for merchant ${merchantId} due to authError=UNAUTHORIZED`,
          );
          results.push({
            provider: "BHARATPE",
            success: false,
            error: "BharatPe auth expired. Please reconnect this merchant.",
          });
          return;
        }

        // Diagnostic log: check if provider is active
        if (provider.status !== "ACTIVE") {
          this.logger.warn(`⚠️ Skipping provider ${provider.providerType} (${provider.id}) because its status is ${provider.status} (Expected: ACTIVE)`);
        }

        const effectiveFrom =
          provider.lastSyncedAt &&
          typeof provider.lastSyncedAt.getTime === "function"
            ? new Date(
                Math.max(
                  // Prefer lastSyncedAt minus buffer to avoid gaps,
                  // but never go earlier than MAX_LOOKBACK_MS.
                  provider.lastSyncedAt.getTime() - SYNC_BUFFER_MS,
                  toDate.getTime() - MAX_LOOKBACK_MS,
                ),
              )
            : fromDate;

        if (provider.providerType === "PAYTM") {
          try {
            const paytmResult = await this.syncPaytmTransactions(
              provider,
              effectiveFrom,
              toDate,
            );

            results.push({
              provider: "PAYTM",
              success: true,
              fetched: paytmResult.fetched || 0,
              saved: paytmResult.saved || 0,
              message: paytmResult.message || "Paytm sync completed",
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync Paytm transactions: ${error.message}`,
            );
            results.push({
              provider: "PAYTM",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "PHONEPE") {
          try {
            const phonepeResult = await this.syncPhonePeTransactions(
              provider,
              effectiveFrom,
              toDate,
            );
            results.push({
              provider: "PHONEPE",
              success: true,
              fetched: phonepeResult.fetched || 0,
              saved: phonepeResult.saved || 0,
              message: phonepeResult.message || "PhonePe sync completed",
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync PhonePe transactions: ${error.message}`,
            );
            results.push({
              provider: "PHONEPE",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "BHARATPE") {
          try {
            const bharatpeResult = await this.syncBharatPeTransactions(
              provider,
              effectiveFrom,
              toDate,
            );

            results.push({
              provider: "BHARATPE",
              success: true,
              fetched: bharatpeResult.fetched || 0,
              saved: bharatpeResult.saved || 0,
              message: bharatpeResult.message || "BharatPe sync completed",
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync BharatPe transactions: ${error.message}`,
            );
            results.push({
              provider: "BHARATPE",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "GPAY") {
          try {
            const gpayResult = await this.syncGPayTransactions(
              provider,
              effectiveFrom,
              toDate,
            );
            if (gpayResult.success) {
              this.logger.log(`📊 GPay sync for ${provider.id}: ${gpayResult.fetched} fetched, ${gpayResult.saved} saved. message: ${gpayResult.message}`);
            }
            results.push({
              provider: "GPAY",
              success: true,
              fetched: gpayResult.fetched || 0,
              saved: gpayResult.saved || 0,
              message: gpayResult.message || "GPay sync completed",
            });
          } catch (error: any) {
            this.logger.error(
              `Failed to sync GPay transactions: ${error.message}`,
            );
            // GPay uses persistent browser sessions — NEVER mark as EXPIRED from sync code.
            // The browser session is in-memory; if it's gone the sync just returns empty results.
            this.logger.warn(`⚠️ GPay sync error for provider ${provider.id} — NOT marking EXPIRED (browser session is in-memory)`);
            results.push({
              provider: "GPAY",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "HDFC") {
          try {
            const hdfcResult = await this.syncHdfcTransactions(
              provider,
              effectiveFrom,
              toDate,
            );
            results.push({
              provider: "HDFC",
              success: true,
              fetched: hdfcResult.fetched || 0,
              saved: hdfcResult.saved || 0,
              message: hdfcResult.message || "HDFC sync completed",
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync HDFC transactions: ${error.message}`,
            );
            results.push({
              provider: "HDFC",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "QUINTUS") {
          try {
            const quintusResult = await this.syncQuintusTransactions(
              provider,
              effectiveFrom,
              toDate,
            );
            results.push({
              provider: "QUINTUS",
              success: true,
              fetched: quintusResult.fetched || 0,
              saved: quintusResult.saved || 0,
              message: quintusResult.message || "QuintusPay sync completed",
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync QuintusPay transactions: ${error.message}`,
            );
            results.push({
              provider: "QUINTUS",
              success: false,
              error: error.message,
            });
          }
        }
      }));

      return {
        success: true,
        merchantId,
        results,
        message: "Transaction sync completed",
      };
    } catch (error) {
      this.logger.error(`Failed to sync transactions: ${error.message}`);
      throw error;
    }
  }

  async syncAllTransactions(
    merchantId: string,
    organizationId: string,
    fromDate: Date,
    toDate: Date,
    excludeProviders: string[] = [],
  ) {
    try {
      this.logger.log(
        `Syncing ALL transaction history for merchant ${merchantId}`,
      );

      // Get merchant with providers
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
        include: {
          providers: true,
        },
      });

      if (!merchant) {
        throw new NotFoundException("Merchant not found");
      }

      const results: any[] = [];
      let totalFetched = 0;
      let totalSaved = 0;

      // Sync from each provider with 31-day chunks for full history
      for (const provider of merchant.providers) {
        if (excludeProviders.includes(provider.providerType)) {
          this.logger.log(
            `Skipping provider ${provider.providerType} for merchant ${merchantId} (excluded)`,
          );
          continue;
        }

        const meta = (provider.metadata as any) || {};

        // Skip BharatPe provider if we previously marked auth as unauthorized
        if (
          provider.providerType === "BHARATPE" &&
          meta?.authError === "UNAUTHORIZED"
        ) {
          this.logger.warn(
            `Skipping BharatPe provider ${provider.id} for merchant ${merchantId} due to authError=UNAUTHORIZED`,
          );
          results.push({
            provider: "BHARATPE",
            success: false,
            error: "BharatPe auth expired. Please reconnect this merchant.",
          });
          continue;
        }

        if (provider.providerType === "PAYTM") {
          try {
            // Split date range into 31-day chunks (Paytm API limitation)
            const chunks = this.splitDateRangeIntoChunks(fromDate, toDate, 31);

            for (const chunk of chunks) {
              let page = 1;
              let hasMore = true;

              while (hasMore && page <= 10) {
                // Max 10 pages per chunk
                const paytmResult = await this.syncPaytmTransactions(
                  provider,
                  chunk.from,
                  chunk.to,
                  50, // 50 per page
                  page,
                );

                totalFetched += paytmResult.fetched || 0;
                totalSaved += paytmResult.saved || 0;

                hasMore = (paytmResult.fetched || 0) >= 50;
                page++;

                if (hasMore) {
                  await new Promise((resolve) => setTimeout(resolve, 500));
                }
              }

              await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            results.push({
              provider: "PAYTM",
              success: true,
              fetched: totalFetched,
              saved: totalSaved,
              chunks: chunks.length,
              message: `Fetched ${totalFetched} transactions from Paytm in ${chunks.length} chunks, saved ${totalSaved}`,
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync all Paytm transactions: ${error.message}`,
            );
            results.push({
              provider: "PAYTM",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "PHONEPE") {
          try {
            let page = 1;
            let hasMore = true;

            while (hasMore && page <= 20) {
              const phonepeResult = await this.syncPhonePeTransactions(
                provider,
                fromDate,
                toDate,
                50,
                page,
              );

              totalFetched += phonepeResult.fetched || 0;
              totalSaved += phonepeResult.saved || 0;

              // If we got less than 50, we've reached the end
              hasMore = (phonepeResult.fetched || 0) >= 50;
              page++;

              // Small delay between requests to avoid rate limiting
              if (hasMore) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
          } catch (error) {
            this.logger.error(
              `Failed to sync all PhonePe transactions: ${error.message}`,
            );
            results.push({
              provider: "PHONEPE",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "BHARATPE") {
          try {
            // No page limit known for BharatPe, but let's assume it returns all in date range or handle pagination if api supports
            // The service we built implementation fetches all for date range
            const bharatpeResult = await this.syncBharatPeTransactions(
              provider,
              fromDate,
              toDate,
            );

            totalFetched += bharatpeResult.fetched || 0;
            totalSaved += bharatpeResult.saved || 0;

            results.push({
              provider: "BHARATPE",
              success: true,
              fetched: bharatpeResult.fetched || 0,
              saved: bharatpeResult.saved || 0,
              message: `Fetched ${bharatpeResult.fetched || 0} transactions from BharatPe, saved ${bharatpeResult.saved || 0}`,
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync all BharatPe transactions: ${error.message}`,
            );
            results.push({
              provider: "BHARATPE",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "GPAY") {
          try {
            // GPay usually allows fetching larger history, let's try chunks
            const chunks = this.splitDateRangeIntoChunks(fromDate, toDate, 31);
            for (const chunk of chunks) {
              const gpayResult = await this.syncGPayTransactions(
                provider,
                chunk.from,
                chunk.to,
              );
              totalFetched += gpayResult.fetched || 0;
              totalSaved += gpayResult.saved || 0;
              
              if (chunks.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
            if (totalFetched > 0) {
              this.logger.log(`📊 GPay syncAll for ${provider.id}: ${totalFetched} fetched, ${totalSaved} saved across ${chunks.length} chunks`);
            }
            results.push({
              provider: "GPAY",
              success: true,
              fetched: totalFetched,
              saved: totalSaved,
              message: `Fetched ${totalFetched} GPay transactions across ${chunks.length} chunks`,
            });
          } catch (error: any) {
            this.logger.error(
              `Failed to sync all GPay transactions: ${error.message}`,
            );
            // GPay uses persistent browser sessions — NEVER mark as EXPIRED from sync code.
            this.logger.warn(`⚠️ GPay syncAll error for provider ${provider.id} — NOT marking EXPIRED (browser session is in-memory)`);
            results.push({
              provider: "GPAY",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "HDFC") {
          try {
            const chunks = this.splitDateRangeIntoChunks(fromDate, toDate, 30);
            for (const chunk of chunks) {
              const hdfcResult = await this.syncHdfcTransactions(
                provider,
                chunk.from,
                chunk.to,
              );
              totalFetched += hdfcResult.fetched || 0;
              totalSaved += hdfcResult.saved || 0;
              
              if (chunks.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
            results.push({
              provider: "HDFC",
              success: true,
              fetched: totalFetched,
              saved: totalSaved,
              message: `Fetched ${totalFetched} HDFC transactions, saved ${totalSaved} across ${chunks.length} chunks`,
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync all HDFC transactions: ${error.message}`,
            );
            results.push({
              provider: "HDFC",
              success: false,
              error: error.message,
            });
          }
        } else if (provider.providerType === "QUINTUS") {
          try {
            const quintusResult = await this.syncQuintusTransactions(
              provider,
              fromDate,
              toDate,
            );
            totalFetched += quintusResult.fetched || 0;
            totalSaved += quintusResult.saved || 0;
            results.push({
              provider: "QUINTUS",
              success: true,
              fetched: quintusResult.fetched || 0,
              saved: quintusResult.saved || 0,
              message: `Fetched ${quintusResult.fetched || 0} QuintusPay transactions, saved ${quintusResult.saved || 0}`,
            });
          } catch (error) {
            this.logger.error(
              `Failed to sync all QuintusPay transactions: ${error.message}`,
            );
            results.push({
              provider: "QUINTUS",
              success: false,
              error: error.message,
            });
          }
        }
      }

      return {
        success: true,
        merchantId,
        results,
        totalFetched,
        totalSaved,
        message: `Complete transaction history sync: ${totalFetched} fetched, ${totalSaved} saved`,
      };
    } catch (error) {
      this.logger.error(`Failed to sync all transactions: ${error.message}`);
      throw error;
    }
  }

  private splitDateRangeIntoChunks(
    fromDate: Date,
    toDate: Date,
    maxDays: number,
  ) {
    const chunks: { from: Date; to: Date }[] = [];
    const msPerDay = 24 * 60 * 60 * 1000;
    const maxMs = maxDays * msPerDay;

    let currentFrom = new Date(fromDate);

    while (currentFrom < toDate) {
      const currentTo = new Date(
        Math.min(currentFrom.getTime() + maxMs, toDate.getTime()),
      );
      chunks.push({
        from: new Date(currentFrom),
        to: new Date(currentTo),
      });
      currentFrom = new Date(currentTo.getTime() + 1); // Start next chunk 1ms after current ends
    }

    return chunks;
  }

  private async syncPaytmTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
    pageSize: number = 50,
    pageNum: number = 1,
  ) {
    const credentials = provider.credentials as any;

    const merchantSession =
      credentials.merchant_session || credentials.merchantSession;
    const merchantCsrfToken =
      credentials.merchant_csrftoken || credentials.merchantCsrfToken;

    if (!merchantSession || !merchantCsrfToken) {
      throw new Error("Paytm session credentials not found");
    }

    // Fetch transactions from Paytm
    const response = await this.paytmService.fetchTransactionHistory(
      merchantSession,
      merchantCsrfToken,
      fromDate,
      toDate,
      pageNum,
      pageSize,
    );

    if (!response.success) {
      const paytmAuth403 =
        response.sessionExpired ||
        (response.statusCode === 403 && !response.infrastructureBlock);
      if (paytmAuth403) {
        try {
          const currentHits = Number(credentials.paytmSessionExpiredHits || 0);
          const nextHits = currentHits + 1;
          const expireNow = nextHits >= this.paytmSessionExpireThreshold;

          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              status: expireNow ? "EXPIRED" : "ACTIVE",
              credentials: {
                ...credentials,
                paytmSessionExpiredHits: nextHits,
              },
            },
          });

          if (expireNow) {
            this.logger.warn(
              `🚫 Paytm session expired for provider ${provider.id}. Marked as EXPIRED after ${nextHits} consecutive 403 responses.`,
            );
          } else {
            this.logger.warn(
              `⚠️ Paytm sessionExpired for provider ${provider.id} (${nextHits}/${this.paytmSessionExpireThreshold}). Keeping ACTIVE until threshold.`,
            );
          }
        } catch (e: any) {
          this.logger.error(
            `Failed to update Paytm session-expired state for provider ${provider.id}: ${e?.message}`,
          );
        }
      }

      return {
        success: false,
        error: response.error || "Failed to fetch transactions",
      };
    }

    if (Number(credentials.paytmSessionExpiredHits || 0) > 0) {
      try {
        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            status: "ACTIVE",
            credentials: {
              ...credentials,
              paytmSessionExpiredHits: 0,
            },
          },
        });
      } catch (e: any) {
        this.logger.warn(
          `Could not reset Paytm session-expired counter for provider ${provider.id}: ${e?.message}`,
        );
      }
    }

    const transactions = response.transactions || [];
    let savedCount = 0;

    if (transactions.length > 0) {
      try {
        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;

        const CONCURRENCY_LIMIT = 10;
        const chunks = [];
        for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
            chunks.push(transactions.slice(i, i + CONCURRENCY_LIMIT));
        }

        for (const chunk of chunks) {
          await Promise.allSettled(
            chunk.map(async (txn) => {
              try {
                let amount = 0;
                if (txn.payMoneyAmount?.value) {
                  amount = parseFloat(txn.payMoneyAmount.value) / 100;
                } else if (txn.payAmount?.value) {
                  amount = parseFloat(txn.payAmount.value) / 100;
                } else if (txn.additionalInfo?.txnAmount?.value) {
                  amount = parseFloat(txn.additionalInfo.txnAmount.value) / 100;
                } else if (txn.amount) {
                  amount = parseFloat(txn.amount) / 100;
                }

                const customerName =
                  txn.additionalInfo?.customerName || txn.nickName || "N/A";
                const customerMobile =
                  txn.additionalInfo?.virtualPaymentAddr ||
                  txn.oppositeUserId ||
                  null;

                const orderData = {
                  externalOrderId:
                    txn.bizOrderId ||
                    txn.merchantTransId ||
                    `paytm-${txn.bizOrderId}`,
                  merchantId: provider.merchantId,
                  providerId: provider.id,
                  amount: amount,
                  currency: "INR",
                  status: this.mapPaytmStatus(txn.orderStatus),
                  paymentMethod: "UPI",
                  customerName: customerName,
                  customerMobile: customerMobile,
                  completedAt: txn.orderCompletedTime
                    ? new Date(txn.orderCompletedTime)
                    : new Date(),
                };

                const axios = require("axios");
                const syncPayload = {
                  merchantId: provider.merchantId,
                  providerId: provider.id,
                  externalTransactionId: txn.bizOrderId || txn.merchantTransId,
                  amount: amount,
                  currency: "INR",
                  status:
                    this.mapPaytmStatus(txn.orderStatus) === "COMPLETED"
                      ? "SUCCESS"
                      : this.mapPaytmStatus(txn.orderStatus) === "FAILED"
                        ? "FAILED"
                        : "PENDING",
                  paymentMethod: "UPI",
                  providerCode: "PAYTM",
                  providerResponse: txn,

                  customerName:
                    txn.additionalInfo?.customerName || txn.nickName || null,
                  customerContact: txn.additionalInfo?.virtualPaymentAddr || null,

                  utr: txn.bankTxnId || txn.merchantTransId || null,
                  paymentApp: txn.additionalInfo?.payerPSP || null,

                  createdAt: txn.orderCreatedTime
                    ? new Date(txn.orderCreatedTime)
                    : new Date(),
                  completedAt: txn.orderCompletedTime
                    ? new Date(txn.orderCompletedTime)
                    : null,

                  paytmOrderId: txn.bizOrderId,
                  paytmMerchantTransId: txn.merchantTransId,
                  collectionMode:
                    txn.additionalInfo?.collectionMode || txn.collectionMode,
                };

                const response = await axios.post(
                  `${paymentServiceUrl}/transactions/sync`,
                  syncPayload,
                  { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }
                );
                
                if (response.data && response.data.success) {
                  if (!response.data.skipped) {
                    savedCount++;
                  }
                }
              } catch (saveError) {
                this.logger.error(
                  `Failed to save transaction ${txn.bizOrderId}:`,
                  saveError.message,
                );
              }
            })
          );
        }
      } catch (error) {
        this.logger.error(
          "Failed to sync transactions to payment service:",
          error.message,
        );
      }
    }

    try {
      const meta = (provider.metadata as Record<string, unknown>) || {};
      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: {
          lastSyncedAt: toDate,
          metadata: { ...meta, lastSync: toDate },
        },
      });
    } catch (e) {
      this.logger.warn(
        `Could not persist lastSyncedAt for Paytm provider ${provider.id}: ${e?.message}`,
      );
    }

    return {
      success: true,
      fetched: transactions.length,
      saved: savedCount,
      message: `Fetched ${transactions.length} transactions from Paytm, saved ${savedCount}`,
    };
  }

  private mapPaytmStatus(paytmStatus: string): string {
    const statusMap: Record<string, string> = {
      TXN_SUCCESS: "COMPLETED",
      TXN_FAILURE: "FAILED",
      PENDING: "PENDING",
      SUCCESS: "COMPLETED",
      FAILED: "FAILED",
    };
    return statusMap[paytmStatus?.toUpperCase()] || "PENDING";
  }

  async getTransactionStats(merchantId: string, organizationId: string) {
    try {
      const merchant = await this.prisma.merchant.findFirst({
        where: { id: merchantId, organizationId },
      });

      if (!merchant || merchant.deletedAt) {
        throw new NotFoundException("Merchant not found");
      }

      try {
        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
        const axios = require("axios");

        const response = await axios.get(
          `${paymentServiceUrl}/dashboard/transactions/stats?merchantId=${merchantId}`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );

        if (response.data && response.data.success) {
          return {
            success: true,
            stats: response.data.stats,
            message: "Transaction stats retrieved successfully",
          };
        }
      } catch (error) {
        this.logger.warn(
          `Failed to fetch stats from payment service: ${error.message}`,
        );
      }

      // Fallback to basic stats
      return {
        success: true,
        stats: {
          totalTransactions: 0,
          totalAmount: 0,
          successfulTransactions: 0,
          failedTransactions: 0,
          pendingTransactions: 0,
          todayTransactions: 0,
          todayAmount: 0,
        },
        message: "Basic stats (payment service unavailable)",
      };
    } catch (error) {
      this.logger.error(`Failed to fetch transaction stats: ${error.message}`);
      throw error;
    }
  }

  async getDashboardTransactions(
    page: number = 1,
    limit: number = 50,
    merchantId?: string,
  ) {
    try {
      this.logger.log(
        `Fetching dashboard transactions (page: ${page}, limit: ${limit})`,
      );

      // For now, return empty array
      // In production, query from transactions table
      return {
        success: true,
        transactions: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
        message: "Transaction history coming soon",
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch dashboard transactions: ${error.message}`,
      );
      throw error;
    }
  }

  async getProviderTransactions(
    provider: string,
    merchantId?: string,
    connectorId?: string,
    page: number = 1,
    limit: number = 100,
  ) {
    try {
      this.logger.log(
        `Fetching ${provider} transactions for merchant ${merchantId}`,
      );

      if (!merchantId) {
        return {
          success: false,
          error: "Merchant ID is required",
        };
      }

      const merchant = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        include: {
          providers: {
            where: connectorId ? { id: connectorId } : {},
          },
        },
      });

      if (!merchant) {
        throw new NotFoundException("Merchant not found");
      }

      const providerData = merchant.providers.find(
        (p) => p.providerType.toLowerCase() === provider.toLowerCase(),
      );

      if (!providerData) {
        return {
          success: false,
          error: `${provider} provider not connected`,
        };
      }

      return {
        success: true,
        transactions: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
        provider: provider.toUpperCase(),
        message: "Transaction fetching from provider coming soon",
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch ${provider} transactions: ${error.message}`,
      );
      throw error;
    }
  }

  async processAndSavePhonePeTransactions(
    merchantId: string,
    providerId: string,
    transactions: any[],
  ) {
    let savedCount = 0;
    const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
    const axios = require("axios");

    if (transactions.length > 0) {
      try {
        const CONCURRENCY_LIMIT = 10;
        for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
          const chunk = transactions.slice(i, i + CONCURRENCY_LIMIT);
          await Promise.allSettled(
            chunk.map(async (txn) => {
              try {
            // Extract amount (PhonePe amounts are in paise, convert to rupees)
            const amount = Number(txn.amount) / 100;

            // Extract customer info
            const customerName = txn.customerDetails?.userName || "N/A";
            const customerVpa = txn.instrumentDetails?.[0]?.vpa || "N/A";
            const paymentApp = txn.paymentApp?.displayText || "PhonePe";

            const syncPayload: Record<string, any> = {
              merchantId: merchantId,
              providerId: providerId,
              externalTransactionId: txn.transactionId,
              amount: amount,
              currency: "INR",
              status: this.mapPhonePeStatus(txn.paymentState),
              paymentMethod: "UPI",
              providerCode: "PHONEPE",
              providerResponse: txn, // FULL PhonePe JSON

              // Customer Details
              customerName: customerName,
              customerContact: customerVpa,

              // Payment Details
              utr: txn.utr || null,
              paymentApp: paymentApp,

              // Timestamps
              createdAt: txn.transactionDate
                ? new Date(txn.transactionDate)
                : new Date(),
              completedAt:
                txn.paymentState === "COMPLETED"
                  ? txn.transactionDate
                    ? new Date(txn.transactionDate)
                    : new Date()
                  : null,
            };
            // So payment-service can resolve order and complete EXPIRED → COMPLETED
            if (txn.merchantTransactionId)
              syncPayload.merchantTransactionId = txn.merchantTransactionId;

            this.logger.debug(`Sending PhonePe txn to payment-service:`, {
              externalId: syncPayload.externalTransactionId,
              amount: syncPayload.amount,
              status: syncPayload.status,
              customerName: syncPayload.customerName,
              customerContact: syncPayload.customerContact,
              paymentApp: syncPayload.paymentApp,
              createdAt: syncPayload.createdAt,
            });

            const response = await axios.post(
              `${paymentServiceUrl}/transactions/sync`,
              syncPayload, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
            );

                if (response.data && response.data.success) {
                  if (!response.data.skipped) {
                    savedCount++;
                  }
                }
              } catch (saveError) {
                this.logger.error(
                  `Failed to save PhonePe transaction ${txn.transactionId}:`,
                  saveError.message,
                );
              }
            })
          );
        }
      } catch (error) {
        this.logger.error(
          "Failed to sync PhonePe transactions to payment service:",
          error.message,
        );
      }
    }

    return savedCount;
  }

  private async syncPhonePeTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
    pageSize: number = 50,
    pageNum: number = 1,
  ) {
    const credentials = provider.credentials as any;

    // Support both web-api and android-api flows
    const method = credentials.method || credentials.authMethod;
    const csrfToken = credentials.csrfToken;
    const cookiesString = credentials.cookiesString;

    const token = credentials.credentials?.token || credentials.token;
    const deviceFingerprint = credentials.deviceFingerprint;
    const refreshToken =
      credentials.credentials?.refreshToken || credentials.refreshToken;
    let groupValue =
      credentials.credentials?.groupValue || credentials.groupValue;
    let groupId = credentials.credentials?.groupId ?? credentials.groupId;
    let fingerprint =
      credentials.credentials?.fingerprint ?? credentials.fingerprint;

    // Fallback: credentials may have been saved without groupValue/groupId/fingerprint (e.g. old flow). Use metadata from connect.
    if (provider.metadata) {
      const meta = provider.metadata as any;
      const accountDetails = meta.phonePeAccountDetails;
      if (accountDetails) {
        if (groupValue == null) {
          groupValue =
            accountDetails.groupValue ?? accountDetails.groups?.[0]?.groupValue;
          if (groupValue)
            this.logger.log(
              `PhonePe groupValue resolved from provider metadata for merchant ${provider.merchantId}`,
            );
        }
        if (groupId == null)
          groupId =
            accountDetails.groupId ?? accountDetails.groups?.[0]?.groupId;
        if (fingerprint == null) fingerprint = accountDetails.fingerprint;
      }
    }

    // Hardening: ensure web-api flow always uses a deterministic, persisted fingerprint.
    // This reduces 412s caused by identity drift across restarts.
    if ((method || "").toLowerCase() === "web-api" && !fingerprint) {
      try {
        const seed = String(
          credentials.phoneNumber ||
            credentials.credentials?.phoneNumber ||
            provider.accountIdentifier ||
            provider.id,
        );
        fingerprint = generateDeterministicPhonePeFingerprint(seed);
        this.logger.log(
          `PhonePe web-api fingerprint missing; generated deterministic fingerprint for provider ${provider.id} (seeded).`,
        );
      } catch (e: any) {
        this.logger.warn(
          `Could not generate PhonePe web fingerprint fallback: ${e?.message}`,
        );
      }
    }

    // Persist generated fingerprint so future syncs stay stable.
    if (
      (method || "").toLowerCase() === "web-api" &&
      fingerprint &&
      (credentials.credentials?.fingerprint ?? credentials.fingerprint) == null
    ) {
      try {
        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            credentials: {
              ...credentials,
              fingerprint,
              credentials: {
                ...(credentials.credentials || {}),
                fingerprint,
              },
            },
          },
        });
      } catch (e: any) {
        this.logger.warn(
          `Could not persist PhonePe web fingerprint to provider credentials: ${e?.message}`,
        );
      }
    }

    const isWebApi = (method || "").toLowerCase() === "web-api";
    if (!token || (!isWebApi && !deviceFingerprint)) {
      this.logger.error(`PhonePe credentials check failed. Debug info:`, {
        hasToken: !!token,
        hasDeviceFingerprint: !!deviceFingerprint,
        isWebApi,
        method,
        hasCredentials: !!credentials,
        hasNestedCredentials: !!credentials.credentials,
        credentialKeys: Object.keys(credentials || {}),
      });
      throw new Error("PhonePe session credentials not found");
    }

    const response = await this.phonepeService.fetchTransactionHistory(
      token,
      deviceFingerprint,
      groupValue,
      refreshToken,
      pageSize,
      provider.id,
      fromDate,
      toDate,
      fingerprint ?? undefined,
      groupId != null ? groupId : undefined,
      cookiesString,
      csrfToken,
      method,
    );

    const hasSessionUpdate =
      response.refreshedToken ||
      response.refreshedRefreshToken ||
      response.refreshedFingerprint ||
      (response.csrfToken && response.csrfToken !== csrfToken) ||
      (response.cookiesString && response.cookiesString !== cookiesString);

    if (hasSessionUpdate) {
      try {
        const latestProvider = await this.prisma.merchantProvider.findUnique({
          where: { id: provider.id },
          select: { credentials: true },
        });

        const latestCreds = (latestProvider?.credentials as any) || credentials;

        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            credentials: {
              ...latestCreds, // Merge against the freshest credentials from DB!
              webSessionExpiredHits: 0,
              token: response.refreshedToken || latestCreds.token,
              refreshToken:
                response.refreshedRefreshToken || latestCreds.refreshToken,
              csrfToken: response.csrfToken || latestCreds.csrfToken,
              cookiesString:
                response.cookiesString || latestCreds.cookiesString,
              credentials: {
                ...(latestCreds.credentials || {}),
                token: response.refreshedToken || latestCreds.credentials?.token || latestCreds.token,
                refreshToken:
                  response.refreshedRefreshToken ||
                  latestCreds.credentials?.refreshToken ||
                  latestCreds.refreshToken,
                csrfToken: response.csrfToken || latestCreds.credentials?.csrfToken || latestCreds.csrfToken,
                cookiesString:
                  response.cookiesString || latestCreds.credentials?.cookiesString || latestCreds.cookiesString,
                fingerprint:
                  response.refreshedFingerprint ||
                  latestCreds.credentials?.fingerprint ||
                  latestCreds.fingerprint,
              },
              verifiedAt: new Date(),
            },
          },
        });
        this.logger.log(
          `🔄 Persisted updated PhonePe session metadata to database for provider ${provider.id}${response.refreshedToken ? " (including refreshed token)" : ""}`,
        );
      } catch (e) {
        this.logger.warn(
          `Could not persist updated PhonePe session metadata to provider credentials: ${e?.message}`,
        );
      }
    }

    if (!response.success || !response.data?.results) {
      if (response.sessionExpired) {
        try {
          const isWebApi = (method || "").toLowerCase() === "web-api";
          // Keepalive cron is the single expiry authority for PhonePe web-api.
          // Sync path should not mark EXPIRED to avoid multi-writer race flips.
          if (isWebApi) {
            this.logger.warn(
              `⚠️ PhonePe web-api sessionExpired in sync for provider ${provider.id}; deferring EXPIRED decision to keepalive.`,
            );
            return {
              success: false,
              error: response.error || "PhonePe web-api transient session drift",
            };
          }

          const latestCookies = String(
            response?.cookiesString || credentials.cookiesString || "",
          );
          const latestCsrf = String(
            response?.csrfToken || credentials.csrfToken || "",
          );
          const signals = getPhonePeSessionSignals(latestCookies, latestCsrf);

          // Avoid false expiry for web-api when trust/anti-bot checks temporarily fail
          // but auth/refresh/csrf session signals are still present.
          if (isWebApi && shouldTreatAsTransientPhonePeSessionDrift(signals)) {
            const currentHits = Number(credentials.webSessionExpiredHits || 0);
            const nextHits = Math.max(0, currentHits - 1);
            const latestProvider = await this.prisma.merchantProvider.findUnique({
              where: { id: provider.id },
              select: { credentials: true },
            });
            const latestCreds = (latestProvider?.credentials as any) || credentials;
            
            await this.prisma.merchantProvider.update({
              where: { id: provider.id },
              data: {
                status: "ACTIVE",
                credentials: {
                  ...latestCreds,
                  webSessionExpiredHits: nextHits,
                  csrfToken: response.csrfToken || latestCreds.csrfToken,
                  cookiesString: response.cookiesString || latestCreds.cookiesString,
                  credentials: {
                    ...(latestCreds.credentials || {}),
                    csrfToken: response.csrfToken || latestCreds.credentials?.csrfToken || latestCreds.csrfToken,
                    cookiesString: response.cookiesString || latestCreds.credentials?.cookiesString || latestCreds.cookiesString,
                  },
                },
              },
            });
            this.logger.warn(
              `⚠️ PhonePe returned sessionExpired but session signals look healthy for provider ${provider.id} [${formatPhonePeSessionSignals(signals)}]. Treating as transient and keeping ACTIVE.`,
            );
            return {
              success: false,
              error: response.error || "Transient PhonePe web-api auth drift",
            };
          }

          const currentHits = Number(credentials.webSessionExpiredHits || 0);
          const nextHits = currentHits + 1;
          const sessionExpiredLimit = Number(process.env.PHONEPE_WEB_SESSION_EXPIRED_LIMIT || 3); // Reduced from 10 to 3
          const expireNow = !isWebApi || nextHits >= sessionExpiredLimit;
          const stack = (new Error().stack || "")
            .split("\n")
            .slice(1, 7)
            .join("\n");
          const latestProvider = await this.prisma.merchantProvider.findUnique({
            where: { id: provider.id },
            select: { credentials: true },
          });
          const latestCreds = (latestProvider?.credentials as any) || credentials;

          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              status: expireNow ? "EXPIRED" : "ACTIVE",
              credentials: {
                ...latestCreds,
                webSessionExpiredHits: nextHits,
              },
            },
          });
          if (expireNow) {
            this.logger.warn(
              `🚨 [DIAGNOSTIC] Marking provider ${provider.id} (${provider.providerType}) as EXPIRED in TransactionService.syncPhonePeTransactions`,
            );
            this.logger.warn(`🚨 [DIAGNOSTIC] EXPIRED write stack:\n${stack}`);
            this.logger.warn(
              `🚫 PhonePe session for provider ${provider.id} is unrecoverable. Marked as EXPIRED${isWebApi ? ` after ${nextHits} consecutive checks` : ""}.`,
            );
          } else {
            this.logger.warn(
              `⚠️ PhonePe sessionExpired for provider ${provider.id} (${nextHits}/${sessionExpiredLimit}). Keeping ACTIVE for web-api retry window.`,
            );
          }
        } catch (e) {
          this.logger.error(
            `Failed to mark provider ${provider.id} as EXPIRED: ${e.message}`,
          );
        }
      }

      return {
        success: false,
        error: response.error || "Failed to fetch PhonePe transactions",
      };
    }

    if ((method || "").toLowerCase() === "web-api") {
      try {
        const latestProvider = await this.prisma.merchantProvider.findUnique({
          where: { id: provider.id },
          select: { credentials: true },
        });
        const latestCreds = (latestProvider?.credentials as any) || credentials;

        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            status: "ACTIVE",
            credentials: {
              ...latestCreds,
              webSessionExpiredHits: 0,
            },
          },
        });
      } catch (e: any) {
        this.logger.warn(
          `Could not auto-heal PhonePe provider ${provider.id} to ACTIVE: ${e?.message}`,
        );
      }
    }

    // If we resolved groupValue from metadata, persist it to credentials so future syncs have it
    const hadGroupValueFromMetadata =
      groupValue != null &&
      (credentials.credentials?.groupValue ?? credentials.groupValue) == null;
    if (hadGroupValueFromMetadata) {
      try {
        const latestProvider = await this.prisma.merchantProvider.findUnique({
          where: { id: provider.id },
          select: { credentials: true },
        });
        const latestCreds = (latestProvider?.credentials as any) || credentials;

        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            credentials: {
              ...latestCreds,
              groupValue,
            },
          },
        });
        this.logger.log(
          `Saved groupValue to PhonePe provider ${provider.id} credentials`,
        );
      } catch (e) {
        this.logger.warn(
          `Could not persist groupValue to provider credentials: ${e?.message}`,
        );
      }
    }

    const transactions = response.data.results || [];
    const savedCount = await this.processAndSavePhonePeTransactions(
      provider.merchantId,
      provider.id,
      transactions,
    );

    // Persist lastSyncedAt for sync range and reconnect backfill
    try {
      const meta = (provider.metadata as Record<string, unknown>) || {};
      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: {
          lastSyncedAt: toDate,
          metadata: { ...meta, lastSync: toDate },
        },
      });
    } catch (e) {
      this.logger.warn(
        `Could not persist lastSyncedAt for provider ${provider.id}: ${e?.message}`,
      );
    }

    return {
      success: true,
      fetched: transactions.length,
      saved: savedCount,
      message: `Fetched ${transactions.length} transactions from PhonePe, saved ${savedCount}`,
    };
  }

  private mapPhonePeStatus(paymentState: string): string {
    switch (paymentState?.toUpperCase()) {
      case "SUCCESS":
      case "COMPLETED":
        return "SUCCESS";
      case "FAILED":
      case "FAILURE":
        return "FAILED";
      case "PENDING":
      case "IN_PROGRESS":
        return "PENDING";
      default:
        return "PENDING";
    }
  }

  private async syncBharatPeTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
  ) {
    const credentials = provider.credentials as any;
    const accessToken = credentials.accessToken;
    const merchantId = credentials.merchantId;
    const cookie = credentials.cookie || "";

    if (!accessToken || !merchantId) {
      throw new Error("BharatPe credentials incomplete");
    }

    // BharatPe transactions API supports a maximum of 31 days per request
    // (dates are inclusive), so chunk to avoid 400: "range exceeded more than 31 days"
    const toDateUtc = new Date(
      Date.UTC(
        toDate.getUTCFullYear(),
        toDate.getUTCMonth(),
        toDate.getUTCDate(),
      ),
    );
    let cursor = new Date(
      Date.UTC(
        fromDate.getUTCFullYear(),
        fromDate.getUTCMonth(),
        fromDate.getUTCDate(),
      ),
    );

    let totalFetched = 0;
    let totalSaved = 0;
    let chunks = 0;
    let anyChunkSucceeded = false;
    let firstError: string | null = null;

    while (cursor <= toDateUtc) {
      const chunkFrom = new Date(cursor);
      const chunkTo = new Date(cursor);
      chunkTo.setUTCDate(chunkTo.getUTCDate() + 30); // 31 inclusive days
      if (chunkTo > toDateUtc) {
        chunkTo.setTime(toDateUtc.getTime());
      }

      chunks++;
      this.logger.log(
        `🇧🇭 BharatPe sync chunk ${chunks}: ${chunkFrom.toISOString().split("T")[0]} → ${chunkTo.toISOString().split("T")[0]}`,
      );

      const response = await this.bharatpeService.fetchTransactionHistory(
        merchantId,
        accessToken,
        cookie,
        chunkFrom,
        chunkTo,
      );

      this.logger.log(
        "🇧🇭 BHARATPE RAW TRANSACTION RESPONSE:",
        JSON.stringify(response),
      );

      if (!response.success) {
        // If BharatPe reports auth error, stop further chunks and mark provider metadata
        if (response.authError) {
          this.logger.error(
            "🚨 BharatPe auth expired. Stopping sync and marking provider as unauthorized.",
          );

          try {
            const meta = (provider.metadata as Record<string, unknown>) || {};
            await this.prisma.merchantProvider.update({
              where: { id: provider.id },
              data: {
                metadata: {
                  ...meta,
                  authError: "UNAUTHORIZED",
                  authExpiredAt: new Date(),
                },
              },
            });
          } catch (e: any) {
            this.logger.warn(
              `Failed to mark BharatPe provider ${provider.id} as unauthorized: ${e?.message}`,
            );
          }

          firstError =
            firstError ||
            response.error ||
            "BharatPe auth expired - reconnect required";
          break;
        }

        firstError =
          firstError ||
          response.error ||
          "Failed to fetch BharatPe transactions";
        this.logger.error(
          `BharatPe fetch failed for chunk ${chunks}:`,
          response.error,
        );
      } else {
        anyChunkSucceeded = true;
        const transactions = response.data.results || [];
        totalFetched += transactions.length;

        this.logger.log(
          `Found ${transactions.length} BharatPe transactions to process (chunk ${chunks}).`,
        );

        if (transactions.length > 0) {
          this.logger.debug(
            "First BharatPe Transaction Sample:",
            JSON.stringify(transactions[0]),
          );
        }

        const savedCount = await this.processAndSaveBharatPeTransactions(
          provider.merchantId,
          provider.id,
          transactions,
        );
        totalSaved += savedCount;
      }

      // next day after chunkTo to avoid overlap (API uses inclusive dates)
      cursor = new Date(chunkTo);
      cursor.setUTCDate(cursor.getUTCDate() + 1);

      // small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    try {
      const meta = (provider.metadata as Record<string, unknown>) || {};
      if (anyChunkSucceeded) {
        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            lastSyncedAt: toDate,
            metadata: { ...meta, lastSync: toDate },
          },
        });
      }
    } catch (e) {
      this.logger.warn(
        `Could not persist lastSyncedAt for BharatPe provider ${provider.id}: ${e?.message}`,
      );
    }

    return {
      success: anyChunkSucceeded,
      fetched: totalFetched,
      saved: totalSaved,
      chunks,
      error: anyChunkSucceeded ? undefined : firstError,
      message: anyChunkSucceeded
        ? `Fetched ${totalFetched} transactions from BharatPe in ${chunks} chunks, saved ${totalSaved}`
        : `BharatPe sync failed${firstError ? `: ${firstError}` : ""}`,
    };
  }

  async processAndSaveBharatPeTransactions(
    merchantId: string,
    providerId: string,
    transactions: any[],
  ) {
    let savedCount = 0;
    const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
    const axios = require("axios");

    if (transactions.length > 0) {
      try {
        const CONCURRENCY_LIMIT = 10;
        for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
          const chunk = transactions.slice(i, i + CONCURRENCY_LIMIT);
          await Promise.allSettled(
            chunk.map(async (txn) => {
              try {
            const amount =
              typeof txn.amount === "string"
                ? parseFloat(txn.amount)
                : txn.amount;

            // Normalize BharatPe timestamp (API may return seconds or milliseconds)
            const rawTs =
              txn.paymentTimestamp ?? txn.transactionDate ?? txn.paymentDate;
            const tsMs =
              typeof rawTs === "number"
                ? rawTs < 1e12
                  ? rawTs * 1000
                  : rawTs
                : rawTs
                  ? new Date(rawTs).getTime()
                  : Date.now();
            const txnDate = Number.isNaN(tsMs) ? new Date() : new Date(tsMs);

            const syncPayload = {
              merchantId: merchantId,
              providerId: providerId,
              externalTransactionId: String(
                txn.id || txn.transactionId || txn.referrenceNo,
              ),
              amount: amount,
              currency: "INR",
              status: this.mapBharatPeStatus(
                txn.status || txn.transactionStatus,
              ),
              paymentMethod: "UPI",
              providerCode: "BHARATPE",
              providerResponse: txn,

              customerName: txn.payerName || txn.senderName || "N/A",
              customerContact: txn.payerMobile || txn.senderMobile || null,

              utr: txn.bankReferenceNo || txn.utr || null,
              paymentApp: txn.paymentApp || txn.payerHandle || null,

              createdAt: txnDate,
              completedAt: txnDate,
            };

                const response = await axios.post(
                  `${paymentServiceUrl}/transactions/sync`,
                  syncPayload, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
                );
                if (response.data && response.data.success) {
                  if (!response.data.skipped) {
                    savedCount++;
                  }
                }
              } catch (saveError) {
                this.logger.error(
                  `Failed to save BharatPe transaction:`,
                  saveError.message,
                );
              }
            })
          );
        }
      } catch (error) {
        this.logger.error(
          "Failed to sync BharatPe transactions to payment service:",
          error.message,
        );
      }
    }
    return savedCount;
  }

  private mapBharatPeStatus(status: string): string {
    switch (status?.toUpperCase()) {
      case "SUCCESS":
        return "SUCCESS";
      case "FAILED":
        return "FAILED";
      case "PENDING":
        return "PENDING";
      default:
        return "PENDING";
    }
  }

  private async syncGPayTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
  ) {
    const response = await this.gpayService.syncTransactions(
      provider,
      fromDate,
      toDate,
    );

    if (!response.success) {
      throw new Error(response.message || "Failed to fetch from GPay");
    }

    const transactions = response.transactions || [];
    const savedCount = await this.processAndSaveGPayTransactions(
      provider.merchantId,
      provider.id,
      transactions,
    );

    // Update provider record to reflect ACTIVE status and fresh sync time
    try {
      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: {
          status: "ACTIVE",
          lastSyncedAt: new Date(),
        },
      });
      this.logger.log(`🔄 Updated GPay provider ${provider.id} status to ACTIVE and recorded lastSync`);
    } catch (e) {
      this.logger.warn(`Failed to update GPay provider metadata after sync: ${e.message}`);
    }

    return {
      success: true,
      fetched: transactions.length,
      saved: savedCount,
      message: `Sync completed: ${transactions.length} fetched, ${savedCount} saved`,
    };
  }

  private async processAndSaveGPayTransactions(
    merchantId: string,
    providerId: string,
    transactions: any[],
  ) {
    let savedCount = 0;
    const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
    const axios = require("axios");

    const CONCURRENCY_LIMIT = 10;
    for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
      const chunk = transactions.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        chunk.map(async (txn) => {
          try {
        // Log raw txn for field discovery (first few only to avoid log spam)
        if (savedCount < 3) {
          this.logger.debug(`📋 GPay RAW txn[${savedCount}]: ${JSON.stringify(txn)}`);
        }

        // ═══════════════════════════════════════════════════════════════════
        // Real GPay batchexecute (RPtkab) field mapping — confirmed via Burp:
        //
        // txn[0]  = "4859708706234826752"         — GPay internal transaction ID
        // txn[1]  = "601266109221"                — UPI Reference Number (UTR/RRN)
        // txn[2]  = [1773989588, 679000000]       — timestamp [epoch_seconds, nanos]
        // txn[3]  = ["INR", 1]                    — [currency, amount_in_rupees]
        // txn[4]  = 1                             — direction flag (1=received, 2=sent)
        // txn[5]  = 4                             — status (1/3/4=COMPLETED, else PENDING)
        // txn[6]  = []                            — empty / reserved
        // txn[7]  = [1773989590]                  — completion timestamp [epoch_seconds]
        // txn[8]  = ["SHIVSAI E", "9167567370@ptyes", "id", 101, 1] — payer info
        //             [0]=name  [1]=UPI VPA
        // txn[9]  = "Sent using Paytm UPI"        — description / note
        // txn[10] = 5                             — category code
        // ═══════════════════════════════════════════════════════════════════

        const record = Array.isArray(txn[0]) && txn[0].length > 3 ? txn[0] : txn;

        const externalId = String(record[0] || `gpay-${Date.now()}`);
        const utr = record[1] ? String(record[1]) : null;

        // Timestamp: epoch seconds at record[2][0], nanoseconds at record[2][1]
        const timestampSeconds = Array.isArray(record[2]) ? record[2][0] : null;
        const timestampNanos = Array.isArray(record[2]) ? record[2][1] || 0 : 0;
        const timestamp = timestampSeconds 
          ? new Date(timestampSeconds * 1000 + Math.floor(timestampNanos / 1_000_000))
          : new Date();

        // Amount: record[3] = ["INR", amount] — amount in rupees
        const amount = Array.isArray(record[3]) ? Number(record[3][1]) : 0;

        // Status code: record[5]
        const statusCode = record[5];
        const status = this.mapGPayStatus(statusCode);

        // Customer info: record[8] = [name, vpa, ...]
        const payerInfo = Array.isArray(record[8]) ? record[8] : [];
        const customerName = typeof payerInfo[0] === "string" ? payerInfo[0] : null;
        const customerContact = typeof payerInfo[1] === "string" ? payerInfo[1] : null;

        // Description: record[9]
        const description = typeof record[9] === "string" ? record[9] : null;

        const currency = "INR";
        const syncPayload = {
          merchantId,
          providerId,
          externalTransactionId: externalId,
          utr: utr && utr.length > 3 ? utr : null,
          customerName,
          customerContact,
          amount,
          currency,
          status: status === "COMPLETED" ? "SUCCESS" : status === "FAILED" ? "FAILED" : "PENDING",
          providerCode: "GPAY",
          providerResponse: txn,
          createdAt: timestamp,
          completedAt: status === "COMPLETED" ? timestamp : null,
          paymentMethod: "UPI",
        };

        this.logger.log(
          `💰 GPay Txn: ${externalId} | ₹${amount} | ${status} | UTR: ${utr || 'N/A'} | ${customerName || 'Unknown'} (${customerContact || 'N/A'}) | ${description || ''}`,
        );

            const response = await axios.post(`${paymentServiceUrl}/transactions/sync`, syncPayload, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
            if (response.data && response.data.success) {
              if (!response.data.skipped) {
                savedCount++;
              }
            }
          } catch (e) {
            this.logger.error(`Failed to save GPay txn: ${e.message}`);
          }
        })
      );
    }

    return savedCount;
  }

  private mapGPayStatus(status: any): string {
    // GPay batchexecute status codes:
    //   3 = Completed
    //   4 = Settled / Success
    //   5 = Failed / Other
    const s = String(status);
    if (s === "3" || s === "4") return "COMPLETED";
    if (s === "5") return "FAILED";
    return "PENDING";
  }

  // ==================== QuintusPay Sync ====================

  private async syncQuintusTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
  ) {
    const credentials = provider.credentials as any;
    const accessToken = credentials.accessToken;

    if (!accessToken) {
      throw new Error("QuintusPay credentials incomplete - no accessToken");
    }

    const response = await this.quintusPayService.fetchTransactionHistory(
      accessToken,
      fromDate,
      toDate,
    );

    if (!response.success) {
      if (response.authError) {
        this.logger.error(
          "🚨 QuintusPay auth expired. Marking provider.",
        );
        try {
          const meta = (provider.metadata as Record<string, unknown>) || {};
          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              metadata: {
                ...meta,
                authError: "UNAUTHORIZED",
                authExpiredAt: new Date(),
              },
            },
          });
        } catch (e: any) {
          this.logger.warn(
            `Failed to mark QuintusPay provider ${provider.id} as unauthorized: ${e?.message}`,
          );
        }
      }
      throw new Error(response.error || "Failed to fetch QuintusPay transactions");
    }

    const transactions = response.data?.results || [];
    const savedCount = await this.processAndSaveQuintusTransactions(
      provider.merchantId,
      provider.id,
      transactions,
    );

    try {
      const meta = (provider.metadata as Record<string, unknown>) || {};
      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: {
          lastSyncedAt: toDate,
          metadata: { ...meta, lastSync: toDate },
        },
      });
    } catch (e) {
      this.logger.warn(
        `Could not persist lastSyncedAt for QuintusPay provider ${provider.id}: ${e?.message}`,
      );
    }

    return {
      success: true,
      fetched: transactions.length,
      saved: savedCount,
      message: `Fetched ${transactions.length} QuintusPay transactions, saved ${savedCount}`,
    };
  }

  private async processAndSaveQuintusTransactions(
    merchantId: string,
    providerId: string,
    transactions: any[],
  ) {
    let savedCount = 0;
    const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
    const axios = require("axios");

    const CONCURRENCY_LIMIT = 10;
    for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
      const chunk = transactions.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.allSettled(
        chunk.map(async (txn) => {
          try {
        const amount =
          typeof txn.amount === "string"
            ? parseFloat(txn.amount)
            : txn.amount || 0;

        // QuintusPay transaction timestamps
        const rawTs = txn.description?.transactionTimestamp || txn.createdAt || txn.updatedAt;
        const txnDate = rawTs ? new Date(rawTs) : new Date();

        const syncPayload = {
          merchantId,
          providerId,
          externalTransactionId: String(
            txn.referenceNo || txn._id || txn.description?.gatewayTransactionId,
          ),
          amount,
          currency: "INR",
          status: this.mapQuintusStatus(txn.status),
          paymentMethod: "UPI",
          providerCode: "QUINTUS",
          providerResponse: txn,

          customerName: txn.description?.payerVPA || "N/A",
          customerContact: txn.description?.payerVPA || null,

          utr: txn.description?.utr || txn.referenceNo || null,
          paymentApp: null,

          createdAt: txnDate,
          completedAt: txnDate,
        };

            const response = await axios.post(
              `${paymentServiceUrl}/transactions/sync`,
              syncPayload, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
            );
            if (response.data && response.data.success) {
              if (!response.data.skipped) {
                savedCount++;
              }
            }
          } catch (saveError) {
            this.logger.error(
              `Failed to save QuintusPay transaction:`,
              saveError.message,
            );
          }
        })
      );
    }

    return savedCount;
  }

  private mapQuintusStatus(status: string): string {
    switch (status?.toUpperCase()) {
      case "SUCCESS":
      case "PAID":
        return "SUCCESS";
      case "FAILED":
      case "REJECT":
      case "DECLINED":
        return "FAILED";
      case "EXPIRED":
        return "FAILED";
      case "PENDING":
      default:
        return "PENDING";
    }
  }

  /**
   * Sync HDFC Vyapar transactions using GET_TRANSACTIONS_V2.
   * If session is expired, attempts auto-refresh using stored mobileNumber + mPin.
   */
  private async syncHdfcTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
  ) {
    const credentials: any = provider.credentials || {};
    let { sessionId, deviceId, mobileNumber, mPin, tidList } = credentials;

    if (!sessionId || !deviceId) {
      return { success: false, fetched: 0, saved: 0, message: "Missing HDFC session credentials" };
    }

    const startDate = fromDate.toISOString().split('T')[0];
    const endDate = toDate.toISOString().split('T')[0];

    // Attempt to fetch transactions
    let result = await this.hdfcService.fetchTransactionHistory(
      sessionId, deviceId, startDate, endDate, tidList,
    );

    // If session expired and we have login creds, try refresh
    if (result.sessionExpired && mobileNumber && mPin) {
      this.logger.log(`🔄 HDFC session expired during sync, refreshing for provider ${provider.id}`);
      const newSession = await this.hdfcService.refreshSession(mobileNumber, mPin, deviceId);

      if (newSession) {
        sessionId = newSession.sessionId;
        deviceId = newSession.deviceId;

        // Fetch TIDs with new session
        const newTids = await this.hdfcService.fetchTerminalInfo(sessionId);
        if (newTids.length > 0) tidList = newTids;

        // Update credentials in DB
        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            credentials: {
              ...credentials,
              sessionId,
              deviceId,
              tidList,
              sessionRefreshFailures: 0,
            },
          },
        });

        // Retry fetch
        result = await this.hdfcService.fetchTransactionHistory(
          sessionId, deviceId, startDate, endDate, tidList,
        );
      } else {
        // Track failure
        const failures = (credentials.sessionRefreshFailures || 0) + 1;
        await this.prisma.merchantProvider.update({
          where: { id: provider.id },
          data: {
            status: failures >= 6 ? "EXPIRED" : "ACTIVE",
            credentials: { ...credentials, sessionRefreshFailures: failures },
          },
        });
        return { success: false, fetched: 0, saved: 0, message: `HDFC session refresh failed (${failures}/6)` };
      }
    } else if (result.sessionExpired) {
      // No login creds stored — can't refresh
      this.logger.warn(`⚠️ HDFC session expired for provider ${provider.id} but no mobileNumber/mPin to refresh`);
      return { success: false, fetched: 0, saved: 0, message: "HDFC session expired and no login credentials stored" };
    }

    const transactions = result.transactions;
    let savedCount = 0;

    if (transactions.length > 0) {
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const axios = require("axios");

      const CONCURRENCY_LIMIT = 10;
      const chunks = [];
      for (let i = 0; i < transactions.length; i += CONCURRENCY_LIMIT) {
          chunks.push(transactions.slice(i, i + CONCURRENCY_LIMIT));
      }

      for (const chunk of chunks) {
        await Promise.allSettled(
          chunk.map(async (txn) => {
            try {
              const amount = parseFloat(txn.amount || txn.txnAmount || txn.transactionAmount || "0");
              const txnId = txn.txnId || txn.transactionId || txn.rrn || txn.utr || `hdfc-${Date.now()}-${Math.random()}`;
              const status = this.mapHdfcStatus(txn.status || txn.txnStatus || txn.transactionStatus);

              const dateStr = txn.txnDate || txn.transactionDate || txn.endTime || txn.sortTime;
              let parsedDate = new Date();
              if (dateStr) {
                // Try to parse '18-06-2026 15:16:19' -> '2026-06-18T15:16:19'
                if (typeof dateStr === 'string' && dateStr.match(/^\d{2}-\d{2}-\d{4}/)) {
                  const parts = dateStr.split(' ');
                  const dateParts = parts[0].split('-');
                  const timePart = parts[1] || '00:00:00';
                  parsedDate = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${timePart}`);
                } else {
                  parsedDate = new Date(dateStr);
                }
              }

              const syncPayload = {
                merchantId: provider.merchantId,
                providerId: provider.id,
                externalTransactionId: txnId,
                amount,
                currency: "INR",
                status,
                paymentMethod: "UPI",
                providerCode: "HDFC",
                providerResponse: txn,
                customerName: txn.payerName || txn.customerName || null,
                customerContact: txn.payerVpa || txn.customerVpa || null,
                utr: txn.rrn || txn.utr || txn.bankReferenceNumber || null,
                createdAt: parsedDate,
                completedAt: parsedDate,
              };

              const response = await axios.post(`${paymentServiceUrl}/transactions/sync`, syncPayload, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
              if (response.data && response.data.success) {
                if (!response.data.skipped) {
                  savedCount++;
                }
              }
            } catch (saveError: any) {
              this.logger.error(`Failed to save HDFC transaction: ${saveError.message}`);
            }
          })
        );
      }
    }

    // Update lastSyncedAt
    try {
      const meta = (provider.metadata as Record<string, unknown>) || {};
      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: {
          lastSyncedAt: toDate,
          metadata: { ...meta, lastSync: toDate },
        },
      });
    } catch (e: any) {
      this.logger.warn(`Could not persist lastSyncedAt for HDFC provider ${provider.id}: ${e?.message}`);
    }

    return {
      success: true,
      fetched: transactions.length,
      saved: savedCount,
      message: `Fetched ${transactions.length} HDFC transactions, saved ${savedCount}`,
    };
  }

  private mapHdfcStatus(status: string | undefined): string {
    if (!status) return "SUCCESS"; // HDFC raw transactions omit status if we filter by SaleSuccess
    switch (status?.toUpperCase()) {
      case "SUCCESS":
      case "COMPLETED":
      case "APPROVED":
      case "SALE SUCCESS":
      case "SALESUCCESS":
        return "SUCCESS";
      case "FAILED":
      case "DECLINED":
      case "REJECTED":
        return "FAILED";
      case "REFUNDED":
      case "REFUND":
        return "REFUNDED";
      case "PENDING":
      case "INITIATED":
      default:
        return "PENDING";
    }
  }
}

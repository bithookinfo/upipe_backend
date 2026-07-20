import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { PaytmSimpleService } from "../provider/paytm-simple.service";
import { PhonePeSimpleService } from "../provider/phonepe-simple.service";
import { BharatPeSimpleService } from "../provider/bharatpe-simple.service";
import { QuintusPaySimpleService } from "../provider/quintuspay-simple.service";
import { GpayService } from "../gpay/gpay.service";
import axios from "axios";
import {
  formatPhonePeSessionSignals,
  getPhonePeSessionSignals,
  shouldTreatAsTransientPhonePeSessionDrift,
} from "../provider/phonepe-session.util";
import { HdfcVyaparService } from "../provider/hdfc-vyapar.service";

@Injectable()
export class OrderStatusCronService {
  private readonly logger = new Logger(OrderStatusCronService.name);
  private readonly processingOrders = new Set<string>();
  private readonly processedTransactionIds = new Set<string>();
  private readonly lastGPaySyncTime = new Map<string, number>();
  private readonly providerLastTxnTime = new Map<string, number>();
  private readonly lastForcedRefreshTime = new Map<string, number>();
  private readonly paytmSessionExpireThreshold = 3;
  private isCheckingPendingOrders = false;
  private checkStartedAt: number = 0;
  private readonly CHECK_STALE_TIMEOUT_MS = 60_000; // 60s — if a check hangs longer, forcibly unlock

  constructor(
    private readonly prisma: PrismaService,
    private readonly paytmService: PaytmSimpleService,
    private readonly phonePeService: PhonePeSimpleService,
    private readonly bharatpeService: BharatPeSimpleService,
    private readonly quintuspayService: QuintusPaySimpleService,
    private readonly hdfcService: HdfcVyaparService,
    @Inject(forwardRef(() => GpayService))
    private readonly gpayService: GpayService,
  ) { }

  @Cron("5,20,35,50 * * * * *", {
    name: "check-pending-orders",
  })
  async checkPendingOrders() {
    if (this.isCheckingPendingOrders) {
      // Safety valve: if the previous check has been running longer than CHECK_STALE_TIMEOUT_MS,
      // the lock is stale (likely a hung browser/network call). Force-release it.
      const elapsed = Date.now() - this.checkStartedAt;
      if (elapsed > this.CHECK_STALE_TIMEOUT_MS) {
        this.logger.warn(
          `⚠️ [Order Status] Force-releasing stale lock (held for ${Math.round(elapsed / 1000)}s, threshold ${Math.round(this.CHECK_STALE_TIMEOUT_MS / 1000)}s)`,
        );
        this.isCheckingPendingOrders = false;
      } else {
        this.logger.debug(`[Order Status] Skipping tick — previous check still running (${Math.round(elapsed / 1000)}s)`);
        return;
      }
    }
    this.isCheckingPendingOrders = true;
    this.checkStartedAt = Date.now();
    try {
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;

      const ordersResponse = await axios.get(`${paymentServiceUrl}/orders`, {
        params: {
          status: "PENDING,EXPIRED",
          limit: 500,
          includePlatform: true,
        },
        timeout: 10000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
    });

      const pendingOrders = (ordersResponse.data?.orders || []).filter(
        (o: any) => new Date(o.createdAt) >= thirtyMinutesAgo,
      );

      if (pendingOrders.length === 0) {
        return;
      }
      this.logger.log(`🔍 Checking ${pendingOrders.length} pending orders...`);

      // Group orders by merchantId — fetch provider txns once per merchant
      const byMerchant = new Map<string, any[]>();
      for (const order of pendingOrders) {
        const mid = order.merchantId;
        if (!byMerchant.has(mid)) byMerchant.set(mid, []);
        byMerchant.get(mid)!.push(order);
      }

      const merchantEntries = Array.from(byMerchant.entries());
      const merchantIds = merchantEntries.map(([id]) => id);
      
      const allProviders = await this.prisma.merchantProvider.findMany({
        where: {
          merchantId: { in: merchantIds },
          status: "ACTIVE",
          merchant: {
            deletedAt: null,
          },
        },
      });

      const providersByMerchant = new Map<string, any[]>();
      for (const p of allProviders) {
        if (!providersByMerchant.has(p.merchantId)) providersByMerchant.set(p.merchantId, []);
        providersByMerchant.get(p.merchantId)!.push(p);
      }

      const CONCURRENCY_LIMIT = 5;

      for (let i = 0; i < merchantEntries.length; i += CONCURRENCY_LIMIT) {
        const chunk = merchantEntries.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(
          chunk.map(async ([merchantId, orders]) => {
            try {
              const merchantProviders = providersByMerchant.get(merchantId) || [];
              await this.checkOrdersForMerchant(orders, merchantProviders);
            } catch (error: any) {
              const msg =
                error?.message || error?.response?.data?.message || String(error);
              this.logger.error(
                `Failed to check orders for merchant ${merchantId}: ${msg}`,
              );
            }
          })
        );
      }
    } catch (error: any) {
      const msg =
        error?.message || error?.response?.data?.message || String(error);
      const status = error?.response?.status;
      const code = error?.code;
      this.logger.error(
        `Error in checkPendingOrders cron: ${msg}${status ? ` (HTTP ${status})` : ""}${code ? ` [${code}]` : ""}`,
      );
    } finally {
      this.isCheckingPendingOrders = false;
    }
  }

  private async checkOrdersForMerchant(orders: any[], providers: any[]) {
    if (orders.length === 0 || providers.length === 0) return;
    const merchantId = orders[0].merchantId;

    this.logger.log(`[Order Status Debug] Found ${providers.length} ACTIVE providers for merchant ${merchantId}`);

    await Promise.all(providers.map(async (provider) => {
      if (provider.status === "EXPIRED" && provider.providerType !== "GPAY") {
        this.logger.warn(`⚠️ Skipping provider ${provider.providerType} (${provider.id}) in OrderStatus (STATUS: EXPIRED)`);
        return;
      }

      if (provider.status === "EXPIRED" && provider.providerType === "GPAY") {
        this.logger.log(`🔍 [DIAGNOSTIC] Attempting GPay sync even though status is EXPIRED (Provider: ${provider.id})`);
      }

      const meta = (provider.metadata as any) || {};
      if (
        provider.providerType === "BHARATPE" &&
        meta?.authError === "UNAUTHORIZED"
      ) {
        return;
      }

      const config = provider.credentials as any;

      if (provider.providerType === "PAYTM") {
        await this.checkPaytmOrdersForMerchant(orders, provider, config);
      } else if (provider.providerType === "PHONEPE") {
        await this.checkPhonePeOrdersForMerchant(orders, provider, config);
      } else if (provider.providerType === "BHARATPE") {
        await this.checkBharatPeOrdersForMerchant(orders, provider, config);
      } else if (provider.providerType === "GPAY") {
        await this.checkGPayOrdersForMerchant(orders, provider, config, {
          immediate: false,
        });
      } else if (provider.providerType === "QUINTUS") {
        await this.checkQuintusPayOrdersForMerchant(orders, provider, config);
      } else if (provider.providerType === "HDFC") {
        await this.checkHdfcOrdersForMerchant(orders, provider, config);
      }
    }));
  }

  async tryMatchPendingOrdersForGpayProvider(providerId: string): Promise<void> {
    try {
      const provider = await this.prisma.merchantProvider.findFirst({
        where: {
          id: providerId,
          providerType: "GPAY",
        },
        include: { merchant: true },
      });
      if (!provider) return;

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      if (!paymentServiceUrl) return;

      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      const ordersResponse = await axios.get(`${paymentServiceUrl}/orders`, {
        params: { status: "PENDING", limit: 50, merchantId: provider.merchantId, includePlatform: true },
        timeout: 10000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
    });
      const fetchedOrders = ordersResponse.data?.orders || [];
      this.logger.log(`[Order Status Debug] tryMatch fetched ${fetchedOrders.length} PENDING orders for merchant ${provider.merchantId}`);
      
      const pendingOrders = fetchedOrders.filter(
        (o: any) => new Date(o.createdAt) >= thirtyMinutesAgo,
      );
      this.logger.log(`[Order Status Debug] tryMatch filtered to ${pendingOrders.length} recent orders`);
      if (pendingOrders.length === 0) return;

      const config = provider.credentials as any;
      await this.checkGPayOrdersForMerchant(pendingOrders, provider, config, {
        immediate: true,
      });
    } catch (error: any) {
      this.logger.warn(
        `GPay immediate order match failed for provider ${providerId}: ${error?.message || error}`,
      );
    }
  }

  private async checkPaytmOrdersForMerchant(
    orders: any[],
    provider: any,
    config: any,
  ) {
    try {
      const merchantSession = config.merchant_session || config.merchantSession;
      const merchantCsrfToken =
        config.merchant_csrftoken || config.merchantCsrfToken;

      if (!merchantSession || !merchantCsrfToken) return;

      const now = new Date();
      const oldestOrderCreatedAt = Math.min(...orders.map(o => new Date(o.createdAt).getTime()));
      const lastTxnTime = this.providerLastTxnTime.get(provider.id);
      const fromTimeMs = lastTxnTime ? lastTxnTime - 60000 : oldestOrderCreatedAt - 5 * 60000;
      const safeFromTimeMs = Math.max(fromTimeMs, now.getTime() - 24 * 60 * 60 * 1000);
      const fromDate = new Date(safeFromTimeMs);

      const response = await this.paytmService.fetchTransactionHistory(
        merchantSession,
        merchantCsrfToken,
        fromDate,
        now,
        1,
        Math.min(50, Math.max(1, orders.length * 10)),
      );

      const paytmAuth403 =
        response.sessionExpired ||
        (response.statusCode === 403 && !response.infrastructureBlock);
      if (paytmAuth403) {
        try {
          const currentHits = Number(config.paytmSessionExpiredHits || 0);
          const nextHits = currentHits + 1;
          const expireNow = nextHits >= this.paytmSessionExpireThreshold;
          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              status: expireNow ? "EXPIRED" : "ACTIVE",
              credentials: {
                ...config,
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
          this.logger.warn(
            `Failed to update Paytm session-expired state for provider ${provider.id}: ${e?.message}`,
          );
        }
        return;
      }

      if (
        !response.success ||
        !response.transactions ||
        response.transactions.length === 0
      ) {
        return;
      }

      if (Number(config.paytmSessionExpiredHits || 0) > 0) {
        try {
          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              status: "ACTIVE",
              credentials: {
                ...config,
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

      if (response.transactions && response.transactions.length > 0) {
        let maxTime = 0;
        for (const txn of response.transactions) {
          const tTime = txn.txnDate || txn.createdDate || txn.transactionDate;
          if (tTime) {
            const ms = new Date(tTime).getTime();
            if (ms > maxTime) maxTime = ms;
          }
        }
        if (maxTime > 0) this.providerLastTxnTime.set(provider.id, maxTime);
      }

      this.logger.log(
        `📋 Found ${response.transactions.length} Paytm txns for merchant ${provider.merchantId} (${orders.length} orders)`,
      );

      for (const order of orders) {
        const orderAmount = Number(order.amount);
        const matchingTxn = response.transactions.find((txn: any) => {

          let txnAmount = 0;
          if (txn.payMoneyAmount?.value) {
            txnAmount = parseFloat(txn.payMoneyAmount.value) / 100;
          } else if (txn.payAmount?.value) {
            txnAmount = parseFloat(txn.payAmount.value) / 100;
          } else if (txn.amount) {
            txnAmount = parseFloat(txn.amount) / 100;
          }

          if (txnAmount !== orderAmount) return false;

          const bizOrderId =
            txn.bizOrderId || txn.orderId || txn.merchantOrderId || "";

          const payerPSP = txn.additionalInfo?.payerPSP
          let merchantTransId = "";
          if (payerPSP.toLowerCase() === "phonepe") {
            merchantTransId = txn.additionalInfo.comment || "";
            // console.log("if comment info ", txn.additionalInfo.comment);
            let withoutUnderscoreOrderExternalId = order.externalOrderId.replace(/_/g, "");

            // console.log("out order info ", order.externalOrderId, " - ", withoutUnderscoreOrderExternalId);
            // console.log("out bizOrderId info ", bizOrderId);
            // console.log("out merchantTransId info ", merchantTransId);
            // console.log("out payerPSP info ", payerPSP);
            return (
              bizOrderId.includes(withoutUnderscoreOrderExternalId) ||
              bizOrderId === withoutUnderscoreOrderExternalId ||
              merchantTransId.includes(withoutUnderscoreOrderExternalId) ||
              merchantTransId === withoutUnderscoreOrderExternalId
            );

          } else {
            merchantTransId = txn.merchantTransId || "";
            // console.log("else merchantTransId info ", txn.merchantTransId);

            return (
              bizOrderId.includes(order.externalOrderId) ||
              bizOrderId === order.externalOrderId ||
              merchantTransId.includes(order.externalOrderId) ||
              merchantTransId === order.externalOrderId
            );
          }
        });
        if (matchingTxn) {
          this.logger.log(
            `🎯 Found matching Paytm transaction for order ${order.externalOrderId}`,
          );
          await this.handlePaytmTransactionMatch(order, matchingTxn, provider);
        }
      }
    } catch (error) {
      this.logger.error(
        `Paytm check failed for merchant ${provider.merchantId}: ${error.message}`,
      );
    }
  }

  private async checkPhonePeOrdersForMerchant(
    orders: any[],
    provider: any,
    config: any,
  ) {
    try {
      this.logger.log(`[Order Status Debug] Starting checkPhonePeOrdersForMerchant for merchant ${provider.merchantId} with ${orders.length} orders`);

      const token = config.credentials?.token || config.token;
      const deviceFingerprint = config.deviceFingerprint;
      const groupValue = config.credentials?.groupValue ?? config.groupValue;
      const refreshToken =
        config.credentials?.refreshToken ?? config.refreshToken;
      const fingerprint = config.credentials?.fingerprint ?? config.fingerprint;
      const groupId = config.credentials?.groupId ?? config.groupId;
      const csrfToken = config.credentials?.csrfToken || config.csrfToken;
      const cookiesString =
        config.credentials?.cookiesString || config.cookiesString;
      const method =
        config.credentials?.method || config.method || config.authMethod;

      const isWebApi = (method || '').toLowerCase() === 'web-api';

      if (!token || (!deviceFingerprint && !fingerprint)) {
        this.logger.log(`[Order Status Debug] Skipping PhonePe check for ${provider.merchantId}: no token or fingerprint (token=${!!token}, deviceFingerprint=${!!deviceFingerprint}, fingerprint=${!!fingerprint}, method=${method})`);
        return;
      }

      const oldestOrderCreatedAt = Math.min(...orders.map(o => new Date(o.createdAt).getTime()));
      const lastTxnTime = this.providerLastTxnTime.get(provider.id);
      const fromTimeMs = lastTxnTime ? lastTxnTime - 60000 : oldestOrderCreatedAt - 5 * 60000;
      const fromDate = new Date(fromTimeMs);

      this.logger.log(`[Order Status Debug] Fetching PhonePe txns for ${provider.merchantId} (method=${method}, isWebApi=${isWebApi}, from=${fromDate.toISOString()})`);

      // Web-API providers share a persistent browser with other crons.
      // Wrap with a timeout to prevent pile-up when the browser is busy.
      const fetchPromise = this.phonePeService.fetchTransactionHistory(
        token,
        deviceFingerprint,
        groupValue,
        refreshToken,
        Math.max(50, orders.length * 10),
        provider.id,
        fromDate,
        undefined,
        fingerprint,
        groupId,
        cookiesString,
        csrfToken,
        method,
      );

      const timeoutMs = isWebApi ? 15000 : 10000;
      let response: any;
      try {
        response = await Promise.race([
          fetchPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`OrderStatusCron: PhonePe fetch timed out after ${timeoutMs}ms (browser likely busy)`)), timeoutMs),
          ),
        ]);
      } catch (timeoutErr: any) {
        this.logger.warn(`⏱️ [Order Status] PhonePe fetch timed out for ${provider.merchantId}: ${timeoutErr.message}`);
        return;
      }

      this.logger.log(`[Order Status Debug] PhonePe fetch txns for ${provider.merchantId} returned success=${!response?.sessionExpired}, results=${response?.data?.results?.length || response?.results?.length || 0}`);

      if (response?.sessionExpired) {
        try {
          const isWebApi = (method || "").toLowerCase() === "web-api";
          // Keepalive cron is the single expiry authority for PhonePe web-api.
          // Order-status path should not mark EXPIRED to avoid multi-writer race flips.
          if (isWebApi) {
            this.logger.log(
              `⚠️ PhonePe web-api sessionExpired in order-status for provider ${provider.id}; contributing to hit-count.`,
            );
          }

          const latestCookies = String(
            response?.cookiesString || config.cookiesString || "",
          );
          const latestCsrf = String(response?.csrfToken || config.csrfToken || "");
          const signals = getPhonePeSessionSignals(latestCookies, latestCsrf);

          // 412/401 bursts can be transient for web-api even with intact session cookies.
          // Do not mark EXPIRED while core auth signals are still present.
          const currentHits = Number(config.webSessionExpiredHits || 0);
          const nextHits = currentHits + 1;
          const sessionExpiredLimit = Number(process.env.PHONEPE_WEB_SESSION_EXPIRED_LIMIT || 3); // Reduced from 10 to 3
          const expireNow = nextHits >= sessionExpiredLimit;

          if (isWebApi && shouldTreatAsTransientPhonePeSessionDrift(signals) && !expireNow) {
            const latestProvider = await this.prisma.merchantProvider.findUnique({
              where: { id: provider.id },
              select: { credentials: true },
            });
            const latestCreds = (latestProvider?.credentials as any) || config;

            await this.prisma.merchantProvider.update({
              where: { id: provider.id },
              data: {
                status: "ACTIVE",
                credentials: {
                  ...latestCreds,
                  webSessionExpiredHits: nextHits,
                  csrfToken: response?.csrfToken || latestCreds.csrfToken,
                  cookiesString: response?.cookiesString || latestCreds.cookiesString,
                  credentials: {
                    ...(latestCreds.credentials || {}),
                    csrfToken: response?.csrfToken || latestCreds.credentials?.csrfToken || latestCreds.csrfToken,
                    cookiesString: response?.cookiesString || latestCreds.credentials?.cookiesString || latestCreds.cookiesString,
                  },
                },
              },
            });
            this.logger.warn(
              `⚠️ OrderStatus got sessionExpired but session signals look healthy for provider ${provider.id} [${formatPhonePeSessionSignals(signals)}]. Keeping ACTIVE (hits=${nextHits}/${sessionExpiredLimit}).`,
            );
            return;
          }

          const finalExpireNow = !isWebApi || expireNow;
          const stack = (new Error().stack || "")
            .split("\n")
            .slice(1, 7)
            .join("\n");
          const latestProvider = await this.prisma.merchantProvider.findUnique({
            where: { id: provider.id },
            select: { credentials: true },
          });
          const latestCreds = (latestProvider?.credentials as any) || config;

          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              status: finalExpireNow ? "EXPIRED" : "ACTIVE",
              credentials: {
                ...latestCreds,
                webSessionExpiredHits: nextHits,
              },
            },
          });
          if (finalExpireNow) {
            this.logger.warn(
              `🚨 [DIAGNOSTIC] Marking provider ${provider.id} (${provider.providerType}) as EXPIRED in OrderStatusCron.checkPhonePeOrdersForMerchant`,
            );
            this.logger.warn(`🚨 [DIAGNOSTIC] EXPIRED write stack:\n${stack}`);
            this.logger.warn(
              `🚫 PhonePe session expired for provider ${provider.id}. Marked as EXPIRED${isWebApi ? ` after ${nextHits} consecutive checks` : ""}.`,
            );
          } else {
            this.logger.warn(
              `⚠️ PhonePe sessionExpired for provider ${provider.id} (${nextHits}/${sessionExpiredLimit}). Keeping ACTIVE for web-api retry window.`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `Failed to mark provider ${provider.id} as EXPIRED: ${e?.message}`,
          );
        }
        return;
      }

      // Auto-heal for web-api: successful fetch means session is currently usable.
      // Restore ACTIVE and reset expiry counter even if no token/cookie delta was returned.
      if ((method || "").toLowerCase() === "web-api") {
        try {
          const latestProvider = await this.prisma.merchantProvider.findUnique({
            where: { id: provider.id },
            select: { credentials: true },
          });
          const latestCreds = (latestProvider?.credentials as any) || config;

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

      const hasSessionUpdate =
        response?.refreshedToken ||
        (response?.csrfToken && response?.csrfToken !== csrfToken) ||
        (response?.cookiesString && response?.cookiesString !== cookiesString);

      if (hasSessionUpdate) {
        try {
          const latestProvider = await this.prisma.merchantProvider.findUnique({
            where: { id: provider.id },
            select: { credentials: true }
          });
          const latestCreds: any = latestProvider?.credentials || config;

          const dbChangedAuth = latestCreds.token !== config.token || latestCreds.refreshToken !== config.refreshToken;

          const newToken = response.refreshedToken || latestCreds.token;
          const newRefreshToken = response.refreshedRefreshToken || latestCreds.refreshToken;
          const newCsrfToken = response.csrfToken || latestCreds.csrfToken;

          let newCookiesString = latestCreds.cookiesString;
          if (response.refreshedToken || response.refreshedRefreshToken) {
            newCookiesString = response.cookiesString || latestCreds.cookiesString;
          } else if (!dbChangedAuth && response.cookiesString && response.cookiesString !== config.cookiesString) {
            newCookiesString = response.cookiesString;
          }

          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: {
              credentials: {
                ...latestCreds,
                webSessionExpiredHits: 0,
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
              },
            },
          });
          this.logger.log(
            `🔄 Persisted updated PhonePe session metadata for provider ${provider.id}`,
          );
        } catch (dbError) {
          this.logger.warn(
            `Could not persist PhonePe session updates: ${dbError.message}`,
          );
        }
      }

      const results = response?.data?.results || response?.results || [];

      if (results.length > 0) {
        let maxTime = 0;
        for (const txn of results) {
          const tTime = txn.transactionDate || txn.createdDate || txn.createdAt;
          if (tTime) {
            const ms = new Date(tTime).getTime();
            if (ms > maxTime) maxTime = ms;
          }
        }
        if (maxTime > 0) {
          this.providerLastTxnTime.set(provider.id, maxTime);
        }
      }

      this.logger.log(`[Order Status Debug] Checking ${orders.length} orders against ${results.length} PhonePe txns for merchant ${provider.merchantId}`);

      if (results.length === 0) return;

      this.logger.log(
        `📋 Found ${results.length} PhonePe txns for merchant ${provider.merchantId} (${orders.length} orders)`,
      );

      for (const order of orders) {
        const orderAmount = Number(order.amount);
        const matchingTxn = results.find((txn: any) => {
          const txnAmount = Number(txn.amount) / 100;
          if (txnAmount !== orderAmount) return false;

          const merchantTxnId = txn.merchantTransactionId || "";
          const txnNote = txn.transactionNote || "";
          const sanitizedOrderId = order.externalOrderId.replace(/[^a-zA-Z0-9]/g, "");
          return (
            merchantTxnId.includes(order.externalOrderId) ||
            merchantTxnId === order.externalOrderId ||
            txnNote.includes(order.externalOrderId) ||
            txnNote.includes(sanitizedOrderId)
          );
        });

        if (matchingTxn) {
          console.log("Order Payload ", order);

          this.logger.log(
            `🎯 Found matching PhonePe transaction for order ${order.externalOrderId}`,
          );
          await this.handlePhonePeTransactionMatch(order, matchingTxn, provider);
        }
      }
    } catch (error) {
      this.logger.error(
        `PhonePe check failed for merchant ${provider.merchantId}: ${error.message}`,
      );
    }
  }

  private async handlePaytmTransactionMatch(
    order: any,
    txn: any,
    provider: any,
  ) {
    const txnStatus = txn.orderStatus || txn.status;

    if (
      txnStatus === "SUCCESS" ||
      txnStatus === "COMPLETED" ||
      txnStatus === "TXN_SUCCESS"
    ) {
      let amount = 0;
      if (txn.payMoneyAmount?.value) {
        amount = parseFloat(txn.payMoneyAmount.value) / 100;
      } else if (txn.payAmount?.value) {
        amount = parseFloat(txn.payAmount.value) / 100;
      } else if (txn.amount) {
        amount = parseFloat(txn.amount) / 100;
      }

      const success = await this.syncTransactionAndCompleteOrder(order, {
        externalTransactionId: txn.merchantTransId || txn.bizOrderId,
        amount: amount,
        currency: "INR",
        status: "SUCCESS",
        paymentMethod: "UPI",
        providerCode: "PAYTM",
        providerResponse: txn,
        customerName: txn.additionalInfo?.customerName || txn.nickName,
        customerContact: txn.additionalInfo?.virtualPaymentAddr,
        utr: txn.bankTxnId || txn.merchantTransId || null,
        paymentApp: txn.additionalInfo?.payerPSP,
        providerId: provider.id,
        merchantId: order.merchantId,
        orderId: order.id,
      });

      if (success) {
        this.logger.log(`🎉 Order ${order.externalOrderId} completed via Paytm!`);
      }
    }
  }

  private async handlePhonePeTransactionMatch(
    order: any,
    txn: any,
    provider: any,
  ) {
    const txnStatus = txn.paymentState || txn.status;

    if (txnStatus === "SUCCESS" || txnStatus === "COMPLETED") {
      const amountInRupees = Number(txn.amount) / 100;

      const success = await this.syncTransactionAndCompleteOrder(order, {
        externalTransactionId: txn.transactionId,
        amount: amountInRupees,
        currency: "INR",
        status: "SUCCESS",
        paymentMethod: "UPI",
        providerCode: "PHONEPE",
        providerResponse: txn,
        customerName: txn.customerDetails?.userName,
        customerContact: txn.instrumentDetails?.[0]?.vpa,
        utr: txn.utr,
        paymentApp: txn.paymentApp?.paymentApp,
        providerId: provider.id,
        merchantId: order.merchantId,
        orderId: order.id,
      });

      if (success) {
        this.logger.log(
          `🎉 Order ${order.externalOrderId} completed via PhonePe!`,
        );
      }
    }
  }

  private async checkBharatPeOrdersForMerchant(
    orders: any[],
    provider: any,
    config: any,
  ) {
    try {
      const accessToken = config.accessToken;
      const merchantId = config.merchantId;
      const cookie = config.cookie || "";

      if (!accessToken || !merchantId) return;

      const now = new Date();
      const oldestOrderCreatedAt = Math.min(...orders.map(o => new Date(o.createdAt).getTime()));
      const lastTxnTime = this.providerLastTxnTime.get(provider.id);
      const fromTimeMs = lastTxnTime ? lastTxnTime - 60000 : oldestOrderCreatedAt - 5 * 60000;
      const safeFromTimeMs = Math.max(fromTimeMs, now.getTime() - 24 * 60 * 60 * 1000);
      const fromDate = new Date(safeFromTimeMs);

      const response = await this.bharatpeService.fetchTransactionHistory(
        merchantId,
        accessToken,
        cookie,
        fromDate,
        now,
      );

      if (!response?.success) {
        if (response.authError) {
          this.logger.error(
            "🚨 BharatPe auth expired. Marking provider as unauthorized.",
          );
          try {
            const meta = (provider.metadata as any) || {};
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
              `Failed to mark BharatPe provider ${provider.id}: ${e?.message}`,
            );
          }
        }
        return;
      }
      const results = response?.data?.results || [];
      if (results.length === 0) return;

      if (results.length > 0) {
        let maxTime = 0;
        for (const txn of results) {
          const raw = txn.paymentTimestamp ?? txn.transactionDate ?? txn.paymentDate ?? txn.createdAt;
          if (raw) {
            let tTime = raw;
            if (typeof raw === "number") tTime = raw < 1e12 ? raw * 1000 : raw;
            else {
              const parsed = new Date(raw).getTime();
              if (!Number.isNaN(parsed)) tTime = parsed;
            }
            if (typeof tTime === "number" && tTime > maxTime) maxTime = tTime;
          }
        }
        if (maxTime > 0) this.providerLastTxnTime.set(provider.id, maxTime);
      }

      this.logger.log(`📋 Found ${results.length} BharatPe txns for merchant ${merchantId} (${orders.length} orders)`);


      const getBharatPeTxnTimeMs = (txn: any): number | null => {
        const raw =
          txn.paymentTimestamp ??
          txn.transactionDate ??
          txn.paymentDate ??
          txn.createdAt;
        if (raw == null) return null;
        if (typeof raw === "number")
          return raw < 1e12 ? raw * 1000 : raw;
        const parsed = new Date(raw).getTime();
        return Number.isNaN(parsed) ? null : parsed;
      };

      let expectedPayeeIdentifier: string | null = null;
      const metadata = provider.metadata as any;
      const upiId: string | undefined = metadata?.upiId || metadata?.upi_id;
      if (upiId && typeof upiId === "string") {
        const atIndex = upiId.indexOf("@");
        const prefix = atIndex > 0 ? upiId.substring(0, atIndex) : upiId;
        expectedPayeeIdentifier = prefix.toLowerCase();
      }

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const fiveMinutes = 5 * 60 * 1000;

      await Promise.all(orders.map(async (order) => {
        const orderCreatedAt = new Date(order.createdAt).getTime();
        const orderAmount = Number(order.amount);

        const potentialMatches = results.filter((txn: any) => {
          if (txn.status !== "SUCCESS") return false;

          if (txn.merchantId && txn.merchantId !== merchantId) return false;
          if (
            expectedPayeeIdentifier &&
            typeof txn.payeeIdentifier === "string"
          ) {
            if (txn.payeeIdentifier.toLowerCase() !== expectedPayeeIdentifier)
              return false;
          }
          if (Number(txn.amount) !== orderAmount) return false;
          const txnTimeMs = getBharatPeTxnTimeMs(txn);
          if (txnTimeMs == null) return false;
          if (
            txnTimeMs < orderCreatedAt ||
            txnTimeMs > orderCreatedAt + fiveMinutes
          )
            return false;
          return true;
        });

        for (const txn of potentialMatches) {
          const txnIdStr = String(txn.id);
          if (this.processedTransactionIds.has(txnIdStr)) continue;

          try {
            const existingTxnResponse = await axios.get(
              `${paymentServiceUrl}/transactions?externalTransactionId=${txnIdStr}`,
              { timeout: 5000,
                  headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
            },
            );
            const existingTxns = existingTxnResponse.data?.transactions || [];

            if (existingTxns.length > 0) {
              this.processedTransactionIds.add(txnIdStr);
              if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();

              const existingTxn = existingTxns[0];
              if (existingTxn.orderId) {
                if (existingTxn.orderId !== order.id) continue;
                return;
              }
            }

            this.logger.log(
              `🎯 Found matching BharatPe transaction for order ${order.externalOrderId}: ₹${txn.amount} from ${txn.payerName}`,
            );
            const success = await this.handleBharatPeTransactionMatch(order, txn, provider);
            
            if (success) {
              this.processedTransactionIds.add(txnIdStr);
              if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();
            }
            
            break;
          } catch (checkError) {
            this.logger.warn(
              `Could not verify BharatPe txn ${txn.id}: ${checkError.message}`,
            );
          }
        }
      }));
    } catch (error) {
      this.logger.error(
        `BharatPe check failed for merchant ${provider.merchantId}: ${error.message}`,
      );
    }
  }

  private async handleBharatPeTransactionMatch(
    order: any,
    txn: any,
    provider: any,
  ): Promise<boolean> {
    if (txn.status === "SUCCESS") {
      const success = await this.syncTransactionAndCompleteOrder(order, {
        externalTransactionId: String(txn.id),
        amount: Number(txn.amount),
        currency: "INR",
        status: "SUCCESS",
        paymentMethod: "UPI",
        providerCode: "BHARATPE",
        providerResponse: txn,
        customerName: txn.payerName || "N/A",
        customerContact: txn.payerHandle || null,
        utr: txn.bankReferenceNo || txn.internalUtr,
        paymentApp: txn.payerHandle,
        providerId: provider.id,
        merchantId: order.merchantId,
        orderId: order.id,
      });

      if (success) {
        this.logger.log(
          `🎉 Order ${order.externalOrderId} completed via BharatPe!`,
        );
      }
      return success;
    }
    return false;
  }

  private async checkGPayOrdersForMerchant(
    orders: any[],
    provider: any,
    config: any,
    opts?: { immediate?: boolean },
  ) {
    const immediate = Boolean(opts?.immediate);
    if (!immediate) {
      const lastSync = this.lastGPaySyncTime.get(provider.id) || 0;
      const timeSinceLastSync = Date.now() - lastSync;

      if (timeSinceLastSync < 25_000) {
        this.logger.log(`⏭️ GPay sync for ${provider.id} ran ${Math.round(timeSinceLastSync / 1000)}s ago, skipping this tick`);
        return;
      }
    }

    this.lastGPaySyncTime.set(provider.id, Date.now());

    try {
      this.logger.log(
        `${immediate ? "⚡" : "🔍"} ${immediate ? "Immediate" : "Fetching"} GPay dashboard for merchant ${provider.merchantId} to match ${orders.length} orders...`,
      );

      if (orders.length === 0) return;

      const now = new Date();
      const fromDate = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours back

      const response = await this.gpayService.syncTransactions(
        provider,
        fromDate,
        now,
      );

      if (!response.success || !response.transactions) {
        return;
      }
      let results: any[] = [];
      if (response && response.transactions) {
        // Log the raw data received from GPay API for debugging
        this.logger.log(`[GPay Raw API Data] Received ${response.transactions.length} records. First record: ${JSON.stringify(response.transactions[0] || null)}`);

        results = response.transactions.map((record: any) => {
          // Check if record is the raw array from GPay
          if (Array.isArray(record) || (Array.isArray(record[0]) && record[0].length > 3)) {
            const r = Array.isArray(record[0]) && record[0].length > 3 ? record[0] : record;
            return {
              txnId: String(r[0]),
              utr: r[1] ? String(r[1]) : null,
              timestamp: Array.isArray(r[2])
                ? new Date(r[2][0] * 1000 + Math.floor((r[2][1] || 0) / 1_000_000))
                : new Date(),
              amount: Array.isArray(r[3]) ? Number(r[3][1]) : 0,
              customerName: Array.isArray(r[8]) ? r[8][0] : null,
              customerVpa: Array.isArray(r[8]) ? r[8][1] : null,
              status: (r[5] === 3 || r[5] === 4) ? 'COMPLETED' : 'PENDING',
              note: typeof r[9] === 'string' ? r[9] : null,
            };
          }
          return record;
        });
      }

      if (results.length === 0) return;

      const getTxnTimeMs = (record: any): number => {
        if (!record || !record.timestamp) return 0;
        if (record.timestamp instanceof Date) return record.timestamp.getTime();
        if (typeof record.timestamp === "string" || typeof record.timestamp === "number") {
          return new Date(record.timestamp).getTime();
        }
        return 0;
      };

      orders.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      results.sort((a: any, b: any) => {
        return getTxnTimeMs(a) - getTxnTimeMs(b);
      });

      this.logger.log(
        `📋 Found ${results.length} GPay txns for merchant ${provider.merchantId} (mapped successfully)`,
      );

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const matchWindowMs = 5 * 60 * 1000; // 5 minute window
      const usedTxnIds = new Set<string>();

      const normalizeRef = (ref: string) => ref.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

      let needsDashboardRefresh = false;

      for (const order of orders) {
        // Skip if already being processed or already completed
        if (this.processingOrders.has(order.id)) continue;

        const orderCreatedAt = new Date(order.createdAt).getTime();
        const orderAmount = Number(order.amount);
        const orderRef = normalizeRef(order.externalOrderId);

        // Find a matching transaction by amount and time window
        let matchingTxn: any = null;
        for (const txn of results) {
          const externalTxnId = String(txn.txnId);

          if (usedTxnIds.has(externalTxnId)) continue;
          if (txn.status !== 'COMPLETED') continue;

          const txnAmount = Number(txn.amount);
          if (txnAmount !== orderAmount) continue;

          // Strong match by merchant/client reference
          const noteRef = normalizeRef(txn.note || "");
          let isMatch = false;
          if (noteRef && orderRef && noteRef.includes(orderRef)) {
            isMatch = true;
          } else if (!noteRef) {
            // No note (yuZqtb push) — only match by time if this is the ONLY pending order with this amount
            // Otherwise, we risk matching the wrong order. The dashboard cron (with notes) will handle it within 25s.
            const sameAmountOrders = orders.filter(
              (o: any) => Number(o.amount) === txnAmount && !this.processingOrders.has(o.id)
            );
            if (sameAmountOrders.length === 1) {
              const txnTimeMs = getTxnTimeMs(txn);
              if (txnTimeMs !== 0) {
                const isTimeMatch = txnTimeMs >= (orderCreatedAt - 60000) && txnTimeMs <= (orderCreatedAt + matchWindowMs);
                if (isTimeMatch) {
                  isMatch = true;
                }
              }
            } else {
              this.logger.log(
                `⏳ Skipping time-based match for order ${order.externalOrderId}: ${sameAmountOrders.length} orders with same amount ₹${txnAmount} — waiting for dashboard note`,
              );
              needsDashboardRefresh = true;
            }
          } else {
            // Has a note but it doesn't match this order — SKIP.
            // The note definitively identifies which order this payment belongs to.
            // DO NOT fall back to time-based matching — that causes wrong-order matches.
            continue;
          }

          if (isMatch) {
            // Claim it SYNCHRONOUSLY to prevent race conditions during the DB check
            usedTxnIds.add(externalTxnId);
            
            if (this.processedTransactionIds.has(externalTxnId)) {
               continue;
            }

            // Risk 2: Collision prevention (DB level)
            try {
              const existingTxnResponse = await axios.get(
                `${paymentServiceUrl}/transactions?externalTransactionId=${externalTxnId}`,
                { timeout: 5000,
                    headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
                },
              );
              const existingTxns = existingTxnResponse.data?.transactions || [];

              if (existingTxns.length > 0 && existingTxns[0].orderId) {
                // Linked already, keep it in usedTxnIds, skip this transaction and KEEP SEARCHING!
                this.processedTransactionIds.add(externalTxnId);
                if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();
                continue;
              } else {
                // Valid unlinked match!
                matchingTxn = txn;
                break;
              }
            } catch (e: any) {
              this.logger.warn(`Failed to verify GPay txn existence: ${e.message}`);
              // Fallback: assume it's good if DB check fails
              matchingTxn = txn;
              break;
            }
          }
        }

        if (matchingTxn) {
          const mTxn: any = matchingTxn;
          const externalTxnId = String(mTxn.txnId);
          const utr = mTxn.utr ? String(mTxn.utr) : null;

          // Ensure it's claimed
          usedTxnIds.add(externalTxnId);

          this.logger.log(
            `🎯 Found matching GPay transaction for order ${order.externalOrderId}: ₹${order.amount} (GPay ID: ${externalTxnId}, UTR: ${utr || 'N/A'})`,
          );

          const success = await this.syncTransactionAndCompleteOrder(order, {
            externalTransactionId: externalTxnId,
            amount: orderAmount,
            currency: "INR",
            status: "COMPLETED",
            paymentMethod: "UPI",
            providerCode: "GPAY",
            providerResponse: mTxn,
            customerName: mTxn.customerName || "N/A",
            customerContact: mTxn.customerVpa || null,
            utr: utr,
            paymentApp: mTxn.note || "GPay",
            providerId: provider.id,
            merchantId: order.merchantId,
            orderId: order.id,
          });
          
          if (success) {
            this.processedTransactionIds.add(externalTxnId);
            if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();
          }
        }
      }

      if (needsDashboardRefresh) {
        const lastRefresh = this.lastForcedRefreshTime.get(provider.id) || 0;
        const cooldownMs = 60_000; // Only force-refresh once per 60 seconds per provider
        if (Date.now() - lastRefresh > cooldownMs) {
          this.logger.log(`🔄 Triggering forced dashboard refresh for provider ${provider.id} due to ambiguous transactions without notes.`);
          this.lastForcedRefreshTime.set(provider.id, Date.now());
          // Run it in the background so we don't block the cron
          this.gpayService.forceDashboardRefresh(provider.id).catch(e => {
            this.logger.warn(`Failed to trigger dashboard refresh: ${e?.message}`);
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `GPay check failed for merchant ${provider.merchantId}: ${error.message}`,
      );
    }
  }

  private async syncTransactionAndCompleteOrder(order: any, txnData: any): Promise<boolean> {
    const orderId = order.id;

    if (this.processingOrders.has(orderId)) {
      this.logger.log(
        `⏭️ Order ${order.externalOrderId} is already being processed, skipping`,
      );
      return false;
    }

    if (Math.abs(Number(order.amount) - Number(txnData.amount)) > 0.01) {
      this.logger.error(`🚨 FATAL: AMOUNT MISMATCH in syncTransactionAndCompleteOrder: Order ${order.externalOrderId} requested ₹${order.amount}, but transaction was ₹${txnData.amount}. Preventing completion!`);
      return false;
    }

    this.processingOrders.add(orderId);

    try {
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;

      try {
        const orderCheck = await axios.get(
          `${paymentServiceUrl}/orders/${order.id}`,
          {
            timeout: 5000,
              headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        },
        );
        if (orderCheck.data?.order?.status === "COMPLETED") {
          this.logger.log(
            `⏭️ Order ${order.externalOrderId} already COMPLETED, skipping completion.`,
          );
          return true;
        }
      } catch (checkError) {
        this.logger.warn(
          `Order status check failed: ${checkError.message}`,
        );
      }

      // 1. Sync the transaction
      const syncResponse = await axios.post(`${paymentServiceUrl}/transactions/sync`, {
        ...txnData,
        status: txnData.status === "COMPLETED" ? "SUCCESS" : txnData.status
      }, {
        timeout: 10000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
    });

      if (!syncResponse.data?.success) {
        this.logger.error(`Failed to sync transaction via API: ${syncResponse.data?.error || 'Unknown error'}`);
        return false;
      }

      // 2. Update order status to COMPLETED
      await axios.patch(
        `${paymentServiceUrl}/orders/${order.id}/status`,
        {
          status: "COMPLETED",
          utr: txnData.utr // Persist the UTR on the order
        },
        {
          timeout: 10000,
            headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        },
      );

      this.logger.log(
        `✅ Synced transaction and completed order ${order.externalOrderId}`,
      );

      // 3. Update merchant usage counters
      try {
        const amount = Number(txnData.amount) || Number(order.amount);
        await this.updateMerchantUsage(order.merchantId, amount);
      } catch (usageError) {
        this.logger.error(
          `Failed to update merchant usage for ${order.merchantId}: ${usageError.message}`,
        );
      }
      
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to sync/complete order ${order.externalOrderId}: ${error.message}`,
      );
      return false;
    } finally {
      this.processingOrders.delete(orderId);
    }
  }

  private async checkQuintusPayOrdersForMerchant(
    orders: any[],
    provider: any,
    config: any,
  ) {
    try {
      const accessToken = config.accessToken;
      if (!accessToken) return;

      const now = new Date();
      const oldestOrderCreatedAt = Math.min(...orders.map(o => new Date(o.createdAt).getTime()));
      const lastTxnTime = this.providerLastTxnTime.get(provider.id);
      const fromTimeMs = lastTxnTime ? lastTxnTime - 60000 : oldestOrderCreatedAt - 5 * 60000;
      const safeFromTimeMs = Math.max(fromTimeMs, now.getTime() - 24 * 60 * 60 * 1000);
      const fromDate = new Date(safeFromTimeMs);

      const response = await this.quintuspayService.fetchTransactionHistory(
        accessToken,
        fromDate,
        now,
      );

      if (!response?.success) {
        return;
      }

      let results = response?.transactions || [];
      if (results.length === 0 && response?.data) {
        // Fallback for different response structure if needed
        if (Array.isArray(response.data)) {
          results = response.data;
        } else if (Array.isArray(response.data.results)) {
          results = response.data.results;
        }
      }
      if (results.length === 0) return;

      if (results.length > 0) {
        let maxTime = 0;
        for (const txn of results) {
          const rawTs = txn.created_at || txn.description?.transactionTimestamp || txn.createdAt || txn.updatedAt;
          if (rawTs) {
            const ms = new Date(rawTs).getTime();
            if (ms > maxTime) maxTime = ms;
          }
        }
        if (maxTime > 0) this.providerLastTxnTime.set(provider.id, maxTime);
      }

      this.logger.log(
        `📋 Found ${results.length} QuintusPay txns for merchant ${provider.merchantId} (${orders.length} orders)`,
      );
      this.logger.log(`[DEBUG] Full QuintusPay response: ${JSON.stringify(results, null, 2)}`);

      await Promise.all(orders.map(async (order) => {
        this.logger.log(`[DEBUG] Checking order ${order.externalOrderId} with amount ${order.amount}`);
        const orderAmount = Number(order.amount);
        const orderCreatedAt = new Date(order.createdAt).getTime();
        const fiveMinutes = 5 * 60 * 1000;

        const potentialMatches = results.filter((txn: any) => {
          if (txn.status !== "SUCCESS" && txn.status !== "PAID") return false;
          if (Number(txn.amount) !== orderAmount) return false;

          if (txn.description?.merchantRequestId) {
            if (txn.description.merchantRequestId === order.externalOrderId || txn.description.merchantRequestId === order.id) {
              return true; // Exact match, skip time window check
            }
          }

          const rawTs = txn.created_at || txn.description?.transactionTimestamp || txn.createdAt || txn.updatedAt;
          const txnTimeMs = rawTs ? new Date(rawTs).getTime() : null;

          if (txnTimeMs == null) {
            this.logger.log(`[DEBUG] Missing timestamp for txn ${txn._id}`);
            return false;
          }
          if (
            txnTimeMs < orderCreatedAt - 60 * 1000 || // 1 min buffer
            txnTimeMs > orderCreatedAt + fiveMinutes
          ) {
            this.logger.log(`[DEBUG] Timestamp out of bounds for txn ${txn._id}: txnTimeMs=${txnTimeMs}, orderCreatedAt=${orderCreatedAt}`);
            return false;
          }

          return true;
        });

        this.logger.log(`[DEBUG] Potential Matches for ${order.externalOrderId}: ${potentialMatches.length}`);

        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;

        for (const txn of potentialMatches) {
          const externalId = String(txn.referenceNo || txn._id || txn.description?.gatewayTransactionId);
          if (this.processedTransactionIds.has(externalId)) continue;
          
          try {
            const existingTxnResponse = await axios.get(
              `${paymentServiceUrl}/transactions?externalTransactionId=${externalId}`,
              { timeout: 5000,
                  headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
            },
            );
            const existingTxns = existingTxnResponse.data?.transactions || [];

            if (existingTxns.length > 0) {
              this.processedTransactionIds.add(externalId);
              if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();
              
              const existingTxn = existingTxns[0];
              if (existingTxn.orderId) {
                if (existingTxn.orderId !== order.id) continue;
                return;
              }
            }

            this.logger.log(
              `🎯 Found matching QuintusPay transaction for order ${order.externalOrderId}: ₹${txn.amount}`,
            );
            const success = await this.handleQuintusPayTransactionMatch(order, txn, provider);
            
            if (success) {
              this.processedTransactionIds.add(externalId);
              if (this.processedTransactionIds.size > 10000) this.processedTransactionIds.clear();
            }
            
            break;
          } catch (checkError) {
            this.logger.warn(
              `Could not verify QuintusPay txn ${txn._id}: ${checkError.message}`,
            );
          }
        }
      }));
    } catch (error) {
      this.logger.error(
        `QuintusPay check failed for merchant ${provider.merchantId}: ${error.message}`,
      );
    }
  }

  private async handleQuintusPayTransactionMatch(
    order: any,
    txn: any,
    provider: any,
  ): Promise<boolean> {
    const txnStatus = txn.status?.toUpperCase();

    if (txnStatus === "SUCCESS" || txnStatus === "PAID") {
      const amount = Number(txn.amount);
      const externalId = String(txn.referenceNo || txn._id || txn.description?.gatewayTransactionId);

      const success = await this.syncTransactionAndCompleteOrder(order, {
        externalTransactionId: externalId,
        amount: amount,
        currency: "INR",
        status: "SUCCESS",
        paymentMethod: "UPI",
        providerCode: "QUINTUSPAY",
        providerResponse: txn,
        customerName: txn.customerName || "N/A",
        customerContact: txn.customerMobile || null,
        utr: txn.bankReferenceNo || txn.utr || null,
        paymentApp: txn.paymentApp || "UPI",
        providerId: provider.id,
        merchantId: order.merchantId,
        orderId: order.id,
      });

      if (success) {
        this.logger.log(`🎉 Order ${order.externalOrderId} completed via QuintusPay!`);
      }
      return success;
    }
    return false;
  }

  private async updateMerchantUsage(merchantId: string, amount: number) {
    const config = await this.prisma.merchantConfig.findUnique({
      where: { merchantId },
    });

    if (!config) {
      this.logger.warn(
        `No config found for merchant ${merchantId}, skipping usage update`,
      );
      return;
    }

    const now = new Date();
    const lastReset = new Date(config.lastDailyReset);
    const isNewDay =
      now.getDate() !== lastReset.getDate() ||
      now.getMonth() !== lastReset.getMonth() ||
      now.getFullYear() !== lastReset.getFullYear();

    const lastMonthlyReset = new Date(config.lastMonthlyReset);
    const isNewMonth =
      now.getMonth() !== lastMonthlyReset.getMonth() ||
      now.getFullYear() !== lastMonthlyReset.getFullYear();

    const updateData: any = {};

    if (isNewDay) {
      updateData.currentDailyAmount = amount;
      updateData.currentDailyTxnCount = 1;
      updateData.lastDailyReset = now;
    } else {
      updateData.currentDailyAmount = config.currentDailyAmount.plus(amount);
      updateData.currentDailyTxnCount = config.currentDailyTxnCount + 1;
    }

    if (isNewMonth) {
      updateData.currentMonthlyAmount = amount;
      updateData.currentMonthlyTxnCount = 1;
      updateData.lastMonthlyReset = now;
    } else {
      updateData.currentMonthlyAmount =
        config.currentMonthlyAmount.plus(amount);
      updateData.currentMonthlyTxnCount = config.currentMonthlyTxnCount + 1;
    }

    await this.prisma.merchantConfig.update({
      where: { merchantId },
      data: updateData,
    });

    const updatedConfig = await this.prisma.merchantConfig.findUnique({
      where: { merchantId },
    });

    if (updatedConfig) {
      const dailyExceeded =
        Number(updatedConfig.currentDailyAmount) >=
        Number(updatedConfig.dailyMaxAmount) ||
        updatedConfig.currentDailyTxnCount >= updatedConfig.dailyMaxTxnCount;
      const monthlyExceeded =
        Number(updatedConfig.currentMonthlyAmount) >=
        Number(updatedConfig.monthlyMaxAmount) ||
        (updatedConfig.monthlyMaxTxnCount &&
          updatedConfig.currentMonthlyTxnCount >=
          updatedConfig.monthlyMaxTxnCount);

      if (dailyExceeded || monthlyExceeded) {
        const reasons: string[] = [];
        if (
          Number(updatedConfig.currentDailyAmount) >=
          Number(updatedConfig.dailyMaxAmount)
        ) {
          reasons.push(`Daily amount limit ₹${updatedConfig.dailyMaxAmount}`);
        }
        if (
          updatedConfig.currentDailyTxnCount >= updatedConfig.dailyMaxTxnCount
        ) {
          reasons.push(
            `Daily transaction limit ${updatedConfig.dailyMaxTxnCount} txns`,
          );
        }
        if (
          Number(updatedConfig.currentMonthlyAmount) >=
          Number(updatedConfig.monthlyMaxAmount)
        ) {
          reasons.push(
            `Monthly amount limit ₹${updatedConfig.monthlyMaxAmount}`,
          );
        }
        if (
          updatedConfig.monthlyMaxTxnCount &&
          updatedConfig.currentMonthlyTxnCount >=
          updatedConfig.monthlyMaxTxnCount
        ) {
          reasons.push(
            `Monthly transaction limit ${updatedConfig.monthlyMaxTxnCount} txns`,
          );
        }

        const statusReason =
          reasons.length > 0
            ? reasons.join(", ")
            : dailyExceeded
              ? "Daily limit reached"
              : "Monthly limit reached";

        await this.prisma.merchant.update({
          where: { id: merchantId },
          data: {
            status: "LIMIT_EXCEEDED",
            statusReason: statusReason,
          },
        });
        this.logger.warn(`⚠️ Merchant ${merchantId} blocked: ${statusReason}`);
      }
    }
  }

  private async checkHdfcOrdersForMerchant(orders: any[], provider: any, config: any) {
    try {
      const sessionId = config.sessionId;
      const deviceId = config.deviceId;

      if (!sessionId || !deviceId) return;

      const oldestOrderCreatedAt = Math.min(...orders.map(o => new Date(o.createdAt).getTime()));
      // Look back 5 minutes from the oldest pending order
      const fromDate = new Date(oldestOrderCreatedAt - 5 * 60000);
      const toDate = new Date();

      const startStr = fromDate.toISOString().split('T')[0];
      const endStr = toDate.toISOString().split('T')[0];

      const response = await this.hdfcService.fetchTransactionHistory(
        sessionId,
        deviceId,
        startStr,
        endStr,
      );

      if (response.sessionExpired) {
        // Expiry logic is usually handled by HdfcKeepaliveCron, but we could mark EXPIRED here.
        this.logger.warn(`HDFC session expired during OrderStatus check for provider ${provider.id}.`);
        return;
      }

      if (!response.transactions || response.transactions.length === 0) return;

      this.logger.log(
        `📋 Found ${response.transactions.length} HDFC txns for merchant ${provider.merchantId} (${orders.length} orders)`,
      );

      for (const order of orders) {
        const orderAmount = Number(order.amount);
        const matchingTxn = response.transactions.find((txn: any) => {
          const txnAmount = Number(txn.amount);
          if (txnAmount !== orderAmount) return false;

          const sanitizedOrderId = order.externalOrderId.replace(/[^a-zA-Z0-9]/g, "");
          const stringifiedTxn = JSON.stringify(txn).replace(/[^a-zA-Z0-9]/g, "");

          return stringifiedTxn.includes(sanitizedOrderId);
        });

        if (matchingTxn) {
          this.logger.log(`🎯 Found matching HDFC transaction for order ${order.externalOrderId}`);
          await this.handleHdfcTransactionMatch(order, matchingTxn, provider);
        }
      }
    } catch (err: any) {
      this.logger.error(`HDFC check failed for merchant ${provider.merchantId}: ${err.message}`);
    }
  }

  private async handleHdfcTransactionMatch(
    order: any,
    txn: any,
    provider: any,
  ) {
    const rawStatus = txn.status || txn.txnStatus || txn.transactionStatus;
    const txnStatus = (rawStatus || "SUCCESS").toString().toUpperCase();

    this.logger.log(`[HDFC Debug] Match evaluated! rawStatus=${rawStatus}, txnStatus=${txnStatus}, txn=${JSON.stringify(txn)}`);

    if (
      txnStatus === "SUCCESS" ||
      txnStatus === "COMPLETED" ||
      txnStatus === "SALE SUCCESS" ||
      txnStatus === "SALESUCCESS" ||
      txnStatus === "APPROVED" ||
      txnStatus === "SETTLED" ||
      !["FAILED", "DECLINED", "REJECTED", "REFUNDED", "REFUND"].includes(txnStatus)
    ) {
      const amount = Number(txn.amount || txn.txnAmount || txn.transactionAmount || order.amount);

      const dateStr = txn.txnDate || txn.transactionDate || txn.endTime || txn.sortTime;
      let parsedDate = new Date();
      if (dateStr) {
        if (typeof dateStr === 'string' && dateStr.match(/^\d{2}-\d{2}-\d{4}/)) {
          const parts = dateStr.split(' ');
          const dateParts = parts[0].split('-');
          const timePart = parts[1] || '00:00:00';
          parsedDate = new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${timePart}`);
        } else {
          parsedDate = new Date(dateStr);
        }
      }

      const success = await this.syncTransactionAndCompleteOrder(order, {
        externalTransactionId: txn.txnId || txn.transactionId || txn.rrn || txn.utr || `hdfc-${Date.now()}`,
        amount: amount,
        currency: "INR",
        status: "SUCCESS",
        paymentMethod: "UPI",
        providerCode: "HDFC",
        providerResponse: txn,
        customerName: txn.payerName || txn.customerName || null,
        customerContact: txn.payerVpa || txn.customerVpa || null,
        utr: txn.rrn || txn.utr || txn.bankReferenceNumber || null,
        paymentApp: txn.paymentApp,
        providerId: provider.id,
        merchantId: order.merchantId,
        orderId: order.id,
        createdAt: parsedDate,
        completedAt: parsedDate,
      });

      if (success) {
        this.logger.log(`🎉 Order ${order.externalOrderId} completed via HDFC!`);
      }
    }
  }
}

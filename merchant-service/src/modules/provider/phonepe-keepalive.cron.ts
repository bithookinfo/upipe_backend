import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { PhonePeWebService } from "./phonepe-web.service";
import { MerchantProviderStatus, ProviderType } from "@prisma/client";
import {
  formatPhonePeSessionSignals,
  getPhonePeSessionSignals,
  shouldTreatAsTransientPhonePeSessionDrift,
} from "./phonepe-session.util";

@Injectable()
export class PhonePeKeepaliveCron {
  private readonly logger = new Logger(PhonePeKeepaliveCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phonePeWeb: PhonePeWebService,
  ) {}

  @Cron("0 0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58 * * * *")
  async keepalivePhonePeWebProviders() {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.PHONEPE,
          status: MerchantProviderStatus.ACTIVE,
          // Keepalive MUST run even for deactivated merchants to prevent their 
          // session cookies from expiring overnight due to inactivity.
          merchant: { deletedAt: null },
        },
        select: {
          id: true,
          merchantId: true,
          credentials: true,
        },
        take: 50,
      });

      const webProviders = providers.filter((p) => {
        const c: any = p.credentials || {};
        const method = (c.method || c.authMethod || c.credentials?.authMethod || "")
          .toString()
          .toLowerCase();
        return method === "web-api";
      });

      if (webProviders.length === 0) return;

      this.logger.log(
        `🔄 PhonePe keepalive: warming ${webProviders.length} web-api provider(s)`,
      );

      const concurrency = 3;
      for (let i = 0; i < webProviders.length; i += concurrency) {
        const batch = webProviders.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (p) => {
            const credentials: any = p.credentials || {};
            // Web-api flow historically stored the access JWT under different keys.
            // Accept all known variants so keepalive never silently skips after reconnect.
            const token =
              credentials.credentials?.token ||
              credentials.token ||
              credentials.credentials?.sessionToken ||
              credentials.sessionToken ||
              credentials.credentials?.accessToken ||
              credentials.accessToken;
            const cookiesString =
              credentials.credentials?.cookiesString || credentials.cookiesString;
            const csrfToken =
              credentials.credentials?.csrfToken || credentials.csrfToken;
            const refreshToken =
              credentials.credentials?.refreshToken || credentials.refreshToken;
            const groupValue =
              credentials.credentials?.groupValue || credentials.groupValue;
            const fingerprint =
              credentials.credentials?.fingerprint || credentials.fingerprint;

            if (!token || !fingerprint) {
              const keysTop = Object.keys(credentials || {}).slice(0, 30);
              const keysNested = Object.keys(credentials.credentials || {}).slice(
                0,
                30,
              );
              this.logger.warn(
                `Keepalive skipped: missing web creds for provider ${p.id} ` +
                  `[hasToken=${!!token} hasCookies=${!!cookiesString} hasCsrf=${!!csrfToken} hasFingerprint=${!!fingerprint}] ` +
                  `[topKeys=${keysTop.join(",")}] [nestedKeys=${keysNested.join(",")}]`,
              );
              return;
            }

            // If DB doesn't have cookies/csrf, recover from persistent profile.
            let effectiveCookies = cookiesString || "";
            let effectiveCsrf = csrfToken || "";
            
            const forceHttp =
              String(process.env.PHONEPE_WEB_FORCE_HTTP || "false").toLowerCase() !==
              "false";

            if (!effectiveCookies || !effectiveCsrf) {
              if (forceHttp) {
                this.logger.warn(
                  `Keepalive skipped: missing cookies/csrf in DB for provider ${p.id} and pure HTTP mode is enabled (no browser recovery)`,
                );
                return;
              }
              try {
                const snap =
                  await this.phonePeWeb.getWebSessionSnapshotFromPersistentBrowser(
                    fingerprint,
                  );
                if (snap?.cookiesString) effectiveCookies = snap.cookiesString;
                if (snap?.csrfToken) effectiveCsrf = snap.csrfToken;
              } catch (e: any) {
                this.logger.warn(
                  `Keepalive: could not recover cookies/csrf from persistent profile for provider ${p.id}: ${e?.message}`,
                );
              }
            }

            if (!effectiveCookies || !effectiveCsrf) {
              this.logger.warn(
                `Keepalive skipped: still missing cookies/csrf for provider ${p.id} [hasCookies=${!!effectiveCookies} hasCsrf=${!!effectiveCsrf}]`,
              );
              return;
            }

            const to = new Date();
            const from = new Date(to.getTime() - 2 * 60 * 60 * 1000);

            const resp = await this.phonePeWeb.fetchTransactionHistoryWeb(
              token,
              effectiveCookies,
              effectiveCsrf,
              fingerprint,
              groupValue,
              1,
              from,
              to,
              false,
              refreshToken,
            );

            if (resp?.sessionExpired) {
              const latestCookies = String(resp?.cookiesString || cookiesString || "");
              const latestCsrf = String(resp?.csrfToken || csrfToken || "");
              const signals = getPhonePeSessionSignals(latestCookies, latestCsrf);

              // 412/401 bursts can be transient for web-api even with intact session cookies.
              // Do not mark EXPIRED while core auth signals are still present.
              const currentHits = Number(credentials.webSessionExpiredHits || 0);
              const nextHits = currentHits + 1;
              const sessionExpiredLimit = Number(process.env.PHONEPE_WEB_SESSION_EXPIRED_LIMIT || 3); // Reduced from 10 to 3
              const expireNow = nextHits >= sessionExpiredLimit;

              if (shouldTreatAsTransientPhonePeSessionDrift(signals) && !expireNow) {
                // If transient and below threshold, keep ACTIVE but still track the hit
                const latestProvider = await this.prisma.merchantProvider.findUnique({
                  where: { id: p.id },
                  select: { credentials: true }
                });
                const latestCreds = (latestProvider?.credentials as any) || credentials;

                await this.prisma.merchantProvider.update({
                  where: { id: p.id },
                  data: {
                    status: MerchantProviderStatus.ACTIVE,
                    credentials: {
                      ...latestCreds,
                      webSessionExpiredHits: nextHits,
                      csrfToken: resp?.csrfToken || latestCreds.csrfToken,
                      cookiesString: resp?.cookiesString || latestCreds.cookiesString,
                      credentials: {
                        ...(latestCreds.credentials || {}),
                        csrfToken: resp?.csrfToken || latestCreds.credentials?.csrfToken || latestCreds.csrfToken,
                        cookiesString: resp?.cookiesString || latestCreds.credentials?.cookiesString || latestCreds.cookiesString,
                      },
                    },
                  },
                });
                this.logger.warn(
                  `⚠️ Keepalive got sessionExpired but session signals look healthy for provider ${p.id} [${formatPhonePeSessionSignals(signals)}]. Keeping ACTIVE (hits=${nextHits}/${sessionExpiredLimit}).`,
                );
                return;
              }

              try {
                const currentHits = Number(credentials.webSessionExpiredHits || 0);
                const nextHits = currentHits + 1;
                const expireNow = nextHits >= sessionExpiredLimit;
                const stack = (new Error().stack || "")
                  .split("\n")
                  .slice(1, 7)
                  .join("\n");
                const latestProvider = await this.prisma.merchantProvider.findUnique({
                  where: { id: p.id },
                  select: { credentials: true }
                });
                const latestCreds = (latestProvider?.credentials as any) || credentials;

                await this.prisma.merchantProvider.update({
                  where: { id: p.id },
                  data: {
                    status: expireNow ? "EXPIRED" : MerchantProviderStatus.ACTIVE,
                    credentials: {
                      ...latestCreds,
                      webSessionExpiredHits: nextHits,
                    },
                  },
                });
                if (expireNow) {
                  this.logger.warn(
                    `🚨 [DIAGNOSTIC] Marking provider ${p.id} (PHONEPE) as EXPIRED in PhonepeKeepaliveCron`,
                  );
                  this.logger.warn(
                    `🚨 [DIAGNOSTIC] EXPIRED write stack:\n${stack}`,
                  );
                  this.logger.warn(
                    `🚫 PhonePe session expired for provider ${p.id}. Marked as EXPIRED after ${nextHits} consecutive checks.`,
                  );
                } else {
                  this.logger.warn(
                    `⚠️ PhonePe keepalive got sessionExpired for provider ${p.id} (${nextHits}/${sessionExpiredLimit}). Keeping ACTIVE until threshold.`,
                  );
                }
              } catch (e: any) {
                this.logger.warn(
                  `Could not mark provider ${p.id} as EXPIRED: ${e?.message}`,
                );
              }
              return;
            }

            const hasUpdate =
              resp?.refreshedToken ||
              resp?.refreshedRefreshToken ||
              (resp?.csrfToken && resp.csrfToken !== csrfToken) ||
              (resp?.cookiesString && resp.cookiesString !== cookiesString);

            const shouldPersist =
              hasUpdate ||
              (resp?.data && resp?.cookiesString && resp?.csrfToken);

            if (!shouldPersist) return;

            try {
              const latestProvider = await this.prisma.merchantProvider.findUnique({
                where: { id: p.id },
                select: { credentials: true }
              });
              const latestCreds: any = latestProvider?.credentials || credentials;
              
              const dbChangedAuth = latestCreds.token !== credentials.token || latestCreds.refreshToken !== credentials.refreshToken;

              const newToken = resp.refreshedToken || latestCreds.token;
              const newRefreshToken = resp.refreshedRefreshToken || latestCreds.refreshToken;
              const newCsrfToken = resp.csrfToken || latestCreds.csrfToken;
              
              let newCookiesString = latestCreds.cookiesString;
              if (resp.refreshedToken || resp.refreshedRefreshToken) {
                  newCookiesString = resp.cookiesString || latestCreds.cookiesString;
              } else if (!dbChangedAuth && resp.cookiesString && resp.cookiesString !== credentials.cookiesString) {
                  newCookiesString = resp.cookiesString;
              }

              await this.prisma.merchantProvider.update({
                where: { id: p.id },
                data: {
                  status: MerchantProviderStatus.ACTIVE,
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
                    verifiedAt: new Date(),
                  },
                },
              });
              this.logger.log(
                `✅ PhonePe keepalive updated session for provider ${p.id}`,
              );
            } catch (e: any) {
              this.logger.warn(
                `Keepalive: could not persist updated session for provider ${p.id}: ${e?.message}`,
              );
            }
          }),
        );
      }
    } catch (e: any) {
      this.logger.warn(`PhonePe keepalive failed: ${e?.message}`);
    }
  }
}


import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { HdfcVyaparService } from "./hdfc-vyapar.service";
import { MerchantProviderStatus, ProviderType } from "@prisma/client";

@Injectable()
export class HdfcKeepaliveCron {
  private readonly logger = new Logger(HdfcKeepaliveCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hdfcService: HdfcVyaparService,
  ) {}

  /**
   * Every 10 minutes, refresh HDFC sessions that have stored mobileNumber + mPin.
   * HDFC sessions are short-lived, so we re-login periodically to keep them fresh.
   * Offset by 3 min from other crons to avoid concurrent load.
   */
  @Cron("0 3,13,23,33,43,53 * * * *")
  async keepaliveHdfcSessions() {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.HDFC,
          status: MerchantProviderStatus.ACTIVE,
          merchant: { deletedAt: null },
        },
        select: {
          id: true,
          merchantId: true,
          credentials: true,
        },
        take: 50,
      });

      // Filter to only providers that have mobileNumber + mPin (can auto-refresh)
      const refreshable = providers.filter((p) => {
        const c: any = p.credentials || {};
        return c.mobileNumber && c.mPin;
      });

      if (refreshable.length === 0) return;

      this.logger.log(
        `🔄 HDFC keepalive: refreshing ${refreshable.length} provider(s)`,
      );

      for (const p of refreshable) {
        try {
          const creds: any = p.credentials || {};

          // Try a lightweight call first to check if session is still alive
          const tids = await this.hdfcService.fetchTerminalInfo(creds.sessionId);

          if (tids.length > 0) {
            // Session is still alive, no need to refresh
            this.logger.debug(
              `✅ HDFC session still alive for provider ${p.id} (${tids.length} TIDs)`,
            );

            // Update tidList in credentials for transaction sync
            if (!creds.tidList || JSON.stringify(creds.tidList) !== JSON.stringify(tids)) {
              await this.prisma.merchantProvider.update({
                where: { id: p.id },
                data: {
                  credentials: {
                    ...creds,
                    tidList: tids,
                    lastKeepalive: new Date().toISOString(),
                  },
                },
              });
            }
            continue;
          }

          // Session expired — refresh it
          this.logger.log(`🔄 HDFC session expired for provider ${p.id}, refreshing...`);

          const newSession = await this.hdfcService.refreshSession(
            creds.mobileNumber,
            creds.mPin,
            creds.deviceId,
          );

          if (newSession) {
            // Fetch TIDs with the new session
            const newTids = await this.hdfcService.fetchTerminalInfo(newSession.sessionId);

            await this.prisma.merchantProvider.update({
              where: { id: p.id },
              data: {
                status: MerchantProviderStatus.ACTIVE,
                credentials: {
                  ...creds,
                  sessionId: newSession.sessionId,
                  deviceId: newSession.deviceId,
                  tidList: newTids.length > 0 ? newTids : creds.tidList,
                  lastKeepalive: new Date().toISOString(),
                  sessionRefreshCount: (creds.sessionRefreshCount || 0) + 1,
                },
              },
            });

            this.logger.log(
              `✅ HDFC session refreshed for provider ${p.id} (${newTids.length} TIDs)`,
            );
          } else {
            // Refresh failed — track consecutive failures
            const failures = (creds.sessionRefreshFailures || 0) + 1;
            const expireThreshold = 6; // After 6 consecutive failures (1 hour), mark EXPIRED

            await this.prisma.merchantProvider.update({
              where: { id: p.id },
              data: {
                status: failures >= expireThreshold ? "EXPIRED" : MerchantProviderStatus.ACTIVE,
                credentials: {
                  ...creds,
                  sessionRefreshFailures: failures,
                  lastKeepaliveAttempt: new Date().toISOString(),
                },
              },
            });

            if (failures >= expireThreshold) {
              this.logger.warn(
                `🚫 HDFC provider ${p.id} marked EXPIRED after ${failures} consecutive refresh failures`,
              );
            } else {
              this.logger.warn(
                `⚠️ HDFC session refresh failed for provider ${p.id} (${failures}/${expireThreshold})`,
              );
            }
          }
        } catch (error: any) {
          this.logger.error(
            `❌ HDFC keepalive failed for provider ${p.id}: ${error?.message}`,
          );
        }
      }
    } catch (e: any) {
      this.logger.warn(`HDFC keepalive cron failed: ${e?.message}`);
    }
  }
}

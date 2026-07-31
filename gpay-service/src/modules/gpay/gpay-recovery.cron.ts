import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { RedisService } from '../../common/redis/redis.service';
import { GpayOrchestratorService } from './gpay-orchestrator.service';
import { BrowserPoolService } from './browser-pool.service';
import { MerchantServiceClient } from '../../clients/merchant-service.client';
import { PlaywrightSessionManager } from './playwright-session-manager.service';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';

interface PendingActivationCandidate {
  merchantId: string;
  providerId: string;
  status: string;
  oldestOrderAt?: string;
}

@Injectable()
export class GpayRecoveryCron {
  private readonly logger = new Logger(GpayRecoveryCron.name);
  private readonly paymentServiceUrl: string;
  private readonly internalToken: string;
  private readonly maxAgeMs: number;
  private readonly enabled: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly merchantClient: MerchantServiceClient,
    private readonly sessionManager: PlaywrightSessionManager,
    private readonly encryptionService: GpayEncryptionService,
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly redisService?: RedisService,
    @Optional() private readonly orchestrator?: GpayOrchestratorService,
    @Optional() private readonly browserPoolService?: BrowserPoolService,
  ) {
    this.paymentServiceUrl =
      this.configService.get('PAYMENT_SERVICE_URL') || 'http://localhost:4003';
    this.internalToken = this.configService.get('INTERNAL_TOKEN') || '';
    this.maxAgeMs = Number(
      this.configService.get('GPAY_PENDING_ACTIVATION_MAX_AGE_MS') || 86400000,
    );
    this.enabled =
      this.configService.get('GPAY_RECOVERY_CRON_ENABLED') !== 'false';
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverSessions(): Promise<void> {
    if (this.configService.get('NEW_GPAY_WORKERS_ENABLED') === 'false') {
      this.logger.debug('NEW_GPAY_WORKERS_ENABLED is false, skipping recovery');
      return;
    }

    try {
      const activeProviders = await this.merchantClient.getActiveProviders();
      for (const provider of activeProviders) {
        if ((provider.metadata as any)?.gpayRuntime === 'NEW') {
          const session = this.sessionManager.getActiveSession(provider.id);
          const isClosed = session?.page ? (session.page as any).isClosed() : true;

          if (!session || isClosed) {
            this.logger.warn(
              `Session missing or closed for provider ${provider.id}. Starting recovery...`,
            );
            await this.sessionManager.closeSession(provider.id);
            let decryptedState: any = undefined;
            if (provider.sessionState) {
              try {
                decryptedState = this.encryptionService.decryptSessionState(
                  provider.sessionState,
                );
              } catch (e: any) {
                this.logger.error(
                  `Failed to decrypt session state for ${provider.id}: ${e.message}`,
                );
              }
            }

            const newSession = await this.sessionManager.launchSession(
              provider,
              decryptedState,
            );
            const businessId = (provider.credentials as any)?.businessId;
            if (newSession?.page && businessId) {
              await newSession.page
                .goto(`https://pay.google.com/g4b/transactions/${businessId}`, {
                  waitUntil: 'domcontentloaded',
                  timeout: 30000,
                })
                .catch(() => null);
            }
            await this.sessionManager.autoHealInvalidTransactionsUrl(
              provider.id,
              newSession,
              businessId,
            );
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error during recoverSessions: ${error.message}`);
    }

    // Secondary recovery: check pending activations if Redis & HttpService are available
    if (this.redisService && this.httpService && this.enabled) {
      await this.runPendingActivationRecovery();
    }
  }

  private async runPendingActivationRecovery(): Promise<void> {
    if (!this.redisService || !this.httpService) return;
    const lockKey = 'gpay:recovery:lock';
    try {
      const client = this.redisService.getClient();
      const acquired = await client.set(lockKey, 'locked', 'EX', 15, 'NX');
      if (acquired !== 'OK') {
        return; // Another instance is running recovery
      }
    } catch {
      return; // Fail safe if Redis is down
    }

    try {
      const candidates = await this.fetchPendingActivations();
      if (candidates.length === 0) return;

      this.logger.debug(
        `Found ${candidates.length} candidate(s) for GPay recovery activation`,
      );

      const concurrency = 3;
      for (let i = 0; i < candidates.length; i += concurrency) {
        const batch = candidates.slice(i, i + concurrency);
        await Promise.all(
          batch.map((candidate) => this.processCandidate(candidate)),
        );
      }
    } catch (error: any) {
      this.logger.warn(`Error during GPay recovery cycle: ${error.message}`);
    }
  }

  private async fetchPendingActivations(): Promise<PendingActivationCandidate[]> {
    if (!this.httpService) return [];
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${this.paymentServiceUrl}/internal/gpay/pending-activations?maxAgeMs=${this.maxAgeMs}`,
          { headers: { 'x-internal-token': this.internalToken } },
        ),
      );
      return (res.data as any)?.candidates || [];
    } catch (error: any) {
      this.logger.warn(
        `Failed to query GET /internal/gpay/pending-activations: ${error.message}`,
      );
      return [];
    }
  }

  private async processCandidate(candidate: PendingActivationCandidate): Promise<void> {
    const { providerId, merchantId } = candidate;
    try {
      if (!this.orchestrator) return;
      const res = await this.orchestrator.activateProvider(providerId, merchantId, {
        requiresPersistentProfile: false,
      });

      if (res.success) {
        this.logger.log(
          `Successfully recovered/activated GPay provider ${providerId} for merchant ${merchantId}`,
        );
      } else {
        this.logger.warn(
          `Failed to recover/activate GPay provider ${providerId}: ${res.message}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Exception processing pending activation candidate ${providerId}: ${error.message}`,
      );
    }
  }
}

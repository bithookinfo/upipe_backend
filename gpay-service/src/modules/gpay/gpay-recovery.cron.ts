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
import * as crypto from 'crypto';

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
  private readonly instanceId = crypto.randomUUID();

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

  @Cron('*/15 * * * * *')
  async recoverSessions(): Promise<void> {
    if (this.configService.get('NEW_GPAY_WORKERS_ENABLED') === 'false') {
      this.logger.debug('NEW_GPAY_WORKERS_ENABLED is false, skipping recovery');
      return;
    }

    if (!this.redisService || !this.httpService || !this.enabled) {
      return;
    }

    await this.runPendingActivationRecovery();
  }

  private async runPendingActivationRecovery(): Promise<void> {
    const lockKey = 'gpay:recovery:lock';
    const runId = crypto.randomUUID();
    const lockValue = `${this.instanceId}:${runId}`;
    let lockAcquired = false;

    try {
      const client = this.redisService!.getClient();
      // Acquire lock with 60 seconds TTL
      const acquired = await client.set(lockKey, lockValue, 'EX', 60, 'NX');
      if (acquired !== 'OK') {
        return; // Another instance is running recovery
      }
      lockAcquired = true;

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
    } finally {
      if (lockAcquired) {
        try {
          const client = this.redisService!.getClient();
          // Release verifies ownership atomically using a Lua script
          const luaScript = `
            if redis.call("get",KEYS[1]) == ARGV[1] then
                return redis.call("del",KEYS[1])
            else
                return 0
            end
          `;
          await client.eval(luaScript, 1, lockKey, lockValue);
        } catch (e: any) {
          this.logger.warn(
            `Failed to release recovery lock atomically: ${e.message}`,
          );
        }
      }
    }
  }

  private async fetchPendingActivations(): Promise<
    PendingActivationCandidate[]
  > {
    if (!this.httpService) return [];
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${this.paymentServiceUrl}/internal/gpay/pending-activations?maxAgeMs=${this.maxAgeMs}`,
          { headers: { 'x-internal-token': this.internalToken } },
        ),
      );
      return res.data?.candidates || [];
    } catch (error: any) {
      this.logger.warn(
        `Failed to query GET /internal/gpay/pending-activations: ${error.message}`,
      );
      return [];
    }
  }

  private async processCandidate(
    candidate: PendingActivationCandidate,
  ): Promise<void> {
    const { providerId, merchantId, status } = candidate;

    // Recovery backoff for EXPIRED providers
    if (status === 'EXPIRED') {
      const client = this.redisService?.getClient();
      if (client) {
        const backoffKey = `gpay:recovery:backoff:${providerId}`;
        const attempts = await client.incr(backoffKey);
        if (attempts === 1) {
          await client.expire(backoffKey, 300); // 5 minutes base backoff
        } else if (attempts > 3) {
          this.logger.warn(
            `Provider ${providerId} is EXPIRED and exceeded recovery attempts. Skipping.`,
          );
          return;
        }
      }
    }

    try {
      if (!this.orchestrator) return;
      const res = await this.orchestrator.activateProvider(
        providerId,
        merchantId,
        {
          requiresPersistentProfile: false,
        },
      );

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

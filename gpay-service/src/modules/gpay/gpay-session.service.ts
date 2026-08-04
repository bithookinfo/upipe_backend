import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';
import { BrowserPoolService } from './browser-pool.service';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class GpaySessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GpaySessionService.name);
  private readonly instanceId: string;
  private readonly leaseTtlSeconds: number;
  private readonly leaseHeartbeatSeconds: number;
  private readonly idleTimeoutMs: number;
  private readonly dualStorageEnabled: boolean;
  private readonly merchantServiceUrl: string;
  private readonly internalToken: string;

  private heartbeatInterval?: NodeJS.Timeout;
  private idleCheckInterval?: NodeJS.Timeout;

  private readonly leaseLostProviders = new Set<string>();
  private readonly activeChallenges = new Set<string>();
  private readonly activeOnboardings = new Set<string>();
  private readonly inFlightReconciliations = new Set<string>();
  private readonly queuedActivations = new Set<string>();
  private pendingOrderChecker?: (providerId: string) => Promise<boolean>;

  // Lua script for heartbeat extension
  private readonly heartbeatScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("expire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  // Lua script for lock release
  private readonly releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly encryptionService: GpayEncryptionService,
    private readonly browserPoolService: BrowserPoolService,
    private readonly httpService: HttpService,
  ) {
    this.instanceId =
      this.configService.get('GPAY_INSTANCE_ID') ||
      `instance-${Math.random().toString(36).substring(2, 8)}`;
    this.leaseTtlSeconds = Number(
      this.configService.get('GPAY_PROVIDER_LEASE_TTL_SECONDS') || 60,
    );
    this.leaseHeartbeatSeconds = Number(
      this.configService.get('GPAY_PROVIDER_LEASE_HEARTBEAT_SECONDS') || 20,
    );
    this.idleTimeoutMs = Number(
      this.configService.get('GPAY_IDLE_TIMEOUT_MS') || 300000,
    );
    this.dualStorageEnabled =
      this.configService.get('GPAY_DUAL_SESSION_STORAGE_ENABLED') === 'true';
    this.merchantServiceUrl =
      this.configService.get('MERCHANT_SERVICE_URL') || 'http://localhost:4002';
    this.internalToken = this.configService.get('INTERNAL_TOKEN') || '';
  }

  onModuleInit() {
    this.heartbeatInterval = setInterval(
      () => this.renewAllLeases(),
      this.leaseHeartbeatSeconds * 1000,
    );
    this.idleCheckInterval = setInterval(() => this.checkIdleSessions(), 30000);
    this.logger.log(
      `GpaySessionService initialized (leaseTTL: ${this.leaseTtlSeconds}s, heartbeat: ${this.leaseHeartbeatSeconds}s, dualStorage: ${this.dualStorageEnabled})`,
    );
  }

  async onModuleDestroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.idleCheckInterval) clearInterval(this.idleCheckInterval);
    await this.releaseAllLeases();
  }

  /**
   * Atomically acquires Redis provider lease. Fail-closed if Redis is unreachable.
   */
  async acquireProviderLease(providerId: string): Promise<boolean> {
    const key = `gpay:provider:${providerId}:owner`;
    const ownerValue = `${this.instanceId}:${providerId}`;

    try {
      const client = this.redisService.getClient();
      const res = await client.set(
        key,
        ownerValue,
        'EX',
        this.leaseTtlSeconds,
        'NX',
      );
      if (res === 'OK') {
        this.logger.log(
          `Acquired Redis lease for provider ${providerId} (${ownerValue})`,
        );
        return true;
      }
      return false;
    } catch (error: any) {
      this.logger.error(
        `FAIL-CLOSED: Redis lease acquisition error for provider ${providerId}: ${error.message}`,
      );
      throw error;
    }
  }

  public markLeaseLost(providerId: string): void {
    this.leaseLostProviders.add(providerId);
    this.logger.warn(
      `[Lease Loss] Marked provider ${providerId} as LEASE_LOST`,
    );
  }

  public isLeaseLost(providerId: string): boolean {
    return this.leaseLostProviders.has(providerId);
  }

  public clearLeaseLost(providerId: string): void {
    this.leaseLostProviders.delete(providerId);
  }

  public registerActivity(
    providerId: string,
    type: 'challenge' | 'onboarding' | 'reconciliation' | 'activation',
    active: boolean,
  ): void {
    const map: Record<string, Set<string>> = {
      challenge: this.activeChallenges,
      onboarding: this.activeOnboardings,
      reconciliation: this.inFlightReconciliations,
      activation: this.queuedActivations,
    };
    if (active) {
      map[type]?.add(providerId);
      this.browserPoolService.updateLastActivity(providerId);
    } else {
      map[type]?.delete(providerId);
    }
  }

  public isBusy(providerId: string): boolean {
    return (
      this.activeChallenges.has(providerId) ||
      this.activeOnboardings.has(providerId) ||
      this.inFlightReconciliations.has(providerId) ||
      this.queuedActivations.has(providerId)
    );
  }

  public registerPendingOrderChecker(
    checker: (providerId: string) => Promise<boolean>,
  ): void {
    this.pendingOrderChecker = checker;
  }

  async verifyLeaseOwner(providerId: string): Promise<boolean> {
    const key = `gpay:provider:${providerId}:owner`;
    const ownerValue = `${this.instanceId}:${providerId}`;
    try {
      const current = await this.redisService.getClient().get(key);
      return current === ownerValue;
    } catch {
      return false;
    }
  }

  async releaseProviderLease(providerId: string): Promise<boolean> {
    if (this.isLeaseLost(providerId)) {
      this.logger.log(
        `Skipping lease release for ${providerId} (lease was previously lost)`,
      );
      return false;
    }

    const key = `gpay:provider:${providerId}:owner`;
    const ownerValue = `${this.instanceId}:${providerId}`;

    try {
      const client = this.redisService.getClient();
      const res = await client.eval(this.releaseScript, 1, key, ownerValue);
      return res === 1;
    } catch (error: any) {
      this.logger.warn(
        `Error releasing lease for provider ${providerId}: ${error.message}`,
      );
      return false;
    }
  }

  private async renewAllLeases(): Promise<void> {
    const activeProviderIds = this.browserPoolService.getAllActiveProviderIds();
    const client = this.redisService.getClient();

    for (const providerId of activeProviderIds) {
      const key = `gpay:provider:${providerId}:owner`;
      const ownerValue = `${this.instanceId}:${providerId}`;
      try {
        const res = await client.eval(
          this.heartbeatScript,
          1,
          key,
          ownerValue,
          String(this.leaseTtlSeconds),
        );
        if (res !== 1) {
          this.logger.warn(
            `Lease heartbeat failed for provider ${providerId}. Lease may have been lost. Shutting down session.`,
          );
          this.markLeaseLost(providerId);
          await this.browserPoolService.releaseContext(providerId);
          this.activeChallenges.delete(providerId);
          this.activeOnboardings.delete(providerId);
          this.inFlightReconciliations.delete(providerId);
          this.queuedActivations.delete(providerId);
        }
      } catch (e: any) {
        this.logger.warn(
          `Redis error during lease heartbeat for ${providerId}: ${e.message}`,
        );
      }
    }
  }

  private async releaseAllLeases(): Promise<void> {
    const activeProviderIds = this.browserPoolService.getAllActiveProviderIds();
    for (const providerId of activeProviderIds) {
      await this.releaseProviderLease(providerId);
    }
  }

  /**
   * Persists Playwright storageState to merchant-service.
   * If dualStorageEnabled is true, saves both encrypted and plaintext/canary backup.
   */
  async persistStorageState(
    providerId: string,
    merchantId: string,
    storageState: any,
  ): Promise<boolean> {
    try {
      const encrypted = this.encryptionService.encrypt(
        JSON.stringify(storageState),
      );

      const payload: any = {
        credentials: {
          encryptedSession: encrypted,
          lastSavedAt: new Date().toISOString(),
        },
      };

      if (this.dualStorageEnabled) {
        payload.credentials.storageState = storageState; // plaintext canary backup
      }

      await firstValueFrom(
        this.httpService.patch(
          `${this.merchantServiceUrl}/internal/gpay/providers/${providerId}/session`,
          payload,
          { headers: { 'x-internal-token': this.internalToken } },
        ),
      );

      this.logger.log(`Persisted session state for provider ${providerId}`);
      return true;
    } catch (error: any) {
      this.logger.error(
        `Failed to persist session state for ${providerId}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Reads and decrypts session state for a provider.
   */
  async restoreStorageState(
    providerId: string,
    merchantId: string,
  ): Promise<any | null> {
    if (providerId.startsWith('temp_') || providerId.startsWith('temp-')) {
      return null;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.merchantServiceUrl}/internal/gpay/providers/${providerId}`,
          { headers: { 'x-internal-token': this.internalToken } },
        ),
      );

      const data = response.data;
      const creds = data?.provider?.credentials || data?.credentials;
      if (!creds) return null;

      if (creds.encryptedSession) {
        try {
          const decryptedJson = this.encryptionService.decrypt(
            creds.encryptedSession,
          );
          return JSON.parse(decryptedJson);
        } catch (decErr: any) {
          this.logger.warn(
            `Failed to decrypt session for ${providerId}: ${decErr.message}. Checking dual storage backup.`,
          );
        }
      }

      if (this.dualStorageEnabled && creds.storageState) {
        this.logger.log(
          `Restoring session from dual storage plaintext backup for ${providerId}`,
        );
        return creds.storageState;
      }

      return null;
    } catch (error: any) {
      this.logger.warn(
        `Could not restore storage state for ${providerId}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Periodic check to shut down open browser contexts that have been idle
   * for > GPAY_IDLE_TIMEOUT_MS and have no pending GPay orders.
   */
  private async checkIdleSessions(): Promise<void> {
    const now = Date.now();
    const activeProviderIds = this.browserPoolService.getAllActiveProviderIds();

    for (const providerId of activeProviderIds) {
      const active = this.browserPoolService.getActiveContext(providerId);
      if (!active) continue;

      if (now - active.lastActivityAt > this.idleTimeoutMs) {
        if (this.isBusy(providerId)) {
          this.logger.debug(
            `Session ${providerId} idle timer expired, but provider has active challenge/onboarding/reconciliation/activation. Skipping idle shutdown.`,
          );
          continue;
        }

        if (this.pendingOrderChecker) {
          try {
            const hasPendingOrders = await this.pendingOrderChecker(providerId);
            if (hasPendingOrders) {
              this.logger.log(
                `Session ${providerId} has pending orders. Keeping active context open.`,
              );
              active.lastActivityAt = now;
              continue;
            }
          } catch (e: any) {
            this.logger.warn(
              `Failed to check pending orders before idle shutdown for ${providerId}: ${e.message}`,
            );
          }
        }

        this.logger.log(
          `Session ${providerId} idle for > ${this.idleTimeoutMs}ms with no pending activity. Executing idle shutdown.`,
        );
        try {
          await new Promise((res) => setTimeout(res, 100));
          const state = await active.context.storageState().catch(() => null);
          if (state) {
            await this.persistStorageState(providerId, '', state);
          }
          await this.browserPoolService.releaseContext(providerId);
          await this.releaseProviderLease(providerId);
        } catch (e: any) {
          this.logger.warn(
            `Error during idle shutdown for ${providerId}: ${e.message}`,
          );
        }
      }
    }
  }
}

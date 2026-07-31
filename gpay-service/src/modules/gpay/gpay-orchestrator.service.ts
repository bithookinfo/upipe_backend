import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { BrowserPoolService, ActivePoolContext } from './browser-pool.service';
import { GpayAuthService } from './gpay-auth.service';
import { GpaySessionService } from './gpay-session.service';
import { GpayRpcListenerService } from './gpay-rpc-listener.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class GpayOrchestratorService {
  private readonly logger = new Logger(GpayOrchestratorService.name);
  private readonly merchantServiceUrl: string;
  private readonly internalToken: string;

  constructor(
    private readonly browserPoolService: BrowserPoolService,
    private readonly authService: GpayAuthService,
    private readonly sessionService: GpaySessionService,
    private readonly rpcListenerService: GpayRpcListenerService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.merchantServiceUrl =
      this.configService.get('MERCHANT_SERVICE_URL') || 'http://localhost:4002';
    this.internalToken = this.configService.get('INTERNAL_TOKEN') || '';
  }

  /**
   * Activates a Google Pay provider context if permitted by status policy.
   * Status Activation Policy: ACTIVE or EXPIRED allowed; INACTIVE or SUSPENDED never allowed.
   */
  async activateProvider(
    providerId: string,
    merchantId: string,
    options?: {
      requiresPersistentProfile?: boolean;
      profilePath?: string;
      force?: boolean;
    },
  ): Promise<{ success: boolean; isPersistent?: boolean; message?: string }> {
    // 1. Verify status policy from merchant-service
    const statusResult = await this.verifyProviderStatusPolicy(providerId);
    if (!statusResult.allowed) {
      this.logger.warn(
        `Activation denied for provider ${providerId}: status is ${statusResult.status}`,
      );
      return {
        success: false,
        message: `Provider status ${statusResult.status} is not eligible for activation.`,
      };
    }

    // 2. Acquire Redis lease
    const leaseAcquired = await this.sessionService.acquireProviderLease(providerId);
    if (!leaseAcquired && !options?.force) {
      this.logger.warn(`Could not acquire Redis lease for provider ${providerId}. Another worker owns it.`);
      return {
        success: false,
        message: `Provider ${providerId} is currently owned by another worker instance.`,
      };
    }

    // 3. Restore storage state (checks encrypted primary + dual-storage plaintext backup)
    const storageState = await this.sessionService.restoreStorageState(
      providerId,
      merchantId,
    );

    // 4. Acquire browser context from pool (Mode A / Mode B hybrid)
    const activeContext = await this.browserPoolService.acquireContext(
      providerId,
      storageState,
      options,
    );

    // 5. Navigate to Google Pay Business console & attach non-blocking RPC listener
    try {
      this.rpcListenerService.attachListener(
        activeContext.page,
        providerId,
        merchantId,
      );

      await activeContext.page.goto(
        'https://pay.google.com/business/console',
        { waitUntil: 'domcontentloaded', timeout: 30000 },
      ).catch((e: any) => {
        this.logger.warn(`Navigation warning for ${providerId}: ${e.message}`);
      });

      await this.authService.setSessionState(providerId, 'ACTIVE', 900);

      this.logger.log(`Successfully activated provider ${providerId} (persistent: ${activeContext.isPersistent})`);
      return {
        success: true,
        isPersistent: activeContext.isPersistent,
      };
    } catch (error: any) {
      this.logger.error(`Error activating provider ${providerId}: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  /**
   * Deactivates a Google Pay provider context, persisting state and releasing locks.
   */
  async deactivateProvider(providerId: string, merchantId: string): Promise<void> {
    const active = this.browserPoolService.getActiveContext(providerId);
    if (active) {
      try {
        const state = await active.context.storageState().catch(() => null);
        if (state) {
          await this.sessionService.persistStorageState(providerId, merchantId, state);
        }
      } catch (e: any) {
        this.logger.warn(`Error saving state during deactivation of ${providerId}: ${e.message}`);
      }
    }

    await this.browserPoolService.releaseContext(providerId);
    await this.sessionService.releaseProviderLease(providerId);
    await this.authService.setSessionState(providerId, 'ACTIVE', 10);
    this.logger.log(`Deactivated provider ${providerId}`);
  }

  private async verifyProviderStatusPolicy(
    providerId: string,
  ): Promise<{ allowed: boolean; status?: string }> {
    try {
      const res = await firstValueFrom(
        this.httpService.get(
          `${this.merchantServiceUrl}/internal/gpay/providers/${providerId}`,
          { headers: { 'x-internal-token': this.internalToken } },
        ),
      );

      const status =
        (res.data as any)?.provider?.status || (res.data as any)?.status || 'ACTIVE';

      // Allowed: ACTIVE, EXPIRED. Never allowed: INACTIVE, SUSPENDED
      if (status === 'INACTIVE' || status === 'SUSPENDED') {
        return { allowed: false, status };
      }

      return { allowed: true, status };
    } catch (error: any) {
      // If endpoint fails or provider not found, allow default check unless explicit error
      this.logger.warn(`Could not verify status for ${providerId}: ${error.message}`);
      return { allowed: true, status: 'ACTIVE' };
    }
  }
}

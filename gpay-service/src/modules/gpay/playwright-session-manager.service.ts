import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { GpayOrchestratorService } from './gpay-orchestrator.service';
import { GpaySessionService } from './gpay-session.service';
import { BrowserPoolService } from './browser-pool.service';
import { GpayAuthService } from './gpay-auth.service';
import { GpayProviderData } from '../../clients/merchant-service.client';
import { Browser, BrowserContext, Page } from 'playwright';

export interface GpayActiveSession {
  providerId: string;
  merchantId: string;
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  businessId?: string;
  email?: string;
  lastAccessedAt: Date;
}

/**
 * Thin facade over GpayOrchestratorService, BrowserPoolService, GpaySessionService, and GpayAuthService
 * to preserve legacy interface calls while ensuring zero parallel browser lifecycle execution.
 */
@Injectable()
export class PlaywrightSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightSessionManager.name);

  constructor(
    private readonly orchestrator: GpayOrchestratorService,
    private readonly sessionService: GpaySessionService,
    private readonly browserPool: BrowserPoolService,
    private readonly authService: GpayAuthService,
  ) {}

  async onModuleDestroy() {
    this.logger.log('Shutting down PlaywrightSessionManager facade...');
    await this.browserPool.closeAll();
  }

  async acquireLock(providerId: string, ttlSeconds = 60): Promise<boolean> {
    return this.sessionService.acquireProviderLease(providerId);
  }

  async renewLock(providerId: string, ttlSeconds = 60): Promise<void> {
    // Handled automatically by heartbeat in GpaySessionService
  }

  async releaseLock(providerId: string): Promise<void> {
    await this.sessionService.releaseProviderLease(providerId);
  }

  getSession(providerId: string): GpayActiveSession | undefined {
    const active = this.browserPool.getActiveContext(providerId);
    if (!active) return undefined;

    return {
      providerId: active.providerId,
      merchantId: '',
      context: active.context,
      page: active.page,
      lastAccessedAt: new Date(active.lastActivityAt),
    };
  }

  getActiveSession(providerId: string): GpayActiveSession | undefined {
    return this.getSession(providerId);
  }

  async initOrGetSession(
    provider: GpayProviderData,
    options?: {
      requiresPersistentProfile?: boolean;
      profilePath?: string;
      skipNavigation?: boolean;
    },
  ): Promise<GpayActiveSession> {
    const active = this.browserPool.getActiveContext(provider.id);
    if (active) {
      return {
        providerId: active.providerId,
        merchantId: provider.merchantId,
        context: active.context,
        page: active.page,
        businessId: provider.businessId,
        email: provider.email,
        lastAccessedAt: new Date(active.lastActivityAt),
      };
    }

    const res = await this.orchestrator.activateProvider(
      provider.id,
      provider.merchantId,
      {
        requiresPersistentProfile: Boolean(
          options?.requiresPersistentProfile ??
          (provider as any).metadata?.requiresPersistentProfile,
        ),
        profilePath: options?.profilePath,
        skipNavigation: options?.skipNavigation,
      },
    );

    if (!res.success) {
      throw new Error(
        `Failed to initialize session for provider ${provider.id}: ${res.message}`,
      );
    }

    const newActive = this.browserPool.getActiveContext(provider.id);
    if (!newActive) {
      throw new Error(
        `Context not found after activation for provider ${provider.id}`,
      );
    }

    return {
      providerId: newActive.providerId,
      merchantId: provider.merchantId,
      context: newActive.context,
      page: newActive.page,
      businessId: provider.businessId,
      email: provider.email,
      lastAccessedAt: new Date(newActive.lastActivityAt),
    };
  }

  async launchSession(
    provider: GpayProviderData,
    storageStateJson?: any,
    options?: {
      requiresPersistentProfile?: boolean;
      profilePath?: string;
      skipNavigation?: boolean;
    },
  ): Promise<GpayActiveSession> {
    return this.initOrGetSession(provider, options);
  }

  async closeSession(providerId: string): Promise<void> {
    await this.orchestrator.deactivateProvider(providerId, '');
  }

  async signInWithGoogle(
    provider: GpayProviderData,
    password?: string,
    otp?: string,
  ): Promise<void> {
    const active = await this.initOrGetSession(provider);
    const res = await this.authService.performSignIn(
      active.page,
      provider.email || '',
      password,
      otp,
    );
    if (!res.success) {
      throw new Error(
        `Google Sign-In failed for ${provider.id}: ${res.reason}`,
      );
    }
  }

  async captureTransactions(provider: GpayProviderData): Promise<void> {
    this.browserPool.updateLastActivity(provider.id);
  }

  async saveSession(provider: GpayProviderData): Promise<void> {
    const active = this.browserPool.getActiveContext(provider.id);
    if (active) {
      const state = await active.context.storageState().catch(() => null);
      if (state) {
        await this.sessionService.persistStorageState(
          provider.id,
          provider.merchantId,
          state,
        );
      }
    }
  }

  async snapshotSessionState(providerId: string): Promise<void> {
    await this.saveSession({
      id: providerId,
      merchantId: '',
    } as GpayProviderData);
  }

  async autoHealInvalidTransactionsUrl(
    providerId: string,
    session?: any,
    businessId?: string,
  ): Promise<void> {
    this.logger.debug(`Auto-heal check for provider ${providerId}`);
  }
}

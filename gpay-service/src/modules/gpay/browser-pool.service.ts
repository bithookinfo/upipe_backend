import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface ActivePoolContext {
  providerId: string;
  browserId: string;
  context: BrowserContext;
  page: Page;
  isPersistent: boolean;
  lastActivityAt: number;
}

interface SharedBrowserInstance {
  id: string;
  browser: Browser;
  activeContextCount: number;
}

@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);
  private sharedBrowsers: SharedBrowserInstance[] = [];
  private activeContexts: Map<string, ActivePoolContext> = new Map();

  private readonly maxContextsPerBrowser: number;
  private readonly maxBrowsersPerInstance: number;
  private readonly maxPersistentProfilesPerInstance: number;
  private readonly nodeId: string;
  private readonly userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  constructor(private readonly configService: ConfigService) {
    this.maxContextsPerBrowser = Number(
      this.configService.get('GPAY_MAX_CONTEXTS_PER_BROWSER') || 5,
    );
    this.maxBrowsersPerInstance = Number(
      this.configService.get('GPAY_MAX_BROWSERS_PER_INSTANCE') || 3,
    );
    this.maxPersistentProfilesPerInstance = Number(
      this.configService.get('GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE') || 3,
    );
    this.nodeId =
      this.configService.get('GPAY_NODE_ID') ||
      `node-${os.hostname().replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  async onModuleInit() {
    this.logger.log(
      `Initializing BrowserPoolService (maxBrowsers: ${this.maxBrowsersPerInstance}, maxContexts/Browser: ${this.maxContextsPerBrowser}, nodeId: ${this.nodeId})`,
    );
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down BrowserPoolService and closing all browsers...');
    await this.closeAll();
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getActiveContext(providerId: string): ActivePoolContext | undefined {
    return this.activeContexts.get(providerId);
  }

  public getAllActiveProviderIds(): string[] {
    return Array.from(this.activeContexts.keys());
  }

  public updateLastActivity(providerId: string): void {
    const active = this.activeContexts.get(providerId);
    if (active) {
      active.lastActivityAt = Date.now();
    }
  }

  /**
   * Acquires a BrowserContext and primary Page for a provider.
   * Mode A (Default): Isolated BrowserContext on a shared Browser instance.
   * Mode B (Fallback): Persistent Context if required or storage restoration fails.
   */
  async acquireContext(
    providerId: string,
    storageState?: any,
    options?: {
      requiresPersistentProfile?: boolean;
      profilePath?: string;
    },
  ): Promise<ActivePoolContext> {
    const existing = this.activeContexts.get(providerId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const usePersistent = Boolean(options?.requiresPersistentProfile);

    if (usePersistent) {
      return this.launchPersistentContext(providerId, options?.profilePath);
    }

    // Mode A: Shared browser pool least-loaded assignment
    const sharedBrowser = await this.getLeastLoadedBrowser();
    try {
      const contextOptions: any = {
        userAgent: this.userAgent,
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      };

      if (storageState && typeof storageState === 'object') {
        contextOptions.storageState = storageState;
      }

      const context = await sharedBrowser.browser.newContext(contextOptions);
      const page = await context.newPage();

      sharedBrowser.activeContextCount++;

      const activeContext: ActivePoolContext = {
        providerId,
        browserId: sharedBrowser.id,
        context,
        page,
        isPersistent: false,
        lastActivityAt: Date.now(),
      };

      this.activeContexts.set(providerId, activeContext);

      context.on('close', () => {
        this.handleContextClosed(providerId, sharedBrowser.id);
      });

      this.logger.log(
        `[Mode A] Acquired shared context for provider ${providerId} on browser ${sharedBrowser.id} (${sharedBrowser.activeContextCount}/${this.maxContextsPerBrowser})`,
      );

      return activeContext;
    } catch (error: any) {
      this.logger.warn(
        `Failed to allocate Mode A shared context for provider ${providerId}: ${error.message}. Falling back to Mode B persistent profile.`,
      );
      return this.launchPersistentContext(providerId, options?.profilePath);
    }
  }

  /**
   * Mode B: Launch a dedicated persistent Chromium context for the provider.
   */
  private async launchPersistentContext(
    providerId: string,
    customProfilePath?: string,
  ): Promise<ActivePoolContext> {
    const currentPersistentCount = Array.from(this.activeContexts.values()).filter(
      (c) => c.isPersistent,
    ).length;
    if (currentPersistentCount >= this.maxPersistentProfilesPerInstance) {
      throw new Error(
        `Persistent profile capacity reached (${currentPersistentCount}/${this.maxPersistentProfilesPerInstance})`,
      );
    }

    const profileDir =
      customProfilePath ||
      path.join(
        os.tmpdir(),
        `gpay-profile-${this.nodeId}-${providerId.replace(/[^a-zA-Z0-9]/g, '')}`,
      );

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      userAgent: this.userAgent,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    const activeContext: ActivePoolContext = {
      providerId,
      browserId: `persistent-${providerId}`,
      context,
      page,
      isPersistent: true,
      lastActivityAt: Date.now(),
    };

    this.activeContexts.set(providerId, activeContext);

    context.on('close', () => {
      this.activeContexts.delete(providerId);
      this.logger.log(`[Mode B] Persistent context closed for provider ${providerId}`);
    });

    this.logger.log(
      `[Mode B] Acquired persistent profile context for provider ${providerId} at ${profileDir} (nodeId: ${this.nodeId})`,
    );

    return activeContext;
  }

  /**
   * Selects the least-loaded healthy shared browser instance, launching a new one if necessary.
   */
  private async getLeastLoadedBrowser(): Promise<SharedBrowserInstance> {
    let bestCandidate: SharedBrowserInstance | null = null;

    for (const instance of this.sharedBrowsers) {
      if (instance.activeContextCount < this.maxContextsPerBrowser) {
        if (
          !bestCandidate ||
          instance.activeContextCount < bestCandidate.activeContextCount
        ) {
          bestCandidate = instance;
        }
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }

    if (this.sharedBrowsers.length < this.maxBrowsersPerInstance) {
      const newBrowser = await this.launchSharedBrowser();
      this.sharedBrowsers.push(newBrowser);
      return newBrowser;
    }

    // All existing browsers are at capacity; return least loaded even if over limit to avoid blocking
    this.logger.warn(
      `All ${this.sharedBrowsers.length} shared browsers are at capacity (${this.maxContextsPerBrowser}). Using least loaded.`,
    );
    return this.sharedBrowsers.reduce((prev, curr) =>
      prev.activeContextCount <= curr.activeContextCount ? prev : curr,
    );
  }

  private async launchSharedBrowser(): Promise<SharedBrowserInstance> {
    const browserId = `shared-browser-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    this.logger.log(`Launched new shared Chromium browser instance: ${browserId}`);

    browser.on('disconnected', () => {
      this.logger.warn(`Shared browser ${browserId} disconnected unexpectedly.`);
      this.sharedBrowsers = this.sharedBrowsers.filter((b) => b.id !== browserId);
    });

    return {
      id: browserId,
      browser,
      activeContextCount: 0,
    };
  }

  private handleContextClosed(providerId: string, browserId: string): void {
    this.activeContexts.delete(providerId);
    const browserInstance = this.sharedBrowsers.find((b) => b.id === browserId);
    if (browserInstance && browserInstance.activeContextCount > 0) {
      browserInstance.activeContextCount--;
    }
  }

  async releaseContext(providerId: string): Promise<void> {
    const active = this.activeContexts.get(providerId);
    if (!active) return;

    try {
      await active.page.close().catch(() => {});
      await active.context.close().catch(() => {});
    } catch (error: any) {
      this.logger.warn(`Error closing context for provider ${providerId}: ${error.message}`);
    } finally {
      this.handleContextClosed(providerId, active.browserId);
      this.logger.log(`Released context for provider ${providerId}`);
    }
  }

  async closeAll(): Promise<void> {
    for (const [providerId, active] of this.activeContexts.entries()) {
      try {
        await active.context.close().catch(() => {});
      } catch (e) {
        // ignore
      }
    }
    this.activeContexts.clear();

    for (const instance of this.sharedBrowsers) {
      try {
        await instance.browser.close().catch(() => {});
      } catch (e) {
        // ignore
      }
    }
    this.sharedBrowsers = [];
  }
}

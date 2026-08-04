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
  emptySince?: number;
  recycleTimer?: NodeJS.Timeout;
}

@Injectable()
export class BrowserPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserPoolService.name);
  private sharedBrowsers: SharedBrowserInstance[] = [];
  private activeContexts: Map<string, ActivePoolContext> = new Map();

  public browserRecycleCount = 0;
  public capacityRejectionCount = 0;

  private readonly maxContextsPerBrowser: number;
  private readonly maxBrowsersPerInstance: number;
  private readonly maxPersistentProfilesPerInstance: number;
  private readonly nodeId: string;
  private readonly userAgent =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

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
    this.logger.log(
      'Shutting down BrowserPoolService and closing all browsers...',
    );
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
    const currentPersistentCount = Array.from(
      this.activeContexts.values(),
    ).filter((c) => c.isPersistent).length;
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

    const launchOpts = this.getLaunchOptions();

    let context: any = null;
    let launchAttempts = 0;
    while (launchAttempts < 3) {
      try {
        this.clearSingletonLock(profileDir);
        context = await chromium.launchPersistentContext(profileDir, {
          ...launchOpts,
          userAgent: this.userAgent,
          viewport: {
            width: 1366 + Math.floor(Math.random() * 100),
            height: 768 + Math.floor(Math.random() * 50),
          },
          deviceScaleFactor: 1.25,
          isMobile: false,
          hasTouch: false,
          locale: 'en-IN',
          timezoneId: 'Asia/Kolkata',
          ignoreHTTPSErrors: true,
        });
        break;
      } catch (e: any) {
        const msg = String(e?.message || '').toLowerCase();
        if (
          msg.includes('singletonlock') ||
          msg.includes('processsingleton') ||
          msg.includes('target page, context or browser has been closed')
        ) {
          launchAttempts++;
          if (launchAttempts >= 3) {
            this.logger.warn(
              `⚠️ GPay profile persistently locked for restore ${providerId}`,
            );
            throw e;
          }
          this.logger.warn(
            `⚠️ GPay profile locked for restore ${providerId}. Retrying in 1s...`,
          );
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw e;
        }
      }
    }

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
      this.logger.log(
        `[Mode B] Persistent context closed for provider ${providerId}`,
      );
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
      bestCandidate.activeContextCount++;
      if (bestCandidate.recycleTimer) {
        clearTimeout(bestCandidate.recycleTimer);
        bestCandidate.recycleTimer = undefined;
        bestCandidate.emptySince = undefined;
        this.logger.log(
          `Cancelled recycling for browser ${bestCandidate.id} as a new context was assigned.`,
        );
      }
      return bestCandidate;
    }

    if (this.sharedBrowsers.length >= this.maxBrowsersPerInstance) {
      this.capacityRejectionCount++;
      throw new Error(
        `Capacity Rejection: Maximum shared browsers (${this.maxBrowsersPerInstance}) reached on node ${this.nodeId}`,
      );
    }

    const newBrowser = await this.launchSharedBrowser();
    newBrowser.activeContextCount++;
    this.sharedBrowsers.push(newBrowser);
    return newBrowser;
  }

  private async launchSharedBrowser(): Promise<SharedBrowserInstance> {
    const browserId = `shared-browser-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const launchOpts = this.getLaunchOptions();

    const browser = await chromium.launch({
      ...launchOpts,
    });

    this.logger.log(
      `Launched new shared Chromium browser instance: ${browserId}`,
    );

    browser.on('disconnected', () => {
      this.logger.warn(
        `Shared browser ${browserId} disconnected unexpectedly.`,
      );
      this.sharedBrowsers = this.sharedBrowsers.filter(
        (b) => b.id !== browserId,
      );
    });

    return {
      id: browserId,
      browser,
      activeContextCount: 0,
    };
  }

  private clearSingletonLock(userDataDir: string) {
    try {
      const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
      for (const file of lockFiles) {
        const filePath = path.join(userDataDir, file);
        try {
          fs.unlinkSync(filePath);
          this.logger.log(`🗑️ Removed stale ${file} from ${userDataDir}`);
        } catch (err: any) {
          if (err.code !== 'ENOENT') {
            this.logger.warn(
              `Could not remove ${file} in ${userDataDir}: ${err.message}`,
            );
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(
        `Failed to clean SingletonLock in ${userDataDir}: ${e.message}`,
      );
    }
  }

  private getLaunchOptions() {
    let headless = process.env.GPAY_HEADLESS !== 'false';
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      headless = true;
    }
    const browserType = process.env.GPAY_BROWSER || 'chromium';
    const proxy = process.env.GPAY_PROXY;
    const proxyConfig = proxy ? { server: proxy } : undefined;

    const opts: any = {
      headless,
      proxy: proxyConfig,
    };

    if (browserType === 'chromium') {
      opts.args = [
        headless ? '--headless=shell' : '',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-dev-shm-usage',
        '--disable-notifications',
        '--disable-background-networking',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        '--disable-software-rasterizer',
        '--disable-canvas-aa',
        '--disable-2d-canvas-clip-aa',
        '--disable-gl-drawing-for-tests',
        '--disable-crash-reporter',
        '--js-flags=--max-old-space-size=256',
      ];
      opts.channel =
        process.env.GPAY_USE_REAL_CHROME !== 'false' ? 'chrome' : undefined;

      if (headless) {
        opts.args.push('--headless=new');
      }
    }

    return opts;
  }

  private handleContextClosed(providerId: string, browserId: string): void {
    this.activeContexts.delete(providerId);
    const browserInstance = this.sharedBrowsers.find((b) => b.id === browserId);
    if (browserInstance && browserInstance.activeContextCount > 0) {
      browserInstance.activeContextCount--;

      if (
        browserInstance.activeContextCount === 0 &&
        !browserInstance.recycleTimer
      ) {
        browserInstance.emptySince = Date.now();
        const timeoutMs = Number(
          this.configService.get('GPAY_EMPTY_BROWSER_IDLE_TIMEOUT_MS') ||
            300000,
        );

        browserInstance.recycleTimer = setTimeout(async () => {
          if (browserInstance.activeContextCount === 0) {
            this.logger.log(
              `Empty browser timeout expired for ${browserId}. Recycling Chromium worker.`,
            );
            try {
              await browserInstance.browser.close().catch(() => {});
            } catch (e: any) {
              this.logger.warn(
                `Error recycling browser ${browserId}: ${e.message}`,
              );
            }
            this.sharedBrowsers = this.sharedBrowsers.filter(
              (b) => b.id !== browserId,
            );
            this.browserRecycleCount++;
          }
        }, timeoutMs);
      }
    }
  }

  async releaseContext(providerId: string): Promise<void> {
    const active = this.activeContexts.get(providerId);
    if (!active) return;

    try {
      await active.page.close().catch(() => {});
      await active.context.close().catch(() => {});
    } catch (error: any) {
      this.logger.warn(
        `Error closing context for provider ${providerId}: ${error.message}`,
      );
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

import {
  Injectable,
  Logger,
  BadRequestException,
  OnModuleDestroy,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { ProviderType, MerchantProviderStatus, MerchantProvider } from "@prisma/client";
import { chromium, firefox } from "playwright";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";

@Injectable()
export class GpayService implements OnModuleDestroy {
  private readonly logger = new Logger(GpayService.name);

  private loginSessions: Map<
    string,
    {
      browser: any;
      context: any;
      page: any;
      organizationId: string;
      email: string;
      password?: string;
      recoveryPhoneNumber?: string;
      googleVerificationCode?: string;
      _autoRetryCount?: number;
      createdAt: number;
    }
  > = new Map();

  private activeSessions: Map<
    string,
    {
      browser: any;
      context: any;
      page: any;
      businessId: string;
      email: string;
      organizationId: string;
      connectedAt: Date;
      lastAccessedAt: Date;
    }
  > = new Map();

  private readonly restoringProviders = new Set<string>();
  private readonly realtimeListenerProviders = new Set<string>();

  private readonly recentGPayPayments = new Map<string, any[]>();
  private readonly lastRPTkabLoadAt = new Map<string, number>();
  private readonly syncingProviders = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) { }

  async onModuleDestroy() {
    this.logger.log("🛑 Shutting down GpayService, closing all active browsers...");
    for (const session of this.activeSessions.values()) {
      try {
        await session.browser?.close?.();
      } catch (e) {
        this.logger.warn(`Failed to close active browser: ${e}`);
      }
    }
    for (const session of this.loginSessions.values()) {
      try {
        await session.browser?.close?.();
      } catch (e) {
        this.logger.warn(`Failed to close login browser: ${e}`);
      }
    }
  }

  /**
   * order-status-cron imports GpayService; avoid static import of OrderStatusCronService here
   * or Nest sees GpayService as undefined (circular module evaluation).
   */
  private getOrderStatusCronSafe(): {
    tryMatchPendingOrdersForGpayProvider: (id: string) => Promise<void>;
  } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { OrderStatusCronService } = require("../transaction/order-status-cron.service");
      return this.moduleRef.get(OrderStatusCronService, { strict: false });
    } catch {
      return null;
    }
  }

  private parseBooleanEnv(
    value: string | undefined,
    defaultValue: boolean,
  ): boolean {
    if (value == null) return defaultValue;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return defaultValue;
  }

  private getStableProfileBaseDir(): string {
    const configured = (process.env.GPAY_PROFILE_DIR || "").trim();
    const preferred = configured || "/var/lib/upipe/gpay_profiles";
    try {
      fs.mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch {
      // Fallback when running on systems without permissions for /var/lib (e.g. local dev)
      const fallback = "/tmp/upipe_gpay_profiles";
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    }
  }

  private getStableUserDataDir(email: string): string {
    const base = this.getStableProfileBaseDir();
    const norm = (email || "").trim().toLowerCase();
    const hash = createHash("sha256").update(norm).digest("hex").slice(0, 24);
    return path.join(base, hash);
  }

  private clearSingletonLock(userDataDir: string) {
    try {
      const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
      for (const file of lockFiles) {
        const filePath = path.join(userDataDir, file);
        try {
          fs.unlinkSync(filePath);
          this.logger.log(`🗑️ Removed stale ${file} from ${userDataDir}`);
        } catch (err: any) {
          if (err.code !== "ENOENT") {
            this.logger.warn(`Could not remove ${file} in ${userDataDir}: ${err.message}`);
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Failed to clean SingletonLock in ${userDataDir}: ${e.message}`);
    }
  }


  @Cron("0 */10 * * * *", { name: "gpay-snapshot-session-state" })
  async snapshotActiveGpaySessionsToDatabase() {
    if (this.parseBooleanEnv(process.env.GPAY_DISABLE_SESSION_SNAPSHOT, false)) {
      return;
    }
    let ok = 0;
    for (const [providerId, session] of this.activeSessions.entries()) {
      try {
        if (typeof session.page?.isClosed === "function" && session.page.isClosed()) {
          continue;
        }
        const url = String(session.page?.url?.() || "");
        if (!url.includes("pay.google.com/g4b")) {
          continue;
        }
        const saved = await this.persistGpaySessionStateToDb(providerId, session.context);
        if (saved) ok += 1;
      } catch {
        // ignore per-provider failures
      }
    }
    if (ok > 0) {
      this.logger.log(
        `💾 GPay sessionState DB snapshot: refreshed ${ok} active provider(s)`,
      );
    }
  }

  @Cron("*/5 * * * *", { name: "gpay-cleanup-stale-login-sessions" })
  async cleanupStaleLoginSessions() {
    const now = Date.now();
    const ttlMs = 15 * 60 * 1000;

    for (const [sessionId, session] of this.loginSessions.entries()) {
      if (now - session.createdAt > ttlMs) {
        this.logger.warn(`🧹 Cleaning up stale login session (user abandoned challenge): ${session.email}`);
        try {
          await session.browser?.close?.();
        } catch { }
        this.loginSessions.delete(sessionId);
      }
    }
  }

  @Cron("*/45 * * * * *")
  async recoverExpiredGpayProviders() {
    try {
      const expiredProviders = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.GPAY,
          status: MerchantProviderStatus.EXPIRED,
          merchant: {
            deletedAt: null,
          },
        },
        select: {
          id: true,
        },
        take: 20,
      });

      if (!expiredProviders.length) return;

      for (const p of expiredProviders) {
        if (this.activeSessions.has(p.id)) {
          await this.prisma.merchantProvider
            .update({
              where: { id: p.id },
              data: { status: MerchantProviderStatus.ACTIVE },
            })
            .catch(() => { });
          this.logger.log(
            `🩹 [DIAGNOSTIC] Recovered GPAY provider ${p.id} EXPIRED -> ACTIVE (active in-memory session)`,
          );
          continue;
        }

        const restored = await this.restoreSession(p.id);
        if (restored) {
          this.logger.log(
            `🩹 [DIAGNOSTIC] Recovered GPAY provider ${p.id} EXPIRED -> ACTIVE (session restored)`,
          );
        }
      }
    } catch (error: any) {
      this.logger.warn(
        `⚠️ GPAY recovery tick failed: ${error?.message || String(error)}`,
      );
    }
  }

  getGpayMetrics() {
    const fs = require('fs');
    const { execSync } = require('child_process');
    let profileDirectories = 0;
    let runningChromes = 0;
    try {
      const gpayProfilesPath = '/var/lib/upipe/gpay_profiles';
      if (fs.existsSync(gpayProfilesPath)) {
        profileDirectories = fs.readdirSync(gpayProfilesPath).filter((f: string) => fs.statSync(`${gpayProfilesPath}/${f}`).isDirectory()).length;
      }
      const pgrepCount = execSync('pgrep chrome | wc -l', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
      runningChromes = parseInt(pgrepCount, 10) || 0;
    } catch (e) { }

    return {
      activeSessions: this.activeSessions.size,
      loginSessions: this.loginSessions.size,
      runningChromes,
      profileDirectories,
    };
  }

  @Cron("*/5 * * * *")
  async monitorBrowserMetrics() {
    const metrics = this.getGpayMetrics();
    const memoryUsage = process.memoryUsage();
    this.logger.log(JSON.stringify({
      event: "browser_count_monitor",
      activeSessions: metrics.activeSessions,
      loginSessions: metrics.loginSessions,
      runningChromes: metrics.runningChromes,
      profileDirectories: metrics.profileDirectories,
      memoryHeapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      memoryRssMB: Math.round(memoryUsage.rss / 1024 / 1024)
    }));
  }

  private getLaunchOptions(email: string) {
    let headless = this.parseBooleanEnv(process.env.GPAY_HEADLESS, true);

    if (process.platform === 'linux' && !process.env.DISPLAY) {
      headless = true;
    }
    const browserType = process.env.GPAY_BROWSER || "chromium";
    const proxy = process.env.GPAY_PROXY;

    const proxyConfig = proxy ? { server: proxy } : undefined;
    if (proxy) {
      this.logger.log(`🔒 Using proxy: ${proxy.replace(/:[^:@]+@/, ":****@")}`);
    }

    const opts: any = {
      headless,
      proxy: proxyConfig,
    };

    if (browserType === "chromium") {
      opts.args = [
        headless ? "--headless=shell" : "",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--disable-dev-shm-usage",
        "--disable-notifications",
        "--disable-background-networking",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--mute-audio",
        "--disable-software-rasterizer",
        "--disable-canvas-aa",
        "--disable-2d-canvas-clip-aa",
        "--disable-gl-drawing-for-tests",
        "--disable-crash-reporter",
        "--js-flags=--max-old-space-size=256"
      ];
      opts.channel = this.parseBooleanEnv(process.env.GPAY_USE_REAL_CHROME, true)
        ? "chrome"
        : undefined;

      // Force Playwright to respect headless in persistent context, especially for Chrome 131+
      if (headless) {
        opts.args.push("--headless=new");
      }
    }

    return opts;
  }


  async connectGPay(
    merchantId: string,
    data: {
      email: string;
      password?: string;
      organizationId?: string;
      sessionId?: string;
      businessId?: string;
      upiId?: string;
      recoveryPhoneNumber?: string;
      googleVerificationCode?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    let browser: any = null;
    let context: any = null;
    let page: any = null;
    let sessionId: string = data.sessionId || "";

    try {
      this.logger.log(`🔗 GPay Connect Request for: ${data.email} (session: ${data.sessionId || 'new'})`);

      if (!data.organizationId) {
        throw new BadRequestException("Organization ID is required");
      }

      sessionId = data.sessionId || `gpay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      let session = this.loginSessions.get(sessionId);

      if (data.sessionId && !session) {
        throw new BadRequestException("Session expired or not found. Please try again.");
      }

      let context: any;
      let page: any;

      if (!session) {
        const existingProvider = await this.prisma.merchantProvider.findFirst({
          where: {
            providerType: ProviderType.GPAY,
            merchant: { organizationId: data.organizationId },
            accountIdentifier: data.email, // Or credentials email
          }
        });

        // If already active in memory, reuse it instead of opening another
        // persistent Chromium profile (prevents SingletonLock conflicts).
        if (existingProvider && this.activeSessions.has(existingProvider.id)) {
          const active = this.activeSessions.get(existingProvider.id)!;
          this.logger.log(`✅ Reusing active in-memory GPay session for ${data.email}`);
          return {
            success: true,
            merchantId: existingProvider.merchantId,
            businessId: active.businessId,
            requiresConfiguration: false,
            sessionId,
            connection: { credentials: { businessId: active.businessId } },
            ...this.gpaySavedUpiResponseFields(existingProvider),
          };
        }

        if (existingProvider && !this.activeSessions.has(existingProvider.id)) {
          this.logger.log(`🔍 Found existing provider for ${data.email}, attempting auto-restore...`);
          const restored = await this.restoreSession(existingProvider.id);
          if (restored) {
            this.logger.log(`✅ Session auto-restored for ${data.email} during connect request`);
            const session = this.activeSessions.get(existingProvider.id);
            return {
              success: true,
              merchantId: existingProvider.merchantId,
              businessId: session.businessId,
              requiresConfiguration: false,
              sessionId,
              connection: { credentials: { businessId: session.businessId } },
              ...this.gpaySavedUpiResponseFields(existingProvider),
            };
          }
        }

        if (!data.password) {
          throw new BadRequestException("Password is required for first-time login");
        }

        const launchOpts = this.getLaunchOptions(data.email);
        const userDataDir = this.getStableUserDataDir(data.email);

        this.logger.log(
          `🚀 Launching Playwright (Persistent Context: ${data.email}) for GPay login (profile: ${userDataDir})...`,
        );

        let launchAttempts = 0;
        
        while (launchAttempts < 3) {
          try {
            this.clearSingletonLock(userDataDir);
            context = await chromium.launchPersistentContext(userDataDir, {
              ...launchOpts,
              viewport: {
                width: 1366 + Math.floor(Math.random() * 100),
                height: 768 + Math.floor(Math.random() * 50)
              },
              deviceScaleFactor: 1.25,
              isMobile: false,
              hasTouch: false,
              locale: "en-IN",
              timezoneId: "Asia/Kolkata",
              userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            });
            break; // Success, exit loop
          } catch (e: any) {
            const msg = String(e?.message || "").toLowerCase();
            if (msg.includes("singletonlock") || msg.includes("processsingleton") || msg.includes("target page, context or browser has been closed")) {
              launchAttempts++;
              if (launchAttempts >= 3) {
                this.logger.warn(`⚠️ GPay profile is persistently locked for ${data.email} after ${launchAttempts} attempts.`);
                throw new BadRequestException("Merchant account is currently busy or already syncing. Please try again in a few moments.");
              }
              const delay = launchAttempts === 1 ? 1000 : 2000;
              this.logger.warn(`⚠️ GPay profile locked for ${data.email}. Retrying in ${delay}ms...`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              throw e;
            }
          }
        }

        browser = context.browser();

        page = await context.newPage();

        // Block heavy resources (images, fonts) and Google telemetry
        await this.optimizePage(page);

        // Entry: Start at main pay.google.com - more organic than g4b/signup (known automation target)
        const gpayBase = "https://pay.google.com";
        const gpayUrl = data.businessId
          ? `https://pay.google.com/g4b/transactions/${data.businessId}`
          : "https://pay.google.com/g4b/signup";

        this.logger.log(`📍 Visiting GPay (organic entry): ${gpayBase}`);
        await page.goto(gpayBase, {
          waitUntil: "networkidle",
          timeout: 25000,
        });

        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 1000));

        await page.mouse.move(100 + Math.random() * 50, 100 + Math.random() * 50);
        for (let i = 0; i <= 15; i++) {
          await page.mouse.move(100 + (i * 100) / 15, 100 + (i * 200) / 15);
        }
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));

        this.logger.log(`📍 Navigating to: ${gpayUrl}`);
        await page.goto(gpayUrl, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));

        // Check for landing page "Sign in" button
        let content = await page.content();
        if (content.includes("Sign in") && !content.includes("Email or phone")) {
          this.logger.log('Landing page detected. Clicking "Sign in" button...');
          await page.evaluate(() => {
            const signinBtn = Array.from(document.querySelectorAll('a, button')).find(el => el.textContent?.trim() === 'Sign in');
            if (signinBtn) (signinBtn as HTMLElement).click();
          });
          await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));

          // Some Google flows open/redirect via a new tab-like page in persistent context.
          const pages = context.pages();
          const latestPage = pages[pages.length - 1];
          if (latestPage && latestPage !== page) {
            page = latestPage;
            this.logger.log("🔄 Switched to latest browser page after Sign in click");
          }
        }

        const currentUrlBeforeAuth = page.url();
        const alreadyOnDashboard = currentUrlBeforeAuth.includes("pay.google.com/g4b/activity") || currentUrlBeforeAuth.includes("pay.google.com/g4b/home");

        if (!alreadyOnDashboard) {
          // Enter email - add delay before first input (reduces bot-like behavior)
          const emailSelector = "#identifierId, input[type=\"email\"], input[name=\"identifier\"]";
          try {
            await page.waitForSelector(emailSelector, { timeout: 45000 });
          } catch (e) {
            const debugTitle = await page.title().catch(() => "");
            const debugUrl = page.url();
            const snippet = (await page.content().catch(() => ""))
              .replace(/\s+/g, " ")
              .slice(0, 240);
            this.logger.error(
              `❌ Email field not found. url=${debugUrl} title=${debugTitle} html_snippet=${snippet}`,
            );
            throw e;
          }
          await new Promise((r) => setTimeout(r, 800 + Math.random() * 400));
          await page.focus(emailSelector);
          await new Promise((r) => setTimeout(r, 200));
          for (const char of data.email) {
            await page.type(emailSelector, char, {
              delay: 60 + Math.floor(Math.random() * 80),
            });
          }

          await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
          await page.keyboard.press("Enter");

          // Wait for password or challenge - longer wait for Google to settle
          await new Promise(resolve => setTimeout(resolve, 3500 + Math.random() * 1500));

          try {
            await page.waitForSelector('input[type="password"]', { timeout: 15000 });
            await page.focus('input[type="password"]');
            await new Promise((r) => setTimeout(r, 1000));
            for (const char of data.password) {
              await page.type('input[type="password"]', char, {
                delay: 40 + Math.floor(Math.random() * 60),
              });
            }
            await new Promise((r) => setTimeout(r, 700 + Math.random() * 400));
            await page.keyboard.press("Enter");
          } catch (e) {
            this.logger.warn("Password field not found, possibly rejection or phone verification");
          }
        } else {
           this.logger.log(`✅ Already on GPay dashboard during login flow - skipping credential entry! URL: ${currentUrlBeforeAuth}`);
        }

        session = {
          browser,
          context,
          page,
          organizationId: data.organizationId,
          email: data.email,
          password: data.password,
          recoveryPhoneNumber: data.recoveryPhoneNumber,
          googleVerificationCode: data.googleVerificationCode,
          createdAt: Date.now(),
        };
        this.loginSessions.set(sessionId, session);
      } else {
        // --- RESUME EXISTING SESSION ---
        browser = session.browser;
        context = session.context;
        page = session.page;
        this.logger.log("🔄 Resuming GPay login session...");
        // Allow updating the recovery phone during resume attempts
        if (data.recoveryPhoneNumber) {
          (session as any).recoveryPhoneNumber = data.recoveryPhoneNumber;
        }
        if (data.googleVerificationCode) {
          (session as any).googleVerificationCode = data.googleVerificationCode;
        }

        // Retry password if stuck on resumed session
        try {
          const urlNow = page.url();
          if (urlNow.includes("challenge/pwd")) {
            const contentNow = await page.content().catch(() => "");
            if (contentNow.includes("Enter your password") || contentNow.includes("Show password")) {
              this.logger.log("⚠️ Resumed session is still on password page. Retrying password entry...");
              await page.waitForSelector('input[type="password"]', { timeout: 5000 });
              await page.focus('input[type="password"]');
              await page.evaluate(() => {
                const el = document.querySelector('input[type="password"]') as HTMLInputElement;
                if (el) el.value = '';
              });
              await new Promise((r) => setTimeout(r, 500));
              for (const char of data.password) {
                await page.type('input[type="password"]', char, { delay: 40 + Math.floor(Math.random() * 60) });
              }
              await new Promise((r) => setTimeout(r, 700));
              const nextBtn = await page.$('#passwordNext button, button:has-text("Next")');
              if (nextBtn) {
                await nextBtn.click();
              } else {
                await page.keyboard.press("Enter");
              }
            }
          }
        } catch (e) {
          this.logger.warn("Retry password failed:", e);
        }
      }

      // Check for challenges (Wait for Google to settle - page may still be navigating after password submit)
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
      } catch {
        // Ignore timeout - page might be slow
      }

      const currentUrl = page.url();
      this.logger.log(`📍 Current URL: ${currentUrl}`);

      // Handle Google's "confirm phone number" step (recovery phone) if it appears.
      // If the UI is detected and phoneNumber is provided, auto-fill + click Send.
      const phoneHandle = await this.detectAndHandleGooglePhoneNumber(
        page,
        (session as any)?.recoveryPhoneNumber || data.recoveryPhoneNumber,
      );
      if (phoneHandle.detected) {
        if (phoneHandle.submitted) {
          this.logger.log("✅ Submitted recovery phone number on Google challenge");
          await new Promise((r) => setTimeout(r, 2500));
        } else {
          // Ask user for the phone number in our UI
          return {
            success: false,
            challenge: {
              type: "GOOGLE_PHONE",
              message:
                "Google needs your recovery phone number to send a verification code. Enter your phone number and click 'Send' on the Google page (or enter it here and click Next).",
              screenshotBase64: await this.safeTakeScreenshot(page),
            },
            sessionId,
            message:
              "Google needs your recovery phone number. Please provide it to continue.",
          };
        }
      }

      // CRITICAL: If we're already on GPay dashboard, user logged in (e.g. via phone) - finalize immediately!
      if (currentUrl.includes("pay.google.com/g4b")) {
        this.logger.log("✅ Already on GPay dashboard - user logged in successfully!");
        const finalUrl = page.url();
        const businessIdMatch = finalUrl.match(/activity\/([^/?#]+)/);
        const businessId = businessIdMatch ? businessIdMatch[1] : "";
        const merchantProfile = await this.fetchMerchantProfile(page, data.email);

        const provider = await this.finalizeGPayConnection(merchantId, {
          email: data.email,
          businessId,
          businessName: merchantProfile.businessName,
          organizationId: data.organizationId,
          upiId: data.upiId,
          isSuperAdmin: data.isSuperAdmin,
        });
        const merchantWithConfig = await this.prisma.merchant.findUnique({
          where: { id: provider.merchantId },
          include: { config: true },
        });
        const requiresConfiguration = !merchantWithConfig?.verified || !merchantWithConfig?.config;
        // Keep browser alive for persistent session — don't close!
        await this.storeActiveSession(provider.id, { browser, context, page, businessId, email: data.email, organizationId: data.organizationId });
        this.loginSessions.delete(sessionId);
        return {
          success: true,
          merchantId: provider.merchantId,
          businessId,
          requiresConfiguration,
          sessionId,
          connection: { credentials: { businessId } },
          ...this.gpaySavedUpiResponseFields(provider),
        };
      }

      // Inspect page for challenges (only if NOT already on dashboard)
      // Retry page.content() - it can fail with "page is navigating" during redirects
      let content = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          content = await page.content();
          break;
        } catch (e: any) {
          if (e?.message?.includes("navigating") && attempt < 4) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw e;
        }
      }

      // Auto-skip "Simplify your sign-in" / passkey prompt - click "Not now"
      if (content.includes("Simplify your sign-in") || (content.includes("passkey") && content.includes("Only create a passkey"))) {
        const clicked = await this.tryClickPasskeyNotNow(page);
        if (clicked) {
          this.logger.log("✅ Clicked 'Not now' on passkey prompt, waiting for navigation...");
          await new Promise((r) => setTimeout(r, 3000));
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: 8000 });
          } catch { }
          // Re-fetch content and re-check URL (might be on dashboard now)
          const urlAfter = page.url();
          if (urlAfter.includes("pay.google.com/g4b")) {
            this.logger.log("✅ Already on GPay dashboard after skipping passkey!");
            const businessIdMatch = urlAfter.match(/activity\/([^/?#]+)/);
            const businessId = businessIdMatch ? businessIdMatch[1] : "";
            const merchantProfile = await this.fetchMerchantProfile(page, data.email);

            const provider = await this.finalizeGPayConnection(merchantId, {
              email: data.email,
              businessId,
              businessName: merchantProfile.businessName,
              organizationId: data.organizationId,
              upiId: data.upiId,
              isSuperAdmin: data.isSuperAdmin,
            });
            const merchantWithConfig = await this.prisma.merchant.findUnique({
              where: { id: provider.merchantId },
              include: { config: true },
            });
            const requiresConfiguration = !merchantWithConfig?.verified || !merchantWithConfig?.config;
            await this.storeActiveSession(provider.id, { browser, context, page, businessId, email: data.email, organizationId: data.organizationId });
            this.loginSessions.delete(sessionId);
            return {
              success: true,
              merchantId: provider.merchantId,
              businessId,
              requiresConfiguration,
              sessionId,
              connection: { credentials: { businessId } },
              ...this.gpaySavedUpiResponseFields(provider),
            };
          }
          for (let a = 0; a < 4; a++) {
            try {
              content = await page.content();
              break;
            } catch (e: any) {
              if (a < 3 && e?.message?.includes("navigating")) await new Promise((r) => setTimeout(r, 1500));
              else if (!e?.message?.includes("navigating")) throw e;
            }
          }
        }
      }

      let challenge = await this.detectAndExtractChallengesFromPage(page, content);

      // No challenge but still on password page - page may be redirecting after 2FA on phone
      const urlBeforeWait = page.url();
      if (!challenge && urlBeforeWait.includes("challenge/pwd") && content.includes("Enter your password")) {
        this.logger.log("⏳ On password/accounts page - waiting for possible redirect to GPay...");
        for (let w = 0; w < 3; w++) {
          await new Promise((r) => setTimeout(r, 4000));
          const urlNow = page.url();
          if (urlNow.includes("pay.google.com/g4b")) {
            this.logger.log("✅ Redirected to GPay dashboard!");
            const businessIdMatch = urlNow.match(/activity\/([^/?#]+)/);
            const businessId = businessIdMatch ? businessIdMatch[1] : "";
            const merchantProfile = await this.fetchMerchantProfile(page, data.email);

            const provider = await this.finalizeGPayConnection(merchantId, {
              email: data.email,
              businessId,
              businessName: merchantProfile.businessName,
              organizationId: data.organizationId,
              upiId: data.upiId,
              isSuperAdmin: data.isSuperAdmin,
            });
            const merchantWithConfig = await this.prisma.merchant.findUnique({
              where: { id: provider.merchantId },
              include: { config: true },
            });
            const requiresConfiguration = !merchantWithConfig?.verified || !merchantWithConfig?.config;
            await this.storeActiveSession(provider.id, { browser, context, page, businessId, email: data.email, organizationId: data.organizationId });
            this.loginSessions.delete(sessionId);
            return {
              success: true,
              merchantId: provider.merchantId,
              businessId,
              requiresConfiguration,
              sessionId,
              connection: { credentials: { businessId } },
              ...this.gpaySavedUpiResponseFields(provider),
            };
          }
        }
      }

      // When resuming with sessionId and we hit RECAPTCHA/Verification Required:
      // User has clicked "I've Confirmed" in our UI after doing manual login on browser/phone.
      if (challenge && data.sessionId && challenge.type === "RECAPTCHA") {
        this.logger.log("🔄 User confirmed - performing fresh navigation to GPay to clear block...");

        // Strategy: Instead of just clicking "Try again" (which Google often rejects again),
        // we navigate back to the GPay portal. If the user cleared the block on their mobile/phone
        // on the same network, Google's IP trust should now allow the Puppeteer session through.
        const gpayUrl = data.businessId
          ? `https://pay.google.com/g4b/transactions/${data.businessId}`
          : "https://pay.google.com/g4b/signup";

        await page.goto(gpayUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise((r) => setTimeout(r, 5000));
        for (let a = 0; a < 4; a++) {
          try {
            content = await page.content();
            break;
          } catch (e: any) {
            if (a === 3 || !e?.message?.includes("navigating")) throw e;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        challenge = await this.detectAndExtractChallengesFromPage(page, content);
      }

      if (challenge) {
        this.logger.log(`⚠️ Challenge detected: ${challenge.type}`);

        // If Google asks for a verification code and we got the code from UI,
        // try to fill it inside Google and submit (works in headless mode).
        if (challenge.type === "GOOGLE_CODE") {
          const codeToUse =
            data.googleVerificationCode || (session as any)?.googleVerificationCode || undefined;

          if (codeToUse && codeToUse.replace(/\D/g, "").length >= 4) {
            const submitted = await this.tryFillGoogleCodeAndSubmit(page, codeToUse);
            if (submitted) {
              this.logger.log("✅ Submitted Google verification code from UI input");
              await new Promise((r) => setTimeout(r, 3500));
              try {
                content = await page.content();
              } catch {
                // ignore
              }
              const refreshed = await this.detectAndExtractChallengesFromPage(page, content);
              if (refreshed && refreshed.type === "GOOGLE_CODE") {
                challenge = refreshed; // still needs code
              } else {
                challenge = null; // moved on, let transition logic finalize
              }
            } else {
              this.logger.log(
                `⚠️ [AUTO-RETRY] Could not submit code, falling through to user verification`,
              );
            }
          }
        }

        if (!challenge) {
          // Continue to the "businessId reached" transition logic below.
        } else {
          // Optional: include screenshot so user can see what's on screen (for debugging)
          let screenshotBase64: string | undefined;
          try {
            const buf = await page.screenshot({ type: "jpeg", quality: 85 });
            screenshotBase64 = Buffer.from(buf).toString("base64");
          } catch {
            // Ignore screenshot errors
          }
          return {
            success: false,
            challenge: { ...challenge, screenshotBase64 },
            sessionId,
            message: challenge.message,
          };
        }
      }

      // Re-read URL and wait for G4B dashboard redirection if we are in transition
      let businessId = "";
      for (let i = 0; i < 6; i++) {
        const currentUrl = page.url();
        const businessIdMatch = currentUrl.match(/activity\/([^/?#]+)/);
        if (businessIdMatch && businessIdMatch[1]) {
          businessId = businessIdMatch[1];
          break;
        }

        if (currentUrl.includes("pay.google.com/g4b/signup")) {
          this.logger.log("⏳ On GPay signup/entry page - waiting for redirect to activity console...");
        }

        await new Promise((r) => setTimeout(r, 3000));
        try {
          // Re-check for challenges in case a new one popped up during transition
          content = await page.content();
          const newChallenge = await this.detectAndExtractChallengesFromPage(page, content);
          if (newChallenge) {
            this.logger.log(`⚠️ New challenge detected during transition: ${newChallenge.type}`);
            return {
              success: false,
              challenge: { ...newChallenge, screenshotBase64: await this.safeTakeScreenshot(page) },
              sessionId,
              message: newChallenge.message,
            };
          }
        } catch { }
      }

      // If we are on the G4B dashboard/console, finalize
      if (businessId) {
        this.logger.log("✅ GPay Business Dashboard reached!");

        // Extract merchant profile details natively before finalization
        const merchantProfile = await this.fetchMerchantProfile(page, data.email);

        // Finalize connection in DB
        const provider = await this.finalizeGPayConnection(
          merchantId,
          {
            email: data.email,
            businessId,
            businessName: merchantProfile.businessName,
            organizationId: data.organizationId,
            upiId: data.upiId,
            isSuperAdmin: data.isSuperAdmin,
          }
        );

        const merchantWithConfig = await this.prisma.merchant.findUnique({
          where: { id: provider.merchantId },
          include: { config: true },
        });
        const requiresConfiguration = !merchantWithConfig?.verified || !merchantWithConfig?.config;

        // Keep browser alive for persistent session
        await this.storeActiveSession(provider.id, { browser, context, page, businessId, email: data.email, organizationId: data.organizationId });
        this.loginSessions.delete(sessionId);

        return {
          success: true,
          merchantId: provider.merchantId,
          businessId,
          requiresConfiguration,
          sessionId,
          connection: { credentials: { businessId } },
          ...this.gpaySavedUpiResponseFields(provider),
        };
      }

      const finalUrl = page.url();
      let waitingMessage = "Logged in successfully, but still waiting for GPay dashboard to load. Please click 'Next' again in a moment.";
      if (finalUrl.includes("challenge/pwd") || finalUrl.includes("signin")) {
        waitingMessage = "Still waiting for Google sign-in step to complete. Google might be loading or password may be incorrect. Please click 'Next' again in a moment.";
      }

      return {
        success: false,
        status: "WAITING",
        message: waitingMessage,
        sessionId,
      };

    } catch (error: any) {
      this.logger.error(`❌ Failed GPay flow:`, error);
      
      try {
        await page?.close?.().catch(() => {});
        await context?.close?.().catch(() => {});
        await browser?.close?.().catch(() => {});
      } catch { }
      
      if (sessionId) {
        this.loginSessions.delete(sessionId);
      }
      
      throw new BadRequestException(error?.message || "GPay connection failed");
    }
  }

  /**
   * Scrapes the merchant business profile (name, etc) from the live GPay dashboard session.
   */
  private async fetchMerchantProfile(page: any, email: string): Promise<{ businessName: string }> {
    try {
      const scraped = await page.evaluate(async () => {
        let businessName = "";

        // Wait briefly for SPA to render the merchant name
        await new Promise(r => setTimeout(r, 2000));

        const EXCLUDED_STRINGS = [
          'activity', 'transactions', 'settings', 'support', 'help', 'google pay',
          'staff access', 'you have staff access', 'manage your account',
          'notifications', 'account', 'feedback', 'privacy policy', 'terms of service'
        ];

        const elementsWithAria = document.querySelectorAll('[aria-label]');
        for (const el of elementsWithAria) {
          const label = el.getAttribute('aria-label') || '';
          if (label.includes('Google Pay for Business') && label.includes('-')) {
            const parts = label.split('-');
            if (parts.length > 1) {
              const candidate = parts[1].trim();
              if (candidate.length > 0 && !EXCLUDED_STRINGS.some(s => candidate.toLowerCase().includes(s))) {
                businessName = candidate;
                return { businessName };
              }
            }
          }
        }

        const possibleHeaders = document.querySelectorAll('header div, [role="banner"] div, h1, h2');
        for (const el of possibleHeaders) {
          const text = el.textContent?.trim() || '';
          if (text.length > 2 && text.length < 50 &&
            !EXCLUDED_STRINGS.some(s => text.toLowerCase().includes(s))) {

            // Check if it's visually prominent (e.g. bold or large font)
            const style = window.getComputedStyle(el);
            if (parseInt(style.fontWeight) > 400 || parseInt(style.fontSize) >= 16) {
              businessName = text;
              break;
            }
          }
        }

        if (!businessName) {
          const nav = document.querySelector('nav, header, [role="banner"]');
          if (nav) {
            const treeWalker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT, null);
            let currentNode = treeWalker.nextNode();
            while (currentNode) {
              const text = currentNode.textContent?.trim() || '';
              if (text.length > 2 && text.length < 50 &&
                !EXCLUDED_STRINGS.some(s => text.toLowerCase().includes(s))) {
                businessName = text;
                break;
              }
              currentNode = treeWalker.nextNode();
            }
          }
        }

        // Final fallback document title (stripped)
        if (!businessName || businessName.toLowerCase() === 'activity') {
          const title = document.title;
          if (title && title.includes("-")) {
            const candidate = title.split("-")[0].trim();
            if (!EXCLUDED_STRINGS.some(s => candidate.toLowerCase().includes(s))) {
              businessName = candidate;
            }
          } else if (title && !EXCLUDED_STRINGS.some(s => title.toLowerCase().includes(s))) {
            businessName = title.trim();
          }
        }

        return { businessName };
      });

      // Absolute final fallback: use the provided email address
      const finalName = scraped.businessName ? scraped.businessName : `GPay ${email}`;
      return { businessName: finalName };
    } catch (error) {
      this.logger.warn(`⚠️ Failed to extract merchant profile from DOM: ${error instanceof Error ? error.message : String(error)}`);
      // Fallback on error
      return { businessName: `GPay ${email}` };
    }
  }

  private extractSavedGpayUpiId(provider: {
    accountIdentifier: string;
  }): string | undefined {
    const id = provider.accountIdentifier?.trim();
    if (!id) return undefined;
    const upiRegex =
      /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{2,64}$/;
    return upiRegex.test(id) ? id : undefined;
  }

  private gpaySavedUpiResponseFields(provider: {
    accountIdentifier: string;
  }): { savedUpiId?: string } {
    const savedUpiId = this.extractSavedGpayUpiId(provider);
    return savedUpiId ? { savedUpiId } : {};
  }

  private async finalizeGPayConnection(
    merchantId: string,
    data: {
      email: string;
      businessId: string;
      businessName?: string;
      organizationId: string;
      upiId?: string;
      isSuperAdmin?: boolean;
    }
  ): Promise<MerchantProvider> {
    let effectiveMerchantId = merchantId;

    let existingMerchantId: string | null = null;

    if (data.upiId) {
      const providerByUpi = await this.prisma.merchantProvider.findFirst({
        where: {
          providerType: ProviderType.GPAY,
          accountIdentifier: data.upiId,
          merchant: {
            organizationId: data.organizationId,
          },
        },
        select: { merchantId: true }
      });
      if (providerByUpi) {
        existingMerchantId = providerByUpi.merchantId;
        this.logger.log(`♻️ Found existing merchant by UPI ID: ${existingMerchantId}`);
      }
    }

    // 2. Try finding by email (accountIdentifier OR credentials?.email)
    if (!existingMerchantId) {
      const existingProviders = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.GPAY,
          merchant: { organizationId: data.organizationId },
        },
        select: { merchantId: true, accountIdentifier: true, credentials: true }
      });

      for (const p of existingProviders) {
        let pEmail = p.accountIdentifier;
        if (p.credentials && typeof p.credentials === 'object' && (p.credentials as any).email) {
          pEmail = (p.credentials as any).email;
        }
        if (pEmail === data.email || p.accountIdentifier === data.email) {
          existingMerchantId = p.merchantId;
          break;
        }
      }

      if (existingMerchantId) {
        this.logger.log(`♻️ Found existing GPay provider by email: ${existingMerchantId}`);
      }
    }

    // 3. Fallback: search for merchant by name (email) in this organization
    if (!existingMerchantId) {
      const existingMerchantByName = await this.prisma.merchant.findFirst({
        where: {
          organizationId: data.organizationId,
          name: data.email,
        },
        select: { id: true }
      });
      if (existingMerchantByName) {
        existingMerchantId = existingMerchantByName.id;
        this.logger.log(`♻️ Found existing merchant by name (email): ${existingMerchantId}`);
      }
    }

    if (existingMerchantId) {
      effectiveMerchantId = existingMerchantId;
    }

    const defaultName = data.businessName ? data.businessName : `GPay ${data.email}`;
    const merchant = await this.findOrCreateMerchant(
      effectiveMerchantId,
      data.organizationId,
      defaultName,
      data.isSuperAdmin,
    );

    // If we extracted a real business name but the merchant already existed with a Generic/Temp name, update it
    let finalMerchantName = merchant.name;
    const isGeneric = (name: string) => {
      if (!name) return true;
      const n = name.toLowerCase();
      return (
        n.startsWith("gpay ") ||
        n === "learn more" ||
        n.includes("staff access") ||
        n.includes("pay for business") ||
        n.includes("sign in") ||
        n.includes("google pay") ||
        n.includes("payment for business") ||
        n.length < 3
      );
    };

    const currentIsGeneric = isGeneric(merchant.name);
    const newNameIsReal = data.businessName && !isGeneric(data.businessName);

    if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
      await this.prisma.merchant.update({
        where: { id: merchant.id },
        data: { name: data.businessName, businessName: data.businessName },
      });
      finalMerchantName = data.businessName;
    } else if (currentIsGeneric && !newNameIsReal) {
      const fallbackName = data.email;
      if (merchant.name !== fallbackName) {
        await this.prisma.merchant.update({
          where: { id: merchant.id },
          data: { name: fallbackName, businessName: fallbackName },
        });
        finalMerchantName = fallbackName;
      }
    }

    // Now look for the provider to update or create
    const existing = await this.prisma.merchantProvider.findFirst({
      where: {
        merchantId: merchant.id,
        providerType: ProviderType.GPAY,
      },
    });

    if (existing) {
      this.logger.log(`🔄 Updating existing provider ${existing.id} for merchant ${merchant.id}`);
      const upiRegex =
        /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{2,64}$/;
      const prevIdentifier = (existing.accountIdentifier || "").trim();
      const incomingUpi = data.upiId?.trim();
      const nextAccountIdentifier =
        incomingUpi && upiRegex.test(incomingUpi)
          ? incomingUpi
          : prevIdentifier && upiRegex.test(prevIdentifier)
            ? prevIdentifier
            : data.email;

      return await this.prisma.merchantProvider.update({
        where: { id: existing.id },
        data: {
          accountIdentifier: nextAccountIdentifier,
          credentials: {
            ...((existing.credentials as any) || {}),
            email: data.email,
            businessId: data.businessId,
          },
          status: MerchantProviderStatus.ACTIVE,
          isActive: true, // Ensure it's active
          metadata: {
            ...((existing.metadata as any) || {}),
            merchantName: finalMerchantName,
            lastSync: new Date(),
            sessionType: 'persistent_browser',
          },
        },
      });
    }

    this.logger.log(`🆕 Creating new provider for merchant ${merchant.id}`);
    return await this.prisma.merchantProvider.create({
      data: {
        merchantId: merchant.id,
        providerType: ProviderType.GPAY,
        accountIdentifier: data.email,
        credentials: {
          email: data.email,
          businessId: data.businessId,
        },
        status: MerchantProviderStatus.ACTIVE,
        metadata: {
          merchantName: finalMerchantName,
          connectedAt: new Date(),
          lastSync: new Date(),
          sessionType: 'persistent_browser',
        },
      },
    });
  }

  private async detectAndExtractChallengesFromPage(page: any, content: string) {
    let url = "";
    try {
      url = page.url();
    } catch {
      // ignore
    }
    try {
      if (!content) {
        content = await page.content();
      }
    } catch {
      return null;
    }

    // Already on GPay dashboard = success, no challenge
    if (url.includes("pay.google.com/g4b")) {
      return null;
    }
    const isRejectedPage = url.includes("signin/rejected");

    // Some flows land directly on passkey enrollment first; try to skip it.
    const hasPasskeyPrompt =
      content.includes("Simplify your sign-in") || url.includes("passkeyenrollment") || url.includes("recoveryoptions") || content.includes("Make sure you can always sign in");

    const clickedNotNow = hasPasskeyPrompt
      ? await this.tryClickPasskeyNotNow(page)
      : await this.tryClickPasskeyNotNow(page, { forceFrameScan: true });

    if (clickedNotNow) {
      await new Promise((r) => setTimeout(r, 1800));
      try {
        content = await page.content();
        url = page.url();
      } catch {
        // ignore and continue with previous snapshot
      }
    }

    const lowerTop = (content || "").toLowerCase();
    const isVerificationCodeFlow =
      lowerTop.includes("verification code") ||
      lowerTop.includes("get a verification code") ||
      lowerTop.includes("recovery phone") ||
      lowerTop.includes("choose how you want to sign in") ||
      url.includes("challenge/selection") ||
      url.includes("challenge/ipp");

    if (isVerificationCodeFlow) {
      // If this is the "choose how you want to sign in" screen, try to select
      // "Get a verification code" so the subsequent code-entry UI appears.
      const isMethodSelection =
        lowerTop.includes("choose how you want to sign in") ||
        url.includes("challenge/selection");

      // DOM-based detection: Google’s code-entry screen contains a real OTP/code input.
      // Text-based heuristics are unreliable across locales / layout changes.
      let domDetect = await this.detectGoogleCodeEntryFromDom(page);
      let isCodeEntryNow = domDetect.isCodeEntry;
      if (domDetect.visibleCodeInputCount > 0) {
        this.logger.log(
          `🧩 [DIAGNOSTIC] GOOGLE_CODE DOM detected OTP inputs: ${domDetect.visibleCodeInputCount}`,
        );
      }

      let attemptedAutoSelect = false;
      if (isMethodSelection && !isCodeEntryNow) {
        const clicked = await this.tryClickGetVerificationCode(page);
        attemptedAutoSelect = attemptedAutoSelect || clicked;
        if (clicked) {
          // Wait for the next screen to load; Google can take a few seconds.
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 2500));
            try {
              url = page.url();
              domDetect = await this.detectGoogleCodeEntryFromDom(page);
              if (domDetect.isCodeEntry) {
                isCodeEntryNow = true;
                break;
              }

              // Fallback: also look at URL/text once in a while.
              if (url.includes("challenge/ipp") || ((content || "").toLowerCase().includes("verification code") && ((content || "").toLowerCase().includes("enter") || (content || "").toLowerCase().includes("code")))) {
                // Keep it as a weak fallback; DOM input remains the source of truth.
                const lower = ((await page.content()) || "").toLowerCase();
                const looksLikeCodeEntry =
                  lower.includes("enter the code") ||
                  lower.includes("enter the verification code") ||
                  (lower.includes("verification code") && lower.includes("enter")) ||
                  lower.includes("6-digit") ||
                  lower.includes("one-time code");
                if (looksLikeCodeEntry) {
                  domDetect = await this.detectGoogleCodeEntryFromDom(page);
                  if (domDetect.isCodeEntry) {
                    isCodeEntryNow = true;
                    break;
                  }
                }
              }
            } catch {
              // ignore and keep waiting
            }
          }
        }
      }

      return {
        type: "GOOGLE_CODE",
        message:
          isCodeEntryNow
            ? "Google is asking for a verification code. Enter the 6-digit code in this portal. We'll submit it automatically in headless mode."
            : attemptedAutoSelect
              ? "Google is still showing the method selection screen for verification code. Please click 'Get a verification code (Recovery phone)' on the Google page, then enter the code in this portal."
              : "Google is asking for a verification code. On the Google page, choose 'Get a verification code' (recovery phone) if shown, then enter the code in this portal.",
      };
    }

    // Page scraping logic for challenges - Google "Confirm it's you" / phone verification
    const isGoogleVerificationPage =
      content.includes("Confirm it's you") ||
      content.includes("check your phone") ||
      content.includes("Trying to sign in?") ||
      content.includes("Match the number") ||
      url.includes("challenge/dp") ||
      url.includes("challenge/pwd") ||
      url.includes("signin/challenge");

    if (isGoogleVerificationPage) {
      if (content.toLowerCase().includes("try another way")) {
        const switched = await this.tryClickTryAnotherWay(page);
        if (switched) {
          await new Promise((r) => setTimeout(r, 1800));
          try {
            content = await page.content();
            url = page.url();
          } catch {
            // ignore
          }
        }
      }

      // Extract prompt number from Google's page (2-3 digits: 32, 49, 77, 117, etc.)
      const extracted = await page.evaluate(() => {
        try {
          let num: string | null = null;
          const bodyText = document.body.innerText;

          // 1. Look for number in tappable/button elements (Google shows numbers as buttons)
          const buttons = Array.from(document.querySelectorAll('[role="button"], button, div[tabindex]'));
          for (const el of buttons) {
            const text = (el.textContent || "").trim();
            if (/^\d{2,3}$/.test(text)) {
              num = text;
              break;
            }
          }

          // 2. Look for prominent numbers (large font, 2-3 digits)
          if (!num) {
            const all = Array.from(document.querySelectorAll("div, span, b, strong, button"));
            for (const el of all) {
              const text = el.textContent?.trim();
              if (text && /^\d{2,3}$/.test(text)) {
                const style = window.getComputedStyle(el);
                const fs = parseInt(style.fontSize);
                const fw = style.fontWeight;
                if (fs >= 18 || parseInt(fw) >= 600) {
                  num = text;
                  break;
                }
              }
            }
          }

          // 3. Regex: "tap 32" or "select 32" or number in instruction text
          if (!num) {
            const m = bodyText.match(/(?:tap|select|choose|use)\s+(\d{2,3})\b/i) ||
              bodyText.match(/\b(\d{2,3})\s+(?:on your phone|to verify)/i);
            if (m) num = m[1];
          }

          // 4. Fallback: first 2-3 digit number in body
          if (!num) {
            const m = bodyText.match(/\b(\d{2,3})\b/);
            if (m) num = m[1];
          }

          // Extract device names: "Google sent a notification to your Google Pixel 10, POCO C75 5G"
          let devs: string[] = [];
          const devMatch = bodyText.match(/notification to your ([^.]+?)(?:\.|Tap|Click|Select)/i);
          if (devMatch) {
            devs = devMatch[1].split(",").map((d) => d.trim()).filter(Boolean);
          }
          return { promptNumber: num, devices: devs };
        } catch {
          return { promptNumber: null, devices: [] };
        }
      }).catch(() => ({ promptNumber: null, devices: [] }));

      const { promptNumber, devices } = extracted;

      // If we found a prompt number OR the page text strongly suggests a phone prompt
      if (promptNumber || content.includes("check your phone") || content.includes("tap Yes") || content.includes("confirmed it's you")) {
        return {
          type: "GOOGLE_PROMPT",
          message: "Check your phone. Tap 'Yes' and then select the number shown below.",
          promptNumber: promptNumber || "??",
          devices: devices?.length ? devices : undefined,
        };
      }
    }

    // (code flow handling is prioritized above)

    if (content.includes("passkey") || url.includes("passkeyenrollment")) {
      return {
        type: "RECAPTCHA", // Map to RECAPTCHA to reuse the confirm button flow
        message:
          "Google is asking for Passkey or Security confirmation. Please check your browser/phone, then click 'I've Confirmed' here.",
      };
    }

    // Do NOT treat the normal password page as RECAPTCHA
    const isPasswordPage = url.includes("challenge/pwd") && (
      content.includes("Enter your password") ||
      content.includes("Show password") ||
      content.includes('type="password"')
    );
    if (isPasswordPage) return null;

    if (
      isRejectedPage ||
      content.toLowerCase().includes("recaptcha") ||
      content.includes("robot") ||
      content.includes("g-recaptcha") ||
      content.includes("unusual activity") ||
      content.includes("not secure") ||
      content.includes("About this page") ||
      content.includes("unusual traffic")
    ) {
      return {
        type: "RECAPTCHA",
        message:
          "Google has flagged this login as unusual. Please log in manually once on your browser/phone (or solve the CAPTCHA if shown below), then click 'I've Confirmed' here.",
      };
    }

    return null;

    return null;
  }

  /**
   * Click "Not now" on Google's passkey prompt ("Simplify your sign-in").
   * Returns true if clicked, false if button not found.
   */
  private async tryClickPasskeyNotNow(
    page: any,
    opts?: { forceFrameScan?: boolean },
  ): Promise<boolean> {
    try {
      // If needed, scan across all frames for the actual "Not now" button.
      // This is important because Google sometimes renders the passkey prompt in an iframe.
      const scanFrames = async () => {
        const frames = typeof page.frames === "function" ? page.frames() : [];
        for (const frame of frames) {
          try {
            const frameUrl = frame.url?.() || "";
            // Keep it scoped: only accounts.google.com style frames.
            if (!/accounts\.google\.com/i.test(frameUrl) && !/google/i.test(frameUrl)) continue;

            if (typeof frame.getByRole === "function") {
              const btn = frame.getByRole("button", { name: /not now/i });
              await btn.click({ timeout: 1200 }).catch(() => { });
              // If no exception, we likely clicked.
              return true;
            }

            const clicked = await frame.evaluate(() => {
              const targets = ["not now", "skip", "no thanks", "maybe later", "cancel"];
              const all = Array.from(
                document.querySelectorAll('button, [role="button"], a, span, div'),
              );
              for (const el of all) {
                const text = (el.textContent || "").trim().toLowerCase();
                if (targets.some((t) => text === t || text.startsWith(t))) {
                  const parent =
                    (el as HTMLElement).closest?.("button, [role='button'], a") || el;
                  (parent as HTMLElement).click?.();
                  return true;
                }
              }
              return false;
            }).catch(() => false);

            if (clicked) return true;
          } catch {
            // ignore and continue to next frame
          }
        }
        return false;
      };

      if (opts?.forceFrameScan) {
        return await scanFrames();
      }

      // Prefer Playwright role-based selectors (more reliable than raw DOM scanning).
      // This handles cases where the visible text is nested or changes slightly.
      try {
        if (typeof page.getByRole === "function") {
          const btn = page.getByRole("button", { name: /not now|cancel|skip|no thanks/i });
          await btn.click({ timeout: 1500 }).catch(() => { });
          // If click didn't throw, assume success.
          return true;
        }
      } catch {
        // fall back
      }

      try {
        if (typeof page.locator === "function") {
          const loc = page.locator("button:has-text(\"Not now\"), [role='button']:has-text(\"Not now\")");
          const count = await loc.count().catch(() => 0);
          if (count > 0) {
            await loc.first().click({ timeout: 1500 }).catch(() => { });
            return true;
          }
        }
      } catch {
        // fall back
      }

      const clicked = await page.evaluate(() => {
        const targets = ["not now", "skip", "no thanks", "maybe later"];
        const all = Array.from(document.querySelectorAll('button, [role="button"], a, span, div'));
        for (const el of all) {
          const text = (el.textContent || "").trim().toLowerCase();
          if (targets.some((t) => text === t || text.startsWith(t))) {
            const parent = (el as HTMLElement).closest?.("button, [role='button'], a") || el;
            if ((parent as HTMLElement).click) {
              (parent as HTMLElement).click();
              return true;
            }
            (el as HTMLElement).click?.();
            return true;
          }
        }
        return false;
      });
      if (clicked) return true;

      // Last resort: scan frames.
      return await scanFrames();
    } catch {
      return false;
    }
  }

  /**
   * Detect the Google "confirm your phone number" step and (optionally) fill it.
   * Returns true if the UI was detected (and handled if phone provided).
   */
  private async detectAndHandleGooglePhoneNumber(
    page: any,
    phoneNumber?: string,
  ): Promise<{ detected: boolean; submitted: boolean }> {
    try {
      const detected = await page.evaluate(() => {
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const body = norm(document.body?.innerText || "");
        if (!body.includes("get a verification code")) return false;
        if (!body.includes("phone number")) return false;
        const input = document.querySelector("input[type='tel'], input[autocomplete='tel'], input[aria-label*='Phone number' i]") as HTMLInputElement | null;
        return !!input;
      }).catch(() => false);

      if (!detected) return { detected: false, submitted: false };
      if (!phoneNumber?.trim()) return { detected: true, submitted: false };

      const cleaned = phoneNumber.replace(/\D/g, "");
      const submitted = await page.evaluate((num: string) => {
        const input =
          (document.querySelector("input[type='tel']") as HTMLInputElement | null) ||
          (document.querySelector("input[autocomplete='tel']") as HTMLInputElement | null) ||
          (document.querySelector("input[aria-label*='Phone number' i]") as HTMLInputElement | null);
        if (!input) return false;
        input.focus();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = num;
        input.dispatchEvent(new Event("input", { bubbles: true }));

        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const candidates = Array.from(document.querySelectorAll("button, [role='button']")) as HTMLElement[];
        const send = candidates.find((b) => norm(b.innerText || b.textContent || "").includes("send"));
        if (send) {
          send.click();
          return true;
        }
        return false;
      }, cleaned).catch(() => false);

      return { detected: true, submitted: !!submitted };
    } catch {
      return { detected: false, submitted: false };
    }
  }

  /**
   * Try to click the action button on Google's challenge page.
   * - "Try again" = shown on "This browser or app may not be secure" page
   * - "I've Confirmed" = shown on some Verification Required pages
   * Called when user has done manual login on browser/phone and clicks retry.
   */
  private async tryClickVerificationConfirmed(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const targets = ["try again", "i've confirmed", "try again later"];
        const all = Array.from(
          document.querySelectorAll('button, [role="button"], a'),
        );
        // Prefer buttons/links with exact or near-exact text
        for (const el of all) {
          const text = (el.textContent || "").trim().toLowerCase();
          if (targets.some((t) => text === t || text.startsWith(t))) {
            (el as HTMLElement).click();
            return true;
          }
        }
        // Fallback: check span/div (e.g. text inside a button)
        const fallback = Array.from(
          document.querySelectorAll('span, div'),
        );
        for (const el of fallback) {
          const text = (el.textContent || "").trim().toLowerCase();
          if (targets.some((t) => text === t) && (el as HTMLElement).offsetParent !== null) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) this.logger.log("✅ Clicked action button (Try again / I've Confirmed)");
      return clicked;
    } catch (e) {
      this.logger.warn("Could not find/click action button:", e);
      return false;
    }
  }

  /**
   * Click "Try another way" when Google challenge supports alternate methods.
   */
  private async tryClickTryAnotherWay(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const targets = ["try another way", "another way", "choose another option"];
        const all = Array.from(document.querySelectorAll("button, [role='button'], a, span, div"));
        for (const el of all) {
          const text = (el.textContent || "").trim().toLowerCase();
          if (!text) continue;
          if (targets.some((t) => text === t || text.includes(t))) {
            const clickable =
              (el as HTMLElement).closest?.("button, [role='button'], a") || el;
            (clickable as HTMLElement).click?.();
            return true;
          }
        }
        return false;
      });
      if (clicked) this.logger.log("✅ Clicked 'Try another way' on Google challenge");
      return !!clicked;
    } catch {
      return false;
    }
  }

  /**
   * Click the "Get a verification code" option on Google's "choose how you want to sign in"
   * screen (when alternate verification method is requested).
   */
  private async tryClickGetVerificationCode(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const isVisible = (el: HTMLElement) => {
          const rects = el.getClientRects();
          if (!rects || rects.length === 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return true;
          if (style.display === "none") return false;
          if (style.visibility === "hidden") return false;
          if (style.opacity === "0") return false;
          return true;
        };

        const bodyText = norm(document.body?.innerText || "");
        if (!bodyText.includes("choose how you want to sign in")) {
          // Avoid clicking random "verification code" text on non-selection pages.
          return false;
        }

        // Prefer clicking the actual option row that contains BOTH:
        // - "Get a verification code"
        // - "Recovery phone"
        // This matches the UI you screenshotted.
        const optionCandidates = Array.from(
          document.querySelectorAll("div[role='link'], div[role='button'], button, [role='button'], a"),
        ).filter((el) => isVisible(el as HTMLElement));

        const pickBest = () => {
          let best: HTMLElement | null = null;
          for (const el of optionCandidates) {
            const t = norm((el as HTMLElement).innerText || (el as HTMLElement).textContent || "");
            if (!t) continue;
            if (t.includes("get a verification code") && t.includes("recovery phone")) {
              best = el as HTMLElement;
              break;
            }
          }
          if (best) return best;

          // Fallback: any visible element mentioning "get a verification code"
          for (const el of optionCandidates) {
            const t = norm((el as HTMLElement).innerText || (el as HTMLElement).textContent || "");
            if (t.includes("get a verification code")) return el as HTMLElement;
          }
          return null;
        };

        const target = pickBest();
        if (!target) return false;

        // Ensure we click a clickable ancestor if text is nested.
        const clickable =
          target.closest?.("div[role='link'], div[role='button'], button, [role='button'], a") || target;
        (clickable as HTMLElement).click?.();
        return true;
      });

      if (clicked) this.logger.log("✅ Clicked 'Get a verification code' on Google challenge");
      return !!clicked;
    } catch {
      return false;
    }
  }

  /**
   * DOM-based detection for Google "enter verification code" screen.
   * We detect OTP/code inputs (one-time-code / numeric / tel + visible).
   */
  private async detectGoogleCodeEntryFromDom(page: any): Promise<{
    isCodeEntry: boolean;
    visibleCodeInputCount: number;
  }> {
    try {
      const detectInDocument = () => {
        const isVisible = (el: HTMLElement) => {
          const rects = el.getClientRects();
          if (!rects || rects.length === 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return true;
          if (style.display === "none") return false;
          if (style.visibility === "hidden") return false;
          if (style.opacity === "0") return false;
          return true;
        };

        const lowerBody = (document.body?.innerText || "").toLowerCase();

        const candidates = Array.from(document.querySelectorAll("input")).filter((el) => {
          const input = el as HTMLInputElement;
          if (!isVisible(input)) return false;

          const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
          const type = (input.getAttribute("type") || "").toLowerCase();
          const inputMode = (input.getAttribute("inputmode") || "").toLowerCase();
          const name = (input.getAttribute("name") || "").toLowerCase();
          const id = (input.id || "").toLowerCase();
          const aria = (input.getAttribute("aria-label") || "").toLowerCase();
          const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();

          const looksOtp =
            autocomplete.includes("one-time-code") ||
            type === "tel" ||
            inputMode === "numeric" ||
            name.includes("code") ||
            id.includes("code") ||
            aria.includes("code") ||
            placeholder.includes("code");

          const isLikelyCodeContext =
            lowerBody.includes("verification code") ||
            lowerBody.includes("one-time code") ||
            lowerBody.includes("recovery phone") ||
            (lowerBody.includes("enter") && lowerBody.includes("code"));

          return looksOtp && isLikelyCodeContext;
        });

        return {
          visibleCodeInputCount: candidates.length,
        };
      };

      // 1) Main document first
      const main = await page.evaluate(detectInDocument).catch(() => ({ visibleCodeInputCount: 0 }));
      if (main?.visibleCodeInputCount > 0) {
        return { isCodeEntry: true, visibleCodeInputCount: Number(main.visibleCodeInputCount || 0) };
      }

      // 2) Then scan iframes (Google often hosts verification UI inside an iframe)
      const frames = typeof page.frames === "function" ? page.frames() : [];
      for (const frame of frames) {
        // Heuristic: only check frames that look like Google sign-in/challenge
        try {
          const frameUrl = frame.url?.() || "";
          if (!/accounts\.google\.com|signin|challenge|g4b/i.test(frameUrl)) continue;
        } catch {
          // ignore
        }

        const inFrame = await frame.evaluate(detectInDocument).catch(() => ({ visibleCodeInputCount: 0 }));
        if (inFrame?.visibleCodeInputCount > 0) {
          return { isCodeEntry: true, visibleCodeInputCount: Number(inFrame.visibleCodeInputCount || 0) };
        }
      }

      return { isCodeEntry: false, visibleCodeInputCount: 0 };
    } catch {
      return { isCodeEntry: false, visibleCodeInputCount: 0 };
    }
  }

  /**
   * Headless-compatible: fill the Google verification code inside Google (including iframes)
   * and try to click "Verify"/"Next".
   */
  private async tryFillGoogleCodeAndSubmit(page: any, code: string): Promise<boolean> {
    const cleaned = (code || "").replace(/\D/g, "");
    if (!cleaned) return false;

    const tryInFrame = async (frame: any): Promise<boolean> => {
      try {
        return await frame.evaluate((codeInner: string) => {
          try {
            const isVisible = (el: HTMLElement) => {
              const rects = el.getClientRects();
              if (!rects || rects.length === 0) return false;
              const style = window.getComputedStyle(el);
              if (!style) return true;
              if (style.display === "none") return false;
              if (style.visibility === "hidden") return false;
              if (style.opacity === "0") return false;
              return true;
            };

            const digits = (codeInner || "").replace(/\D/g, "");
            if (!digits) return false;

            const inputs = Array.from(document.querySelectorAll("input")).filter((el) => {
              const input = el as HTMLInputElement;
              if (!isVisible(input)) return false;

              const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
              const type = (input.getAttribute("type") || "").toLowerCase();
              const inputMode = (input.getAttribute("inputmode") || "").toLowerCase();
              const name = (input.getAttribute("name") || "").toLowerCase();
              const id = (input.id || "").toLowerCase();
              const aria = (input.getAttribute("aria-label") || "").toLowerCase();
              const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();

              const looksOtp =
                autocomplete.includes("one-time-code") ||
                type === "tel" ||
                inputMode.includes("numeric") ||
                name.includes("code") ||
                id.includes("code") ||
                aria.includes("code") ||
                placeholder.includes("code");

              return looksOtp;
            });

            if (!inputs.length) return false;

            const setInputValue = (input: HTMLInputElement, val: string) => {
              input.focus();
              input.value = "";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.value = val;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            };

            const allSingleDigit = inputs.every((i) => {
              const inp = i as HTMLInputElement;
              const ml = inp.maxLength || parseInt(inp.getAttribute("maxlength") || "0", 10) || 0;
              return ml === 1;
            });

            if (allSingleDigit && inputs.length >= 2) {
              const chars = digits.split("");
              for (let i = 0; i < inputs.length; i++) {
                const ch = chars[i] || "";
                setInputValue(inputs[i] as HTMLInputElement, ch);
              }
            } else {
              setInputValue(inputs[0] as HTMLInputElement, digits);
            }

            const buttons = Array.from(
              document.querySelectorAll("button, [role='button'], input[type='submit']"),
            ).filter((el) => isVisible(el as HTMLElement));

            const normText = (t: string) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();

            const clickBtn = buttons.find((el) => {
              const text =
                (el as HTMLElement).getAttribute("aria-label") ||
                (el as HTMLElement).textContent ||
                (el as HTMLInputElement).value ||
                "";
              const n = normText(text);
              return n.includes("verify") || n.includes("next") || n.includes("done") || n.includes("continue");
            }) as HTMLElement | undefined;

            if (clickBtn?.click) {
              clickBtn.click();
              return true;
            }

            // Fallback: press Enter on the first input
            const first = inputs[0] as HTMLInputElement;
            first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            return true;
          } catch {
            return false;
          }
        }, cleaned);
      } catch {
        return false;
      }
    };

    // 1) Try main document first
    if (await tryInFrame(page)) return true;

    // 2) Then scan iframes (Google verification UI is often hosted in an iframe)
    const frames = typeof page.frames === "function" ? page.frames() : [];
    for (const frame of frames) {
      try {
        const frameUrl = frame.url?.() || "";
        if (frameUrl && !/accounts\.google\.com|signin|challenge|google/i.test(frameUrl)) continue;
      } catch {
        // ignore frameUrl errors
      }

      if (await tryInFrame(frame)) return true;
    }

    return false;
  }

  /**
   * Detect challenges in GPay/Google RPC responses
   */
  detectAndExtractChallenges(responseData: any) {
    if (!responseData || !Array.isArray(responseData)) return null;

    // Look for B4hajb or oHUEyd patterns
    const b4hajbResult = responseData.find(
      (item: any) => item[0] === "wrb.fr" && item[1] === "B4hajb",
    );

    if (b4hajbResult && b4hajbResult[2]) {
      try {
        const inner = JSON.parse(b4hajbResult[2]);
        // Looking for "LOGIN_CHALLENGE" or "TWO_STEP_VERIFICATION"
        const status = inner?.[0]?.[2];

        if (status === "LOGIN_CHALLENGE") {
          // Check for key 1037 (Device Prompt number)
          const challengePayload = inner?.[0]?.[29]; // Index 29 usually holds extra info
          const data1037 = challengePayload?.["1037"];

          if (data1037 && data1037[4]) {
            return {
              type: "GOOGLE_PROMPT",
              promptNumber: data1037[4], // e.g., 43
              devices: data1037[5]?.[0] || [], // List of devices notified
              message: "Check your phone for the verification number.",
            };
          }
        }
      } catch (e) {
        this.logger.error("Error parsing B4hajb challenge", e);
      }
    }

    // Look for reCAPTCHA markers: "recaptcha" or specific error codes
    const responseStr = JSON.stringify(responseData).toLowerCase();
    if (responseStr.includes("recaptcha") || responseStr.includes("robot")) {
      return {
        type: "RECAPTCHA",
        message: "Google requires you to solve a CAPTCHA. Please solve it in the GPay app or try again.",
      };
    }

    return null;
  }

  /**
   * Update GPay UPI ID - finds the GPay connection by org + email and updates accountIdentifier.
   */
  async updateGpayUpi(data: {
    organizationId: string;
    upiId: string;
    email?: string;
  }) {
    try {
      this.logger.log(
        `📝 Updating GPay UPI for org: ${data.organizationId}, upiId: ${data.upiId}`,
      );

      if (!data.organizationId || !data.upiId?.trim()) {
        throw new BadRequestException(
          "Organization ID and UPI ID are required",
        );
      }

      const upiRegex =
        /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{2,64}$/;
      if (!upiRegex.test(data.upiId.trim())) {
        throw new BadRequestException(
          "Invalid UPI ID format (e.g., yourname@gpay)",
        );
      }

      // Find GPay row: accountIdentifier may be Gmail (first connect) or VPA (after update / reconnect).
      // Do not require accountIdentifier === email or the lookup fails after we persist UPI as identifier.
      const emailNorm = data.email?.trim().toLowerCase();
      const upiNorm = data.upiId.trim().toLowerCase();

      const candidates = await this.prisma.merchantProvider.findMany({
        where: {
          merchant: {
            organizationId: data.organizationId,
            deletedAt: null,
          },
          providerType: ProviderType.GPAY,
        },
        orderBy: { updatedAt: "desc" },
      });

      let provider = null as (typeof candidates)[0] | null;
      if (emailNorm) {
        provider =
          candidates.find((p) => {
            const acct = (p.accountIdentifier || "").toLowerCase();
            const cred = (p.credentials as { email?: string } | null)?.email;
            const credStr =
              typeof cred === "string" ? cred.toLowerCase() : "";
            return acct === emailNorm || credStr === emailNorm;
          }) ?? null;
      }
      if (!provider) {
        provider =
          candidates.find(
            (p) => (p.accountIdentifier || "").toLowerCase() === upiNorm,
          ) ?? null;
      }
      if (!provider && candidates.length === 1) {
        provider = candidates[0];
      }

      if (!provider) {
        throw new BadRequestException(
          "No GPay connection found for this organization. Please connect GPay first.",
        );
      }

      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: { accountIdentifier: data.upiId.trim() },
      });

      const merchantWithConfig = await this.prisma.merchant.findUnique({
        where: { id: provider.merchantId },
        include: { config: true },
      });
      const requiresConfiguration = !merchantWithConfig?.verified || !merchantWithConfig?.config;

      this.logger.log(`✅ GPay UPI updated: ${provider.id} -> ${data.upiId}`);
      return {
        success: true,
        merchantId: provider.merchantId,
        requiresConfiguration,
        message: "GPay UPI ID saved successfully",
      };
    } catch (error: any) {
      this.logger.error(`❌ Failed to update GPay UPI:`, error);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        error?.message || "Failed to update GPay UPI",
      );
    }
  }

  private async findOrCreateMerchant(
    merchantId: string,
    organizationId: string,
    name: string,
    isSuperAdmin: boolean = false,
  ) {
    // When onboarding with temp- merchantId: always create NEW merchant (don't attach to existing PhonePe/etc)
    const isNewOnboarding = merchantId.startsWith("temp-") || !merchantId;
    if (isNewOnboarding) {
      const id = `gpay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      return this.prisma.merchant.create({
        data: {
          id,
          organizationId,
          name,
          isActive: true,
          isPlatform: isSuperAdmin,
        },
      });
    }

    // When connecting to existing merchant (real merchantId): find or create that one
    // Look up regardless of deletedAt to allow restoration
    let merchant = await this.prisma.merchant.findFirst({
      where: { id: merchantId, organizationId } as any,
    });

    if (merchant && merchant.deletedAt) {
      this.logger.log(`♻️ Restoring soft-deleted merchant: ${merchant.id}`);
      merchant = await this.prisma.merchant.update({
        where: { id: merchant.id },
        data: { deletedAt: null, isActive: true } as any,
      });
    }
    if (!merchant) {
      merchant = await this.prisma.merchant.create({
        data: {
          id: merchantId,
          organizationId,
          name,
          isActive: true,
          isPlatform: isSuperAdmin,
        },
      });
    }
    return merchant;
  }

  // ─── Persistent Browser Session Management ───────────────────────────────

  private async optimizePage(page: any) {
    await page.route("**/*", (route: any) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort();
        return;
      }

      const url = route.request().url();
      if (
        url.includes("play.google.com/log") ||
        url.includes("google.com/pagead/") ||
        url.includes("googleadservices.com") ||
        url.includes("doubleclick.net") ||
        url.includes("google-analytics.com") ||
        url.includes("googletagmanager.com")
      ) {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  /** Merge latest Playwright storage into credentials.sessionState (DB). */
  private async persistGpaySessionStateToDb(
    providerId: string,
    context: any,
  ): Promise<boolean> {
    if (!context || typeof context.storageState !== "function") {
      return false;
    }
    const state = await context.storageState();
    const provider = await this.prisma.merchantProvider.findUnique({
      where: { id: providerId },
    });
    if (!provider) return false;
    const credentials = (provider.credentials as any) || {};
    await this.prisma.merchantProvider.update({
      where: { id: providerId },
      data: {
        credentials: {
          ...credentials,
          sessionState: state,
        },
      },
    });
    return true;
  }

  private async storeActiveSession(
    providerId: string,
    session: { browser: any; context: any; page: any; businessId: string; email: string; organizationId: string }
  ) {
    // Clean up any existing session for this provider
    const existing = this.activeSessions.get(providerId);
    if (existing) {
      existing.browser.close().catch(() => { });
    }

    this.activeSessions.set(providerId, {
      ...session,
      connectedAt: new Date(),
      lastAccessedAt: new Date(),
    });

    // Capture Playwright storage state (cookies + localStorage) for persistence
    try {
      const state = await session.context.storageState();

      // Persist to database so it survives server restarts
      const provider = await this.prisma.merchantProvider.findUnique({ where: { id: providerId } });
      const credentials = (provider?.credentials as any) || {};

      await this.prisma.merchantProvider.update({
        where: { id: providerId },
        data: {
          status: 'ACTIVE',
          credentials: {
            ...credentials,
            sessionState: state,
            businessId: session.businessId,
            email: session.email,
          }
        },
      });
      this.logger.log(`💾 Persisted GPay session state to DB for provider ${providerId}`);
    } catch (e) {
      this.logger.warn(`⚠️ Failed to persist GPay session state to DB: ${e?.message}`);
    }

    this.logger.log(`🟢 Persistent GPay session stored for provider ${providerId} (${session.email}) — browser kept alive`);
    this.logger.log(`📊 Active GPay sessions: ${this.activeSessions.size}`);

    // Start real-time listener (navigates once and stays there)
    this.setupRealtimeListener(providerId, session.businessId).catch(err => {
      this.logger.error(`❌ Failed to setup real-time listener for ${providerId}: ${err.message}`);
    });
  }

  /**
   * Attempt to restore a persistent browser session from stored state in the database.
   * Returns true if restored successfully, false otherwise.
   */
  private async restoreSession(providerId: string): Promise<boolean> {
    if (this.restoringProviders.has(providerId)) return false;
    this.restoringProviders.add(providerId);

    try {
      this.logger.log(`🔄 Attempting to restore GPay session for provider ${providerId}...`);

      const provider = await this.prisma.merchantProvider.findUnique({
        where: { id: providerId },
        include: { merchant: true }
      });

      if (!provider || !provider.isActive) {
        this.logger.warn(`Cannot restore session: Provider ${providerId} not found or inactive`);
        return false;
      }

      const credentials = provider.credentials as any;
      const sessionState = credentials?.sessionState;
      const businessId = credentials?.businessId;
      const email = credentials?.email;

      if (!businessId || !email) {
        this.logger.warn(`No businessId/email found for provider ${providerId}`);
        return false;
      }

      const browserType = process.env.GPAY_BROWSER || "chromium";
      const launchOpts = this.getLaunchOptions(email);

      // Prefer restoring via stable persistent profile on disk.
      // This typically survives restarts better than replaying storageState.
      if (browserType === "chromium") {
        const userDataDir = this.getStableUserDataDir(email);
        let context: any = null;
        let ownedByActiveSessions = false;
        
        let launchAttempts = 0;
        while (launchAttempts < 3) {
          try {
            this.clearSingletonLock(userDataDir);
            context = await chromium.launchPersistentContext(userDataDir, {
              ...launchOpts,
              viewport: { width: 1920, height: 1080 },
              locale: "en-IN",
              timezoneId: "Asia/Kolkata",
            });
            break;
          } catch (e: any) {
            const msg = String(e?.message || "").toLowerCase();
            if (msg.includes("singletonlock") || msg.includes("processsingleton") || msg.includes("target page, context or browser has been closed")) {
              launchAttempts++;
              if (launchAttempts >= 3) {
                this.logger.warn(`⚠️ GPay profile persistently locked for restore ${email}`);
                throw e;
              }
              this.logger.warn(`⚠️ GPay profile locked for restore ${email}. Retrying in 1s...`);
              await new Promise(r => setTimeout(r, 1000));
            } else {
              throw e;
            }
          }
        }

        try {
          const browser = context.browser();
          const page = await context.newPage();
          await this.optimizePage(page);

          const transactionsUrl = `https://pay.google.com/g4b/transactions/${businessId}`;
          this.logger.log(`📍 Verifying restored session at: ${transactionsUrl}`);
          await page.goto(transactionsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await new Promise((r) => setTimeout(r, 2000));

          const currentUrl = page.url();
          if (!currentUrl.includes("pay.google.com/g4b")) {
            this.logger.warn(
              `⚠️ GPay restoration for ${providerId} redirected to login (${currentUrl}) — session likely requires manual re-auth`,
            );
            await browser?.close?.().catch(() => { });
          } else {
            this.logger.log(
              `✅ Session restored successfully for provider ${providerId} via persistent profile. Setting status ACTIVE.`,
            );
            await this.prisma.merchantProvider
              .update({ where: { id: providerId }, data: { status: "ACTIVE" } })
              .catch(() => { });

            this.activeSessions.set(providerId, {
              browser,
              context,
              page,
              businessId,
              email,
              organizationId: provider.merchant.organizationId,
              connectedAt: new Date(),
              lastAccessedAt: new Date(),
            });
            ownedByActiveSessions = true;

            await this.persistGpaySessionStateToDb(providerId, context).catch((e: any) =>
              this.logger.warn(
                `Could not persist GPay sessionState after profile restore ${providerId}: ${e?.message}`,
              ),
            );

            this.setupRealtimeListener(providerId, businessId).catch(() => { });
            return true;
          }
        } catch (e: any) {
          this.logger.warn(
            `⚠️ Persistent-profile restore failed for ${providerId}: ${e?.message || String(e)}`,
          );
        } finally {
          if (!ownedByActiveSessions && context) {
            const startTime = (context as any)._startTime || Date.now();
            try {
              await context.close();
              this.logger.log(`Browser Closed | reason: persistent restore finally | lifetime: ${Date.now() - startTime}ms`);
            } catch (_) {}
          }
        }
      }

      // Fallback: restore using stored storageState (works sometimes, less reliable)
      if (!sessionState) {
        this.logger.warn(`No sessionState found for provider ${providerId} (cannot fallback restore)`);
        return false;
      }

      let browser: any = null;
      let context: any = null;
      let ownedByActiveSessions = false;
      try {
        const launcher = browserType === "chromium" ? chromium : firefox;
        browser = await launcher.launch(launchOpts);

        context = await browser.newContext({
          storageState: sessionState,
          viewport: { width: 1920, height: 1080 },
          locale: "en-US",
          userAgent:
            browserType === "firefox"
              ? undefined
              : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        });

        const page = await context.newPage();
      await this.optimizePage(page);

      // Verify if session is still valid by visiting the transactions page
      const transactionsUrl = `https://pay.google.com/g4b/transactions/${businessId}`;
      this.logger.log(`📍 Verifying restored session at: ${transactionsUrl}`);

      await page.goto(transactionsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000)); // Allow SPA to settle

      const currentUrl = page.url();
      if (!currentUrl.includes('pay.google.com/g4b')) {
        this.logger.warn(`⚠️ GPay restoration for ${providerId} redirected to login (${currentUrl}) — session likely requires manual re-auth or headed browser`);
        await browser.close().catch(() => { });
        return false;
      }

      this.logger.log(`✅ Session restored successfully for provider ${providerId}! Explicitly setting status to ACTIVE.`);

      // Ensure DB status is ACTIVE upon successful restoration
      await this.prisma.merchantProvider.update({
        where: { id: providerId },
        data: { status: 'ACTIVE' }
      }).catch(() => { });

      // Store in memory and setup listener
      this.activeSessions.set(providerId, {
        browser,
        context,
        page,
        businessId,
        email,
        organizationId: provider.merchant.organizationId,
        connectedAt: new Date(),
        lastAccessedAt: new Date()
      });
      ownedByActiveSessions = true;

      await this.persistGpaySessionStateToDb(providerId, context).catch((e: any) =>
        this.logger.warn(
          `Could not persist GPay sessionState after storageState restore ${providerId}: ${e?.message}`,
        ),
      );

      this.setupRealtimeListener(providerId, businessId).catch(() => { });
      return true;
    } catch (e: any) {
      this.logger.warn(`⚠️ Fallback restore failed for ${providerId}: ${e?.message || String(e)}`);
      return false;
    } finally {
      if (!ownedByActiveSessions && browser) {
        const startTime = (browser as any)._startTime || Date.now();
        try {
          await browser.close();
          this.logger.log(`Browser Closed | reason: fallback restore finally | lifetime: ${Date.now() - startTime}ms`);
        } catch (_) {}
      }
    }

    } catch (error) {
      this.logger.error(`❌ Failed to restore GPay session for ${providerId}:`, error);
      return false;
    } finally {
      this.restoringProviders.delete(providerId);
    }
  }

  /**
   * Get the live browser page for a provider (for making authenticated API calls).
   * Returns null if no active session exists.
   */
  getActiveSession(providerId: string) {
    return this.activeSessions.get(providerId) || null;
  }

  /**
   * Check if a provider has an active browser session.
   */
  hasActiveSession(providerId: string): boolean {
    return this.activeSessions.has(providerId);
  }

  /**
   * Clean up a specific provider's browser session.
   */
  async cleanupSession(providerId: string) {
    const session = this.activeSessions.get(providerId);
    if (session) {
      this.logger.log(`🔴 Closing persistent GPay session for provider ${providerId}`);
      await session.browser.close().catch(() => { });
      this.activeSessions.delete(providerId);
    }
    this.realtimeListenerProviders.delete(providerId);
  }

  /**
   * Clean up ALL active browser sessions (e.g., on server shutdown).
   */
  async cleanupAllSessions() {
    this.logger.log(`🔴 Cleaning up ${this.activeSessions.size} active GPay sessions...`);
    for (const [id, session] of this.activeSessions) {
      await session.browser.close().catch(() => { });
      this.activeSessions.delete(id);
    }
    this.realtimeListenerProviders.clear();
  }

  // ─── Real-time Listener Logic ───────────────────────────────────────────

  private async setupRealtimeListener(providerId: string, businessId: string) {
    const session = this.activeSessions.get(providerId);
    if (!session) return;

    if (this.realtimeListenerProviders.has(providerId)) return;
    this.realtimeListenerProviders.add(providerId);

    this.recentGPayPayments.set(providerId, []);

    const transactionsUrl = `https://pay.google.com/g4b/transactions/${businessId}`;

    try {
      this.logger.log(`📡 Setting up real-time GPay listener for provider ${providerId}...`);

      // Monitor navigations (detect redirects to login/error pages)
      session.page.on('framenavigated', (frame: any) => {
        const url = frame.url();
        if (frame === session.page.mainFrame() && !url.includes(businessId)) {
          this.logger.warn(`⚠️ GPay browser navigated away from transactions: ${url} (Provider: ${providerId})`);
          if (url.includes('accounts.google.com') || url.includes('ServiceLogin')) {
            this.logger.error(`🚫 GPay SESSION EXPIRED (Redirected to login) for provider ${providerId}`);
          }
        }
      });

      this.logger.log(`👂 Real-time GPay listener attached before navigation for provider ${providerId}`);

      session.page.on('response', async (response: any) => {
        try {
          const url = response.url();
          if (!url.includes('batchexecute')) return;

          const status = response.status();
          if (status !== 200) {
            this.logger.warn(`⚠️ GPay batchexecute non-200 response: ${status} for ${providerId}`);
          }

          const text = await response.text().catch(() => '');
          if (!text) return;

          const cleaned = text.replace(/^\)\]\}'\n/, '');
          const lines = cleaned.split(/\r?\n/);

          for (const line of lines) {
            if (!line.trim().startsWith('[')) continue;
            try {
              const parsed = JSON.parse(line.trim());
              for (const item of parsed) {
                if (!Array.isArray(item) || !item[2]) continue;
                const rpcId = item[1];

                // RPtkab = full transaction list on page load
                if (rpcId === 'RPtkab') {
                  const innerData = JSON.parse(item[2]);
                  const txnList = this.findRealTxnList(innerData);
                  if (txnList?.length) {
                    this.logger.log(`📋 RPtkab: ${txnList.length} transactions loaded for ${providerId}`);
                    const buffer = this.recentGPayPayments.get(providerId) || [];
                    // Merge — update existing entries (e.g. yuZqtb push without note) with RPtkab data (which has note)
                    for (const txn of txnList) {
                      const parsedTxn = this.parseTxnRecord(txn);
                      const existingIdx = buffer.findIndex((t: any) => t.txnId === parsedTxn.txnId);
                      if (existingIdx >= 0) {
                        // UPDATE existing entry with RPtkab data (which has note, full customer info, etc.)
                        buffer[existingIdx] = { ...buffer[existingIdx], ...parsedTxn };
                      } else {
                        buffer.push(parsedTxn);
                      }
                    }
                    this.recentGPayPayments.set(providerId, buffer);
                    this.lastRPTkabLoadAt.set(providerId, Date.now());
                  }
                }

                // yuZqtb = real-time single payment push from Google
                if (rpcId === 'yuZqtb') {
                  const txn = JSON.parse(item[2]);
                  this.logger.log(`[GPay Raw yuZqtb Debug] Raw payload: ${JSON.stringify(txn)}`);
                  // yuZqtb flat: [txnId, utr, [ts, nanos], [currency, amount], customerName, vpa, ...]
                  const txnId = String(txn[0]);
                  const buffer = this.recentGPayPayments.get(providerId) || [];
                  if (!buffer.find((t: any) => t.txnId === txnId)) {
                    const amount = Array.isArray(txn[3]) ? Number(txn[3][1]) : 0;
                    const utr = txn[1] ? String(txn[1]) : null;

                    buffer.push({
                      txnId,
                      utr,
                      timestamp: Array.isArray(txn[2])
                        ? new Date(txn[2][0] * 1000 + Math.floor((txn[2][1] || 0) / 1_000_000))
                        : new Date(),
                      amount,
                      customerName: typeof txn[4] === 'string' ? txn[4] : null,
                      customerVpa: typeof txn[5] === 'string' ? txn[5] : null,
                      status: 'COMPLETED',
                      note: typeof txn[9] === 'string' ? txn[9] : null,
                    });
                    this.logger.log(`🔔 Real-time GPay payment: ₹${amount} UTR: ${utr} (Provider: ${providerId})`);
                    const orderCron = this.getOrderStatusCronSafe();
                    if (orderCron) {
                      void orderCron
                        .tryMatchPendingOrdersForGpayProvider(providerId)
                        .catch((e: any) =>
                          this.logger.warn(
                            `GPay immediate order match failed: ${e?.message || e}`,
                          ),
                        );
                    }
                  }
                  this.recentGPayPayments.set(providerId, buffer);
                }
              }
            } catch { }
          }
        } catch { }
      });

      await session.page
        .goto(transactionsUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45000, // Extended timeout for first load
        })
        .catch(async (e: any) => {
          const msg = String(e?.message || "");
          this.logger.warn(`Initial nav warning for ${providerId}: ${msg}`);
          if (msg.includes("net::ERR_ABORTED")) {
            await new Promise((r) => setTimeout(r, 1200));
            await session.page
              .goto(transactionsUrl, { waitUntil: "domcontentloaded", timeout: 45000 })
              .catch((e2: any) =>
                this.logger.warn(`Initial nav retry warning for ${providerId}: ${e2?.message}`),
              );
          }
        });
    } catch (err: any) {
      this.logger.error(`❌ Global error in GPay listener for ${providerId}: ${err.message}`);
      this.realtimeListenerProviders.delete(providerId);
    }
  }

  private async ensureActiveSession(providerId: string) {
    let session = this.activeSessions.get(providerId) || null;
    if (!session) return null;

    try {
      if (typeof session.page?.isClosed === "function" && session.page.isClosed()) {
        this.logger.warn(
          `⚠️ Stale GPay page detected (closed) for provider ${providerId}. Attempting restore...`,
        );
        await this.cleanupSession(providerId);
        const restored = await this.restoreSession(providerId);
        return restored ? (this.activeSessions.get(providerId) || null) : null;
      }
    } catch {
      // ignore
    }

    try {
      session.page?.url?.();
    } catch {
      this.logger.warn(
        `⚠️ Stale GPay session detected (url() failed) for provider ${providerId}. Attempting restore...`,
      );
      await this.cleanupSession(providerId);
      const restored = await this.restoreSession(providerId);
      return restored ? (this.activeSessions.get(providerId) || null) : null;
    }

    session.lastAccessedAt = new Date();
    return session;
  }

  private parseTxnRecord(record: any) {
    const r = Array.isArray(record[0]) && record[0].length > 3 ? record[0] : record;
    
    // Debug logging to inspect the actual array structure coming from Google Pay
    console.log(`[GPay Raw RPtkab Debug] Record array: ${JSON.stringify(r)}`);
    
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

  private findRealTxnList(data: any, depth = 0): any[] | null {
    if (depth > 6 || !data) return null;
    if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0]) &&
      typeof data[0][0] === 'string' && data[0].length >= 5) return data;
    if (Array.isArray(data) && data.length === 1 && Array.isArray(data[0]))
      return this.findRealTxnList(data[0], depth + 1);
    if (Array.isArray(data)) {
      for (const el of data) {
        const found = this.findRealTxnList(el, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  private async autoHealInvalidTransactionsUrl(
    providerId: string,
    session: any,
    fallbackBusinessId?: string,
  ): Promise<boolean> {
    try {
      const page = session?.page;
      if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
        return false;
      }

      const currentUrl = String(page.url?.() || "");
      const isMissingBusinessIdTxnUrl =
        /^https:\/\/pay\.google\.com\/g4b\/transactions\/?(?:[?#].*)?$/i.test(currentUrl);
      if (!isMissingBusinessIdTxnUrl) return false;

      let businessId = session?.businessId || fallbackBusinessId;
      if (!businessId) {
        // Try DB credentials first when caller couldn't provide fallback.
        const provider = await this.prisma.merchantProvider
          .findUnique({ where: { id: providerId }, select: { credentials: true } })
          .catch(() => null);
        const creds = (provider?.credentials as any) || {};
        businessId = creds?.businessId || "";
      }

      if (!businessId) {
        // Last-resort discovery: open transactions root and extract businessId from redirected URL.
        try {
          await page.goto("https://pay.google.com/g4b/transactions", {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          const discoveredUrl = String(page.url?.() || "");
          const match = discoveredUrl.match(/\/(?:activity|transactions)\/([^/?#]+)/i);
          if (match?.[1]) {
            businessId = match[1];
            this.logger.log(
              `🔎 [DIAGNOSTIC] GPay discovered missing businessId for ${providerId}: ${businessId}`,
            );
          }
        } catch {
          // Ignore discovery navigation failure and continue to warning below.
        }
      }

      if (!businessId) {
        this.logger.warn(
          `⚠️ GPay URL heal skipped for ${providerId}: transactions URL missing businessId and no fallback id available`,
        );
        return false;
      }

      const healedUrl = `https://pay.google.com/g4b/transactions/${businessId}`;
      this.logger.warn(
        `🩹 [DIAGNOSTIC] GPay invalid transactions URL detected for ${providerId} (${currentUrl}). Healing to ${healedUrl}`,
      );
      await page.goto(healedUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Attach discovered businessId for current in-memory session and DB restores.
      if (!session?.businessId || session.businessId !== businessId) {
        session.businessId = businessId;
        try {
          const provider = await this.prisma.merchantProvider.findUnique({
            where: { id: providerId },
            select: { credentials: true },
          });
          const credentials = (provider?.credentials as any) || {};
          await this.prisma.merchantProvider.update({
            where: { id: providerId },
            data: {
              credentials: {
                ...credentials,
                businessId,
              },
            },
          });
        } catch (e: any) {
          this.logger.warn(
            `⚠️ Could not persist discovered businessId for ${providerId}: ${e?.message || e}`,
          );
        }
      }

      return true;
    } catch (err: any) {
      this.logger.warn(
        `⚠️ GPay URL heal failed for ${providerId}: ${err?.message || err}`,
      );
      return false;
    }
  }

  async forceDashboardRefresh(providerId: string): Promise<boolean> {
    try {
      const session = this.activeSessions.get(providerId);
      if (!session) {
        this.logger.warn(`Cannot force refresh: No active session for provider ${providerId}`);
        return false;
      }
      this.logger.log(`🔄 [DIAGNOSTIC] Forcing GPay dashboard refresh for ${providerId} to fetch missing notes...`);
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
      // Clear the last load time so syncTransactions also knows it reloaded
      this.lastRPTkabLoadAt.delete(providerId);
      await new Promise((r) => setTimeout(r, 2500)); // allow RPtkab to fire and populate buffer
      return true;
    } catch (e: any) {
      this.logger.warn(`⚠️ Failed to force GPay dashboard refresh for ${providerId}: ${e?.message}`);
      return false;
    }
  }

  async syncTransactions(
    provider: any,
    fromDate: Date,
    toDate: Date,
    page: number = 1,
    pageSize: number = 50,
  ) {
    if (this.syncingProviders.has(provider.id)) {
      this.logger.warn(`⏭️ GPay sync already in progress for provider ${provider.id}, skipping`);
      return { success: true, fetched: 0, transactions: [], message: 'Sync already in progress' };
    }

    this.syncingProviders.add(provider.id);

    try {
      let session = await this.ensureActiveSession(provider.id);

      // Auto-restore if session is missing from memory but might exist in DB
      if (!session) {
        const restored = await this.restoreSession(provider.id);
        if (restored) {
          session = await this.ensureActiveSession(provider.id);
        }
      }

      if (!session) {
        this.logger.warn(`⚠️ No active GPay session for ${provider.id} — returning empty (session lives in browser memory)`);
        return { success: true, fetched: 0, transactions: [], message: 'No active browser session' };
      }

      // Session heartbeat log (Critical for verification)
      let currentUrl = "";
      try {
        currentUrl = session.page.url();
      } catch {
        const healed = await this.ensureActiveSession(provider.id);
        if (!healed) {
          this.logger.warn(`⚠️ GPay session became invalid for ${provider.id} (url failed) — returning empty`);
          return { success: true, fetched: 0, transactions: [], message: 'No active browser session' };
        }
        session = healed;
        currentUrl = session.page.url();
      }
      this.logger.log(`💓 [DIAGNOSTIC] GPay sync heartbeat for ${provider.id}. Browser status: ${provider.status}, URL: ${currentUrl}`);

      const fallbackBusinessId =
        provider?.connection?.credentials?.businessId ||
        provider?.credentials?.businessId ||
        undefined;
      const healedInvalidTxnUrl = await this.autoHealInvalidTransactionsUrl(
        provider.id,
        session,
        fallbackBusinessId,
      );
      if (healedInvalidTxnUrl) {
        currentUrl = session.page.url();
        this.logger.log(
          `✅ [DIAGNOSTIC] GPay URL healed for ${provider.id}. Current URL: ${currentUrl}`,
        );
      }

      // Self-heal stale DB state: if browser is live on GPay but DB still says EXPIRED,
      // flip it back to ACTIVE so admin UI and validation logic stay consistent.
      if (
        provider.status === "EXPIRED" &&
        typeof currentUrl === "string" &&
        currentUrl.includes("pay.google.com/g4b")
      ) {
        try {
          await this.prisma.merchantProvider.update({
            where: { id: provider.id },
            data: { status: "ACTIVE" },
          });
          provider.status = "ACTIVE";
          this.logger.log(
            `🩹 [DIAGNOSTIC] Restored provider ${provider.id} status from EXPIRED -> ACTIVE (live GPay session detected)`,
          );
        } catch (e: any) {
          this.logger.warn(
            `Could not restore provider ${provider.id} status to ACTIVE: ${e?.message}`,
          );
        }
      }

      const buildFiltered = () => {
        const buffer = this.recentGPayPayments.get(provider.id) || [];
        // Add 5 minutes to toDate to account for Google server clock being slightly ahead of local server clock
        const adjustedToDate = new Date(toDate.getTime() + 5 * 60 * 1000);
        return buffer.filter((t: any) => {
          const ts = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
          return ts >= fromDate && ts <= adjustedToDate && t.status === 'COMPLETED';
        });
      };

      let filtered = buildFiltered();
      const hasSeenRPTkab = this.lastRPTkabLoadAt.has(provider.id);

      if (filtered.length === 0 && !hasSeenRPTkab) {
        // RPtkab (initial list) may arrive a few seconds after restore/listener attach.
        // On cold start (no RPtkab observed yet), wait longer to avoid returning 0 too early.
        const waitAttempts = 15;
        for (let i = 0; i < waitAttempts; i++) {
          await new Promise((r) => setTimeout(r, 900));
          filtered = buildFiltered();
          if (filtered.length > 0) {
            this.logger.log(
              `⏳ [DIAGNOSTIC] GPay buffer populated after wait for provider ${provider.id}: ${filtered.length} txns`,
            );
            break;
          }
        }
      }

      if (filtered.length === 0 && !this.lastRPTkabLoadAt.has(provider.id)) {
        try {
          await session.page.reload({
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });
          await new Promise((r) => setTimeout(r, 2500));
          filtered = buildFiltered();
          if (filtered.length > 0) {
            this.logger.log(
              `🔄 [DIAGNOSTIC] GPay buffer repopulated after forced reload for provider ${provider.id}: ${filtered.length} txns`,
            );
          }
        } catch (e: any) {
          // If Playwright target died, try one self-heal restore and retry reload once.
          if ((e?.message || "").toLowerCase().includes("has been closed")) {
            this.logger.warn(
              `⚠️ GPay reload failed due to closed target for ${provider.id}. Attempting restore and retry...`,
            );
            const healed = await this.ensureActiveSession(provider.id);
            if (healed) {
              session = healed;
              try {
                await session.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
                await new Promise((r) => setTimeout(r, 2500));
                filtered = buildFiltered();
              } catch (e2: any) {
                this.logger.warn(
                  `⚠️ GPay forced reload failed after restore for provider ${provider.id}: ${e2?.message}`,
                );
              }
            }
          }
          this.logger.warn(
            `⚠️ GPay forced reload failed for provider ${provider.id}: ${e?.message}`,
          );
        }
      }

      const adjustedToDateFinal = new Date(toDate.getTime() + 5 * 60 * 1000);
      const finalized = filtered.filter((t: any) => {
        const ts = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
        return ts >= fromDate && ts <= adjustedToDateFinal && t.status === 'COMPLETED';
      });

      this.logger.log(`📦 Returning ${finalized.length} transactions from live buffer for provider ${provider.id}`);

      const transactions = finalized.map((t: any) => {
        const tsSec = Math.floor(t.timestamp.getTime() / 1000);
        const tsNanos = (t.timestamp.getTime() % 1000) * 1_000_000;
        return [
          t.txnId,
          t.utr,
          [tsSec, tsNanos],
          ["INR", t.amount],
          1,
          4, // SUCCESS
          [],
          [tsSec],
          [t.customerName, t.customerVpa],
          t.note || null,
          5
        ];
      });

      return {
        success: true,
        fetched: transactions.length,
        transactions,
        message: `${transactions.length} from live buffer`,
      };
    } finally {
      this.syncingProviders.delete(provider.id);
    }
  }



  private async checkProviderLimit(
    organizationId: string,
    providerCode: string,
  ): Promise<void> {
    try {
      const subscriptionServiceUrl =
        process.env.SUBSCRIPTION_SERVICE_URL;
      const axios = require("axios");
      await axios.get(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/provider-access/${providerCode}`,
      );
    } catch (err: any) {
      if (err?.response?.status === 403) {
        throw new BadRequestException(
          err?.response?.data?.message || "Provider limit reached for your plan",
        );
      }
    }
  }

  private async safeTakeScreenshot(page: any): Promise<string | undefined> {
    try {
      // Screenshot can be slow on Google challenge pages; never block connect-gpay too long.
      const buf = await page.screenshot({
        type: "jpeg",
        quality: 85,
        timeout: 2500,
      });
      return Buffer.from(buf).toString("base64");
    } catch {
      return undefined;
    }
  }
}


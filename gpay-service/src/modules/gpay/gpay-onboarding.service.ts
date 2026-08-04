import {
  Injectable,
  Logger,
  BadRequestException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { PlaywrightSessionManager } from './playwright-session-manager.service';
import { MerchantServiceClient } from '../../clients/merchant-service.client';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';
import { GpayService } from './gpay.service';

/**
 * GpayOnboardingService
 *
 * Handles Playwright browser automation for GPay login/onboarding.
 * Ported from merchant-service. Uses PlaywrightSessionManager for browser lifecycle.
 */
@Injectable()
export class GpayOnboardingService {
  private readonly logger = new Logger(GpayOnboardingService.name);

  constructor(
    private readonly sessionManager: PlaywrightSessionManager,
    private readonly merchantClient: MerchantServiceClient,
    private readonly encryptionService: GpayEncryptionService,
    @Inject(forwardRef(() => GpayService))
    private readonly gpayService: GpayService,
  ) {}

  // Delegate loginSessions to GpayService so state is shared
  private get loginSessions() {
    return this.gpayService.getLoginSessions();
  }

  private getStableProfileBaseDir(): string {
    const home = os.homedir();
    const dir = path.join(home, '.gpay_profiles');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getStableUserDataDir(email: string): string {
    const base = this.getStableProfileBaseDir();
    const norm = (email || '').trim().toLowerCase();
    const hash = createHash('sha256').update(norm).digest('hex').slice(0, 24);
    return path.join(base, hash);
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
      gpayRuntime?: 'LEGACY' | 'NEW';
    },
  ) {
    let browser: any = null;
    const context: any = null;
    const page: any = null;
    let sessionId: string = data.sessionId || '';

    try {
      this.logger.log(
        `🔗 GPay Connect Request for: ${data.email} (session: ${data.sessionId || 'new'})`,
      );

      if (!data.organizationId) {
        throw new BadRequestException('Organization ID is required');
      }

      sessionId =
        data.sessionId ||
        `gpay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      let session = this.loginSessions.get(sessionId);

      if (data.sessionId && !session) {
        throw new BadRequestException(
          'Session expired or not found. Please try again.',
        );
      }

      let context: any;
      let page: any;

      if (!session) {
        const existingProvider =
          await this.merchantClient.getProviderByMerchant(merchantId);

        // If already active in memory, reuse it instead of opening another
        // persistent Chromium profile (prevents SingletonLock conflicts).
        if (
          existingProvider &&
          this.sessionManager.getActiveSession(existingProvider.id)
        ) {
          this.logger.log(
            `✅ Reusing active in-memory GPay session for ${data.email}`,
          );
          return {
            success: true,
            merchantId: existingProvider.merchantId,
            businessId: (existingProvider.credentials as any)?.businessId,
            requiresConfiguration: false,
            status: 'CONNECTED',
            providerId: existingProvider.id,
          };
        }

        if (!data.password) {
          throw new BadRequestException(
            'Password is required for first-time login',
          );
        }

        // Launch via PlaywrightSessionManager (replaces chromium.launchPersistentContext)
        const mockProviderData: any = existingProvider || {
          id: `temp_gpay_${Date.now()}`,
          merchantId,
          provider: 'GPAY',
          status: 'PENDING',
          credentials: { email: data.email, businessId: data.businessId },
          metadata: {
            gpayRuntime: 'NEW',
            browserSessionType: 'IN_MEMORY_PERSISTENT',
          },
        };

        let storageStateJson: any = undefined;
        if (
          existingProvider &&
          (existingProvider.credentials as any)?.sessionStateEncrypted
        ) {
          try {
            storageStateJson = this.encryptionService.decryptSessionState(
              (existingProvider.credentials as any).sessionStateEncrypted,
            );
          } catch (e: any) {
            this.logger.warn(
              `Failed to decrypt sessionState for ${existingProvider.id}: ${e.message}`,
            );
          }
        } else if (
          existingProvider &&
          (existingProvider.credentials as any)?.sessionState
        ) {
          storageStateJson = (existingProvider.credentials as any).sessionState;
        }

        const profilePath = this.getStableUserDataDir(data.email);

        const launchedSession = await this.sessionManager.launchSession(
          mockProviderData,
          storageStateJson,
          {
            requiresPersistentProfile: true,
            profilePath: profilePath,
            skipNavigation: true,
          },
        );
        browser = launchedSession.browser;
        context = launchedSession.context;
        page = launchedSession.page;

        // Block heavy resources (images, fonts) and Google telemetry
        await this.optimizePage(page);

        // Entry: Start at main pay.google.com - more organic than g4b/signup (known automation target)
        const gpayBase = 'https://pay.google.com';
        const gpayUrl = data.businessId
          ? `https://pay.google.com/g4b/transactions/${data.businessId}`
          : 'https://pay.google.com/g4b/signup';

        this.logger.log(`📍 Visiting GPay (organic entry): ${gpayBase}`);
        await page.goto(gpayBase, {
          waitUntil: 'networkidle',
          timeout: 25000,
        });

        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 1000));

        await page.mouse.move(
          100 + Math.random() * 50,
          100 + Math.random() * 50,
        );
        for (let i = 0; i <= 15; i++) {
          await page.mouse.move(100 + (i * 100) / 15, 100 + (i * 200) / 15);
        }
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));

        this.logger.log(`📍 Navigating to: ${gpayUrl}`);
        await page.goto(gpayUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 500));

        // Check for landing page "Sign in" button
        const content = await page.content();
        if (
          content.includes('Sign in') &&
          !content.includes('Email or phone')
        ) {
          this.logger.log(
            'Landing page detected. Clicking "Sign in" button...',
          );
          await page.evaluate(() => {
            const signinBtn = Array.from(
              document.querySelectorAll('a, button'),
            ).find((el) => el.textContent?.trim() === 'Sign in');
            if (signinBtn) (signinBtn as HTMLElement).click();
          });
          await new Promise((r) => setTimeout(r, 2500 + Math.random() * 1500));

          // Some Google flows open/redirect via a new tab-like page in persistent context.
          const pages = context.pages();
          const latestPage = pages[pages.length - 1];
          if (latestPage && latestPage !== page) {
            page = latestPage;
            this.logger.log(
              '🔄 Switched to latest browser page after Sign in click',
            );
          }
        }

        const currentUrlBeforeAuth = page.url();
        const alreadyOnDashboard =
          currentUrlBeforeAuth.includes('pay.google.com/g4b/activity') ||
          currentUrlBeforeAuth.includes('pay.google.com/g4b/home');

        if (!alreadyOnDashboard) {
          // --- FIX for Account Chooser ---
          if (page.url().includes('accountchooser')) {
            this.logger.log(
              `Account chooser detected for ${data.email}. Handling...`,
            );
            try {
              let clicked = false;
              // Try to find the specific email in the list
              const accountSel = `div[data-email="${data.email}"], div[data-identifier="${data.email}"]`;
              const accElem = await page.$(accountSel).catch(() => null);
              if (accElem) {
                this.logger.log(`Found ${data.email} in chooser, clicking it.`);
                await accElem.click();
                clicked = true;
              }

              if (!clicked) {
                this.logger.log(
                  `Did not find ${data.email}, clicking "Use another account"...`,
                );
                const useAnother = await page
                  .$('text=/Use another account/i')
                  .catch(() => null);
                if (useAnother) {
                  await useAnother.click();
                  clicked = true;
                } else {
                  const evalClicked = await page.evaluate(() => {
                    const allNodes = Array.from(
                      document.querySelectorAll('div, li, span'),
                    );
                    const target = allNodes.find(
                      (n) =>
                        n.textContent &&
                        n.textContent.trim().toLowerCase() ===
                          'use another account',
                    );
                    if (target) {
                      (target as HTMLElement).click();
                      return true;
                    }
                    return false;
                  });
                  if (evalClicked) clicked = true;
                }
              }

              if (clicked) {
                await new Promise((r) => setTimeout(r, 3500)); // wait for navigation/transition
              } else {
                this.logger.warn(
                  "Could not find account or 'Use another account' button.",
                );
                const allText = await page
                  .evaluate(() => document.body.innerText)
                  .catch(() => '');
                this.logger.debug(
                  'Page text: ' + allText.replace(/\s+/g, ' ').slice(0, 300),
                );
              }
            } catch (err: any) {
              this.logger.warn(
                'Failed handling account chooser: ' + err.message,
              );
            }
          }
          // ---------------------------------

          // Check if we jumped straight to password field (happens if we clicked an existing account)
          // Also check if the email field is present but hidden, which usually indicates we are on the password step.
          const isEmailHidden = await page
            .evaluate(() => {
              const emailElem = document.querySelector(
                '#identifierId, input[type="email"], input[name="identifier"]',
              );
              return !!(
                emailElem &&
                (emailElem.getAttribute('type') === 'hidden' ||
                  (emailElem as HTMLElement).offsetParent === null)
              );
            })
            .catch(() => false);

          const passElemFast = await page
            .$('input[type="password"]')
            .catch(() => null);
          const isPasswordAlreadyVisible = passElemFast
            ? await passElemFast.isVisible().catch(() => false)
            : false;

          if (!isPasswordAlreadyVisible && !isEmailHidden) {
            // Enter email - add delay before first input (reduces bot-like behavior)
            const emailSelector =
              '#identifierId, input[type="email"], input[name="identifier"]';
            try {
              await page.waitForSelector(emailSelector, { timeout: 90000 });
            } catch (e) {
              const debugTitle = await page.title().catch(() => '');
              const debugUrl = page.url();
              const snippet = (await page.content().catch(() => ''))
                .replace(/\s+/g, ' ')
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
            await page.keyboard.press('Enter');

            // Wait for password or challenge - longer wait for Google to settle
            await new Promise((resolve) =>
              setTimeout(resolve, 3500 + Math.random() * 1500),
            );
          }

          try {
            await page.waitForSelector('input[type="password"]', {
              timeout: 15000,
            });
            await page.focus('input[type="password"]');
            await new Promise((r) => setTimeout(r, 1000));
            for (const char of data.password) {
              await page.type('input[type="password"]', char, {
                delay: 40 + Math.floor(Math.random() * 60),
              });
            }
            await new Promise((r) => setTimeout(r, 700 + Math.random() * 400));
            await page.keyboard.press('Enter');
          } catch (e) {
            this.logger.warn(
              'Password field not found, possibly rejection or phone verification',
            );
          }
        } else {
          this.logger.log(
            `✅ Already on GPay dashboard during login flow - skipping credential entry! URL: ${currentUrlBeforeAuth}`,
          );
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
        // In the new runtime, mid-flow session resumption uses RPC challenge flow.
        throw new BadRequestException(
          'Resuming session mid-flow must use RPC challenge flow in NEW runtime.',
        );
        this.logger.log('🔄 Resuming GPay login session...');
        // Allow updating the recovery phone during resume attempts
        if (data.recoveryPhoneNumber) {
          session.recoveryPhoneNumber = data.recoveryPhoneNumber;
        }
        if (data.googleVerificationCode) {
          session.googleVerificationCode = data.googleVerificationCode;
        }

        // Retry password if stuck on resumed session
        try {
          const urlNow = page.url();
          if (urlNow.includes('challenge/pwd')) {
            const contentNow = await page.content().catch(() => '');
            if (
              contentNow.includes('Enter your password') ||
              contentNow.includes('Show password')
            ) {
              this.logger.log(
                '⚠️ Resumed session is still on password page. Retrying password entry...',
              );
              await page.waitForSelector('input[type="password"]', {
                timeout: 5000,
              });
              await page.focus('input[type="password"]');
              await page.evaluate(() => {
                const el = document.querySelector(
                  'input[type="password"]',
                ) as HTMLInputElement;
                if (el) el.value = '';
              });
              await new Promise((r) => setTimeout(r, 500));
              for (const char of data.password!) {
                await page.type('input[type="password"]', char, {
                  delay: 40 + Math.floor(Math.random() * 60),
                });
              }
              await new Promise((r) => setTimeout(r, 700));
              const nextBtn = await page.$(
                '#passwordNext button, button:has-text("Next")',
              );
              if (nextBtn) {
                await nextBtn.click();
              } else {
                await page.keyboard.press('Enter');
              }
            }
          }
        } catch (e) {
          this.logger.warn('Retry password failed:', e);
        }
      }

      // Check for challenges (Wait for Google to settle - page may still be navigating after password submit)
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
      } catch {
        // Ignore timeout - page might be slow
      }

      const currentUrl = page.url();
      this.logger.log(`📍 Current URL: ${currentUrl}`);

      // Handle Google's "confirm phone number" step (recovery phone) if it appears.
      // If the UI is detected and phoneNumber is provided, auto-fill + click Send.
      const phoneHandle = await this.detectAndHandleGooglePhoneNumber(
        page,
        session?.recoveryPhoneNumber || data.recoveryPhoneNumber,
      );
      if (phoneHandle.detected) {
        if (phoneHandle.submitted) {
          this.logger.log(
            '✅ Submitted recovery phone number on Google challenge',
          );
          await new Promise((r) => setTimeout(r, 2500));
        } else {
          // Ask user for the phone number in our UI
          return {
            success: false,
            challenge: {
              type: 'GOOGLE_PHONE',
              message:
                "Google needs your recovery phone number to send a verification code. Enter your phone number and click 'Send' on the Google page (or enter it here and click Next).",
              screenshotBase64: await this.safeTakeScreenshot(page),
            },
            sessionId,
            message:
              'Google needs your recovery phone number. Please provide it to continue.',
          };
        }
      }

      // CRITICAL: If we're already on GPay dashboard, user logged in (e.g. via phone) - finalize immediately!
      if (currentUrl.includes('pay.google.com/g4b')) {
        this.logger.log(
          '✅ Already on GPay dashboard - user logged in successfully!',
        );
        const finalUrl = page.url();
        const businessIdMatch = finalUrl.match(/activity\/([^/?#]+)/);
        const businessId = businessIdMatch ? businessIdMatch[1] : '';
        const merchantProfile = await this.fetchMerchantProfile(
          page,
          data.email,
        );

        const _finalData = await this.gpayService.finalizeGPayConnection(
          merchantId,
          {
            email: data.email,
            businessId,
            businessName: merchantProfile.businessName,
            organizationId: data.organizationId,
            upiId: data.upiId,
            isSuperAdmin: data.isSuperAdmin,
          },
        );
        const provider = (_finalData as any).provider || {
          id: merchantId,
          merchantId,
        };
        const requiresConfiguration = provider.requiresConfiguration ?? true;
        // Keep browser alive for persistent session — don't close!
        await this.sessionManager.snapshotSessionState(
          provider?.id || merchantId,
        );
        this.loginSessions.delete(sessionId);
        return {
          success: true,
          merchantId: provider.merchantId,
          businessId,
          requiresConfiguration,
          sessionId,
          connection: { credentials: { businessId } },
          savedUpiId: data.upiId,
        };
      }

      // Inspect page for challenges (only if NOT already on dashboard)
      // Retry page.content() - it can fail with "page is navigating" during redirects
      let content = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          content = await page.content();
          break;
        } catch (e: any) {
          if (e?.message?.includes('navigating') && attempt < 4) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw e;
        }
      }

      // Auto-skip "Simplify your sign-in" / passkey prompt - click "Not now"
      if (
        content.includes('Simplify your sign-in') ||
        (content.includes('passkey') &&
          content.includes('Only create a passkey'))
      ) {
        const clicked = await this.tryClickPasskeyNotNow(page);
        if (clicked) {
          this.logger.log(
            "✅ Clicked 'Not now' on passkey prompt, waiting for navigation...",
          );
          await new Promise((r) => setTimeout(r, 3000));
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
          } catch {
            // ignore timeout
          }
          // Re-fetch content and re-check URL (might be on dashboard now)
          const urlAfter = page.url();
          if (urlAfter.includes('pay.google.com/g4b')) {
            this.logger.log(
              '✅ Already on GPay dashboard after skipping passkey!',
            );
            const businessIdMatch = urlAfter.match(/activity\/([^/?#]+)/);
            const businessId = businessIdMatch ? businessIdMatch[1] : '';
            const merchantProfile = await this.fetchMerchantProfile(
              page,
              data.email,
            );

            const _finalData = await this.gpayService.finalizeGPayConnection(
              merchantId,
              {
                email: data.email,
                businessId,
                businessName: merchantProfile.businessName,
                organizationId: data.organizationId,
                upiId: data.upiId,
                isSuperAdmin: data.isSuperAdmin,
              },
            );
            const provider = (_finalData as any).provider || {
              id: merchantId,
              merchantId,
            };
            const requiresConfiguration =
              (_finalData as any).requiresConfiguration ?? true;
            await this.sessionManager.snapshotSessionState(
              provider?.id || merchantId,
            );
            this.loginSessions.delete(sessionId);
            return {
              success: true,
              merchantId: provider.merchantId,
              businessId,
              requiresConfiguration,
              sessionId,
              connection: { credentials: { businessId } },
              savedUpiId: data.upiId,
            };
          }
          for (let a = 0; a < 4; a++) {
            try {
              content = await page.content();
              break;
            } catch (e: any) {
              if (a < 3 && e?.message?.includes('navigating'))
                await new Promise((r) => setTimeout(r, 1500));
              else if (!e?.message?.includes('navigating')) throw e;
            }
          }
        }
      }

      let challenge = await this.detectAndExtractChallengesFromPage(
        page,
        content,
      );

      // No challenge but still on password page - page may be redirecting after 2FA on phone
      const urlBeforeWait = page.url();
      if (
        !challenge &&
        urlBeforeWait.includes('challenge/pwd') &&
        content.includes('Enter your password')
      ) {
        this.logger.log(
          '⏳ On password/accounts page - waiting for possible redirect to GPay...',
        );
        for (let w = 0; w < 3; w++) {
          await new Promise((r) => setTimeout(r, 4000));
          const urlNow = page.url();
          if (urlNow.includes('pay.google.com/g4b')) {
            this.logger.log('✅ Redirected to GPay dashboard!');
            const businessIdMatch = urlNow.match(/activity\/([^/?#]+)/);
            const businessId = businessIdMatch ? businessIdMatch[1] : '';
            const merchantProfile = await this.fetchMerchantProfile(
              page,
              data.email,
            );

            const _finalData = await this.gpayService.finalizeGPayConnection(
              merchantId,
              {
                email: data.email,
                businessId,
                businessName: merchantProfile.businessName,
                organizationId: data.organizationId,
                upiId: data.upiId,
                isSuperAdmin: data.isSuperAdmin,
              },
            );
            const provider = (_finalData as any).provider || {
              id: merchantId,
              merchantId,
            };
            const requiresConfiguration =
              (_finalData as any).requiresConfiguration ?? true;
            await this.sessionManager.snapshotSessionState(
              provider?.id || merchantId,
            );
            this.loginSessions.delete(sessionId);
            return {
              success: true,
              merchantId: provider.merchantId,
              businessId,
              requiresConfiguration,
              sessionId,
              connection: { credentials: { businessId } },
              savedUpiId: data.upiId,
            };
          }
        }
      }

      // When resuming with sessionId and we hit RECAPTCHA/Verification Required:
      // User has clicked "I've Confirmed" in our UI after doing manual login on browser/phone.
      if (challenge && data.sessionId && challenge.type === 'RECAPTCHA') {
        this.logger.log(
          '🔄 User confirmed - performing fresh navigation to GPay to clear block...',
        );

        // Strategy: Instead of just clicking "Try again" (which Google often rejects again),
        // we navigate back to the GPay portal. If the user cleared the block on their mobile/phone
        // on the same network, Google's IP trust should now allow the Puppeteer session through.
        const gpayUrl = data.businessId
          ? `https://pay.google.com/g4b/transactions/${data.businessId}`
          : 'https://pay.google.com/g4b/signup';

        await page.goto(gpayUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        await new Promise((r) => setTimeout(r, 5000));
        for (let a = 0; a < 4; a++) {
          try {
            content = await page.content();
            break;
          } catch (e: any) {
            if (a === 3 || !e?.message?.includes('navigating')) throw e;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        challenge = await this.detectAndExtractChallengesFromPage(
          page,
          content,
        );
      }

      if (challenge) {
        this.logger.log(`⚠️ Challenge detected: ${challenge.type}`);

        // If Google asks for a verification code and we got the code from UI,
        // try to fill it inside Google and submit (works in headless mode).
        if (challenge.type === 'GOOGLE_CODE') {
          const codeToUse =
            data.googleVerificationCode ||
            session?.googleVerificationCode ||
            undefined;

          if (codeToUse && codeToUse.replace(/\D/g, '').length >= 4) {
            const submitted = await this.tryFillGoogleCodeAndSubmit(
              page,
              codeToUse,
            );
            if (submitted) {
              this.logger.log(
                '✅ Submitted Google verification code from UI input',
              );
              await new Promise((r) => setTimeout(r, 3500));
              try {
                content = await page.content();
              } catch {
                // ignore
              }
              const refreshed = await this.detectAndExtractChallengesFromPage(
                page,
                content,
              );
              if (refreshed && refreshed.type === 'GOOGLE_CODE') {
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
            const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
            screenshotBase64 = Buffer.from(buf).toString('base64');
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
      let businessId = '';
      for (let i = 0; i < 6; i++) {
        const currentUrl = page.url();
        const businessIdMatch = currentUrl.match(/activity\/([^/?#]+)/);
        if (businessIdMatch && businessIdMatch[1]) {
          businessId = businessIdMatch[1];
          break;
        }

        if (currentUrl.includes('pay.google.com/g4b/signup')) {
          this.logger.log(
            '⏳ On GPay signup/entry page - waiting for redirect to activity console...',
          );
        }

        await new Promise((r) => setTimeout(r, 3000));
        try {
          // Re-check for challenges in case a new one popped up during transition
          content = await page.content();
          const newChallenge = await this.detectAndExtractChallengesFromPage(
            page,
            content,
          );
          if (newChallenge) {
            this.logger.log(
              `⚠️ New challenge detected during transition: ${newChallenge.type}`,
            );
            return {
              success: false,
              challenge: {
                ...newChallenge,
                screenshotBase64: await this.safeTakeScreenshot(page),
              },
              sessionId,
              message: newChallenge.message,
            };
          }
        } catch {
          // ignore
        }
      }

      // If we are on the G4B dashboard/console, finalize
      if (businessId) {
        this.logger.log('✅ GPay Business Dashboard reached!');

        // Extract merchant profile details natively before finalization
        const merchantProfile = await this.fetchMerchantProfile(
          page,
          data.email,
        );

        const _finalData = await this.gpayService.finalizeGPayConnection(
          merchantId,
          {
            email: data.email,
            businessId,
            businessName: merchantProfile.businessName,
            organizationId: data.organizationId,
            upiId: data.upiId,
            isSuperAdmin: data.isSuperAdmin,
          },
        );
        const provider = (_finalData as any).provider || {
          id: merchantId,
          merchantId,
        };
        const requiresConfiguration =
          (_finalData as any).requiresConfiguration ?? true;

        // Keep browser alive for persistent session
        await this.sessionManager.snapshotSessionState(
          provider?.id || merchantId,
        );
        this.loginSessions.delete(sessionId);

        return {
          success: true,
          merchantId: provider.merchantId,
          businessId,
          requiresConfiguration,
          sessionId,
          connection: { credentials: { businessId } },
          savedUpiId: data.upiId,
        };
      }

      const finalUrl = page.url();
      let waitingMessage =
        "Logged in successfully, but still waiting for GPay dashboard to load. Please click 'Next' again in a moment.";
      if (finalUrl.includes('challenge/pwd') || finalUrl.includes('signin')) {
        waitingMessage =
          "Still waiting for Google sign-in step to complete. Google might be loading or password may be incorrect. Please click 'Next' again in a moment.";
      }

      return {
        success: false,
        status: 'WAITING',
        message: waitingMessage,
        sessionId,
      };
    } catch (error: any) {
      this.logger.error(`❌ Failed GPay flow:`, error);

      try {
        await page?.close?.().catch(() => {});
        await context?.close?.().catch(() => {});
        await browser?.close?.().catch(() => {});
      } catch {
        // ignore
      }

      if (sessionId) {
        this.loginSessions.delete(sessionId);
      }

      let errorMessage = error?.message || 'GPay connection failed';
      if (
        errorMessage.includes('Timeout') &&
        errorMessage.includes('waitForSelector')
      ) {
        errorMessage =
          'Connection timed out while waiting for Google to respond. This usually happens if the network is slow or Google requires additional verification (like a CAPTCHA or Security Key). Please try again.';
      } else if (
        errorMessage.includes('net::ERR_ABORTED') ||
        errorMessage.includes('Navigation failed')
      ) {
        errorMessage =
          'The connection to Google was interrupted. Please try again.';
      }

      throw new BadRequestException(errorMessage);
    }
  }

  private async fetchMerchantProfile(
    page: any,
    email: string,
  ): Promise<{ businessName: string }> {
    try {
      const scraped = await page.evaluate(async () => {
        let businessName = '';

        // Wait briefly for SPA to render the merchant name
        await new Promise((r) => setTimeout(r, 2000));

        const EXCLUDED_STRINGS = [
          'activity',
          'transactions',
          'settings',
          'support',
          'help',
          'google pay',
          'staff access',
          'you have staff access',
          'manage your account',
          'notifications',
          'account',
          'feedback',
          'privacy policy',
          'terms of service',
        ];

        const elementsWithAria = document.querySelectorAll('[aria-label]');
        for (const el of elementsWithAria) {
          const label = el.getAttribute('aria-label') || '';
          if (
            label.includes('Google Pay for Business') &&
            label.includes('-')
          ) {
            const parts = label.split('-');
            if (parts.length > 1) {
              const candidate = parts[1].trim();
              if (
                candidate.length > 0 &&
                !EXCLUDED_STRINGS.some((s) =>
                  candidate.toLowerCase().includes(s),
                )
              ) {
                businessName = candidate;
                return { businessName };
              }
            }
          }
        }

        const possibleHeaders = document.querySelectorAll(
          'header div, [role="banner"] div, h1, h2',
        );
        for (const el of possibleHeaders) {
          const text = el.textContent?.trim() || '';
          if (
            text.length > 2 &&
            text.length < 50 &&
            !EXCLUDED_STRINGS.some((s) => text.toLowerCase().includes(s))
          ) {
            // Check if it's visually prominent (e.g. bold or large font)
            const style = window.getComputedStyle(el);
            if (
              parseInt(style.fontWeight) > 400 ||
              parseInt(style.fontSize) >= 16
            ) {
              businessName = text;
              break;
            }
          }
        }

        if (!businessName) {
          const nav = document.querySelector('nav, header, [role="banner"]');
          if (nav) {
            const treeWalker = document.createTreeWalker(
              nav,
              NodeFilter.SHOW_TEXT,
              null,
            );
            let currentNode = treeWalker.nextNode();
            while (currentNode) {
              const text = currentNode.textContent?.trim() || '';
              if (
                text.length > 2 &&
                text.length < 50 &&
                !EXCLUDED_STRINGS.some((s) => text.toLowerCase().includes(s))
              ) {
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
          if (title && title.includes('-')) {
            const candidate = title.split('-')[0].trim();
            if (
              !EXCLUDED_STRINGS.some((s) => candidate.toLowerCase().includes(s))
            ) {
              businessName = candidate;
            }
          } else if (
            title &&
            !EXCLUDED_STRINGS.some((s) => title.toLowerCase().includes(s))
          ) {
            businessName = title.trim();
          }
        }

        return { businessName };
      });

      // Absolute final fallback: use the provided email address
      const finalName = scraped.businessName
        ? scraped.businessName
        : `GPay ${email}`;
      return { businessName: finalName };
    } catch (error) {
      this.logger.warn(
        `⚠️ Failed to extract merchant profile from DOM: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fallback on error
      return { businessName: `GPay ${email}` };
    }
  }

  private async detectAndExtractChallengesFromPage(page: any, content: string) {
    let url = '';
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
    if (url.includes('pay.google.com/g4b')) {
      return null;
    }
    const isRejectedPage = url.includes('signin/rejected');

    // Some flows land directly on passkey enrollment first; try to skip it.
    const hasPasskeyPrompt =
      content.includes('Simplify your sign-in') ||
      url.includes('passkeyenrollment') ||
      url.includes('recoveryoptions') ||
      content.includes('Make sure you can always sign in');

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

    const lowerTop = (content || '').toLowerCase();
    const isVerificationCodeFlow =
      lowerTop.includes('verification code') ||
      lowerTop.includes('get a verification code') ||
      lowerTop.includes('recovery phone') ||
      lowerTop.includes('choose how you want to sign in') ||
      url.includes('challenge/selection') ||
      url.includes('challenge/ipp');

    if (isVerificationCodeFlow) {
      // If this is the "choose how you want to sign in" screen, try to select
      // "Get a verification code" so the subsequent code-entry UI appears.
      const isMethodSelection =
        lowerTop.includes('choose how you want to sign in') ||
        url.includes('challenge/selection');

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
              if (
                url.includes('challenge/ipp') ||
                ((content || '').toLowerCase().includes('verification code') &&
                  ((content || '').toLowerCase().includes('enter') ||
                    (content || '').toLowerCase().includes('code')))
              ) {
                // Keep it as a weak fallback; DOM input remains the source of truth.
                const lower = ((await page.content()) || '').toLowerCase();
                const looksLikeCodeEntry =
                  lower.includes('enter the code') ||
                  lower.includes('enter the verification code') ||
                  (lower.includes('verification code') &&
                    lower.includes('enter')) ||
                  lower.includes('6-digit') ||
                  lower.includes('one-time code');
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
        type: 'GOOGLE_CODE',
        message: isCodeEntryNow
          ? "Google is asking for a verification code. Enter the 6-digit code in this portal. We'll submit it automatically in headless mode."
          : attemptedAutoSelect
            ? "Google is still showing the method selection screen for verification code. Please click 'Get a verification code (Recovery phone)' on the Google page, then enter the code in this portal."
            : "Google is asking for a verification code. On the Google page, choose 'Get a verification code' (recovery phone) if shown, then enter the code in this portal.",
      };
    }

    // Page scraping logic for challenges - Google "Confirm it's you" / phone verification
    const isGoogleVerificationPage =
      content.includes("Confirm it's you") ||
      content.includes('check your phone') ||
      content.includes('Trying to sign in?') ||
      content.includes('Match the number') ||
      url.includes('challenge/dp') ||
      url.includes('challenge/pwd') ||
      url.includes('signin/challenge');

    if (isGoogleVerificationPage) {
      if (content.toLowerCase().includes('try another way')) {
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
      const extracted = await page
        .evaluate(() => {
          try {
            let num: string | null = null;
            const bodyText = document.body.innerText;

            // 1. Look for number in tappable/button elements (Google shows numbers as buttons)
            const buttons = Array.from(
              document.querySelectorAll(
                '[role="button"], button, div[tabindex]',
              ),
            );
            for (const el of buttons) {
              const text = (el.textContent || '').trim();
              if (/^\d{2,3}$/.test(text)) {
                num = text;
                break;
              }
            }

            // 2. Look for prominent numbers (large font, 2-3 digits)
            if (!num) {
              const all = Array.from(
                document.querySelectorAll('div, span, b, strong, button'),
              );
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
              const m =
                bodyText.match(/(?:tap|select|choose|use)\s+(\d{2,3})\b/i) ||
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
            const devMatch = bodyText.match(
              /notification to your ([^.]+?)(?:\.|Tap|Click|Select)/i,
            );
            if (devMatch) {
              devs = devMatch[1]
                .split(',')
                .map((d) => d.trim())
                .filter(Boolean);
            }
            return { promptNumber: num, devices: devs };
          } catch {
            return { promptNumber: null, devices: [] };
          }
        })
        .catch(() => ({ promptNumber: null, devices: [] }));

      const { promptNumber, devices } = extracted;

      // If we found a prompt number OR the page text strongly suggests a phone prompt
      if (
        promptNumber ||
        content.includes('check your phone') ||
        content.includes('tap Yes') ||
        content.includes("confirmed it's you")
      ) {
        return {
          type: 'GOOGLE_PROMPT',
          message:
            "Check your phone. Tap 'Yes' and then select the number shown below.",
          promptNumber: promptNumber || '??',
          devices: devices?.length ? devices : undefined,
        };
      }
    }

    // (code flow handling is prioritized above)

    if (content.includes('passkey') || url.includes('passkeyenrollment')) {
      return {
        type: 'RECAPTCHA', // Map to RECAPTCHA to reuse the confirm button flow
        message:
          "Google is asking for Passkey or Security confirmation. Please check your browser/phone, then click 'I've Confirmed' here.",
      };
    }

    // Do NOT treat the normal password page as RECAPTCHA
    const isPasswordPage =
      url.includes('challenge/pwd') &&
      (content.includes('Enter your password') ||
        content.includes('Show password') ||
        content.includes('type="password"'));
    if (isPasswordPage) return null;

    if (
      isRejectedPage ||
      content.toLowerCase().includes('recaptcha') ||
      content.includes('robot') ||
      content.includes('g-recaptcha') ||
      content.includes('unusual activity') ||
      content.includes('not secure') ||
      content.includes('About this page') ||
      content.includes('unusual traffic')
    ) {
      return {
        type: 'RECAPTCHA',
        message:
          "Google has flagged this login as unusual. Please log in manually once on your browser/phone (or solve the CAPTCHA if shown below), then click 'I've Confirmed' here.",
      };
    }

    return null;

    return null;
  }

  private async tryClickPasskeyNotNow(
    page: any,
    opts?: { forceFrameScan?: boolean },
  ): Promise<boolean> {
    try {
      // If needed, scan across all frames for the actual "Not now" button.
      // This is important because Google sometimes renders the passkey prompt in an iframe.
      const scanFrames = async () => {
        const frames = typeof page.frames === 'function' ? page.frames() : [];
        for (const frame of frames) {
          try {
            const frameUrl = frame.url?.() || '';
            // Keep it scoped: only accounts.google.com style frames.
            if (
              !/accounts\.google\.com/i.test(frameUrl) &&
              !/google/i.test(frameUrl)
            )
              continue;

            if (typeof frame.getByRole === 'function') {
              const btn = frame.getByRole('button', { name: /not now/i });
              await btn.click({ timeout: 1200 }).catch(() => {});
              // If no exception, we likely clicked.
              return true;
            }

            const clicked = await frame
              .evaluate(() => {
                const targets = [
                  'not now',
                  'skip',
                  'no thanks',
                  'maybe later',
                  'cancel',
                ];
                const all = Array.from(
                  document.querySelectorAll(
                    'button, [role="button"], a, span, div',
                  ),
                );
                for (const el of all) {
                  const text = (el.textContent || '').trim().toLowerCase();
                  if (targets.some((t) => text === t || text.startsWith(t))) {
                    const parent =
                      (el as HTMLElement).closest?.(
                        "button, [role='button'], a",
                      ) || el;
                    (parent as HTMLElement).click?.();
                    return true;
                  }
                }
                return false;
              })
              .catch(() => false);

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
        if (typeof page.getByRole === 'function') {
          const btn = page.getByRole('button', {
            name: /not now|cancel|skip|no thanks/i,
          });
          await btn.click({ timeout: 1500 }).catch(() => {});
          // If click didn't throw, assume success.
          return true;
        }
      } catch {
        // fall back
      }

      try {
        if (typeof page.locator === 'function') {
          const loc = page.locator(
            'button:has-text("Not now"), [role=\'button\']:has-text("Not now")',
          );
          const count = await loc.count().catch(() => 0);
          if (count > 0) {
            await loc
              .first()
              .click({ timeout: 1500 })
              .catch(() => {});
            return true;
          }
        }
      } catch {
        // fall back
      }

      const clicked = await page.evaluate(() => {
        const targets = ['not now', 'skip', 'no thanks', 'maybe later'];
        const all = Array.from(
          document.querySelectorAll('button, [role="button"], a, span, div'),
        );
        for (const el of all) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (targets.some((t) => text === t || text.startsWith(t))) {
            const parent =
              (el as HTMLElement).closest?.("button, [role='button'], a") || el;
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

  private async detectAndHandleGooglePhoneNumber(
    page: any,
    phoneNumber?: string,
  ): Promise<{ detected: boolean; submitted: boolean }> {
    try {
      const detected = await page
        .evaluate(() => {
          const norm = (s: string) =>
            (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const body = norm(document.body?.innerText || '');
          if (!body.includes('get a verification code')) return false;
          if (!body.includes('phone number')) return false;
          const input = document.querySelector(
            "input[type='tel'], input[autocomplete='tel'], input[aria-label*='Phone number' i]",
          );
          return !!input;
        })
        .catch(() => false);

      if (!detected) return { detected: false, submitted: false };
      if (!phoneNumber?.trim()) return { detected: true, submitted: false };

      const cleaned = phoneNumber.replace(/\D/g, '');
      const submitted = await page
        .evaluate((num: string) => {
          const input = (
            document.querySelector("input[type='tel']") ||
            document.querySelector("input[autocomplete='tel']") ||
            document.querySelector("input[aria-label*='Phone number' i]")
          ) as HTMLInputElement | null;
          if (!input) return false;
          input.focus();
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.value = num;
          input.dispatchEvent(new Event('input', { bubbles: true }));

          const norm = (s: string) =>
            (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const candidates = Array.from(
            document.querySelectorAll("button, [role='button']"),
          ) as HTMLElement[];
          const send = candidates.find((b) =>
            norm(b.innerText || b.textContent || '').includes('send'),
          );
          if (send) {
            send.click();
            return true;
          }
          return false;
        }, cleaned)
        .catch(() => false);

      return { detected: true, submitted: !!submitted };
    } catch {
      return { detected: false, submitted: false };
    }
  }

  private async tryClickVerificationConfirmed(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const targets = ['try again', "i've confirmed", 'try again later'];
        const all = Array.from(
          document.querySelectorAll('button, [role="button"], a'),
        );
        // Prefer buttons/links with exact or near-exact text
        for (const el of all) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (targets.some((t) => text === t || text.startsWith(t))) {
            (el as HTMLElement).click();
            return true;
          }
        }
        // Fallback: check span/div (e.g. text inside a button)
        const fallback = Array.from(document.querySelectorAll('span, div'));
        for (const el of fallback) {
          const text = (el.textContent || '').trim().toLowerCase();
          if (
            targets.some((t) => text === t) &&
            (el as HTMLElement).offsetParent !== null
          ) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (clicked)
        this.logger.log(
          "✅ Clicked action button (Try again / I've Confirmed)",
        );
      return clicked;
    } catch (e) {
      this.logger.warn('Could not find/click action button:', e);
      return false;
    }
  }

  private async tryClickTryAnotherWay(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const targets = [
          'try another way',
          'another way',
          'choose another option',
        ];
        const all = Array.from(
          document.querySelectorAll("button, [role='button'], a, span, div"),
        );
        for (const el of all) {
          const text = (el.textContent || '').trim().toLowerCase();
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
      if (clicked)
        this.logger.log("✅ Clicked 'Try another way' on Google challenge");
      return !!clicked;
    } catch {
      return false;
    }
  }

  private async tryClickGetVerificationCode(page: any): Promise<boolean> {
    try {
      const clicked = await page.evaluate(() => {
        const norm = (s: string) =>
          (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el: HTMLElement) => {
          const rects = el.getClientRects();
          if (!rects || rects.length === 0) return false;
          const style = window.getComputedStyle(el);
          if (!style) return true;
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;
          if (style.opacity === '0') return false;
          return true;
        };

        const bodyText = norm(document.body?.innerText || '');
        if (!bodyText.includes('choose how you want to sign in')) {
          // Avoid clicking random "verification code" text on non-selection pages.
          return false;
        }

        // Prefer clicking the actual option row that contains BOTH:
        // - "Get a verification code"
        // - "Recovery phone"
        // This matches the UI you screenshotted.
        const optionCandidates = Array.from(
          document.querySelectorAll(
            "div[role='link'], div[role='button'], button, [role='button'], a",
          ),
        ).filter((el) => isVisible(el as HTMLElement));

        const pickBest = () => {
          let best: HTMLElement | null = null;
          for (const el of optionCandidates) {
            const t = norm(
              (el as HTMLElement).innerText ||
                (el as HTMLElement).textContent ||
                '',
            );
            if (!t) continue;
            if (
              t.includes('get a verification code') &&
              t.includes('recovery phone')
            ) {
              best = el as HTMLElement;
              break;
            }
          }
          if (best) return best;

          // Fallback: any visible element mentioning "get a verification code"
          for (const el of optionCandidates) {
            const t = norm(
              (el as HTMLElement).innerText ||
                (el as HTMLElement).textContent ||
                '',
            );
            if (t.includes('get a verification code')) return el as HTMLElement;
          }
          return null;
        };

        const target = pickBest();
        if (!target) return false;

        // Ensure we click a clickable ancestor if text is nested.
        const clickable =
          target.closest?.(
            "div[role='link'], div[role='button'], button, [role='button'], a",
          ) || target;
        (clickable as HTMLElement).click?.();
        return true;
      });

      if (clicked)
        this.logger.log(
          "✅ Clicked 'Get a verification code' on Google challenge",
        );
      return !!clicked;
    } catch {
      return false;
    }
  }

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
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;
          if (style.opacity === '0') return false;
          return true;
        };

        const lowerBody = (document.body?.innerText || '').toLowerCase();

        const candidates = Array.from(
          document.querySelectorAll('input'),
        ).filter((el) => {
          const input = el;
          if (!isVisible(input)) return false;

          const autocomplete = (
            input.getAttribute('autocomplete') || ''
          ).toLowerCase();
          const type = (input.getAttribute('type') || '').toLowerCase();
          const inputMode = (
            input.getAttribute('inputmode') || ''
          ).toLowerCase();
          const name = (input.getAttribute('name') || '').toLowerCase();
          const id = (input.id || '').toLowerCase();
          const aria = (input.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (
            input.getAttribute('placeholder') || ''
          ).toLowerCase();

          const looksOtp =
            autocomplete.includes('one-time-code') ||
            type === 'tel' ||
            inputMode === 'numeric' ||
            name.includes('code') ||
            id.includes('code') ||
            aria.includes('code') ||
            placeholder.includes('code');

          const isLikelyCodeContext =
            lowerBody.includes('verification code') ||
            lowerBody.includes('one-time code') ||
            lowerBody.includes('recovery phone') ||
            (lowerBody.includes('enter') && lowerBody.includes('code'));

          return looksOtp && isLikelyCodeContext;
        });

        return {
          visibleCodeInputCount: candidates.length,
        };
      };

      // 1) Main document first
      const main = await page
        .evaluate(detectInDocument)
        .catch(() => ({ visibleCodeInputCount: 0 }));
      if (main?.visibleCodeInputCount > 0) {
        return {
          isCodeEntry: true,
          visibleCodeInputCount: Number(main.visibleCodeInputCount || 0),
        };
      }

      // 2) Then scan iframes (Google often hosts verification UI inside an iframe)
      const frames = typeof page.frames === 'function' ? page.frames() : [];
      for (const frame of frames) {
        // Heuristic: only check frames that look like Google sign-in/challenge
        try {
          const frameUrl = frame.url?.() || '';
          if (!/accounts\.google\.com|signin|challenge|g4b/i.test(frameUrl))
            continue;
        } catch {
          // ignore
        }

        const inFrame = await frame
          .evaluate(detectInDocument)
          .catch(() => ({ visibleCodeInputCount: 0 }));
        if (inFrame?.visibleCodeInputCount > 0) {
          return {
            isCodeEntry: true,
            visibleCodeInputCount: Number(inFrame.visibleCodeInputCount || 0),
          };
        }
      }

      return { isCodeEntry: false, visibleCodeInputCount: 0 };
    } catch {
      return { isCodeEntry: false, visibleCodeInputCount: 0 };
    }
  }

  private async tryFillGoogleCodeAndSubmit(
    page: any,
    code: string,
  ): Promise<boolean> {
    const cleaned = (code || '').replace(/\D/g, '');
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
              if (style.display === 'none') return false;
              if (style.visibility === 'hidden') return false;
              if (style.opacity === '0') return false;
              return true;
            };

            const digits = (codeInner || '').replace(/\D/g, '');
            if (!digits) return false;

            const inputs = Array.from(
              document.querySelectorAll('input'),
            ).filter((el) => {
              const input = el;
              if (!isVisible(input)) return false;

              const autocomplete = (
                input.getAttribute('autocomplete') || ''
              ).toLowerCase();
              const type = (input.getAttribute('type') || '').toLowerCase();
              const inputMode = (
                input.getAttribute('inputmode') || ''
              ).toLowerCase();
              const name = (input.getAttribute('name') || '').toLowerCase();
              const id = (input.id || '').toLowerCase();
              const aria = (
                input.getAttribute('aria-label') || ''
              ).toLowerCase();
              const placeholder = (
                input.getAttribute('placeholder') || ''
              ).toLowerCase();

              const looksOtp =
                autocomplete.includes('one-time-code') ||
                type === 'tel' ||
                inputMode.includes('numeric') ||
                name.includes('code') ||
                id.includes('code') ||
                aria.includes('code') ||
                placeholder.includes('code');

              return looksOtp;
            });

            if (!inputs.length) return false;

            const setInputValue = (input: HTMLInputElement, val: string) => {
              input.focus();
              input.value = '';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.value = val;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            };

            const allSingleDigit = inputs.every((i) => {
              const inp = i;
              const ml =
                inp.maxLength ||
                parseInt(inp.getAttribute('maxlength') || '0', 10) ||
                0;
              return ml === 1;
            });

            if (allSingleDigit && inputs.length >= 2) {
              const chars = digits.split('');
              for (let i = 0; i < inputs.length; i++) {
                const ch = chars[i] || '';
                setInputValue(inputs[i], ch);
              }
            } else {
              setInputValue(inputs[0], digits);
            }

            const buttons = Array.from(
              document.querySelectorAll(
                "button, [role='button'], input[type='submit']",
              ),
            ).filter((el) => isVisible(el as HTMLElement));

            const normText = (t: string) =>
              (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

            const clickBtn = buttons.find((el) => {
              const text =
                (el as HTMLElement).getAttribute('aria-label') ||
                (el as HTMLElement).textContent ||
                (el as HTMLInputElement).value ||
                '';
              const n = normText(text);
              return (
                n.includes('verify') ||
                n.includes('next') ||
                n.includes('done') ||
                n.includes('continue')
              );
            }) as HTMLElement | undefined;

            if (clickBtn?.click) {
              clickBtn.click();
              return true;
            }

            // Fallback: press Enter on the first input
            const first = inputs[0];
            first.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                bubbles: true,
              }),
            );
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
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    for (const frame of frames) {
      try {
        const frameUrl = frame.url?.() || '';
        if (
          frameUrl &&
          !/accounts\.google\.com|signin|challenge|google/i.test(frameUrl)
        )
          continue;
      } catch {
        // ignore frameUrl errors
      }

      if (await tryInFrame(frame)) return true;
    }

    return false;
  }

  detectAndExtractChallenges(responseData: any) {
    if (!responseData || !Array.isArray(responseData)) return null;

    // Look for B4hajb or oHUEyd patterns
    const b4hajbResult = responseData.find(
      (item: any) => item[0] === 'wrb.fr' && item[1] === 'B4hajb',
    );

    if (b4hajbResult && b4hajbResult[2]) {
      try {
        const inner = JSON.parse(b4hajbResult[2]);
        // Looking for "LOGIN_CHALLENGE" or "TWO_STEP_VERIFICATION"
        const status = inner?.[0]?.[2];

        if (status === 'LOGIN_CHALLENGE') {
          // Check for key 1037 (Device Prompt number)
          const challengePayload = inner?.[0]?.[29]; // Index 29 usually holds extra info
          const data1037 = challengePayload?.['1037'];

          if (data1037 && data1037[4]) {
            return {
              type: 'GOOGLE_PROMPT',
              promptNumber: data1037[4], // e.g., 43
              devices: data1037[5]?.[0] || [], // List of devices notified
              message: 'Check your phone for the verification number.',
            };
          }
        }
      } catch (e) {
        this.logger.error('Error parsing B4hajb challenge', e);
      }
    }

    // Look for reCAPTCHA markers: "recaptcha" or specific error codes
    const responseStr = JSON.stringify(responseData).toLowerCase();
    if (responseStr.includes('recaptcha') || responseStr.includes('robot')) {
      return {
        type: 'RECAPTCHA',
        message:
          'Google requires you to solve a CAPTCHA. Please solve it in the GPay app or try again.',
      };
    }

    return null;
  }

  private async optimizePage(page: any) {
    await page.route('**/*', (route: any) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort();
        return;
      }

      const url = route.request().url();
      if (
        url.includes('play.google.com/log') ||
        url.includes('google.com/pagead/') ||
        url.includes('googleadservices.com') ||
        url.includes('doubleclick.net') ||
        url.includes('google-analytics.com') ||
        url.includes('googletagmanager.com')
      ) {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  private async safeTakeScreenshot(page: any): Promise<string | undefined> {
    try {
      // Screenshot can be slow on Google challenge pages; never block connect-gpay too long.
      const buf = await page.screenshot({
        type: 'jpeg',
        quality: 85,
        timeout: 2500,
      });
      return Buffer.from(buf).toString('base64');
    } catch {
      return undefined;
    }
  }
}

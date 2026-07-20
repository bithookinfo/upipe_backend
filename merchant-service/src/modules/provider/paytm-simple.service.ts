import { Injectable, Logger, BadRequestException, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Cron } from "@nestjs/schedule";
import { MerchantProviderStatus, ProviderType } from "@prisma/client";
import axios from "axios";
import puppeteer from "puppeteer-extra";
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

@Injectable()
export class PaytmSimpleService implements OnModuleDestroy {
  private readonly logger = new Logger(PaytmSimpleService.name);

  private browserSessions: Map<
    string,
    { browser: any; page: any; frame: any; expiresAt: number }
  > = new Map();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleDestroy() {
    this.logger.log("🛑 Shutting down PaytmSimpleService, closing all active browsers...");
    for (const [sessionId, sessionData] of this.browserSessions.entries()) {
      try {
        await sessionData.browser?.close?.();
      } catch (e) {
        this.logger.warn(`Failed to close PAYTM browser for ${sessionId}: ${e}`);
      }
    }
  }

  private generateRandomIP(): string {
    const octet = () => Math.floor(Math.random() * 256);
    return `${octet()}.${octet()}.${octet()}.${octet()}`;
  }

  @Cron("0 */15 * * * *", { name: "paytm-keepalive-inactive-merchants" })
  async keepalivePaytmSessions() {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.PAYTM,
          status: MerchantProviderStatus.ACTIVE,
          merchant: { deletedAt: null },
        },
        select: {
          id: true,
          credentials: true,
        },
        take: 50,
      });

      if (!providers.length) return;

      this.logger.log(`💓 Paytm Keepalive: Warming ${providers.length} active Paytm provider(s) to prevent idle expiration...`);

      for (const p of providers) {
        try {
          const creds: any = p.credentials || {};
          if (creds.merchantSession && creds.merchantCsrfToken) {
            await this.fetchMerchantMetadata(creds.merchantSession, creds.merchantCsrfToken);
          }
        } catch (error: any) {
          this.logger.warn(`⚠️ Paytm Keepalive failed for ${p.id}: ${error?.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`❌ Paytm Keepalive cron failed: ${error?.message}`);
    }
  }

  @Cron("*/30 * * * * *", { name: "paytm-cleanup-abandoned-sessions" })
  async sweepAbandonedSessions() {
    const now = Date.now();
    for (const [sessionId, sessionData] of this.browserSessions.entries()) {
      if (now > sessionData.expiresAt) {
        this.logger.log(`🧹 Cleaning up abandoned PAYTM session: ${sessionId}`);
        try {
          await sessionData.browser?.close?.();
        } catch (e: any) {
          this.logger.warn(`Failed to close PAYTM browser for ${sessionId}: ${e?.message}`);
        }
        this.browserSessions.delete(sessionId);
      }
    }
  }

  async sendOtp(
    username: string,
    password: string,
    userAgent: string,
    sessionId: string,
  ): Promise<any> {
    let browser: any = null;
    try {
      this.logger.log(`🚀 Launching Puppeteer for Paytm login: ${username}`);

      puppeteer.use(StealthPlugin());

      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      const page = await browser.newPage();

      await page.setUserAgent(userAgent);

      await page.setViewport({ width: 1280, height: 800 });

      this.logger.log("📱 Navigating to Paytm login page...");

      try {
        await page.goto(
          "https://dashboard.paytm.com/login/?referrer=Business",
          {
            waitUntil: "networkidle2",
            timeout: 60000,
          },
        );
      } catch (navError: any) {
        this.logger.error(`Navigation error: ${navError.message}`);
        this.logger.log("Retrying without referrer...");
        await page.goto("https://dashboard.paytm.com/login/", {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
      }

      this.logger.log("⏳ Waiting for React app to initialize...");
      await new Promise((resolve) => setTimeout(resolve, 8000));

      page.on("console", (msg: any) => {
        const type = msg.type();
        if (type === "error" || type === "warning") {
          this.logger.warn(`Browser ${type}: ${msg.text()}`);
        }
      });

      page.on("pageerror", (error: any) => {
        this.logger.error("Page JavaScript error:", error.message);
      });

      const screenshotPath = `/tmp/paytm-login-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      this.logger.log(`📸 Screenshot saved: ${screenshotPath}`);

      const pageContent = await page.content();
      this.logger.log(`📄 Page HTML length: ${pageContent.length}`);

      const fs = require("fs");
      const htmlPath = `/tmp/paytm-login-${Date.now()}.html`;
      fs.writeFileSync(htmlPath, pageContent);
      this.logger.log(`📝 HTML saved: ${htmlPath}`);

      // Check for JavaScript errors
      const jsStatus = await page.evaluate(() => {
        return {
          hasReact: !!(window as any).React,
          hasApp: !!document.querySelector("app-login"),
          scriptCount: document.querySelectorAll("script").length,
          errorMessages: Array.from(
            document.querySelectorAll('[class*="error"]'),
          ).map((el) => el.textContent),
        };
      });
      this.logger.log("📊 Page JavaScript status:", JSON.stringify(jsStatus));

      const pageInfo = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText : "";
        const allInputs = Array.from(document.querySelectorAll("input"));
        const allButtons = Array.from(document.querySelectorAll("button"));
        const hasReact =
          !!(window as any).React || document.querySelector("[data-reactroot]");

        return {
          bodyText: bodyText.substring(0, 500),
          inputCount: allInputs.length,
          inputs: allInputs.map((input) => ({
            type: input.type,
            name: input.name,
            id: input.id,
            placeholder: input.placeholder,
            className: input.className,
          })),
          buttonCount: allButtons.length,
          hasReact,
          title: document.title,
          url: window.location.href,
        };
      });

      if (pageInfo.inputCount > 0) {
        this.logger.log(`📝 Input fields:`);
        this.logger.log(JSON.stringify(pageInfo.inputs, null, 2));
      }

      this.logger.log("🔍 Looking for oauth iframe...");

      try {
        await page.waitForSelector("iframe#oauth-iframe", {
          timeout: 15000,
        });
        this.logger.log("✅ Found OAuth iframe element");
      } catch (iframeError) {
        this.logger.error("❌ OAuth iframe not found");
        throw new BadRequestException("Paytm OAuth iframe did not load");
      }

      // Wait for iframe src to be set by JavaScript
      this.logger.log("⏳ Waiting for iframe src attribute to be set...");
      let srcAttempts = 0;
      let iframeSrc = "";

      while (!iframeSrc && srcAttempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        iframeSrc = await page.evaluate(() => {
          const iframe = document.querySelector("iframe#oauth-iframe");
          return iframe
            ? iframe.getAttribute("src") ||
                iframe.getAttribute("data-src") ||
                ""
            : "";
        });

        if (iframeSrc) {
          this.logger.log(`✅ Iframe src set to: ${iframeSrc}`);
        } else {
          this.logger.debug(
            `Attempt ${srcAttempts + 1}: Iframe src not set yet`,
          );
        }

        srcAttempts++;
      }

      if (!iframeSrc) {
        this.logger.error("❌ Iframe src was never set by JavaScript");
        this.logger.error(
          "This suggests Paytm has changed their login page structure",
        );
        throw new BadRequestException(
          "Paytm OAuth iframe failed to initialize. Please try again or contact support.",
        );
      }

      const frameHandle = await page.$("iframe#oauth-iframe");
      if (!frameHandle) {
        throw new BadRequestException("Could not access OAuth iframe");
      }

      const frame = await frameHandle.contentFrame();
      if (!frame) {
        throw new BadRequestException("Could not access iframe content");
      }

      this.logger.log(
        "🔄 Switched to iframe context, waiting for iframe to load...",
      );

      // Wait for iframe to navigate away from about:blank
      this.logger.log("⏳ Waiting for iframe to fully load...");

      let attempts = 0;
      let iframeUrl = "about:blank";

      while (iframeUrl === "about:blank" && attempts < 20) {
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms

        try {
          iframeUrl = await frame.evaluate(() => window.location.href);
          if (iframeUrl !== "about:blank") {
            this.logger.log(`✅ Iframe loaded: ${iframeUrl}`);
          }
        } catch (e) {}

        attempts++;
      }

      if (iframeUrl === "about:blank") {
        this.logger.error("❌ Iframe content never loaded");
        throw new BadRequestException(
          "Paytm OAuth iframe failed to load content",
        );
      }

      this.logger.log("⏳ Waiting 3 seconds for iframe content to render...");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      try {
        const iframeContent = await frame.evaluate(() => {
          return {
            url: window.location.href,
            title: document.title,
            bodyText: document.body?.innerText?.substring(0, 200) || "[EMPTY]",
            inputCount: document.querySelectorAll("input").length,
            buttonCount: document.querySelectorAll("button").length,
            hasLoginForm: !!document.querySelector("form"),
            htmlLength: document.documentElement.innerHTML.length,
          };
        });
        this.logger.log(
          "📋 Iframe content:",
          JSON.stringify(iframeContent, null, 2),
        );
      } catch (evalError: any) {
        this.logger.error(
          "❌ Failed to evaluate iframe content:",
          evalError.message,
        );
      }

      try {
        await frame.waitForSelector("input", {
          timeout: 60000,
          visible: true,
        });
      } catch (waitError) {
        this.logger.error("❌ Timeout waiting for input fields inside iframe");

        const errorScreenshot = `/tmp/paytm-iframe-error-${Date.now()}.png`;
        await page.screenshot({ path: errorScreenshot, fullPage: true });
        this.logger.error(`📸 Error screenshot saved: ${errorScreenshot}`);

        throw new BadRequestException(
          "Login form inputs did not load inside iframe. Paytm may have changed their login page.",
        );
      }

      const inputs = await frame.$$("input");
      this.logger.log(`✅ Found ${inputs.length} input fields inside iframe`);

      if (inputs.length < 2) {
        throw new BadRequestException(
          `Only found ${inputs.length} input field(s), need at least 2 for username and password`,
        );
      }

      this.logger.log(`✍️  Filling username in first input field...`);
      await inputs[0].type(username, { delay: 100 });

      this.logger.log("🔑 Filling password in second input field...");
      await inputs[1].type(password, { delay: 100 });

      this.logger.log("👂 Setting up response listener...");
      const responsePromise = page.waitForResponse(
        (response: any) =>
          response.url().includes("/um/authorize/proceed") ||
          response.url().includes("/login") ||
          response.url().includes("/authorize") ||
          response.url().includes("/oauth"),
        { timeout: 60000 },
      );

      this.logger.log("🖱️  Looking for submit button inside iframe...");
      // Find buttons INSIDE the iframe
      const buttons = await frame.$$("button");

      if (buttons.length === 0) {
        throw new BadRequestException("No submit button found inside iframe");
      }

      this.logger.log(
        `✅ Found ${buttons.length} buttons in iframe, clicking the first one...`,
      );
      await buttons[0].click();

      this.logger.log("⏳ Waiting for Paytm response...");
      const response = await responsePromise;
      let responseData: any = null;

      try {
        const text = await response.text();
        try {
          responseData = JSON.parse(text);
        } catch (e) {
          this.logger.warn(
            `⚠️  Paytm returned non-JSON response: ${text.substring(0, 200)}...`,
          );
          if (response.status() >= 400) {
            throw new BadRequestException(
              `Paytm error (${response.status()}): ${text.substring(0, 100)}`,
            );
          }
        }
      } catch (parseError: any) {
        if (parseError instanceof BadRequestException) throw parseError;
        this.logger.error(
          `❌ Failed to parse Paytm response: ${parseError.message}`,
        );
      }

      if (responseData) {
        this.logger.log(`📄 Paytm Response: ${JSON.stringify(responseData)}`);
      }

      if (
        responseData?.status === "SUCCESS" ||
        responseData?.state ||
        responseData?.stateCode
      ) {
        const stateCode = responseData.state || responseData.stateCode;
        const csrfToken = responseData.csrfToken || "";

        let finalCsrfToken = csrfToken;
        if (!finalCsrfToken) {
          try {
            this.logger.log("🔍 Extracting CSRF token from iframe...");

            finalCsrfToken = await frame.evaluate(() => {
              if ((window as any).csrfToken) return (window as any).csrfToken;

              const stored = localStorage.getItem("csrfToken");
              if (stored) return stored;

              const sessionStored = sessionStorage.getItem("csrfToken");
              if (sessionStored) return sessionStored;

              const metaToken = document.querySelector(
                'meta[name="csrf-token"]',
              );
              if (metaToken) return metaToken.getAttribute("content") || "";

              return "";
            });

            if (finalCsrfToken) {
              this.logger.log(
                `✅ Extracted CSRF token from iframe: ${finalCsrfToken.substring(0, 10)}...`,
              );
            } else {
              // If still no token, try main page
              this.logger.log("🔍 Trying to extract CSRF from main page...");
              finalCsrfToken = await page.evaluate(() => {
                if ((window as any).csrfToken) return (window as any).csrfToken;
                const stored = localStorage.getItem("csrfToken");
                if (stored) return stored;
                return "";
              });

              if (finalCsrfToken) {
                this.logger.log(
                  `✅ Extracted CSRF token from main page: ${finalCsrfToken.substring(0, 10)}...`,
                );
              }
            }
          } catch (extractError) {
            this.logger.warn(
              "⚠️  Could not extract CSRF token, will use stateCode as fallback",
            );
          }
        }

        this.logger.log(`✅ OTP sent successfully! State: ${stateCode}`);

        // If we still don't have a CSRF token, use stateCode (Paytm might accept it)
        const tokenToReturn = finalCsrfToken || stateCode;
        this.logger.log(
          `🎫 Using token for verification: ${tokenToReturn.substring(0, 20)}...`,
        );

        this.browserSessions.set(sessionId, { 
          browser, 
          page, 
          frame,
          expiresAt: Date.now() + 5 * 60 * 1000 
        });
        this.logger.log(
          `💾 Browser session stored for ${sessionId}, keeping browser open for OTP entry`,
        );

        return {
          status: "SUCCESS",
          stateCode: stateCode,
          csrfToken: tokenToReturn,
          message: "OTP sent to your registered mobile number",
          sessionId: sessionId, // Return sessionId to frontend
        };
      }

      if (
        responseData?.responseCode === "434" ||
        responseData?.message === "Bad Request"
      ) {
        await browser.close();
        browser = null;
        throw new BadRequestException(
          "Invalid credentials. Please check your username and password.",
        );
      }

      if (responseData?.message) {
        await browser.close();
        browser = null;
        throw new BadRequestException(`Paytm: ${responseData.message}`);
      }

      await browser.close();
      browser = null;
      throw new BadRequestException("Failed to send OTP. Please try again.");
    } catch (error: any) {
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          this.logger.error("Failed to close browser:", closeError);
        }
      }

      this.logger.error("❌ Paytm OTP send failed:", error.message);

      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error.message?.includes("timeout")) {
        throw new BadRequestException(
          "Request timeout. Paytm is taking too long to respond. Please try again.",
        );
      }

      if (error.message?.includes("net::ERR")) {
        throw new BadRequestException(
          "Network error. Please check your internet connection.",
        );
      }

      if (error.message?.includes("selector")) {
        throw new BadRequestException(
          "Paytm login page has changed. Please contact support.",
        );
      }

      throw new BadRequestException(
        "Failed to send OTP. Please try again or contact support.",
      );
    }
  }

  async verifyOtpWithPuppeteer(sessionId: string, otp: string): Promise<any> {
    try {
      this.logger.log(
        `🔐 Verifying OTP with Puppeteer for session: ${sessionId}`,
      );

      // Retrieve stored browser session
      const session = this.browserSessions.get(sessionId);
      if (!session) {
        throw new BadRequestException(
          "Session expired. Please request OTP again.",
        );
      }

      const { browser, page, frame } = session;

      this.logger.log(`✅ Retrieved browser session, filling OTP: ${otp}`);

      // Wait for OTP input field in iframe
      await frame.waitForSelector(
        'input[type="tel"], input[type="text"], input[type="number"]',
        {
          visible: true,
          timeout: 10000,
        },
      );

      const otpInputs = await frame.$$(
        'input[type="tel"], input[type="text"], input[type="number"]',
      );

      if (otpInputs.length === 0) {
        throw new BadRequestException("OTP input field not found");
      }

      // Fill OTP in the input field
      this.logger.log(`✍️  Typing OTP in input field...`);
      await otpInputs[0].type(otp, { delay: 100 });

      // Find and click verify button
      const buttons = await frame.$$("button");
      if (buttons.length === 0) {
        throw new BadRequestException("Verify button not found");
      }

      this.logger.log(`🖱️  Clicking verify button...`);

      // Use domcontentloaded instead of networkidle0 for faster response
      const navigationPromise = page
        .waitForNavigation({
          waitUntil: "domcontentloaded", // Much faster than networkidle0
          timeout: 15000, // Reduced from 60s to 15s
        })
        .catch(() => null); // Don't fail if no navigation

      await buttons[0].click();

      this.logger.log(`⏳ Waiting for login to complete...`);
      await navigationPromise;

      // Reduced wait time from 3s to 1s
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const currentUrl = page.url();
      this.logger.log(`📍 Current URL after OTP: ${currentUrl}`);

      if (!currentUrl.includes("dashboard.paytm.com")) {
        const errorText = await frame
          .evaluate(() => document.body.innerText)
          .catch(() => "");
        if (
          errorText.toLowerCase().includes("invalid") ||
          errorText.toLowerCase().includes("incorrect")
        ) {
          await browser.close();
          this.browserSessions.delete(sessionId);
          throw new BadRequestException("Invalid OTP. Please try again.");
        }

        throw new BadRequestException("Login failed. Please try again.");
      }

      this.logger.log(
        `✅ Successfully logged in! Extracting merchant details...`,
      );

      // Extract cookies from the authenticated session
      const cookies = await page.cookies();
      let merchantSession = "";
      let merchantCsrfToken = "";

      this.logger.log(
        `🍪 Found ${cookies.length} cookies: ${cookies.map((c) => c.name).join(", ")}`,
      );

      cookies.forEach((cookie: any) => {
        if (cookie.name === "SESSION") {
          merchantSession = cookie.value;
          this.logger.log(
            `📝 Extracted SESSION: ${merchantSession.substring(0, 20)}...`,
          );
        }
        if (cookie.name === "XSRF-TOKEN") {
          merchantCsrfToken = cookie.value;
          this.logger.log(
            `📝 Extracted XSRF-TOKEN: ${merchantCsrfToken.substring(0, 20)}...`,
          );
        }
      });

      if (!merchantSession || !merchantCsrfToken) {
        throw new BadRequestException("Failed to extract session cookies");
      }

      this.logger.log(`🔍 Waiting for dashboard to load...`);

      const currentPageUrl = page.url();
      this.logger.log(`📍 Current page after login: ${currentPageUrl}`);

      if (currentPageUrl.includes("/auth?code=")) {
        this.logger.log(`⏳ Waiting for redirect to dashboard...`);
        try {
          await page.waitForNavigation({
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });
          const newUrl = page.url();
          this.logger.log(`✅ Redirected to: ${newUrl}`);
        } catch (navError) {
          this.logger.warn(`⚠️  Navigation timeout, continuing anyway...`);
        }
      }

      // Wait a bit for the dashboard to stabilize
      await new Promise((resolve) => setTimeout(resolve, 2000));

      this.logger.log(`🔍 Fetching merchant metadata via backend API...`);
      const merchantApiData = await this.fetchMerchantMetadata(
        merchantSession,
        merchantCsrfToken,
      );

      this.logger.debug(
        `📊 Merchant API Data:`,
        JSON.stringify(merchantApiData, null, 2),
      );

      let merchantDetails: any = { upiId: null, displayName: "Paytm Merchant" };

      if (merchantApiData.success && merchantApiData.data) {
        this.logger.log(`✅ Using API data from: ${merchantApiData.source}`);
        const data = merchantApiData.data;

        if (
          merchantApiData.source === "qr_product_api" ||
          merchantApiData.source === "qr_data_api"
        ) {
          // Handle both wrapped and unwrapped response arrays
          const responseList =
            data.response || data.data?.response || data.orderList || [];

          if (responseList.length > 0) {
            // Find the active QR code (usually first, or one with status active)
            const qrInfo = responseList[0];
            const upiMatch = qrInfo.deepLink?.match(/upi:\/\/pay\?pa=([^&]+)/);

            if (upiMatch) {
              merchantDetails.upiId = decodeURIComponent(upiMatch[1]);
            } else if (qrInfo.virtualPaymentAddr) {
              // specific usage
              merchantDetails.upiId = qrInfo.virtualPaymentAddr;
            }

            merchantDetails.displayName =
              qrInfo.displayName || qrInfo.merchantName || "Paytm Merchant";
            merchantDetails.merchantId = qrInfo.mappingId || qrInfo.mid;
          }
        } else if (merchantApiData.source === "profile_api") {
          merchantDetails.upiId =
            data.upiId || data.vpa || data.virtualPaymentAddr || null;
          merchantDetails.displayName =
            data.businessName || data.name || "Paytm Merchant";
          merchantDetails.merchantId = data.mid || data.merchantId;
        }
      }

      if (!merchantDetails.upiId) {
        this.logger.log(`⚠️  API extraction failed, trying page scraping...`);

        const qrPageInfo = await page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          bodyTextLength: document.body.innerText.length,
          bodyTextPreview: document.body.innerText.substring(0, 500),
        }));

        this.logger.log(`📄 Current Page Info:`, qrPageInfo);

        try {
          const screenshotPath = `/tmp/paytm-dashboard-${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          this.logger.log(`📸 Dashboard screenshot saved: ${screenshotPath}`);
        } catch (screenshotError) {
          this.logger.warn("Could not save screenshot");
        }

        merchantDetails = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          const bodyHTML = document.body.innerHTML;

          let upiId = null;

          const paytmMatch = bodyText.match(/(\w+@paytm)/i);
          if (paytmMatch) upiId = paytmMatch[1];

          if (!upiId) {
            const upiMatch = bodyText.match(/(\w+\.[\w.]+@[\w.]+)/);
            if (upiMatch) upiId = upiMatch[1];
          }

          if (!upiId) {
            const upiElements = document.querySelectorAll(
              '[data-upi], [data-vpa], [class*="upi"], [class*="vpa"]',
            );
            for (const el of upiElements) {
              const text = el.textContent?.trim() || "";
              if (text.includes("@")) {
                upiId = text;
                break;
              }
            }
          }

          const nameElement = document.querySelector(
            '[class*="merchant"], [class*="business"], h1, h2',
          );
          const displayName =
            nameElement?.textContent?.trim() || "Paytm Merchant";

          return {
            upiId,
            displayName,
            bodyTextPreview: bodyText.substring(0, 500),
            foundUpiInHTML:
              bodyHTML.includes("@paytm") || bodyHTML.includes("upi"),
          };
        });
      }

      this.logger.log(`📊 Extracted merchant details:`, merchantDetails);

      await browser.close();
      this.browserSessions.delete(sessionId);
      this.logger.log(`🧹 Browser closed and session cleaned up`);

      const fullResponse = {
        status: "SUCCESS",
        merchant_session: merchantSession,
        merchant_csrftoken: merchantCsrfToken,
        upiId: merchantDetails.upiId,
        displayName: merchantDetails.displayName,
        merchantId: merchantDetails.merchantId,
        qrData: merchantApiData.success ? merchantApiData.data : null,
        message: "OTP verified successfully",
      };

      this.logger.log(
        `📦 PAYTM VERIFICATION COMPLETE. UPI ID: ${fullResponse.upiId}`,
      );
      // this.logger.debug(JSON.stringify(fullResponse, null, 2));

      return fullResponse;
    } catch (error: any) {
      this.logger.error("❌ Puppeteer OTP verification failed:", error.message);

      const session = this.browserSessions.get(sessionId);
      if (session) {
        try {
          await session.browser.close();
        } catch (closeError) {
          this.logger.error("Failed to close browser:", closeError);
        }
        this.browserSessions.delete(sessionId);
      }

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException("Failed to verify OTP. Please try again.");
    }
  }

  async verifyOtp(state: string, csrfToken: string, otp: string): Promise<any> {
    try {
      const fakeIP = this.generateRandomIP();
      const url = "https://accounts.paytm.com/login/validate/otp";

      const payload = {
        otp: otp,
        state: state,
        csrfToken: csrfToken,
      };

      const headers = {
        Host: "accounts.paytm.com",
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-Forwarded-For": `${fakeIP}:443`,
        Accept: "application/json",
      };

      this.logger.log(`🔐 Verifying Paytm OTP from fake IP: ${fakeIP}`);
      this.logger.log(`📦 Payload: ${JSON.stringify(payload)}`);
      this.logger.log(`📋 Headers: ${JSON.stringify(headers)}`);

      const response = await axios.post(url, payload, { headers });

      this.logger.log(
        `✅ Paytm OTP Verification Response Status: ${response.status}`,
      );
      this.logger.log(`📄 Full Response: ${JSON.stringify(response.data)}`);

      if (response.data?.redirectUri) {
        this.logger.log(`🔗 Following redirect: ${response.data.redirectUri}`);

        try {
          const redirectResponse = await axios.get(response.data.redirectUri, {
            headers: {
              Host: "dashboard.paytm.com",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              Referer: "https://accounts.paytm.com/",
            },
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 400,
          });

          this.logger.log(
            `✅ Redirect followed, status: ${redirectResponse.status}`,
          );

          const cookies = redirectResponse.headers["set-cookie"] || [];
          let merchantSession = "";
          let merchantCsrfToken = "";

          this.logger.log(
            `🍪 Received ${cookies.length} cookies from redirect`,
          );

          cookies.forEach((cookie: string) => {
            if (cookie.includes("SESSION=")) {
              merchantSession = cookie.split("SESSION=")[1].split(";")[0];
              this.logger.log(
                `📝 Extracted SESSION: ${merchantSession.substring(0, 20)}...`,
              );
            }
            if (cookie.includes("XSRF-TOKEN=")) {
              merchantCsrfToken = cookie.split("XSRF-TOKEN=")[1].split(";")[0];
              this.logger.log(
                `📝 Extracted XSRF-TOKEN: ${merchantCsrfToken.substring(0, 20)}...`,
              );
            }
          });

          if (!merchantSession || !merchantCsrfToken) {
            this.logger.error(
              "❌ Failed to extract session cookies from redirect",
            );
            this.logger.error(`All cookies: ${JSON.stringify(cookies)}`);
            throw new BadRequestException(
              "Failed to get authenticated session from Paytm",
            );
          }

          return {
            status: "SUCCESS",
            merchant_session: merchantSession,
            merchant_csrftoken: merchantCsrfToken,
            message: "OTP verified successfully",
          };
        } catch (redirectError: any) {
          this.logger.error(
            "❌ Error following redirect:",
            redirectError.message,
          );
          throw new BadRequestException(
            "Failed to complete Paytm authentication",
          );
        }
      }

      throw new BadRequestException(response.data?.message || "Invalid OTP");
    } catch (error: any) {
      this.logger.error("❌ Paytm OTP verification failed:", error.message);

      if (error.response) {
        this.logger.error(
          "📄 Paytm Error Response:",
          JSON.stringify(error.response.data),
        );
        const errorMessage =
          error.response.data?.message ||
          error.response.data?.error ||
          "OTP verification failed";
        throw new BadRequestException(errorMessage);
      }

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        "Failed to verify Paytm OTP. Please try again.",
      );
    }
  }

  async getQrCode(
    merchantSession: string,
    merchantCsrfToken: string,
  ): Promise<any> {
    try {
      this.logger.log(`🎯 Fetching Paytm QR code...`);
      this.logger.log(`   SESSION: ${merchantSession.substring(0, 20)}...`);
      this.logger.log(
        `   XSRF-TOKEN: ${merchantCsrfToken.substring(0, 20)}...`,
      );

      const url =
        "https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all&pageNo=1&pageSize=100";

      const headers = {
        Host: "dashboard.paytm.com",
        "XSRF-TOKEN": merchantCsrfToken,
        Cookie: `SESSION=${merchantSession}; XSRF-TOKEN=${merchantCsrfToken}`, // Include both cookies
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://dashboard.paytm.com/",
      };

      this.logger.log(`📤 Making QR code request...`);
      const response = await axios.get(url, { headers });

      this.logger.log(`✅ QR code response status: ${response.status}`);

      if (
        response.data?.statusCode === "200" &&
        response.data?.response?.length > 0
      ) {
        const qrData = response.data.response[0];

        const upiMatch = qrData.deepLink?.match(/upi:\/\/pay\?pa=([^&]+)/);
        const upiId = upiMatch ? decodeURIComponent(upiMatch[1]) : null;

        this.logger.log(`UPI ID extracted: ${upiId}`);

        this.logger.log(`QR Code Data:`, {
          merchantId: qrData.mappingId,
          upiId: upiId,
          displayName: qrData.displayName,
          stickerId: qrData.stickerId,
          deepLink: qrData.deepLink,
        });

        return {
          statusCode: "200",
          merchantId: qrData.mappingId,
          upiId,
          displayName: qrData.displayName,
          stickerId: qrData.stickerId,
          deepLink: qrData.deepLink,
          response: response.data.response,
          merchant_session: merchantSession,
          merchant_csrftoken: merchantCsrfToken,
        };
      }

      throw new BadRequestException("Failed to fetch QR code details");
    } catch (error) {
      this.logger.error("Paytm QR code fetch failed:", error);
      throw new BadRequestException("Failed to get Paytm QR code");
    }
  }

  async connectMerchant(
    merchantId: string,
    phoneNumber: string,
    paytmMerchantId: string,
    upiId: string,
  ): Promise<any> {
    try {
      const existingConnector = await this.prisma.merchantProvider.findFirst({
        where: {
          merchantId,
          providerType: "PAYTM",
        },
      });

      const connectorConfig = {
        phoneNumber,
        paytmMerchantId,
        upiId,
        status: "Active",
      };

      if (existingConnector) {
        const latestCreds = (existingConnector.credentials as any) || {};
        await this.prisma.merchantProvider.update({
          where: { id: existingConnector.id },
          data: {
            accountIdentifier: upiId,
            credentials: { ...latestCreds, ...connectorConfig },
            isActive: true,
          },
        });
      } else {
        await this.prisma.merchantProvider.create({
          data: {
            merchantId,
            providerType: "PAYTM",
            accountIdentifier: upiId,
            credentials: connectorConfig,
            isActive: true,
          },
        });
      }

      this.logger.log(`Paytm merchant connected for merchant ${merchantId}`);

      return {
        success: true,
        message: "Paytm merchant connected successfully",
        paytmMerchantId,
        upiId,
      };
    } catch (error) {
      this.logger.error("Paytm merchant connection failed:", error);
      throw new BadRequestException("Failed to connect Paytm merchant");
    }
  }

  async getTransaction(
    merchantSession: string,
    merchantCsrfToken: string,
    merchantTransId: string,
  ): Promise<any> {
    try {
      const url = "https://dashboard.paytm.com/api/v3/order/list";

      const payload = {
        bizTypeList: ["ACQUIRING"],
        pageSize: 1,
        pageNum: 1,
        merchantTransId: merchantTransId,
        isSort: true,
      };

      const headers = {
        Host: "dashboard.paytm.com",
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": merchantCsrfToken,
        Cookie: `SESSION=${merchantSession}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      };

      const response = await axios.post(url, payload, { headers });

      if (response.data?.status === "SUCCESS" || response.data?.data) {
        return {
          status: "SUCCESS",
          data: response.data.data || response.data,
          merchant_session: merchantSession,
          merchant_csrftoken: merchantCsrfToken,
        };
      }

      return {
        status: "FAILED",
        data: null,
      };
    } catch (error) {
      this.logger.error("Paytm transaction fetch failed:", error);
      return {
        status: "FAILED",
        data: null,
      };
    }
  }

  async checkTransactionStatus(
    orderId: string,
    merchantSession: string,
    merchantCsrfToken: string,
  ): Promise<any> {
    try {
      const result = await this.getTransaction(
        merchantSession,
        merchantCsrfToken,
        orderId,
      );

      if (result.status === "SUCCESS" && result.data) {
        const transaction = result.data;

        return {
          found: true,
          status: transaction.status || transaction.txnStatus,
          amount: transaction.amount || transaction.txnAmount,
          transactionId: transaction.transactionId || transaction.txnId,
          timestamp: transaction.timestamp || transaction.txnDate,
        };
      }

      return {
        found: false,
        status: "PENDING",
      };
    } catch (error) {
      this.logger.error("Paytm transaction status check failed:", error);
      return {
        found: false,
        status: "PENDING",
      };
    }
  }

  async getUserInfo(
    merchantSession: string,
    merchantCsrfToken: string,
  ): Promise<any> {
    try {
      const url = "https://dashboard.paytm.com/api/v1/context";

      const headers = {
        Host: "dashboard.paytm.com",
        "XSRF-TOKEN": merchantCsrfToken,
        Cookie: `SESSION=${merchantSession}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      };

      const response = await axios.get(url, { headers });

      if (response.data) {
        return {
          statusCode: "200",
          data: response.data,
          merchant_session: merchantSession,
          merchant_csrftoken: merchantCsrfToken,
        };
      }

      throw new BadRequestException("Failed to fetch user info");
    } catch (error: any) {
      this.logger.error("Paytm user info fetch failed:", error.message);

      if (error.response?.status === 403) {
        const err: any = new BadRequestException(
          "Session expired (403) - please reconnect",
        );
        err.response = error.response;
        throw err;
      }

      throw new BadRequestException("Failed to get Paytm user info");
    }
  }

  async fetchMerchantMetadata(
    merchantSession: string,
    merchantCsrfToken: string,
  ): Promise<any> {
    const headers = {
      Host: "dashboard.paytm.com",
      "X-XSRF-TOKEN": merchantCsrfToken,
      Cookie: `SESSION=${merchantSession}`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const tryRequest = async (
      url: string,
      method: "GET" | "POST" = "GET",
      data: any = null,
    ) => {
      try {
        const response = await axios({
          url,
          method,
          headers,
          data,
          timeout: 10000,
        });
        return response.data;
      } catch (e: any) {
        this.logger.debug(
          `Metadata API attempt failed for ${url}: ${e.message}`,
        );
        return null;
      }
    };

    // 1. Try Wallet Product API
    const qrProduct = await tryRequest(
      "https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all&pageNo=1&pageSize=100",
    );
    if (qrProduct) {
      if (
        (qrProduct.response && qrProduct.response.length > 0) ||
        (qrProduct.data?.response && qrProduct.data.response.length > 0)
      ) {
        return { success: true, data: qrProduct, source: "qr_product_api" };
      }
    }

    // 2. Try Standard QR Data API
    const qrData = await tryRequest(
      "https://dashboard.paytm.com/api/v1/merchant/user/qr-data",
      "POST",
      {},
    );
    if (qrData) {
      if (qrData.response || qrData.statusCode === "SUCCESS") {
        return { success: true, data: qrData, source: "qr_data_api" };
      }
    }

    // 3. Try Profile API
    const profileData = await tryRequest(
      "https://dashboard.paytm.com/api/v1/merchant/profile",
    );
    if (profileData) {
      return { success: true, data: profileData, source: "profile_api" };
    }

    return { success: false, error: "All backend metadata APIs failed" };
  }

  async fetchTransactionHistory(
    merchantSession: string,
    merchantCsrfToken: string,
    fromDate: Date,
    toDate: Date,
    pageNo: number = 1,
    pageSize: number = 100,
  ): Promise<any> {
    try {
      this.logger.log(
        `📊 Fetching Paytm transaction history from ${fromDate.toISOString()} to ${toDate.toISOString()}`,
      );

      const url = "https://dashboard.paytm.com/api/v3/order/list";
      const normalizedPageSize = Math.min(50, Math.max(1, pageSize));

      const headers = {
        Host: "dashboard.paytm.com",
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": merchantCsrfToken,
        "XSRF-TOKEN": merchantCsrfToken,
        Cookie: `SESSION=${merchantSession}; XSRF-TOKEN=${merchantCsrfToken}`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://dashboard.paytm.com/",
        Origin: "https://dashboard.paytm.com",
      };

      // Format dates as ISO strings with timezone (Paytm requires timezone offset)
      // Example format: "2021-01-25T23:59:35+05:30"
      const formatDateWithTimezone = (date: Date): string => {
        // Convert UTC to IST (UTC + 5:30)
        const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds
        const istTime = new Date(date.getTime() + istOffset);

        // Format as YYYY-MM-DDTHH:MM:SS
        const year = istTime.getUTCFullYear();
        const month = String(istTime.getUTCMonth() + 1).padStart(2, "0");
        const day = String(istTime.getUTCDate()).padStart(2, "0");
        const hours = String(istTime.getUTCHours()).padStart(2, "0");
        const minutes = String(istTime.getUTCMinutes()).padStart(2, "0");
        const seconds = String(istTime.getUTCSeconds()).padStart(2, "0");

        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+05:30`;
      };

      const fromDateStr = formatDateWithTimezone(fromDate);
      const toDateStr = formatDateWithTimezone(toDate);

      const payload = {
        bizTypeList: ["ACQUIRING"],
        orderCreatedStartTime: fromDateStr,
        orderCreatedEndTime: toDateStr,
        pageSize: normalizedPageSize,
        pageNum: pageNo,
        isSort: true,
      };

      this.logger.log(
        `📤 Requesting transactions with payload: ${JSON.stringify(payload)}`,
      );

      const response = await axios.post(url, payload, { headers });

      this.logger.log(
        `✅ Transaction history response status: ${response.status}`,
      );

      const isSuccess =
        response.data?.resultInfo?.resultStatus === "S" ||
        response.data?.resultInfo?.resultCode === "SUCCESS" ||
        response.data?.status === "SUCCESS" ||
        response.data?.code === 200;

      if (response.data && isSuccess) {
        const transactions =
          response.data.orderList ||
          response.data.data?.list ||
          response.data.data?.orderList ||
          [];
        const total =
          response.data.total ||
          response.data.data?.total ||
          transactions.length;

        if (transactions.length > 0) {
          this.logger.log(
            `📊 Found ${transactions.length} transactions (total: ${total})`,
          );
          // Log full first transaction for debugging
          this.logger.debug(
            `First transaction sample:`,
            JSON.stringify(transactions[0], null, 2),
          );
        } else {
          this.logger.log(
            `ℹ️ No transactions found in the specified date range`,
          );
        }

        return {
          success: true,
          transactions,
          total,
        };
      }

      const paytmErrorMsg =
        response.data?.resultInfo?.resultMsg ||
        response.data?.resultInfo?.resultCode ||
        "Unexpected Paytm response format";
      if (response.data?.resultInfo?.resultStatus === "F") {
        this.logger.warn(`❌ Paytm rejected request: ${paytmErrorMsg}`);
        return {
          success: false,
          transactions: [],
          total: 0,
          error: paytmErrorMsg,
        };
      }

      this.logger.warn("❌ Unexpected response format");
      this.logger.warn("Response:", JSON.stringify(response.data));

      return {
        success: false,
        transactions: [],
        total: 0,
        error: "Unexpected Paytm response format",
        statusCode: response?.status,
      };
    } catch (error: any) {
      this.logger.error(
        "Paytm transaction history fetch failed:",
        error.message,
      );

      if (error.response) {
        this.logger.error("Response status:", error.response.status);
        this.logger.error(
          "Response data:",
          JSON.stringify(error.response.data).substring(0, 500),
        );
      }

      const statusCode = error?.response?.status;
      const sessionExpired = statusCode === 403;

      return {
        success: false,
        transactions: [],
        total: 0,
        error: error.message,
        statusCode,
        sessionExpired,
      };
    }
  }

  generatePaymentIntents(
    upiId: string,
    amount: number,
    merchantName: string,
    transactionRef: string,
  ): { bhimLink: string; paytmLink: string } {
    const bhimLink = `upi://pay?pa=${upiId}&am=${amount}&pn=${encodeURIComponent(merchantName)}&tn=${transactionRef}&tr=${transactionRef}`;

    const paytmLink = `paytmmp://cash_wallet?pa=${upiId}&pn=${encodeURIComponent(merchantName)}&am=${amount}&cu=INR&tn=${transactionRef}&tr=${transactionRef}&mc=4722&&sign=AAuN7izDWN5cb8A5scnUiNME+LkZqI2DWgkXlN1McoP6WZABa/KkFTiLvuPRP6/nWK8BPg/rPhb+u4QMrUEX10UsANTDbJaALcSM9b8Wk218X+55T/zOzb7xoiB+BcX8yYuYayELImXJHIgL/c7nkAnHrwUCmbM97nRbCVVRvU0ku3Tr&featuretype=money_transfer`;

    return {
      bhimLink,
      paytmLink,
    };
  }
}

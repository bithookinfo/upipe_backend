import { Injectable, Logger, BadRequestException, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import axios from "axios";
import puppeteer from "puppeteer-extra";
import {
  getPhonePeSessionSignals,
  shouldTreatAsTransientPhonePeSessionDrift,
} from "./phonepe-session.util";

const StealthPlugin = require("puppeteer-extra-plugin-stealth");

class Semaphore {
  private tasks: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) { }
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise(resolve => this.tasks.push(resolve));
  }
  release() {
    this.active--;
    const next = this.tasks.shift();
    if (next) {
      this.active++;
      next();
    }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
}
const browserSemaphore = new Semaphore(2);

@Injectable()
export class PhonePeWebService implements OnModuleDestroy {
  private readonly logger = new Logger(PhonePeWebService.name);

  async onModuleDestroy() {
    this.logger.log("🛑 Shutting down PhonePeWebService, no persistent browsers to close (ephemeral).");
  }
  private readonly loginPageUrl = "https://business.phonepe.com/login";
  private readonly webApiBase = "https://web-api.phonepe.com";
  /** Analytics / telemetry host (see Burp: bulk/ingest pairs with transactions/recent on live page). */
  private readonly apiPhonePeBase = "https://api.phonepe.com";
  // Keep these aligned with latest Burp captures.
  private readonly webDesktopUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
  private readonly webSecChUa = '"Not-A.Brand";v="24", "Chromium";v="146"';
  private readonly profileRoot =
    process.env.PHONEPE_PERSISTENT_PROFILE_ROOT ||
    `${process.cwd()}/.phonepe-profiles`;

  // Send OTP endpoint (from Burp capture)
  private readonly sendOtpPath = "/apis/mi-web/v2/auth/web/login/initiate";
  // Verify OTP endpoint (from Burp capture)
  private readonly verifyOtpPath = "/apis/mi-web/v4/auth/web/login";

  private stealthInitialized = false;

  // Persistent browser contexts keyed by fingerprint (web identity).
  // This mimics a real browser staying logged in for days.
  // Persistent contexts removed to prevent memory leaks. Browsers are now ephemeral.
  private persistentLocks = new Map<string, Promise<void>>();
  private browserLaunchLocks = new Map<string, Promise<void>>();

  // Cooldown after refresh failure (PhonePe returns 401 from server). Key: fingerprint, Value: last failure timestamp.
  private refreshFailureCooldown = new Map<string, number>();
  private readonly REFRESH_COOLDOWN_MS = 120_000; // 2 min - avoid spamming refresh when it consistently fails
  /** Proactive /auth/refresh when JWT has less than this many seconds left (Burp: refresh before short-lived JWT dies). */
  private readonly jwtProactiveRefreshSeconds = 1800;

  // Store session data between sendOtp and verifyOtp
  private webSessions: Map<
    string,
    {
      cookies: string;
      csrfToken: string;
      fingerprint: string;
      token: string;
      phoneNumber: string;
      sitekey?: string;
    }
  > = new Map();

  private initStealth() {
    if (!this.stealthInitialized) {
      puppeteer.use(StealthPlugin());
      this.stealthInitialized = true;
    }
  }

  private sanitizeProfileKey(key: string): string {
    if (!key || key === "default") return "default";
    // Use a hash for long fingerprints to avoid folder name collisions/limits
    const hash = require("crypto").createHash("md5").update(key).digest("hex");
    const prefix = key.split(".")[0].replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
    return `${prefix}_${hash}`;
  }

  private async optimizePuppeteerPage(page: any) {
    try {
      await page.setRequestInterception(true);
      page.on('request', (request: any) => {
        if (request.isInterceptResolutionHandled()) return;
        const resourceType = request.resourceType();
        if (['image', 'media', 'font'].includes(resourceType)) {
          request.abort().catch(() => { });
        } else {
          request.continue().catch(() => { });
        }
      });
    } catch (e: any) {
      this.logger.warn(`Could not optimize Puppeteer page: ${e?.message}`);
    }
  }

  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Per-key mutex with a hard timeout to prevent permanent deadlocks.
    // CRITICAL: on timeout we also CLOSE the persistent browser for this key so
    // the next attempt launches a fresh one instead of reusing a zombie browser
    // whose page.goto/page.evaluate is still hung in the background.
    const forceHttp =
      String(process.env.PHONEPE_WEB_FORCE_HTTP || "true").toLowerCase() !==
      "false";
    const LOCK_TIMEOUT_MS = forceHttp ? 10_000 : 30_000;
    const prev = this.persistentLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.persistentLocks.set(key, next);

    // Wait for previous holder but cap the wait.
    let prevTimer: ReturnType<typeof setTimeout> | null = null;
    let prevTimedOut = false;
    await Promise.race([
      prev,
      new Promise<void>((resolve) => {
        prevTimer = setTimeout(() => {
          prevTimedOut = true;
          this.logger.warn(`⚠️ withKeyLock: timed out waiting for previous holder on key "${key}"; breaking deadlock`);
          resolve();
        }, LOCK_TIMEOUT_MS);
      }),
    ]);

    if (prevTimer) clearTimeout(prevTimer);

    // If we broke through a stuck predecessor, kill its zombie browser so we start fresh.
    if (prevTimedOut) {
      await this.closePersistentBrowserForKey(key);
    }

    let lockTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          lockTimer = setTimeout(async () => {
            this.logger.error(`🔒 withKeyLock: fn() timed out after ${LOCK_TIMEOUT_MS}ms on key "${key}"; killing zombie browser`);
            // Kill the browser so the hung page.goto/evaluate is aborted
            await this.closePersistentBrowserForKey(key);
            reject(new Error(`withKeyLock: fn() timed out after ${LOCK_TIMEOUT_MS}ms for key "${key}"`));
          }, LOCK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (lockTimer) clearTimeout(lockTimer);
      release();
      if (this.persistentLocks.get(key) === next) this.persistentLocks.delete(key);
    }
  }

  /** Close and discard the persistent browser for a sanitized key. Safe to call even if no browser exists. */
  private async closePersistentBrowserForKey(key: string): Promise<void> {
    // No-op: browsers are now ephemeral and closed immediately by callers.
  }

  private async getPersistentBrowser(fingerprint: string) {
    const key = this.sanitizeProfileKey(fingerprint || "default");

    // Launch path: take a dedicated launch lock to avoid concurrent launch attempts
    const prev = this.browserLaunchLocks.get(key) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.browserLaunchLocks.set(key, prev.then(() => next));
    await prev;

    try {
      this.initStealth();
      const userDataDir = path.join(this.profileRoot, key);
      try {
        fs.mkdirSync(userDataDir, { recursive: true });
      } catch { }

      // Cleanup stale SingletonLock if it exists (Puppeteer fails to launch if this file exists from a previous crash)
      const lockFile = path.join(userDataDir, "SingletonLock");
      if (fs.existsSync(lockFile)) {
        this.logger.warn(`🧹 Removing stale SingletonLock for key ${key} at ${lockFile}`);
        try {
          fs.unlinkSync(lockFile);
        } catch (unlinkErr: any) {
          this.logger.error(`❌ Failed to remove stale SingletonLock: ${unlinkErr.message}`);
        }
      }

      this.logger.log(`🚀 Launching ephemeral browser for persistent profile key: ${key}`);
      const browser = await puppeteer.launch({
        headless: "new" as any,
        userDataDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,800",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      });

      const ctx = { browser, lastUsedAt: Date.now(), userDataDir };
      return ctx;
    } finally {
      release();
      if (this.browserLaunchLocks.get(key) === next) this.browserLaunchLocks.delete(key);
    }
  }

  private async snapshotCookiesFromPage(page: any): Promise<string> {
    const apiCookies = await page.cookies("https://web-api.phonepe.com");
    const bizCookies = await page.cookies("https://business.phonepe.com");
    const allCookies = [...apiCookies, ...bizCookies];
    const seen = new Set<string>();
    const unique = allCookies.filter((c: { name: string }) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
    return unique
      .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
      .join("; ");
  }

  private extractCsrfFromCookiesString(cookieStr: string): string {
    return (
      this.extractTokenFromCookies(cookieStr, "_X52F70K3N") ||
      this.extractTokenFromCookies(cookieStr, "_CKB2N1BHVZ") ||
      ""
    );
  }

  /** HttpOnly-aware CSRF from the browser jar (document.cookie cannot see HttpOnly). */
  private async extractCsrfFromPageCookieJar(page: any): Promise<string> {
    const apiCookies = await page.cookies("https://web-api.phonepe.com");
    const bizCookies = await page.cookies("https://business.phonepe.com");
    const all = [...apiCookies, ...bizCookies];
    const x52 = all.find((c: { name: string }) => c.name === "_X52F70K3N")
      ?.value;
    const ckb = all.find((c: { name: string }) => c.name === "_CKB2N1BHVZ")
      ?.value;
    return x52 || ckb || "";
  }

  private safeString(value: any, maxLen = 180): string {
    if (value == null) return "";
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
  }

  private extractFailureSummary(body: any): string {
    if (!body) return "";
    const source =
      typeof body === "string"
        ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })()
        : body;
    if (typeof source === "string") return this.safeString(source, 120);
    const code =
      source?.code ||
      source?.errorCode ||
      source?.data?.code ||
      source?.data?.errorCode ||
      source?.responseCode ||
      "";
    const message =
      source?.message ||
      source?.error ||
      source?.data?.message ||
      source?.data?.error ||
      source?.description ||
      "";
    const result = [code ? `code=${code}` : "", message ? `msg=${this.safeString(message, 120)}` : ""]
      .filter(Boolean)
      .join(" ");
    return result || this.safeString(source, 120);
  }

  private buildSessionSignalSnapshot(cookies: string, csrfToken?: string): string {
    const hasAuth = !!this.extractTokenFromCookies(cookies || "", "MERCHANT_USER_A_TOKEN");
    const hasRefresh = !!this.extractTokenFromCookies(cookies || "", "MERCHANT_USER_R_TOKEN");
    const hasCsrfCookie =
      !!this.extractTokenFromCookies(cookies || "", "_X52F70K3N") ||
      !!this.extractTokenFromCookies(cookies || "", "_CKB2N1BHVZ");
    const hasTrustCid = !!this.extractTokenFromCookies(cookies || "", "_ppabwdcid");
    const hasTrustSid = !!this.extractTokenFromCookies(cookies || "", "_ppabwdsid");
    const csrfHeader = !!csrfToken;
    return `auth=${hasAuth} refresh=${hasRefresh} csrfCookie=${hasCsrfCookie} csrfHeader=${csrfHeader} trustCid=${hasTrustCid} trustSid=${hasTrustSid}`;
  }

  /**
   * When PhonePe responds CF004 (invalid csrf), the browser SPA typically reboots the CSRF pair.
   * Do the same from inside the tab so Set-Cookie updates the HttpOnly jar.
   */
  private async bootstrapCsrfPairInPageContext(
    page: any,
    fingerprint: string,
  ): Promise<{ ok: boolean; newCsrf: string; cookiesString: string; status: number }> {
    try {
      this.logger.log(`🧩 CSRF bootstrap: calling /auth/logout inside tab...`);
      const fpHeader = this.fingerprintForWebApi(
        await this.snapshotCookiesFromPage(page).catch(() => ""),
        fingerprint,
      );
      const res = await page.evaluate(async (fp: string) => {
        try {
          const r = await fetch("https://web-api.phonepe.com/apis/mi-web/v1/auth/logout", {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "Content-Type": "application/json",
              "X-App-Id": "oculus",
              "X-Source-Type": "WEB",
              "X-Source-Platform": "WEB",
              Namespace: "insights",
              Fingerprint: fp,
              "X-Device-Fingerprint": "123",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
            },
            body: "null",
          });
          const t = await r.text();
          return {
            status: r.status,
            ok: r.ok,
            csrf: r.headers.get("x-csrf-token") || "",
            bodySnippet: t ? t.slice(0, 140) : "",
          };
        } catch (e: any) {
          return { status: 0, ok: false, csrf: "", bodySnippet: e?.message || "fetch error" };
        }
      }, fpHeader);

      if (res?.csrf) {
        await page.setCookie({
          name: "_X52F70K3N",
          value: res.csrf,
          domain: ".phonepe.com",
          path: "/",
          secure: true,
          sameSite: "Lax",
        });
      }
      const cookiesString = await this.snapshotCookiesFromPage(page).catch(() => "");
      const newCsrf =
        this.extractTokenFromCookies(cookiesString, "_X52F70K3N") ||
        this.extractTokenFromCookies(cookiesString, "_CKB2N1BHVZ") ||
        res?.csrf ||
        "";
      this.logger.log(
        `🧩 CSRF bootstrap result: status=${Number(res?.status || 0)} ok=${!!res?.ok} hasNewCsrf=${!!newCsrf}`,
      );
      return { ok: !!res?.ok, newCsrf, cookiesString, status: Number(res?.status || 0) };
    } catch (e: any) {
      return { ok: false, newCsrf: "", cookiesString: "", status: 0 };
    }
  }

  /**
   * Generate the web-style fingerprint (from Burp capture).
   * Format: pbweb_<hash>_<random> repeated 4 times separated by dots.
   * To reduce 412s due to fingerprint mismatch, this is deterministic when a seed is provided
   * (e.g. phoneNumber or deviceFingerprint).
   */
  public generateWebFingerprint(seed?: string): string {
    const crypto = require("crypto");
    // If we have a seed (deviceFingerprint / phoneNumber), derive a stable hash from it.
    const base = seed || crypto.randomBytes(16).toString("hex");
    const hash = crypto
      .createHash("sha256")
      .update(base)
      .digest("hex")
      .slice(0, 32);
    // Short random-looking suffix derived from hash to avoid pure repetition.
    const rand = hash.slice(0, 5);
    const segment = `pbweb_${hash}_${rand}`;
    return `${segment}.${segment}.${segment}.${segment}`;
  }

  private generateRandomString(length: number): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Merges new cookies from Set-Cookie headers into an existing cookie string.
   */
  private mergeCookies(
    currentCookies: string,
    setCookieHeaders: string | string[] | undefined,
  ): string {
    if (!setCookieHeaders) return currentCookies;

    const cookieArray = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : [setCookieHeaders];
    let updatedCookies = currentCookies;

    for (const cookie of cookieArray) {
      const [nameVal] = cookie.split(";");
      if (nameVal && nameVal.includes("=")) {
        const [name, ...valParts] = nameVal.split("=");
        const val = valParts.join("=");

        const regex = new RegExp(`(^|;\\s*)${name.trim()}=[^;]+`);
        if (updatedCookies.match(regex)) {
          updatedCookies = updatedCookies.replace(
            regex,
            `$1${name.trim()}=${val.trim()}`,
          );
        } else {
          updatedCookies +=
            (updatedCookies ? `; ` : "") + `${name.trim()}=${val.trim()}`;
        }
      }
    }
    return updatedCookies;
  }

  /**
   * Parse cookie string into Puppeteer cookie format for .phonepe.com so
   * requests from the page (e.g. to web-api.phonepe.com) send the same cookies.
   */
  private parseCookiesForPuppeteer(
    cookieStr: string,
  ): Array<{ name: string; value: string; domain: string; path: string }> {
    if (!cookieStr || !cookieStr.trim()) return [];
    const list: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
    }> = [];
    const parts = cookieStr.split(";");
    for (const part of parts) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!name) continue;
      list.push({ name, value, domain: ".phonepe.com", path: "/" });
    }
    return list;
  }

  /**
   * PhonePe Web flow requires additional "trust" cookies (e.g. _ppabwd*)
   * that are often created only after real browser navigation.
   * We bootstrap them inside the persistent profile and then re-snapshot cookies.
   */
  private async bootstrapPersistentTrustCookies(
    fingerprint: string,
    cookiesString: string,
  ): Promise<{ cookiesString: string; csrfToken: string }> {
    const browserCtx = await this.getPersistentBrowser(fingerprint);
    const page = await browserCtx.browser.newPage();
    await this.optimizePuppeteerPage(page);
    try {
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      );
      const shortFp = (fingerprint || "").split(".")[0] || "";

      let workingCookies = cookiesString || "";

      // Navigate first so .phonepe.com domain is initialized for setCookie.
      await page.goto("https://business.phonepe.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      const cookieList = this.parseCookiesForPuppeteer(workingCookies);
      if (cookieList.length > 0) {
        await page.setCookie(...cookieList);
      }

      // Burp shows _ppabwd* is set by api.phonepe.com "garfield ingest".
      // In headless Chrome, third-party Set-Cookie may be blocked; so:
      // 1) call ingest from the browser context
      // 2) capture Set-Cookie from Puppeteer response headers (even if the browser refuses to apply it)
      // 3) merge cookies and inject them into the persistent browser profile.
      try {
        // First, try the garfield init call (often safe, returns Set-Cookie for _ppabwd*).
        // We do this via axios because the browser may not accept third-party cookies.
        try {
          const initUrl =
            "https://api.phonepe.com/apis/garfield/v1/init/BUSINESS_WEB_DASHBOARD";
          const initRes = await axios.post(initUrl, null, {
            headers: {
              Host: "api.phonepe.com",
              Cookie: workingCookies,
              "Content-Type": "application/json",
              Accept: "*/*",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
              "X-Namespace-Id": "BUSINESS_WEB_DASHBOARD",
            } as any,
            timeout: 15000,
            validateStatus: (s) => s < 500,
          });

          const initSc = initRes.headers?.["set-cookie"];
          const initArr = Array.isArray(initSc) ? initSc : initSc ? [initSc] : [];
          const initNames = initArr
            .map((x: string) =>
              String(x || "").split(";")[0].split("=")[0].trim(),
            )
            .filter(Boolean);
          this.logger.log(
            `🧩 [trust-bootstrap] garfield init: ${initRes.status} set-cookie=[${[
              ...new Set(initNames),
            ].join(", ")}]`,
          );

          if (initArr.length > 0) {
            workingCookies = this.mergeCookies(workingCookies, initArr);
            const initCookieList = this.parseCookiesForPuppeteer(workingCookies);
            if (initCookieList.length > 0) {
              await page.setCookie(...initCookieList);
            }
          }
        } catch (e: any) {
          this.logger.warn(
            `🧩 [trust-bootstrap] garfield init failed: ${e?.message || String(e)}`,
          );
        }

        const ingestUrl =
          "https://api.phonepe.com/apis/garfield/v1/BUSINESS_WEB_DASHBOARD/auth/ingest";

        // Ensure we're on business origin (matches Burp's CORS allowlist)
        await page.goto("https://business.phonepe.com/dashboard", {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });

        const waitResp = page
          .waitForResponse(
            (r) =>
              r.url() === ingestUrl &&
              r.request()?.method?.() === "POST",
            { timeout: 12000 },
          )
          .catch(() => null);

        await page
          .evaluate(
            async ({ fp, url }) => {
              const body = {
                screenResolution: `${window.screen.width}x${window.screen.height}`,
                screenColorDepth: `${window.screen.colorDepth}-bit`,
                screenWidth: window.screen.width,
                screenHeight: window.screen.height,
                referer: window.location.href,
                pageUrl: window.location.href,
                trackerId: "PHONEPE_MERCHANT_OFFLINE",
                events: [],
              };

              await fetch(url, {
                method: "POST",
                credentials: "include",
                headers: {
                  "Content-Type": "application/json",
                  "X-Namespace-Id": "BUSINESS_WEB_DASHBOARD",
                  "X-Device-Fingerprint": fp,
                  "X-Source-Version": "2.12.41",
                  Accept: "*/*",
                },
                body: JSON.stringify(body),
              }).catch(() => { });
            },
            { fp: shortFp, url: ingestUrl },
          )
          .catch(() => { });

        const ingestResp: any = await waitResp;
        const headers = ingestResp ? ingestResp.headers?.() : null;
        const setCookieHeader =
          headers?.["set-cookie"] ||
          headers?.["Set-Cookie"] ||
          null;

        const scArr = Array.isArray(setCookieHeader)
          ? setCookieHeader
          : setCookieHeader
            ? [setCookieHeader]
            : [];
        const scNames = scArr
          .map((x: string) =>
            String(x || "").split(";")[0].split("=")[0].trim(),
          )
          .filter(Boolean);

        this.logger.log(
          `🧩 [trust-bootstrap] garfield ingest(browser): ${ingestResp ? ingestResp.status?.() : "NO_RESP"
          } set-cookie=[${[...new Set(scNames)].join(", ")}]`,
        );

        if (scArr.length > 0) {
          workingCookies = this.mergeCookies(workingCookies, scArr);
          const newCookieList = this.parseCookiesForPuppeteer(workingCookies);
          if (newCookieList.length > 0) {
            await page.setCookie(...newCookieList);
          }
        }

        if (
          workingCookies.includes("_ppabwdcid=") ||
          workingCookies.includes("_ppabwdsid=")
        ) {
          this.logger.log(
            `🧩 [trust-bootstrap] _ppabwd* present after browser-captured merge`,
          );
        } else {
          this.logger.warn(
            `🧩 [trust-bootstrap] _ppabwd* still missing after browser-captured merge`,
          );
        }
      } catch (e: any) {
        this.logger.warn(
          `🧩 [trust-bootstrap] garfield ingest failed: ${e?.message || String(e)}`,
        );
        // Best-effort; we still continue with navigation/snapshot.
      }

      // Visit web-api after trust cookies are potentially issued.
      await page.goto("https://web-api.phonepe.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      // Snapshot from both origins; merge to one cookie string.
      const cookiesA = await page.cookies("https://business.phonepe.com");
      const cookiesB = await page.cookies("https://web-api.phonepe.com");
      const cookiesC: any[] = await page
        .cookies("https://api.phonepe.com")
        .catch(() => []);
      const merged = [...cookiesA, ...cookiesB, ...cookiesC];
      const cookiesOut = merged
        .map((c) => `${c.name}=${c.value}`)
        // de-dupe by keeping last occurrence
        .filter((kv, idx, arr) => arr.lastIndexOf(kv) === idx)
        .join("; ");

      const csrf =
        merged.find((c) => c.name === "_X52F70K3N")?.value ||
        this.extractTokenFromCookies(cookiesOut, "_X52F70K3N") ||
        "";

      return { cookiesString: cookiesOut, csrfToken: csrf };
    } finally {
      await page.close().catch(() => { });
      await browserCtx.browser.close().catch(() => { });
    }
  }

  /**
   * Keepalive helper: when DB is missing cookiesString/csrfToken, recover them from the
   * persistent browser profile (this is the closest thing to a "real browser session").
   */
  async getWebSessionSnapshotFromPersistentBrowser(
    fingerprint: string,
  ): Promise<{ cookiesString: string; csrfToken: string }> {
    const browserCtx = await this.getPersistentBrowser(fingerprint);
    const page = await browserCtx.browser.newPage();
    await this.optimizePuppeteerPage(page);
    try {
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(this.webDesktopUa);
      page.setDefaultNavigationTimeout(20000);
      page.setDefaultTimeout(20000);

      await page.goto("https://business.phonepe.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await new Promise((r) => setTimeout(r, 500));

      const cookiesString =
        (await this.snapshotCookiesFromPage(page).catch(() => "")) || "";
      const csrfToken =
        (await this.extractCsrfFromPageCookieJar(page).catch(() => "")) ||
        this.extractCsrfFromCookiesString(cookiesString) ||
        "";
      return { cookiesString, csrfToken };
    } finally {
      await page.close().catch(() => { });
      await browserCtx.browser.close().catch(() => { });
    }
  }

  /**
   * Extract the expiry timestamp (unix seconds) from the JWT in MERCHANT_USER_A_TOKEN cookie.
   */
  private extractJwtExpiry(cookies: string): number | null {
    const match = cookies.match(/MERCHANT_USER_A_TOKEN=([^;]+)/);
    if (!match || !match[1]) return null;
    try {
      const parts = match[1].split(".");
      if (parts.length !== 3) return null;
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      );
      return typeof payload.exp === "number" ? payload.exp : null;
    } catch {
      return null;
    }
  }

  /**
   * Extract PhonePe session id (`sid`) from MERCHANT_USER_A_TOKEN JWT payload.
   */
  private extractJwtSessionId(cookies: string): string | null {
    const match = cookies.match(/MERCHANT_USER_A_TOKEN=([^;]+)/);
    if (!match || !match[1]) return null;
    try {
      const parts = match[1].split(".");
      if (parts.length !== 3) return null;
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      );
      return typeof payload.sid === "string" ? payload.sid : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns true if the JWT in cookies is expired or will expire within `bufferSeconds`.
   */
  private isJwtExpiredOrExpiring(
    cookies: string,
    bufferSeconds: number = 300,
  ): boolean {
    const exp = this.extractJwtExpiry(cookies);
    if (exp === null) return true;
    return Date.now() / 1000 >= exp - bufferSeconds;
  }

  /**
   * Extract a named token value from a cookie string.
   */
  private extractTokenFromCookies(
    cookies: string,
    tokenName: string,
  ): string | null {
    const regex = new RegExp(`${tokenName}=([^;]+)`);
    const match = cookies.match(regex);
    return match && match[1] ? match[1] : null;
  }

  /**
   * PhonePe stores the session-bound browser segment in `_F1P21N7`. The web-api
   * `Fingerprint` header must match that cookie (Burp: segment repeated 4x).
   * Using only the DB fingerprint while cookies carry a different `_F1P21N7`
   * yields CF004 / invalid csrf and 412 after JWT expiry.
   */
  private fingerprintForWebApi(
    cookies: string | null | undefined,
    fingerprint: string,
  ): string {
    const jar = String(cookies || "");
    const fromCookie = (this.extractTokenFromCookies(jar, "_F1P21N7") || "").trim();
    const base = fromCookie || String(fingerprint || "").trim();
    if (!base) return "";
    return base.includes(".")
      ? base
      : `${base}.${base}.${base}.${base}`;
  }

  private ensureF1P21N7InCookies(cookies: string, fingerprint: string): string {
    if (!fingerprint) return cookies;
    const existing = this.extractTokenFromCookies(cookies, "_F1P21N7");
    if (existing) return cookies;
    const segment = fingerprint.split(".")[0];
    const prefix = cookies && !cookies.trim().endsWith(";") ? "; " : "";
    return `${cookies}${prefix}_F1P21N7=${segment};`;
  }

  /**
   * Build the common headers used for web-api.phonepe.com requests.
   */
  private buildWebHeaders(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    authToken?: string,
  ): Record<string, string> {
    const cookiesWithFp = this.ensureF1P21N7InCookies(cookies, fingerprint);
    // Burp invariant: X-Csrf-Token must match _X52F70K3N cookie value.
    // If the cookie is present, prefer it over any passed csrfToken.
    const csrfFromCookie =
      this.extractTokenFromCookies(cookiesWithFp || "", "_X52F70K3N") || "";
    const effectiveCsrf = csrfFromCookie || csrfToken;
    const fpHeader = this.fingerprintForWebApi(cookiesWithFp, fingerprint);

    const headers: Record<string, string> = {
      Host: "web-api.phonepe.com",
      Cookie: cookiesWithFp,
      "Sec-Ch-Ua-Platform": '"macOS"',
      "X-Csrf-Token": effectiveCsrf,
      "Accept-Language": "en-GB,en;q=0.9",
      Fingerprint: fpHeader,
      "X-Device-Fingerprint": "123",
      "Sec-Ch-Ua": this.webSecChUa,
      "Sec-Ch-Ua-Mobile": "?0",
      "X-App-Id": "oculus",
      "X-Source-Type": "WEB",
      "User-Agent": this.webDesktopUa,
      Accept: "application/json, text/plain, */*",
      Namespace: "insights",
      "Content-Type": "application/json",
      "X-Source-Platform": "WEB",
      Origin: "https://business.phonepe.com",
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Referer: "https://business.phonepe.com/",
      "Accept-Encoding": "gzip, deflate, br",
      Priority: "u=1, i",
      Connection: "keep-alive",
    };

    // Required for most mi-web endpoints (e.g. /transactions/*). Without this, PhonePe returns 403.
    if (authToken && authToken.trim()) {
      headers.Authorization = `O-Bearer ${authToken}`;
    }

    return headers;
  }

  /**
   * Headers for POST https://api.phonepe.com/apis/unified-ingestion/v5/bulk/ingest
   * (decoded from burp/see, burp/seee — same cookies + CSRF + fingerprint as web-api).
   */
  private buildBulkIngestHeaders(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
  ): Record<string, string> {
    const cookiesWithFp = this.ensureF1P21N7InCookies(cookies, fingerprint);
    const csrfFromCookie =
      this.extractTokenFromCookies(cookiesWithFp || "", "_X52F70K3N") || "";
    const effectiveCsrf = csrfFromCookie || csrfToken;
    const fp = this.fingerprintForWebApi(cookiesWithFp, fingerprint);
    return {
      Cookie: cookiesWithFp,
      "X-Csrf-Token": effectiveCsrf,
      "Accept-Language": "en-GB,en;q=0.9",
      Fingerprint: fp,
      "X-Device-Fingerprint": "123",
      "Sec-Ch-Ua": this.webSecChUa,
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "X-App-Id": "oculus",
      "X-Source-Type": "WEB",
      "User-Agent": this.webDesktopUa,
      Accept: "application/json, text/plain, */*",
      Namespace: "insights",
      "Content-Type": "application/json",
      "X-Source-Platform": "WEB",
      Origin: "https://business.phonepe.com",
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      Referer: "https://business.phonepe.com/",
      "Accept-Encoding": "gzip, deflate, br",
      Priority: "u=1, i",
    };
  }

  /**
   * Mirrors the browser's `bulk/ingest` networkMetric after `transactions/recent`
   * (LIVE_TRANSACTIONS_PAGE / getLiveTransactionsV2). Optional; requires analytics IDs.
   */
  private fireBulkIngestAfterRecentNonBlocking(params: {
    cookiesString: string;
    csrfToken: string;
    fingerprint: string;
    latencySec: number;
    merchantId: string;
    phonePeUserId: string;
    merchantUserId: string;
  }): void {
    const body = [
      {
        meta: {
          schemaName: "STREAMS_EVENT",
          sensitivity: "LOW",
          source: "WEB",
          batchId: randomUUID(),
        },
        dataPoints: [
          {
            data: {
              app: "pb_web_analytics",
              eventType: "networkMetric",
              groupingKey: randomUUID(),
              farmId: "nm5",
              eventSchemaVersion: "v1",
              eventTTLBucket: "MEDIUM",
              eventData: {
                name: "API_LATENCY",
                value: "NA",
                userId: params.phonePeUserId,
                merchantId: params.merchantId,
                merchantUserId: params.merchantUserId,
                merchantType: "OFFLINE_MERCHANT",
                pageName: "LIVE_TRANSACTIONS_PAGE",
                featureType: {
                  testMode: false,
                  splitSettlementEnabled: false,
                },
                additionalData: {
                  serviceName: "mi-web",
                  url: `${this.webApiBase}/apis/mi-web/v1/transactions/recent`,
                  latency: Math.max(0, params.latencySec),
                  dynamicApiUrl: "/mi-web/v1/transactions/recent",
                  method: "post",
                  apiName: "getLiveTransactionsV2",
                },
              },
              id: randomUUID(),
            },
            id: randomUUID(),
          },
        ],
      },
    ];

    const headers = this.buildBulkIngestHeaders(
      params.cookiesString,
      params.csrfToken,
      params.fingerprint,
    );

    axios
      .post(`${this.apiPhonePeBase}/apis/unified-ingestion/v5/bulk/ingest`, body, {
        headers,
        timeout: 5000,
        validateStatus: () => true,
      })
      .catch((e: any) => {
        this.logger.debug(`bulk/ingest after recent skipped/failed: ${e?.message}`);
      });
  }

  /**
   * Attempt to refresh the web session by calling lightweight GET endpoints
   * (/user/reset, /user/me) with the refresh token cookie. The server may
   * silently renew MERCHANT_USER_A_TOKEN via Set-Cookie when MERCHANT_USER_R_TOKEN
   * is still valid.
   */
  private async refreshWebSession(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    refreshToken?: string,
  ): Promise<{
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    csrfToken: string;
    cookiesString: string;
  }> {
    let currentCookies = this.ensureF1P21N7InCookies(cookies, fingerprint);
    let currentCsrf = csrfToken;

    // If refreshToken wasn't passed explicitly, try to read it from cookiesString.
    // This is critical for web-api flow where we often persist tokens only as cookies.
    if (!refreshToken) {
      const extracted = this.extractTokenFromCookies(
        currentCookies,
        "MERCHANT_USER_R_TOKEN",
      );
      if (extracted) refreshToken = extracted;
    }

    if (refreshToken) {
      const regex = /MERCHANT_USER_R_TOKEN=[^;]*(?:;|$)/;
      const newVal = `MERCHANT_USER_R_TOKEN=${refreshToken};`;
      if (currentCookies.match(/MERCHANT_USER_R_TOKEN=/)) {
        currentCookies = currentCookies.replace(regex, newVal);
      } else {
        currentCookies = `${newVal} ${currentCookies}`.trim();
      }
    }

    const oldAuthToken = this.extractTokenFromCookies(
      currentCookies,
      "MERCHANT_USER_A_TOKEN",
    );

    const endpoints = [
      { name: "/user/reset", path: "/apis/mi-web/v1/user/reset" },
      { name: "/user/me", path: "/apis/mi-web/v1/user/me" },
    ];

    for (const ep of endpoints) {
      try {
        this.logger.log(`🔄 Session refresh: calling ${ep.name}...`);
        const headers = this.buildWebHeaders(
          currentCookies,
          currentCsrf,
          fingerprint,
        );
        const res = await axios.get(`${this.webApiBase}${ep.path}`, {
          headers,
          timeout: 10000,
          validateStatus: (s) => s < 500,
        });

        currentCookies = this.mergeCookies(
          currentCookies,
          res.headers["set-cookie"],
        );
        const newCsrf = res.headers["x-csrf-token"];
        if (newCsrf) {
          currentCsrf = newCsrf;
          currentCookies = this.mergeCookies(
            currentCookies,
            `_X52F70K3N=${newCsrf}`,
          );
        }

        this.logger.log(
          `🔄 ${ep.name} returned ${res.status}${res.headers["x-expired-tokens"] ? " (X-EXPIRED-TOKENS present)" : ""}`,
        );

        const newToken = this.extractTokenFromCookies(
          currentCookies,
          "MERCHANT_USER_A_TOKEN",
        );
        const newRefreshToken = this.extractTokenFromCookies(
          currentCookies,
          "MERCHANT_USER_R_TOKEN",
        );

        if (newToken && newToken !== oldAuthToken) {
          this.logger.log(
            `✅ Web session token refreshed via ${ep.name} Set-Cookie`,
          );
          return {
            refreshedToken: newToken,
            refreshedRefreshToken:
              newRefreshToken && newRefreshToken !== refreshToken
                ? newRefreshToken
                : null,
            csrfToken: currentCsrf,
            cookiesString: currentCookies,
          };
        }
      } catch (e: any) {
        this.logger.warn(`⚠️ ${ep.name} failed: ${e.message}`);
      }
    }

    return {
      refreshedToken: null,
      refreshedRefreshToken: null,
      csrfToken: currentCsrf,
      cookiesString: currentCookies,
    };
  }

  /**
   * Directly refresh the session using the dedicated /auth/refresh endpoint.
   * Per Burp: axios gets 401 (TLS fingerprint); browser gets 200. Use browser FIRST.
   * On success: new A_TOKEN has Max-Age ~60 days — session stays alive.
   */
  private async refreshWebSessionDirect(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    refreshToken?: string,
  ): Promise<any> {
    return browserSemaphore.run(() => this._refreshWebSessionDirect(cookies, csrfToken, fingerprint, refreshToken));
  }

  private async bootstrapCsrfPureHttp(
    cookies: string,
    fingerprint: string,
  ): Promise<{ newCsrf: string; cookiesString: string }> {
    try {
      this.logger.log(`🧩 Pure HTTP CSRF bootstrap: calling /auth/logout...`);
      const { gotScraping } = await eval('import("got-scraping")');
      const headers = this.buildWebHeaders(cookies, "", fingerprint);
      delete headers.Authorization;

      const rawResponse = await gotScraping({
        url: `${this.webApiBase}/apis/mi-web/v1/auth/logout`,
        method: "POST",
        body: "null",
        headers: headers as any,
        timeout: { request: 15000 },
        throwHttpErrors: false,
        responseType: "text",
      });

      let currentCookies = this.mergeCookies(cookies, rawResponse.headers['set-cookie']);
      const newCsrf = rawResponse.headers['x-csrf-token'];
      if (newCsrf) {
        currentCookies = this.mergeCookies(currentCookies, `_X52F70K3N=${newCsrf}`);
      }

      const extractedCsrf = this.extractTokenFromCookies(currentCookies, "_X52F70K3N") ||
        this.extractTokenFromCookies(currentCookies, "_CKB2N1BHVZ") || newCsrf || "";

      this.logger.log(`🧩 Pure HTTP CSRF bootstrap result: status=${rawResponse.statusCode} hasNewCsrf=${!!extractedCsrf}`);
      return { newCsrf: extractedCsrf, cookiesString: currentCookies };
    } catch (e: any) {
      return { newCsrf: "", cookiesString: cookies };
    }
  }

  private async _refreshWebSessionDirect(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    refreshToken?: string,
    forceHttpOverride: boolean = false,
  ): Promise<{
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    csrfToken: string;
    cookiesString: string;
  }> {
    let currentCookies = this.ensureF1P21N7InCookies(cookies, fingerprint);
    let currentCsrf = csrfToken;

    if (!currentCsrf && currentCookies) {
      currentCsrf =
        this.extractTokenFromCookies(currentCookies, "_X52F70K3N") ||
        this.extractTokenFromCookies(currentCookies, "_CKB2N1BHVZ") ||
        "";
    }
    if (!currentCsrf) {
      this.logger.warn(
        `⚠️ Skipping /auth/refresh: no CSRF token (would get CF005). Warm session first.`,
      );
      return {
        refreshedToken: null,
        refreshedRefreshToken: null,
        csrfToken: currentCsrf,
        cookiesString: currentCookies,
      };
    }

    const forceHttp = forceHttpOverride ||
      String(process.env.PHONEPE_WEB_FORCE_HTTP || "false").toLowerCase() ===
      "true";

    if (forceHttp) {
      this.logger.log(`🔄 Pure HTTP /auth/refresh requested, trying HTTP (got-scraping)...`);
      for (const includeAuth of [false, true]) {
        try {
          const token = this.extractTokenFromCookies(currentCookies, "MERCHANT_USER_A_TOKEN");
          const headers = this.buildWebHeaders(currentCookies, currentCsrf, fingerprint);
          headers.Origin = "https://business.phonepe.com";
          headers.Referer = "https://business.phonepe.com/";
          if (includeAuth && token) {
            headers.Authorization = `O-Bearer ${token}`;
          }
          this.logger.log(`  Trying HTTP refresh (includeAuth=${includeAuth})...`);
          const { gotScraping } = await eval('import("got-scraping")');
          const rawResponse = await gotScraping({
            url: `${this.webApiBase}/apis/mi-web/v1/auth/refresh`,
            method: "POST",
            body: "{}",
            headers: headers as any,
            timeout: { request: 15000 },
            throwHttpErrors: false,
            responseType: "json",
          });
          const res = {
            status: rawResponse.statusCode,
            headers: rawResponse.headers as Record<string, any>,
            data: rawResponse.body,
          };

          if (res.status === 200) {
            currentCookies = this.mergeCookies(currentCookies, res.headers['set-cookie']);
            const newCsrf = res.headers['x-csrf-token'];
            if (newCsrf) {
              currentCsrf = newCsrf;
              currentCookies = this.mergeCookies(currentCookies, `_X52F70K3N=${newCsrf}`);
            }

            const newToken = this.extractTokenFromCookies(currentCookies, 'MERCHANT_USER_A_TOKEN');
            const newRefreshToken = this.extractTokenFromCookies(currentCookies, 'MERCHANT_USER_R_TOKEN');

            this.logger.log(`✅ HTTP refresh successful`);
            return {
              refreshedToken: newToken,
              refreshedRefreshToken: newRefreshToken !== refreshToken ? newRefreshToken : null,
              csrfToken: currentCsrf,
              cookiesString: currentCookies,
            };
          } else {
            const bodyStr = JSON.stringify(res.data || {});
            this.logger.debug(`  HTTP refresh status=${res.status} body=${bodyStr}`);

            if (res.status === 401 && bodyStr.includes("CF004")) {
              this.logger.warn(`🧩 /auth/refresh CF004 (Invalid CSRF): bootstrapping CSRF pair then retrying once...`);
              const boot = await this.bootstrapCsrfPureHttp(currentCookies, fingerprint);
              if (boot.newCsrf) {
                currentCsrf = boot.newCsrf;
                const retryHeaders = this.buildWebHeaders(currentCookies, currentCsrf, fingerprint);
                retryHeaders.Origin = "https://business.phonepe.com";
                retryHeaders.Referer = "https://business.phonepe.com/";
                if (includeAuth && token) {
                  retryHeaders.Authorization = `O-Bearer ${token}`;
                }

                const retryRes = await gotScraping({
                  url: `${this.webApiBase}/apis/mi-web/v1/auth/refresh`,
                  method: "POST",
                  body: "{}",
                  headers: retryHeaders as any,
                  timeout: { request: 15000 },
                  throwHttpErrors: false,
                  responseType: "json",
                });

                if (retryRes.statusCode === 200) {
                  currentCookies = this.mergeCookies(currentCookies, retryRes.headers['set-cookie']);
                  const retryNewCsrf = retryRes.headers['x-csrf-token'];
                  if (retryNewCsrf) {
                    currentCsrf = retryNewCsrf;
                    currentCookies = this.mergeCookies(currentCookies, `_X52F70K3N=${retryNewCsrf}`);
                  }
                  const newToken = this.extractTokenFromCookies(currentCookies, 'MERCHANT_USER_A_TOKEN');
                  const newRefreshToken = this.extractTokenFromCookies(currentCookies, 'MERCHANT_USER_R_TOKEN');
                  this.logger.log(`✅ HTTP refresh successful after CSRF bootstrap`);
                  return {
                    refreshedToken: newToken,
                    refreshedRefreshToken: newRefreshToken !== refreshToken ? newRefreshToken : null,
                    csrfToken: currentCsrf,
                    cookiesString: currentCookies,
                  };
                }
              }
            }
          }
        } catch (e: any) {
          this.logger.debug(`  HTTP refresh error: ${e.message}`);
        }
      }

      this.logger.log(
        `⚠️ HTTP refresh failed.`,
      );

      if (forceHttpOverride) {
        return {
          refreshedToken: null,
          refreshedRefreshToken: null,
          csrfToken: currentCsrf,
          cookiesString: currentCookies,
        };
      }
    }

    const usePersistent = String(process.env.PHONEPE_PERSISTENT_BROWSER || "false").toLowerCase() === "true";

    if (usePersistent) {
      // Persistent profile first — same Chromium trust as sync (ephemeral refresh often status=0 / CF004).
      this.logger.log(`🔄 Refreshing via persistent browser (same profile as web sync)...`);
      const persistentResult = await this.refreshWebSessionViaPersistentBrowser(
        currentCookies,
        currentCsrf,
        fingerprint,
      );
      if (
        persistentResult.refreshedToken ||
        persistentResult.refreshedRefreshToken
      ) {
        return persistentResult;
      }
      this.logger.log(`🔄 Persistent refresh missed; trying direct HTTP refresh...`);
    } else {
      this.logger.log(`🔄 PHONEPE_PERSISTENT_BROWSER is false; skipping browser, executing pure HTTP token refresh...`);
    }

    const httpResult = await this._refreshWebSessionDirect(
      currentCookies,
      currentCsrf,
      fingerprint,
      refreshToken,
      true
    );

    return httpResult;
  }


  /**
   * POST /auth/refresh from an existing page on business.phonepe.com (cookies already applied).
   * Shared by ephemeral refresh, persistent refresh, and persistent sync pre-flight.
   */
  private async refreshAuthInPageContext(
    page: any,
    cookiesString: string,
    csrfToken: string,
    fingerprint: string,
  ): Promise<{
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    csrfToken: string;
    cookiesString: string;
    httpStatus: number;
  }> {
    let currentCsrf = csrfToken;
    // IMPORTANT: Fingerprint and auth signals must be derived from the *live* page cookie jar,
    // not a potentially stale DB snapshot string. Otherwise PhonePe may reject refresh with CF004.
    const liveCookiesString =
      (await this.snapshotCookiesFromPage(page).catch(() => "")) || cookiesString;
    const fpHeader = this.fingerprintForWebApi(liveCookiesString, fingerprint);
    const accessTokenFromJar =
      this.extractTokenFromCookies(liveCookiesString, "MERCHANT_USER_A_TOKEN") ||
      "";
    // IMPORTANT: For mi-web endpoints, PhonePe expects X-Csrf-Token to match the NON-HttpOnly
    // cookie `_X52F70K3N` (the SPA mirrors header -> cookie). `_CKB2N1BHVZ` is HttpOnly and
    // should not be used as the header value (causes CF004).
    const altCsrfFromString =
      this.extractTokenFromCookies(liveCookiesString, "_X52F70K3N") || "";

    const jarCsrf = await this.extractCsrfFromPageCookieJar(page);
    const csrfSeen = new Set<string>();
    const csrfCandidates: string[] = [];
    for (const s of [jarCsrf, currentCsrf, altCsrfFromString]) {
      const t = String(s || "").trim();
      if (t && !csrfSeen.has(t)) {
        csrfSeen.add(t);
        csrfCandidates.push(t);
      }
    }

    const tryRefresh = async (csrf: string, includeAuth: boolean) => {
      return page.evaluate(
        async (opts: {
          fp: string;
          csrf: string;
          accessToken: string;
          includeAuth: boolean;
        }) => {
          try {
            const getCsrf = () => {
              const match = document.cookie.match(/_X52F70K3N=([^;]+)/);
              if (!match) return "";
              try {
                return decodeURIComponent(match[1]);
              } catch {
                return match[1];
              }
            };
            const headerCsrf = getCsrf() || opts.csrf;
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              Accept: "application/json, text/plain, */*",
              "X-Csrf-Token": headerCsrf,
              Fingerprint: opts.fp,
              "X-Device-Fingerprint": "123",
              "X-App-Id": "oculus",
              "X-Source-Type": "WEB",
              "X-Source-Platform": "WEB",
              Namespace: "insights",
              "Sec-Fetch-Site": "same-site",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
            };
            if (opts.includeAuth && opts.accessToken) {
              headers.Authorization = `O-Bearer ${opts.accessToken}`;
            }

            const res = await fetch(
              "https://web-api.phonepe.com/apis/mi-web/v1/auth/refresh",
              {
                method: "POST",
                credentials: "include",
                headers,
                body: "{}",
              },
            );
            const text = await res.text();
            return {
              status: res.status,
              ok: res.ok,
              bodySnippet: text ? text.slice(0, 220) : "",
            };
          } catch (e: any) {
            return {
              status: 0,
              ok: false,
              bodySnippet: e?.message || "fetch error",
            };
          }
        },
        {
          fp: fpHeader,
          csrf,
          accessToken: accessTokenFromJar,
          includeAuth,
        },
      );
    };

    const attemptRefresh = async () => {
      let refreshResult = { status: 0, ok: false, bodySnippet: "" };
      outer: for (let i = 0; i < csrfCandidates.length; i++) {
        const c = csrfCandidates[i];
        for (const includeAuth of [false, true]) {
          refreshResult = await tryRefresh(c, includeAuth);
          if (refreshResult.status === 200 && refreshResult.ok) break outer;
        }
        if (i < csrfCandidates.length - 1) {
          this.logger.debug(
            `Browser refresh CSRF candidate #${i + 1} exhausted → last status=${refreshResult.status}`,
          );
        }
      }
      return refreshResult;
    };

    let refreshResult = await attemptRefresh();

    // CF004 invalid csrf: bootstrap CSRF pair inside the tab (logout) and retry once.
    const isCf004 =
      refreshResult.status === 401 &&
      String(refreshResult.bodySnippet || "").includes("CF004");
    if (isCf004) {
      this.logger.warn(`🧩 /auth/refresh CF004: bootstrapping CSRF pair then retrying once...`);
      const boot = await this.bootstrapCsrfPairInPageContext(page, fingerprint);
      if (boot?.newCsrf) {
        // Update candidate list for the retry
        csrfCandidates.unshift(boot.newCsrf);
        currentCsrf = boot.newCsrf;
      }
      refreshResult = await attemptRefresh();
    }

    const mergedCookies = await this.snapshotCookiesFromPage(page);
    const newCsrf =
      this.extractTokenFromCookies(mergedCookies, "_X52F70K3N") ||
      this.extractTokenFromCookies(mergedCookies, "_CKB2N1BHVZ") ||
      currentCsrf;
    currentCsrf = newCsrf;

    if (refreshResult.status !== 200 || !refreshResult.ok) {
      this.logger.warn(
        `⚠️ In-page /auth/refresh returned ${refreshResult.status}${refreshResult.bodySnippet ? ` body=${refreshResult.bodySnippet}` : ""}`,
      );
      return {
        refreshedToken: null,
        refreshedRefreshToken: null,
        csrfToken: currentCsrf,
        cookiesString: mergedCookies || cookiesString,
        httpStatus: refreshResult.status,
      };
    }

    const newToken = this.extractTokenFromCookies(
      mergedCookies,
      "MERCHANT_USER_A_TOKEN",
    );
    const newRefreshToken = this.extractTokenFromCookies(
      mergedCookies,
      "MERCHANT_USER_R_TOKEN",
    );

    this.logger.log(`✅ In-page /auth/refresh successful (HTTP 200)`);
    return {
      refreshedToken: newToken,
      refreshedRefreshToken: newRefreshToken || null,
      csrfToken: currentCsrf,
      cookiesString: mergedCookies,
      httpStatus: 200,
    };
  }

  /**
   * Same as ephemeral refresh but uses the stable Puppeteer profile for this fingerprint
   * (matches transaction sync) so PhonePe sees one continuous browser, not a cold profile.
   */
  private async refreshWebSessionViaPersistentBrowser(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
  ): Promise<{
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    csrfToken: string;
    cookiesString: string;
  }> {
    // NOTE: Do NOT take withKeyLock here. Caller (`fetchTransactionHistoryWeb`) already
    // serializes per-fingerprint; taking it again deadlocks the request.
    let page: any = null;
    try {
      const browserCtx = await this.getPersistentBrowser(fingerprint);
      const browser = browserCtx.browser;
      page = await browser.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setUserAgent(this.webDesktopUa);
      await page.setViewport({ width: 1280, height: 800 });
      page.setDefaultNavigationTimeout(20000);
      page.setDefaultTimeout(20000);

      const cookieList = this.parseCookiesForPuppeteer(cookies);
      if (cookieList.length > 0) {
        await page.setCookie(...cookieList);
      }

      await page.goto("https://business.phonepe.com/", {
        waitUntil: "networkidle2",
        timeout: 20000,
      });
      await new Promise((r) => setTimeout(r, 200));

      const ref = await this.refreshAuthInPageContext(
        page,
        cookies,
        csrfToken,
        fingerprint,
      );
      return {
        refreshedToken: ref.refreshedToken,
        refreshedRefreshToken: ref.refreshedRefreshToken,
        csrfToken: ref.csrfToken,
        cookiesString: ref.cookiesString,
      };
    } catch (e: any) {
      this.logger.warn(`⚠️ Persistent-browser refresh failed: ${e.message}`);
      return {
        refreshedToken: null,
        refreshedRefreshToken: null,
        csrfToken,
        cookiesString: cookies,
      };
    } finally {
      if (page) {
        try {
          await page.close().catch(() => { });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Refresh session via ephemeral real browser (Puppeteer). Fallback when persistent refresh fails.
   */
  private async refreshWebSessionViaBrowser(
    cookies: string,
    csrfToken: string,
    fingerprint: string,
  ): Promise<{
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    csrfToken: string;
    cookiesString: string;
  }> {
    let currentCookies = cookies;
    let currentCsrf = csrfToken;
    let browser: any = null;
    let ephemeralProfileDir: string | null = null;
    const startTime = Date.now();

    try {
      this.logger.log(`[EPHEMERAL BROWSER] 🚀 Launching 5-second headless Chromium instance...`);
      this.initStealth();
      ephemeralProfileDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ppweb-refresh-"),
      );
      browser = await puppeteer.launch({
        headless: "new" as any,
        userDataDir: ephemeralProfileDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,800",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
      });
      const page = await browser.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setUserAgent(this.webDesktopUa);
      await page.setViewport({ width: 1280, height: 800 });

      this.logger.log(`[EPHEMERAL BROWSER] 🌍 Loading PhonePe SPA to trigger background analytics keepalive...`);
      await page.goto("https://business.phonepe.com/", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      const cookieList = this.parseCookiesForPuppeteer(currentCookies);
      if (cookieList.length > 0) {
        await page.setCookie(...cookieList);
      }

      await page
        .reload({ waitUntil: "networkidle2", timeout: 20000 })
        .catch(() => { });
      await new Promise((r) => setTimeout(r, 200));

      const mergedCookies = await this.snapshotCookiesFromPage(page);
      const newCsrf =
        this.extractTokenFromCookies(mergedCookies, "_X52F70K3N") ||
        this.extractTokenFromCookies(mergedCookies, "_CKB2N1BHVZ") ||
        currentCsrf;

      // Close browser IMMEDIATELY so it doesn't interfere
      await browser.close().catch(() => { });
      browser = null as any;

      this.logger.log(`[EPHEMERAL BROWSER] 🔄 Executing pure HTTP token refresh using fresh browser cookies...`);
      // Use pure HTTP fetch (gotScraping) for the refresh, avoiding in-page race conditions
      const httpRefresh = await this._refreshWebSessionDirect(mergedCookies, newCsrf, fingerprint, undefined, true);

      if (!httpRefresh.refreshedToken) {
        this.logger.warn(`⚠️ HTTP refresh after ephemeral browser failed.`);
        return {
          refreshedToken: null,
          refreshedRefreshToken: null,
          csrfToken: newCsrf,
          cookiesString: mergedCookies,
        };
      }

      const outCsrf = httpRefresh.csrfToken || newCsrf;
      const outCookies = httpRefresh.cookiesString || mergedCookies;
      const refreshedToken = httpRefresh.refreshedToken;
      const refreshedRefreshToken = httpRefresh.refreshedRefreshToken;

      this.logger.log(`[EPHEMERAL BROWSER] ✅ Keepalive complete in ${Date.now() - startTime}ms! Browser will now be destroyed to free RAM.`);
      return {
        refreshedToken,
        refreshedRefreshToken,
        csrfToken: outCsrf,
        cookiesString: outCookies,
      };
    } catch (e: any) {
      this.logger.warn(`⚠️ Browser-based refresh failed: ${e.message}`);
      return {
        refreshedToken: null,
        refreshedRefreshToken: null,
        csrfToken: currentCsrf,
        cookiesString: currentCookies,
      };
    } finally {
      if (browser) await browser.close().catch(() => { });
      if (ephemeralProfileDir) {
        try {
          fs.rmSync(ephemeralProfileDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Warm the web session by calling the metrics/stats endpoint.
   * This rotates the CSRF and keeps the session active.
   */
  public async warmWebSession(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
  ): Promise<{ csrfToken: string; cookiesString: string }> {
    try {
      this.logger.log(`🔥 Proactively warming web session via metrics/stats...`);
      const body = {
        from: Date.now() - 24 * 60 * 60 * 1000,
        to: Date.now(),
        selectedDateType: "day",
        filters: { status: ["COMPLETED"] },
        transactionType: "FORWARD",
      };

      // Burp working flow for metrics/stats uses cookie auth + csrf/fingerprint,
      // without Authorization header.
      const headers = this.buildWebHeaders(cookies, csrfToken, fingerprint);
      const res = await axios.post(`${this.webApiBase}/apis/mi-web/v3/transactions/metrics/stats`, body, {
        headers,
        timeout: 15000,
        validateStatus: (s) => s < 500,
      });

      const newCsrf = res.headers['x-csrf-token'];
      const updatedCookies = this.mergeCookies(cookies, res.headers['set-cookie']);

      return {
        csrfToken: newCsrf || csrfToken,
        cookiesString: newCsrf
          ? this.mergeCookies(updatedCookies, `_X52F70K3N=${newCsrf}`)
          : updatedCookies,
      };
    } catch (e: any) {
      this.logger.warn(`⚠️ Warming failed: ${e.message}`);
      return { csrfToken, cookiesString: cookies };
    }
  }

  /**
   * Fetch transactions using the same browser context (Puppeteer) so requests
   * come from a real browser with the same cookies — improves session trust
   * and may avoid 412 when Node/axios is treated as a different device.
   */
  private async fetchTransactionHistoryViaBrowser(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue: string | null | undefined,
    size: number,
    fromTimestamp: number,
    toTimestamp: number,
    refreshToken?: string,
  ): Promise<any> {
    return browserSemaphore.run(() => this._fetchTransactionHistoryViaBrowser(
      authToken, cookies, csrfToken, fingerprint, groupValue, size, fromTimestamp, toTimestamp, refreshToken
    ));
  }

  private async _fetchTransactionHistoryViaBrowser(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue: string | null | undefined,
    size: number,
    fromTimestamp: number,
    toTimestamp: number,
    refreshToken?: string,
  ): Promise<{
    success: boolean;
    data: { results: any[]; totalResults: number; totalAmount?: number } | null;
    error?: string;
    csrfToken?: string;
    cookiesString?: string;
    refreshedToken?: string;
    refreshedRefreshToken?: string;
  }> {
    let browser: any = null;
    let ephemeralProfileDir: string | null = null;
    try {
      this.initStealth();
      ephemeralProfileDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ppweb-browserfetch-"),
      );
      browser = await puppeteer.launch({
        headless: "new" as any,
        userDataDir: ephemeralProfileDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,800",
        ],
      });
      const page = await browser.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setUserAgent(this.webDesktopUa);
      await page.setViewport({ width: 1280, height: 800 });

      const cookieList = this.parseCookiesForPuppeteer(cookies);
      if (cookieList.length > 0) {
        await page.setCookie(...cookieList);
      }

      const fpHeader = this.fingerprintForWebApi(cookies, fingerprint);

      await page.goto(this.loginPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      const metricsBody = {
        from: fromTimestamp,
        to: toTimestamp,
        selectedDateType: "week",
        filters: { status: ["COMPLETED"] },
        transactionType: "FORWARD",
      };
      const listBody = {
        offset: 0,
        size: size,
        filters: { status: ["COMPLETED"] },
        transactionType: "FORWARD",
        from: fromTimestamp,
        to: toTimestamp,
        selectedDateType: "week",
      };

      const result = await page.evaluate(
        async (opts: {
          metricsBody: any;
          listBody: any;
          csrf: string;
          fp: string;
        }) => {
          const base = "https://web-api.phonepe.com";
          const getCsrf = () => {
            const match = document.cookie.match(/_X52F70K3N=([^;]+)/);
            return match ? match[1] : opts.csrf;
          };
          const currentCsrf = getCsrf();

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "X-Csrf-Token": currentCsrf,
            Fingerprint: opts.fp,
            "X-Device-Fingerprint": "123",
            "X-App-Id": "oculus",
            "X-Source-Type": "WEB",
            "X-Source-Platform": "WEB",
            Namespace: "insights",
            "Sec-Fetch-Site": "same-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
            Origin: "https://business.phonepe.com",
            Referer: "https://business.phonepe.com/",
          };

          const metricsRes = await fetch(
            `${base}/apis/mi-web/v3/transactions/metrics/stats`,
            {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify(opts.metricsBody),
            },
          );

          if (metricsRes.status === 412 || metricsRes.status === 401) {
            return { ok: false, status: metricsRes.status, listData: null };
          }

          const listRes = await fetch(
            `${base}/apis/mi-web/v3/transactions/list`,
            {
              method: "POST",
              credentials: "include",
              headers,
              body: JSON.stringify(opts.listBody),
            },
          );

          if (listRes.status !== 200) {
            return { ok: false, status: listRes.status, listData: null };
          }
          const listData = await listRes.json();
          return { ok: true, status: 200, listData };
        },
        {
          metricsBody,
          listBody,
          csrf: csrfToken,
          fp: fpHeader,
        },
      );

      let outCookies = cookies;
      let outCsrf = csrfToken;
      if (result.ok && result.listData) {
        outCookies = await this.snapshotCookiesFromPage(page);
        outCsrf =
          this.extractCsrfFromCookiesString(outCookies) || csrfToken;
      }

      await browser.close();
      browser = null;
      if (ephemeralProfileDir) {
        try {
          fs.rmSync(ephemeralProfileDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        ephemeralProfileDir = null;
      }

      if (!result.ok || !result.listData) {
        return {
          success: false,
          data: null,
          error: `Browser fetch returned ${result.status}`,
        };
      }

      const listData = result.listData as any;
      const resultsArray =
        listData?.data?.results ??
        listData?.results ??
        listData?.transactions ??
        [];
      const totalCount =
        listData?.data?.totalResults ??
        listData?.totalResults ??
        listData?.totalTransactions ??
        resultsArray.length;

      const newA =
        this.extractTokenFromCookies(outCookies, "MERCHANT_USER_A_TOKEN") ||
        authToken;
      const newR =
        this.extractTokenFromCookies(outCookies, "MERCHANT_USER_R_TOKEN") ||
        refreshToken ||
        "";
      const prevR = refreshToken || "";

      this.logger.log(
        `✅ Same-browser fetch: ${totalCount} transactions (session trust path)`,
      );
      return {
        success: true,
        data: {
          results: resultsArray,
          totalResults: totalCount,
          totalAmount: listData?.data?.totalAmount ?? 0,
        },
        csrfToken: outCsrf,
        cookiesString: outCookies,
        refreshedToken: newA && newA !== authToken ? newA : undefined,
        refreshedRefreshToken:
          newR && newR !== prevR ? newR : undefined,
      };
    } catch (err: any) {
      this.logger.warn(`⚠️ Same-browser fetch failed: ${err?.message}`);
      if (browser) {
        try {
          await browser.close();
        } catch (_) { }
      }
      if (ephemeralProfileDir) {
        try {
          fs.rmSync(ephemeralProfileDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      return {
        success: false,
        data: null,
        error: err?.message ?? "Browser fetch failed",
      };
    }
  }

  /**
   * Persistent-browser variant of web API sync.
   * Uses a stable Chromium profile keyed by fingerprint to mimic the same browser staying logged in.
   * This is the closest we can get to the "15 days logged-in" behavior you see in a real browser.
   */
  private async fetchTransactionHistoryViaPersistentBrowser(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue: string | null | undefined,
    size: number,
    fromTimestamp: number,
    toTimestamp: number,
    refreshToken?: string,
    _didRetry: boolean = false,
  ): Promise<any> {
    return browserSemaphore.run(() => this._fetchTransactionHistoryViaPersistentBrowser(
      authToken, cookies, csrfToken, fingerprint, groupValue, size, fromTimestamp, toTimestamp, refreshToken, _didRetry
    ));
  }

  private async _fetchTransactionHistoryViaPersistentBrowser(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue: string | null | undefined,
    size: number,
    fromTimestamp: number,
    toTimestamp: number,
    refreshToken?: string,
    _didRetry: boolean = false,
  ): Promise<{
    success: boolean;
    data: { results: any[]; totalResults: number; totalAmount?: number } | null;
    error?: string;
    csrfToken?: string;
    cookiesString?: string;
    refreshedToken?: string | null;
    refreshedRefreshToken?: string | null;
    sessionExpired?: boolean;
  }> {
    // NOTE: Do NOT take withKeyLock here. Caller (`fetchTransactionHistoryWeb`) already
    // serializes per-fingerprint; taking it again deadlocks the request.
    let browserCtx: any = null;
    let page: any = null;
    try {
      browserCtx = await this.getPersistentBrowser(fingerprint);
      const browser = browserCtx.browser;

      // Always open a fresh page for each sync to avoid "detached frame" artifacts
      page = await browser.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(this.webDesktopUa);
      page.setDefaultNavigationTimeout(20000);
      page.setDefaultTimeout(20000);

      // Navigate first using the persistent profile's existing cookies.
      // CRITICAL: do NOT blindly overwrite the persistent jar with DB cookies —
      // stale DB credentials can destroy a fresh logged-in profile and cause "JWT expired Xs ago".
      await page.goto("https://business.phonepe.com/", {
        waitUntil: "domcontentloaded", // Wait for basic DOM to avoid getting stuck on tracking requests
        timeout: 10000,
      });

      // Minimal delay for cookie settling (persistent profile already has cookies)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const profileJar =
        (await this.snapshotCookiesFromPage(page).catch(() => "")) || "";
      const profileHasAuth =
        !!this.extractTokenFromCookies(profileJar, "MERCHANT_USER_A_TOKEN") &&
        !!this.extractTokenFromCookies(profileJar, "MERCHANT_USER_R_TOKEN");
      const profileJwtHealthy =
        profileHasAuth && !this.isJwtExpiredOrExpiring(profileJar, 120);

      // If the profile already has a healthy session, prefer it over DB snapshot.
      // Otherwise (cold start), apply DB cookies to restore auth.
      if (!profileJwtHealthy) {
        const cookieList = this.parseCookiesForPuppeteer(cookies);
        if (cookieList.length > 0) {
          await page.setCookie(...cookieList);
          // Re-visit business after applying cookies
          await page.goto("https://business.phonepe.com/", {
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      let cookieJarStringForFp =
        (await this.snapshotCookiesFromPage(page).catch(() => "")) ||
        profileJar ||
        cookies;
      const csrfForSession =
        csrfToken ||
        // Prefer non-HttpOnly CSRF cookie for header use
        this.extractTokenFromCookies(cookieJarStringForFp, "_X52F70K3N") ||
        this.extractCsrfFromCookiesString(cookieJarStringForFp) ||
        "";
      if (this.isJwtExpiredOrExpiring(cookieJarStringForFp, 600)) {
        this.logger.log(
          `⏰ Persistent sync: JWT expired or within 600s of expiry — /auth/refresh before warm/list`,
        );
        // When JWT is dead, PhonePe frequently rejects refresh with CF004 unless CSRF pair is re-bootstrapped.
        // Bootstrap first so the HttpOnly jar is updated, then refresh.
        await this.bootstrapCsrfPairInPageContext(page, fingerprint).catch(() => { });
        const pre = await this.refreshAuthInPageContext(
          page,
          cookieJarStringForFp,
          csrfForSession,
          fingerprint,
        );
        cookieJarStringForFp = pre.cookiesString || cookieJarStringForFp;
        if (pre.httpStatus === 200 && pre.refreshedToken) {
          this.logger.log(
            `✅ Persistent sync: pre-flight refresh issued new MERCHANT_USER_A_TOKEN`,
          );
        }
        const reapplied = this.parseCookiesForPuppeteer(cookieJarStringForFp);
        if (reapplied.length > 0) {
          await page.setCookie(...reapplied);
        }
      }

      const bodyList = {
        offset: 0,
        size: Math.max(1, Math.min(50, size || 10)),
        filters: { status: ["COMPLETED"] },
        transactionType: "FORWARD",
        from: fromTimestamp,
        to: toTimestamp,
        selectedDateType:
          (toTimestamp - fromTimestamp) / (24 * 60 * 60 * 1000) <= 8
            ? "week"
            : "custom",
      };

      // Debug: log cookies the browser actually has before making API calls
      const browserCookies = await page.cookies("https://web-api.phonepe.com");
      const bizCookiesPre = await page.cookies("https://business.phonepe.com");
      const allCookieNames = [
        ...new Set(
          [...browserCookies, ...bizCookiesPre].map((c: any) => c.name),
        ),
      ];
      const hasAuthToken = browserCookies.some(
        (c: any) => c.name === "MERCHANT_USER_A_TOKEN",
      );
      const hasCsrf = browserCookies.some(
        (c: any) => c.name === "_X52F70K3N" || c.name === "_CKB2N1BHVZ",
      );
      const hasPpabwdcid = browserCookies.some(
        (c: any) => c.name === "_ppabwdcid",
      );
      const hasPpabwdsid = browserCookies.some(
        (c: any) => c.name === "_ppabwdsid",
      );
      this.logger.log(
        `🍪 Browser cookies: [${allCookieNames.join(", ")}] hasAuth=${hasAuthToken} hasCsrf=${hasCsrf} hasPpabwdcid=${hasPpabwdcid} hasPpabwdsid=${hasPpabwdsid} total=${allCookieNames.length}`,
      );

      let result: any;
      let newCookies: string;
      let newCsrf: string;
      let listStatus: number | undefined;
      let warmStatus: number | undefined;

      for (let browserAttempt = 0; browserAttempt < 2; browserAttempt++) {
        const fpHeader = this.fingerprintForWebApi(
          cookieJarStringForFp,
          fingerprint,
        );
        const jarCsrf = await this.extractCsrfFromPageCookieJar(page);
        const initialCsrf =
          jarCsrf ||
          csrfToken ||
          this.extractCsrfFromCookiesString(cookieJarStringForFp);

        // Run warm + list in the same persistent browser context.
        result = await page.evaluate(
          async (opts: any) => {
            const getCookie = (name: string) => {
              const match = document.cookie.match(
                new RegExp("(^| )" + name + "=([^;]+)"),
              );
              return match ? match[2] : null;
            };

            // Prefer Node-supplied CSRF (from HttpOnly-aware jar); then non-HttpOnly cookie.
            const freshCsrf = opts.csrf || getCookie("_X52F70K3N") || "";

            const commonHeaders: Record<string, string> = {
              "Content-Type": "application/json",
              Accept: "application/json, text/plain, */*",
              "X-Csrf-Token": freshCsrf,
              Fingerprint: opts.fingerprint,
              "X-Device-Fingerprint": "123",
              "X-App-Id": "oculus",
              "X-Source-Type": "WEB",
              "X-Source-Platform": "WEB",
              Namespace: "insights",
              "Sec-Fetch-Site": "same-site",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
            };

            // PhonePe expects X-Csrf-Token to match _X52F70K3N in the cookie jar.
            // Responses often send a new x-csrf-token header without Set-Cookie; sync both.
            const applyRotatedCsrf = (token: string | null | undefined) => {
              if (!token) return;
              commonHeaders["X-Csrf-Token"] = token;
              try {
                // Raw value — must match Puppeteer setCookie and PhonePe header (encodeURIComponent breaks some tokens).
                document.cookie = `_X52F70K3N=${token}; path=/; domain=.phonepe.com; Secure; SameSite=Lax`;
              } catch {
                /* ignore */
              }
            };

            const doPost = async (url: string, body: any) => {
              try {
                const res = await fetch(url, {
                  method: "POST",
                  credentials: "include",
                  mode: "cors",
                  cache: "no-store",
                  headers: commonHeaders,
                  body: JSON.stringify(body),
                });
                const text = await res.text();
                let json: any = null;
                try {
                  json = text ? JSON.parse(text) : null;
                } catch {
                  json = null;
                }
                return {
                  status: res.status,
                  ok: res.ok,
                  headers: {
                    "x-csrf-token": res.headers.get("x-csrf-token"),
                  },
                  bodyText: text,
                  bodyJson: json,
                };
              } catch (e: any) {
                return {
                  status: 0,
                  ok: false,
                  headers: { "x-csrf-token": null },
                  bodyText: "",
                  bodyJson: null,
                  fetchError:
                    (e && (e.message || (e.toString && e.toString()))) ||
                    String(e),
                };
              }
            };

            const warmBody = {
              from: opts.from,
              to: opts.to,
              selectedDateType: opts.selectedDateType,
              filters: { status: ["COMPLETED"] },
              transactionType: "FORWARD",
            };
            const warm = await doPost(
              "https://web-api.phonepe.com/apis/mi-web/v3/transactions/metrics/stats",
              warmBody,
            );

            if (warm?.headers?.["x-csrf-token"]) {
              applyRotatedCsrf(warm.headers["x-csrf-token"]);
            }

            let recent: any = null;
            if (warm?.status === 200) {
              const recentBody = opts.to
                ? { filters: {}, lastTimestamp: opts.to }
                : { filters: {} };
              recent = await doPost(
                "https://web-api.phonepe.com/apis/mi-web/v1/transactions/recent",
                recentBody,
              );
              if (recent?.headers?.["x-csrf-token"]) {
                applyRotatedCsrf(recent.headers["x-csrf-token"]);
              }
            }

            const list = await doPost(
              "https://web-api.phonepe.com/apis/mi-web/v3/transactions/list",
              opts.listBody,
            );

            return {
              warm,
              recent,
              list,
              csrf: commonHeaders["X-Csrf-Token"],
            };
          },
          {
            csrf: initialCsrf,
            fingerprint: fpHeader,
            authToken: authToken,
            from: fromTimestamp,
            to: toTimestamp,
            selectedDateType:
              (toTimestamp - fromTimestamp) / (24 * 60 * 60 * 1000) <= 8
                ? "week"
                : "custom",
            listBody: bodyList,
          },
        );

        newCookies = await this.snapshotCookiesFromPage(page);
        cookieJarStringForFp = newCookies;
        newCsrf =
          this.extractCsrfFromCookiesString(newCookies) ||
          result?.csrf ||
          initialCsrf;
        listStatus = result?.list?.status;
        warmStatus = result?.warm?.status;

        if (listStatus === 200) break;

        const rotTok = result?.warm?.headers?.["x-csrf-token"];
        const warmJson = result?.warm?.bodyJson;
        const warmCode = warmJson?.code || warmJson?.errorCode;
        const warmCf004 =
          String(warmCode || "").toUpperCase() === "CF004" ||
          String(result?.warm?.bodyText || "").includes("CF004");
        // Warm 401 often returns a fresh x-csrf-token (CF004 or not). Sync jar once before retry.
        if (browserAttempt === 0 && warmStatus === 401 && rotTok) {
          await page.setCookie({
            name: "_X52F70K3N",
            value: rotTok,
            domain: ".phonepe.com",
            path: "/",
            secure: true,
            sameSite: "Lax",
          });
          this.logger.log(
            warmCf004
              ? `🔄 Warm CF004: applied x-csrf-token to _X52F70K3N cookie jar, retrying browser sequence once`
              : `🔄 Warm 401: applied rotated x-csrf-token to _X52F70K3N, retrying browser sequence once`,
          );
          continue;
        }
        break;
      }

      // Decide success based on list response
      if (listStatus !== 200) {
        const listSummary = this.extractFailureSummary(
          result?.list?.bodyJson || result?.list?.bodyText,
        );
        const warmSummary = this.extractFailureSummary(
          result?.warm?.bodyJson || result?.warm?.bodyText,
        );
        const fetchErr =
          result?.list?.fetchError || result?.warm?.fetchError || null;
        this.logger.warn(
          `🧪 Browser web-api non-200: list=${listStatus} warm=${warmStatus} ${listSummary ? `[list ${listSummary}]` : ""} ${warmSummary ? `[warm ${warmSummary}]` : ""} [signals ${this.buildSessionSignalSnapshot(newCookies, newCsrf)}]`,
        );
        return {
          success: false,
          data: null,
          error: `Browser web-api status list=${listStatus} warm=${warmStatus}${fetchErr ? ` fetchError=${fetchErr}` : ""}`,
          csrfToken: newCsrf,
          cookiesString: newCookies,
          // Only treat 412 as expired; 401/403 can be transient (csrf/session trust).
          sessionExpired: listStatus === 412,
        };
      }

      const resultsArray =
        result?.list?.bodyJson?.data?.results ||
        result?.list?.bodyJson?.results ||
        result?.list?.bodyJson?.transactions ||
        [];
      const totalCount =
        result?.list?.bodyJson?.data?.totalResults ||
        result?.list?.bodyJson?.totalResults ||
        resultsArray.length ||
        0;

      return {
        success: true,
        data: {
          results: resultsArray,
          totalResults: totalCount,
          totalAmount: result?.list?.bodyJson?.data?.totalAmount || 0,
        },
        csrfToken: newCsrf,
        cookiesString: newCookies,
        refreshedToken:
          this.extractTokenFromCookies(newCookies, "MERCHANT_USER_A_TOKEN") || null,
        refreshedRefreshToken:
          this.extractTokenFromCookies(newCookies, "MERCHANT_USER_R_TOKEN") || null,
      };
    } catch (err: any) {
      this.logger.warn(`🧪 Persistent-browser result: FAIL (${err.message})`);
      return {
        success: false,
        data: null,
        error: err.message || "Persistent browser sync failed",
      };
    } finally {
      if (page) {
        try {
          await page.close().catch(() => { });
        } catch { }
      }
      if (browserCtx && browserCtx.browser) {
        try {
          await browserCtx.browser.close().catch(() => {});
        } catch {}
      }
    }
  }

  /**
   * Step 1: Visit business.phonepe.com to get initial CSRF cookies,
   * then solve hCaptcha and call the REAL web API endpoint.
   */
  async sendOtpViaWeb(phoneNumber: string): Promise<any> {
    const sessionId = `ppweb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let browser: any = null;

    try {
      this.logger.log(`🌐 [Web API] Starting web OTP flow for ${phoneNumber}`);

      // Step 1: Get CSRF cookies by visiting the login page
      this.initStealth();

      browser = await puppeteer.launch({
        headless: "new" as any, // Use new headless mode (harder to detect)
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--window-size=1280,800",
        ],
      });

      const page = await browser.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      );
      await page.setViewport({ width: 1280, height: 800 });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en;q=0.9",
      });

      // Intercept Set-Cookie headers from API calls to capture CSRF
      let interceptedCsrf = "";
      page.on("response", async (response: any) => {
        try {
          const headers = response.headers();
          const setCookieHeader = headers["set-cookie"] || "";
          if (
            setCookieHeader.includes("_CKB2N1BHVZ") ||
            setCookieHeader.includes("_X52F70K3N")
          ) {
            this.logger.log(
              `🔍 Intercepted CSRF cookie from: ${response.url()}`,
            );
          }
          // Also look for x-csrf-token in response headers
          if (headers["x-csrf-token"]) {
            interceptedCsrf = headers["x-csrf-token"];
            this.logger.log(
              `🔍 Intercepted X-Csrf-Token header: ${interceptedCsrf}`,
            );
          }
        } catch (e) {
          // Ignore
        }
      });

      this.logger.log("📱 Visiting PhonePe Business login page for cookies...");
      await page.goto(this.loginPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      // Wait for the SPA to fully render - look for the phone input or login form
      this.logger.log("⏳ Waiting for SPA to fully render...");
      try {
        await page.waitForSelector(
          "#phone_number, input[type='tel'], .login-form, button",
          {
            timeout: 10000,
          },
        );
        this.logger.log("✅ SPA login form detected");
      } catch (e) {
        this.logger.warn(
          "⚠️ Login form selector not found within 10s, continuing anyway...",
        );
      }

      // Brief pause for SPA cookies (waitForSelector above already waited for the form)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 1b: Call /apis/mi-web/v1/user/reset to clear old auth tokens
      // From Burp: this endpoint clears OCULUS_G_TOKEN, OCULUS_R_TOKEN, etc. (Max-Age=0)
      // It does NOT set _X52F70K3N — that cookie is generated by the SPA's JS during page load.
      const webFingerprint = this.generateWebFingerprint(phoneNumber);
      this.logger.log("🔄 Calling /user/reset to clear old auth tokens...");

      try {
        // First try from within the page context (so cookies auto-set)
        const resetResult = await page.evaluate(async (fingerprint: string) => {
          try {
            const res = await fetch(
              "https://web-api.phonepe.com/apis/mi-web/v1/user/reset",
              {
                method: "GET",
                credentials: "include",
                headers: {
                  Accept: "application/json, text/plain, */*",
                  "X-App-Id": "oculus",
                  "X-Source-Type": "WEB",
                  "X-Source-Platform": "WEB",
                  Namespace: "insights",
                  Fingerprint: fingerprint,
                  "X-Device-Fingerprint": "123",
                },
              },
            );
            return {
              status: res.status,
              ok: res.ok,
              statusText: res.statusText,
            };
          } catch (e: any) {
            return { status: 0, ok: false, statusText: e.message };
          }
        }, webFingerprint);
        this.logger.log(
          `🔄 /user/reset response: ${resetResult.status} ${resetResult.statusText}`,
        );

        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (resetErr: any) {
        this.logger.warn(
          `⚠️ In-page /user/reset call failed: ${resetErr.message}. Trying direct axios call...`,
        );
      }

      // Step 1c: Call /auth/logout via direct axios to OBTAIN the CSRF token pair.
      // From Burp analysis: /auth/logout is the ONLY endpoint that returns BOTH:
      //   - X-Csrf-Token response header (SPA JS writes this to _X52F70K3N cookie)
      //   - Set-Cookie: _CKB2N1BHVZ=...; (HttpOnly server-side CSRF cookie)
      // In a fresh session (no prior cookies), the SPA never calls /auth/logout,
      // so we must make this call directly to bootstrap the CSRF pair.
      let ckb2n1bhvzCookie = "";
      try {
        const currentPageCookies = await page.cookies();
        const currentCookieString = currentPageCookies
          .map((c: any) => `${c.name}=${c.value}`)
          .join("; ");

        this.logger.log("🔑 Calling /auth/logout to obtain CSRF token pair...");
        const logoutResp = await axios.post(
          `${this.webApiBase}/apis/mi-web/v1/auth/logout`,
          null,
          {
            headers: {
              Host: "web-api.phonepe.com",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-GB,en;q=0.9",
              "Sec-Ch-Ua": this.webSecChUa,
              "Sec-Ch-Ua-Mobile": "?0",
              "Sec-Ch-Ua-Platform": '"macOS"',
              "Sec-Fetch-Site": "same-site",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Dest": "empty",
              Priority: "u=1, i",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
              "User-Agent": this.webDesktopUa,
              "X-App-Id": "oculus",
              "X-Source-Type": "WEB",
              "X-Source-Platform": "WEB",
              Namespace: "insights",
              Fingerprint: webFingerprint,
              "X-Device-Fingerprint": "123",
              Cookie: currentCookieString,
            },
            timeout: 10000,
            validateStatus: (status) => status < 500,
          },
        );

        this.logger.log(`🔑 /auth/logout response: ${logoutResp.status}`);

        // Extract X-Csrf-Token from response header — this is what the SPA writes to _X52F70K3N
        if (logoutResp.headers["x-csrf-token"]) {
          interceptedCsrf = logoutResp.headers["x-csrf-token"];
          this.logger.log(
            `✅ X-Csrf-Token from /auth/logout: ${interceptedCsrf}`,
          );

          // Inject _X52F70K3N cookie into Puppeteer (mimicking what SPA JS does)
          await page.setCookie({
            name: "_X52F70K3N",
            value: interceptedCsrf,
            domain: ".phonepe.com",
            path: "/",
            secure: true,
          });
        }

        // Extract _CKB2N1BHVZ from Set-Cookie (HttpOnly, server-managed)
        const logoutSetCookies = logoutResp.headers["set-cookie"] || [];
        const logoutCookieArray = Array.isArray(logoutSetCookies)
          ? logoutSetCookies
          : [logoutSetCookies];

        for (const sc of logoutCookieArray) {
          if (sc.includes("_CKB2N1BHVZ=")) {
            ckb2n1bhvzCookie = sc.split("_CKB2N1BHVZ=")[1].split(";")[0];
            if (ckb2n1bhvzCookie && ckb2n1bhvzCookie.length > 1) {
              this.logger.log(
                `✅ _CKB2N1BHVZ from /auth/logout: ${ckb2n1bhvzCookie.substring(0, 20)}...`,
              );
              // Inject into Puppeteer page cookies
              await page.setCookie({
                name: "_CKB2N1BHVZ",
                value: ckb2n1bhvzCookie,
                domain: ".phonepe.com",
                path: "/",
                secure: true,
                httpOnly: true,
              });
            }
          }
        }
      } catch (logoutErr: any) {
        this.logger.warn(`⚠️ /auth/logout failed: ${logoutErr.message}`);
      }

      // Poll for CSRF cookie (it may take time for JS to set it)
      let csrfToken = "";
      let cookieString = "";
      for (let attempt = 0; attempt < 16; attempt++) {
        const cookies = await page.cookies();

        // Check for _X52F70K3N (non-HttpOnly CSRF set by SPA's client-side JS)
        const csrfCookie = cookies.find((c: any) => c.name === "_X52F70K3N");
        if (csrfCookie) {
          csrfToken = csrfCookie.value;
          cookieString = cookies
            .map((c: any) => `${c.name}=${c.value}`)
            .join("; ");
          this.logger.log(
            `✅ CSRF cookie found on attempt ${attempt + 1}: ${csrfToken}`,
          );
          this.logger.log(
            `🍪 All cookies: ${cookies.map((c: any) => c.name).join(", ")}`,
          );
          break;
        }

        if (attempt < 15) {
          this.logger.debug(
            `⏳ CSRF cookie not yet set by SPA JS (attempt ${attempt + 1}/16), waiting 500ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // If no _X52F70K3N cookie, try getting CSRF from page JavaScript context
      if (!csrfToken) {
        this.logger.warn(
          "⚠️ _X52F70K3N cookie not found, trying JS extraction...",
        );

        // Try to extract from the page's JavaScript (React state, window variables, meta tags)
        const jsExtracted = await page.evaluate(() => {
          // Check document.cookie (non-HttpOnly cookies)
          const docCookies = document.cookie;
          const csrfMatch = docCookies.match(/_X52F70K3N=([^;]+)/);
          if (csrfMatch)
            return { source: "document.cookie", value: csrfMatch[1] };

          // Check meta tags
          const metaCsrf = document.querySelector("meta[name='csrf-token']");
          if (metaCsrf)
            return {
              source: "meta",
              value: metaCsrf.getAttribute("content") || "",
            };

          // Check window variables
          const win = window as any;
          if (win.__CSRF_TOKEN__)
            return {
              source: "window.__CSRF_TOKEN__",
              value: win.__CSRF_TOKEN__,
            };
          if (win.csrfToken)
            return { source: "window.csrfToken", value: win.csrfToken };

          // Check for Ant Design's XSRF token (common in React apps)
          if (win.__NEXT_DATA__?.props?.csrfToken)
            return {
              source: "NEXT_DATA",
              value: win.__NEXT_DATA__.props.csrfToken,
            };

          return { source: "none", value: "", cookies: docCookies };
        });

        this.logger.log(
          `🔍 JS extraction result: ${JSON.stringify(jsExtracted)}`,
        );

        if (jsExtracted.value) {
          csrfToken = jsExtracted.value;
          this.logger.log(`✅ CSRF from ${jsExtracted.source}: ${csrfToken}`);
        }
      }

      // Use intercepted CSRF if we still don't have one
      if (!csrfToken && interceptedCsrf) {
        csrfToken = interceptedCsrf;
        this.logger.log(`✅ Using intercepted X-Csrf-Token: ${csrfToken}`);
      }

      // Build final cookie string if not already built
      if (!cookieString) {
        const cookies = await page.cookies();
        cookieString = cookies
          .map((c: any) => `${c.name}=${c.value}`)
          .join("; ");
        this.logger.log(
          `🍪 Final cookies (${cookies.length}): ${cookies.map((c: any) => c.name).join(", ")}`,
        );
      }

      if (!csrfToken) {
        // Last resort: take a screenshot and log the page content for debugging
        const screenshotPath = `/tmp/phonepe-web-csrf-debug-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const pageContent = await page.evaluate(() =>
          document.body.innerText?.substring(0, 500),
        );
        this.logger.error(`❌ No CSRF token found after all attempts`);
        this.logger.error(`📸 Debug screenshot: ${screenshotPath}`);
        this.logger.error(`📄 Page content: ${pageContent}`);

        // Try proceeding anyway - the API might still work or give a better error
        this.logger.warn("⚠️ Proceeding without CSRF token...");
      }

      // Step 2: Extract hCaptcha sitekey and solve it
      let sitekey = await page.evaluate(() => {
        const el = document.querySelector("[data-sitekey]");
        return el?.getAttribute("data-sitekey") || "";
      });

      // PhonePe's known business sitekey if not found in DOM
      if (!sitekey) {
        sitekey = "a0d72677-5e54-4291-844f-108b4bf5c9a1";
        this.logger.log(`⚠️ Using fallback hCaptcha sitekey: ${sitekey}`);
      }

      let hCaptchaToken = "";

      if (sitekey) {
        this.logger.log(`🔐 hCaptcha sitekey found: ${sitekey}`);
        const captchaApiKey = process.env.CAPTCHA_API_KEY;

        if (captchaApiKey) {
          this.logger.log("🔑 Solving hCaptcha via 2captcha...");
          try {
            hCaptchaToken = await this.solveHCaptcha(
              sitekey,
              this.loginPageUrl,
              captchaApiKey,
            );
            this.logger.log(
              `✅ hCaptcha solved! Token length: ${hCaptchaToken.length}`,
            );
          } catch (err: any) {
            this.logger.error(`❌ hCaptcha solving failed: ${err.message}`);
          }
        } else {
          this.logger.warn(
            "⚠️ No CAPTCHA_API_KEY. Trying API call without captcha token...",
          );
        }
      } else {
        this.logger.log("ℹ️ No hCaptcha sitekey found (may not be required)");
      }

      // Close browser - we have everything we need
      await browser.close();
      browser = null;

      // Step 3: Make direct API call to the REAL web endpoint
      // webFingerprint was already generated in Step 1b (/user/reset)

      const payload = {
        type: "OTP_V2",
        endpoint: phoneNumber,
        channelType: "SMS",
        deviceFingerprint: "123",
      };

      // 1. Sync _X52F70K3N with csrfToken header
      let finalCookies = cookieString || "";
      if (csrfToken) {
        const regex = /_X52F70K3N=[^;]*(?:;|$)/;
        const newValue = `_X52F70K3N=${csrfToken};`;
        if (finalCookies.match(/_X52F70K3N=/)) {
          finalCookies = finalCookies.replace(regex, newValue);
        } else {
          finalCookies = `${newValue} ${finalCookies}`.trim();
        }
      }

      const headers: Record<string, string> = this.buildWebHeaders(
        finalCookies,
        csrfToken || "",
        webFingerprint,
      );
      headers["Content-Length"] = JSON.stringify(payload).length.toString();

      if (hCaptchaToken) {
        headers["H-Captcha-Token"] = hCaptchaToken;
      }

      const url = `${this.webApiBase}${this.sendOtpPath}`;
      this.logger.log(`📤 Calling web API: POST ${url}`);
      this.logger.debug(`📤 Payload: ${JSON.stringify(payload)}`);

      const response = await axios.post(url, payload, {
        headers,
        timeout: 15000,
        validateStatus: (status) => status < 500,
      });

      this.logger.log(
        `📥 Web API response: ${response.status} - ${JSON.stringify(response.data)}`,
      );

      // Check for new CSRF token in response headers
      const newCsrfToken = response.headers["x-csrf-token"] || csrfToken;

      // Update cookies if Set-Cookie is present
      const setCookies = response.headers["set-cookie"];
      let updatedCookieString = cookieString;
      if (setCookies) {
        const newCookies = Array.isArray(setCookies)
          ? setCookies
          : [setCookies];
        for (const sc of newCookies) {
          const [nameVal] = sc.split(";");
          const [name, val] = nameVal.split("=");
          // Update or add the cookie
          const regex = new RegExp(`${name.trim()}=[^;]+`);
          if (updatedCookieString.match(regex)) {
            updatedCookieString = updatedCookieString.replace(
              regex,
              `${name.trim()}=${val}`,
            );
          } else {
            updatedCookieString += `; ${name.trim()}=${val}`;
          }
        }
      }

      if (response.status === 200 && response.data?.token) {
        const token = response.data.token;
        const expiry = response.data.expiry;

        this.logger.log(
          `✅ PhonePe web OTP sent successfully! Token: ${token.substring(0, 10)}..., Expiry: ${expiry}s`,
        );

        // Store session for verify step
        this.webSessions.set(sessionId, {
          cookies: updatedCookieString,
          csrfToken: newCsrfToken,
          fingerprint: webFingerprint,
          token: token,
          phoneNumber: phoneNumber,
        });

        return {
          success: true,
          token: token,
          deviceFingerprint: "123",
          fingerprint: webFingerprint,
          message: "OTP sent via PhonePe web API",
          sessionId: sessionId,
          method: "web-api",
        };
      }

      // API returned non-success
      this.logger.error(
        `❌ Web API failed: ${response.status} - ${JSON.stringify(response.data)}`,
      );

      if (
        response.data?.code === "CAPTCHA_REQUIRED" ||
        response.status === 403
      ) {
        throw new BadRequestException(
          "PhonePe web API requires captcha. Set CAPTCHA_API_KEY env variable with a 2captcha API key.",
        );
      }

      throw new BadRequestException(
        `PhonePe web API error: ${response.data?.message || response.data?.code || `HTTP ${response.status}`}`,
      );
    } catch (error: any) {
      this.logger.error(`❌ PhonePe web OTP failed: ${error.message}`);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to send OTP via PhonePe web API: ${error.message}`,
      );
    } finally {
      if (browser) {
        try {
          await browser.close().catch(() => {});
        } catch (e) { }
      }
    }
  }

  /**
   * Phase 1: Prepare web session — launch Puppeteer, get cookies/CSRF/sitekey.
   * Returns { sessionId, sitekey } so the frontend can show hCaptcha to the user.
   */
  async prepareWebSession(
    phoneNumber: string,
  ): Promise<{ sessionId: string; sitekey: string }> {
    const crypto = require("crypto");
    // Use a deterministic seed that is stable for the provider lifecycle.
    // We generate a providerId-like UUID here and embed it into sessionId so the connect flow
    // can reuse it when creating the MerchantProvider record.
    const proposedProviderId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");
    const sessionId = `ppweb_${proposedProviderId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let page: any = null;

    let browserInstance: any = null;

    try {
      this.logger.log(
        `🌐 [Prepare] Starting web session preparation for ${phoneNumber}`,
      );

      // Use a stable fingerprint seed per account (phone number), not a random providerId.
      // Random seed causes identity drift across flows/reconnects and can trigger 401/412.
      const webFingerprint = this.generateWebFingerprint(phoneNumber);
      const browserCtx = await this.getPersistentBrowser(webFingerprint);
      browserInstance = browserCtx.browser;

      page = await browserInstance.newPage();
      await this.optimizePuppeteerPage(page);
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      );
      await page.setViewport({ width: 1280, height: 800 });
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-GB,en;q=0.9" });

      let interceptedCsrf = "";
      page.on("response", async (response: any) => {
        try {
          const headers = response.headers();
          if (headers["x-csrf-token"]) {
            interceptedCsrf = headers["x-csrf-token"];
          }
        } catch (e) { }
      });

      this.logger.log("📱 [Prepare] Visiting PhonePe Business login page...");
      await page.goto(this.loginPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      try {
        await page.waitForSelector(
          "#phone_number, input[type='tel'], .login-form, button",
          { timeout: 10000 },
        );
        this.logger.log("✅ [Prepare] SPA login form detected");
      } catch (e) {
        this.logger.warn(
          "⚠️ [Prepare] Login form selector not found, continuing...",
        );
      }

      // Brief pause for SPA to set cookies (waitForSelector above already waited for the form)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Call /user/reset
      this.logger.log("🔄 [Prepare] Calling /user/reset...");
      try {
        await page.evaluate(async (fingerprint: string) => {
          try {
            await fetch(
              "https://web-api.phonepe.com/apis/mi-web/v1/user/reset",
              {
                method: "GET",
                credentials: "include",
                headers: {
                  Accept: "application/json, text/plain, */*",
                  "X-App-Id": "oculus",
                  "X-Source-Type": "WEB",
                  "X-Source-Platform": "WEB",
                  Namespace: "insights",
                  Fingerprint: fingerprint,
                  "X-Device-Fingerprint": "123",
                },
              },
            );
          } catch (e) { }
        }, webFingerprint);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (e: any) {
        this.logger.warn(`⚠️ [Prepare] /user/reset failed: ${e.message}`);
      }

      // Call /auth/logout to get CSRF pair
      let ckb2n1bhvzCookie = "";
      try {
        const currentPageCookies = await page.cookies();
        const currentCookieString = currentPageCookies
          .map((c: any) => `${c.name}=${c.value}`)
          .join("; ");

        this.logger.log("🔑 [Prepare] Calling /auth/logout for CSRF...");
        const logoutResp = await axios.post(
          `${this.webApiBase}/apis/mi-web/v1/auth/logout`,
          null,
          {
            headers: {
              Host: "web-api.phonepe.com",
              Accept: "application/json, text/plain, */*",
              "Accept-Language": "en-GB,en;q=0.9",
              Origin: "https://business.phonepe.com",
              Referer: "https://business.phonepe.com/",
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
              "X-App-Id": "oculus",
              "X-Source-Type": "WEB",
              "X-Source-Platform": "WEB",
              Namespace: "insights",
              Fingerprint: webFingerprint,
              "X-Device-Fingerprint": "123",
              Cookie: currentCookieString,
            },
            timeout: 10000,
            validateStatus: (status) => status < 500,
          },
        );

        if (logoutResp.headers["x-csrf-token"]) {
          interceptedCsrf = logoutResp.headers["x-csrf-token"];
          await page.setCookie({
            name: "_X52F70K3N",
            value: interceptedCsrf,
            domain: ".phonepe.com",
            path: "/",
            secure: true,
          });
        }

        const logoutSetCookies = logoutResp.headers["set-cookie"] || [];
        const logoutCookieArray = Array.isArray(logoutSetCookies)
          ? logoutSetCookies
          : [logoutSetCookies];
        for (const sc of logoutCookieArray) {
          if (sc.includes("_CKB2N1BHVZ=")) {
            ckb2n1bhvzCookie = sc.split("_CKB2N1BHVZ=")[1].split(";")[0];
            if (ckb2n1bhvzCookie && ckb2n1bhvzCookie.length > 1) {
              await page.setCookie({
                name: "_CKB2N1BHVZ",
                value: ckb2n1bhvzCookie,
                domain: ".phonepe.com",
                path: "/",
                secure: true,
                httpOnly: true,
              });
            }
          }
        }
      } catch (logoutErr: any) {
        this.logger.warn(
          `⚠️ [Prepare] /auth/logout failed: ${logoutErr.message}`,
        );
      }

      // Poll for CSRF cookie
      let csrfToken = "";
      let cookieString = "";
      for (let attempt = 0; attempt < 16; attempt++) {
        const cookies = await page.cookies();
        const csrfCookie = cookies.find((c: any) => c.name === "_X52F70K3N");
        if (csrfCookie) {
          csrfToken = csrfCookie.value;
          cookieString = cookies
            .map((c: any) => `${c.name}=${c.value}`)
            .join("; ");
          this.logger.log(
            `✅ [Prepare] CSRF cookie found on attempt ${attempt + 1}: ${csrfToken}`,
          );
          break;
        }
        if (attempt < 15) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      if (!csrfToken && interceptedCsrf) {
        csrfToken = interceptedCsrf;
      }

      if (!cookieString) {
        const cookies = await page.cookies();
        cookieString = cookies
          .map((c: any) => `${c.name}=${c.value}`)
          .join("; ");
      }

      // Extract sitekey
      let sitekey = await page.evaluate(() => {
        const el = document.querySelector("[data-sitekey]");
        return el?.getAttribute("data-sitekey") || "";
      });
      if (!sitekey) {
        sitekey = "a0d72677-5e54-4291-844f-108b4bf5c9a1";
        this.logger.log(
          `⚠️ [Prepare] Using fallback hCaptcha sitekey: ${sitekey}`,
        );
      }

      // Close the page AND browser — we only need cookies/CSRF for HTTP-based Phase 2
      await page.close().catch(() => { });
      await browserInstance.close().catch(() => { });

      // Store session for Phase 2
      this.webSessions.set(sessionId, {
        cookies: cookieString,
        csrfToken: csrfToken,
        fingerprint: webFingerprint,
        token: "", // Will be set after completeWebOtp
        phoneNumber: phoneNumber,
        sitekey: sitekey,
      });

      this.logger.log(
        `✅ [Prepare] Session stored: ${sessionId}, sitekey: ${sitekey}`,
      );

      return { sessionId, sitekey };
    } catch (error: any) {
      if (page) {
        try {
          await page.close().catch(() => { });
        } catch (e) { }
      }
      // Always close the browser to avoid locking the profile directory
      try {
        if (typeof browserInstance !== 'undefined' && browserInstance) {
          await browserInstance.close().catch(() => { });
        }
      } catch (e) { }
      this.logger.error(`❌ [Prepare] Failed: ${error.message}`);
      throw new BadRequestException(
        `Failed to prepare PhonePe web session: ${error.message}`,
      );
    }
  }

  /**
   * Phase 2: Complete OTP send using user-provided captcha token.
   * Retrieves stored session and calls the PhonePe login/initiate API.
   */
  async completeWebOtp(sessionId: string, captchaToken: string): Promise<any> {
    try {
      this.logger.log(
        `🔐 [Complete] Using captcha token to send OTP for session: ${sessionId}`,
      );

      const session = this.webSessions.get(sessionId);
      if (!session) {
        throw new BadRequestException(
          "Web session expired or not found. Please request OTP again.",
        );
      }

      const payload = {
        type: "OTP_V2",
        endpoint: session.phoneNumber,
        channelType: "SMS",
        deviceFingerprint: "123",
      };

      let finalCookies = session.cookies || "";
      if (session.csrfToken) {
        const regex = /_X52F70K3N=[^;]*(?:;|$)/;
        const newValue = `_X52F70K3N=${session.csrfToken};`;
        if (finalCookies.match(/_X52F70K3N=/)) {
          finalCookies = finalCookies.replace(regex, newValue);
        } else {
          finalCookies = `${newValue} ${finalCookies}`.trim();
        }
      }

      const headers: Record<string, string> = this.buildWebHeaders(
        finalCookies,
        session.csrfToken || "",
        session.fingerprint,
      );
      headers["Content-Length"] = JSON.stringify(payload).length.toString();
      if (captchaToken) {
        headers["H-Captcha-Token"] = captchaToken;
      }

      const url = `${this.webApiBase}${this.sendOtpPath}`;
      this.logger.log(`📤 [Complete] Calling web API: POST ${url}`);

      const response = await axios.post(url, payload, {
        headers,
        timeout: 15000,
        validateStatus: (status) => status < 500,
      });

      this.logger.log(
        `📥 [Complete] Web API response: ${response.status} - ${JSON.stringify(response.data)}`,
      );

      // Update cookies if Set-Cookie is present
      const newCsrfToken =
        response.headers["x-csrf-token"] || session.csrfToken;
      const setCookies = response.headers["set-cookie"];
      let updatedCookieString = session.cookies;
      if (setCookies) {
        const newCookies = Array.isArray(setCookies)
          ? setCookies
          : [setCookies];
        for (const sc of newCookies) {
          const [nameVal] = sc.split(";");
          const [name, val] = nameVal.split("=");
          const regex = new RegExp(`${name.trim()}=[^;]+`);
          if (updatedCookieString.match(regex)) {
            updatedCookieString = updatedCookieString.replace(
              regex,
              `${name.trim()}=${val}`,
            );
          } else {
            updatedCookieString += `; ${name.trim()}=${val}`;
          }
        }
      }

      if (response.status === 200 && response.data?.token) {
        const token = response.data.token;
        const expiry = response.data.expiry;

        this.logger.log(
          `✅ [Complete] OTP sent! Token: ${token.substring(0, 10)}..., Expiry: ${expiry}s`,
        );

        // Update session for verify step
        this.webSessions.set(sessionId, {
          ...session,
          cookies: updatedCookieString,
          csrfToken: newCsrfToken,
          token: token,
        });

        return {
          success: true,
          token: token,
          deviceFingerprint: "123",
          fingerprint: session.fingerprint,
          message: "OTP sent via PhonePe web API",
          sessionId: sessionId,
          method: "web-api",
        };
      }

      this.logger.error(
        `❌ [Complete] Web API failed: ${response.status} - ${JSON.stringify(response.data)}`,
      );

      if (
        response.data?.code === "CAPTCHA_REQUIRED" ||
        response.status === 403
      ) {
        throw new BadRequestException(
          "Captcha verification failed. Please try again.",
        );
      }

      throw new BadRequestException(
        `PhonePe web API error: ${response.data?.message || response.data?.code || `HTTP ${response.status}`}`,
      );
    } catch (error: any) {
      this.logger.error(`❌ [Complete] Failed: ${error.message}`);
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to send OTP via PhonePe web API: ${error.message}`,
      );
    }
  }

  /**
   * Step 2: Verify OTP using the web API endpoint.
   * Uses /apis/mi-web/v4/auth/web/login (from Burp capture)
   */
  async verifyOtpViaWeb(
    sessionId: string,
    otp: string,
    phoneNumber: string,
  ): Promise<any> {
    try {
      this.logger.log(`🔐 [Web API] Verifying OTP for session: ${sessionId}`);

      const session = this.webSessions.get(sessionId);
      if (!session) {
        throw new BadRequestException(
          "Web session expired or not found. Please request OTP again.",
        );
      }

      // Build the verify payload matching Burp capture exactly
      const payload = {
        loginRequest: {
          type: "OTP_V2",
          deviceFingerprint: "123",
          endpoint: phoneNumber,
          otp: otp,
          token: session.token,
          channelType: "SMS",
        },
        deviceInfo: {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          channelType: "WEB",
          browserFingerPrint: {
            xosv: "Chrome 145",
            omid: "Web Browser",
            xdpi: session.fingerprint.split(".")[0],
          },
          browserFingerPrintXosv: "Chrome 145",
          browserFingerPrintOmid: "Web Browser",
          browserFingerPrintXdpi: session.fingerprint.split(".")[0],
        },
      };

      let finalCookies = session.cookies || "";
      if (session.csrfToken) {
        const regex = /_X52F70K3N=[^;]*(?:;|$)/;
        const newValue = `_X52F70K3N=${session.csrfToken};`;
        if (finalCookies.match(/_X52F70K3N=/)) {
          finalCookies = finalCookies.replace(regex, newValue);
        } else {
          finalCookies = `${newValue} ${finalCookies}`.trim();
        }
      }

      const headers: Record<string, string> = this.buildWebHeaders(
        finalCookies,
        session.csrfToken || "",
        session.fingerprint,
      );
      headers["Content-Length"] = JSON.stringify(payload).length.toString();

      const url = `${this.webApiBase}${this.verifyOtpPath}`;
      this.logger.log(`📤 Calling web verify API: POST ${url}`);

      const response = await axios.post(url, payload, {
        headers,
        timeout: 15000,
        validateStatus: (status) => status < 500,
      });

      this.logger.log(
        `📥 Verify response: ${response.status} - ${JSON.stringify(response.data).substring(0, 300)}`,
      );

      if (response.status !== 200 || !response.data?.success) {
        const errorMsg = response.data?.message || `HTTP ${response.status}`;
        throw new BadRequestException(
          `PhonePe OTP verification failed: ${errorMsg}`,
        );
      }

      // Clean up session ONLY on success
      this.webSessions.delete(sessionId);

      const data = response.data;

      // Extract tokens and CSRF from headers/cookies
      const setCookies = response.headers["set-cookie"] || [];
      const cookieArray = Array.isArray(setCookies) ? setCookies : [setCookies];
      const newCsrfFromHeader = response.headers["x-csrf-token"];

      let authToken = "";
      let refreshToken = "";

      for (const cookie of cookieArray) {
        if (cookie.includes("MERCHANT_USER_A_TOKEN=")) {
          authToken = cookie.split("MERCHANT_USER_A_TOKEN=")[1].split(";")[0];
        }
        if (cookie.includes("MERCHANT_USER_R_TOKEN=")) {
          refreshToken = cookie
            .split("MERCHANT_USER_R_TOKEN=")[1]
            .split(";")[0];
        }
      }

      this.logger.log(`✅ PhonePe web login successful!`);

      // ── Inject verified cookies into persistent browser profile ──
      // This is the critical link: the sync flow uses getPersistentBrowser(fingerprint)
      // which reuses the same userDataDir. By injecting cookies now, the sync flow
      // will automatically have the valid auth session.
      try {
        const browserCtx = await this.getPersistentBrowser(session.fingerprint);
        const tempPage = await browserCtx.browser.newPage();
        await this.optimizePuppeteerPage(tempPage);
        try {
          await tempPage.goto("https://business.phonepe.com/", { waitUntil: "domcontentloaded", timeout: 15000 });

          // Inject all cookies from the verify response
          const allCookiesToSet: Array<{ name: string; value: string; domain: string; path: string; secure?: boolean; httpOnly?: boolean }> = [];
          for (const cookie of cookieArray) {
            const parts = cookie.split(";");
            const [nameVal] = parts;
            const eqIdx = nameVal.indexOf("=");
            if (eqIdx > 0) {
              const name = nameVal.slice(0, eqIdx).trim();
              const value = nameVal.slice(eqIdx + 1).trim();
              allCookiesToSet.push({ name, value, domain: ".phonepe.com", path: "/", secure: true });
            }
          }

          // Also set CSRF cookie
          if (newCsrfFromHeader) {
            allCookiesToSet.push({ name: "_X52F70K3N", value: newCsrfFromHeader, domain: ".phonepe.com", path: "/", secure: true });
          }

          if (allCookiesToSet.length > 0) {
            await tempPage.setCookie(...allCookiesToSet);
            this.logger.log(`🔗 Injected ${allCookiesToSet.length} cookies into persistent browser profile`);
          }
        } finally {
          await tempPage.close().catch(() => { });
          await browserCtx.browser.close().catch(() => { });
        }
      } catch (injectErr: any) {
        this.logger.warn(`⚠️ Failed to inject cookies into persistent browser: ${injectErr.message}`);
      }

      let groups = data.groups || [];

      // Merge cookies and synchronize CSRF
      let mergedCookies = this.mergeCookies(session.cookies, setCookies);

      // Priority: 1. Header, 2. Previous value, 3. Cookie
      let finalCsrfToken = newCsrfFromHeader || session.csrfToken;
      const csrfCookieMatch = mergedCookies.match(/_X52F70K3N=([^;]+)/);
      if (!newCsrfFromHeader) {
        if (csrfCookieMatch && csrfCookieMatch[1]) {
          finalCsrfToken = csrfCookieMatch[1];
        }
      }

      // Ensure the cookie matches the token if we got it from the header
      if (
        newCsrfFromHeader &&
        (!csrfCookieMatch || csrfCookieMatch[1] !== newCsrfFromHeader)
      ) {
        mergedCookies = this.mergeCookies(
          mergedCookies,
          `_X52F70K3N=${newCsrfFromHeader}`,
        );
      }

      // Bootstrap "_ppabwd*" trust cookies inside the persistent browser profile.
      // Without these, PhonePe frequently returns 403 OIM002 even with valid JWT+CSRF.
      try {
        const beforeHasPpabwd =
          mergedCookies.includes("_ppabwdcid=") || mergedCookies.includes("_ppabwdsid=");
        const boot = await this.bootstrapPersistentTrustCookies(
          session.fingerprint,
          mergedCookies,
        );
        mergedCookies = boot.cookiesString || mergedCookies;
        finalCsrfToken = boot.csrfToken || finalCsrfToken;
        const afterHasPpabwd =
          mergedCookies.includes("_ppabwdcid=") || mergedCookies.includes("_ppabwdsid=");
        if (!beforeHasPpabwd && afterHasPpabwd) {
          this.logger.log(
            `✅ Bootstrapped PhonePe trust cookies (_ppabwd*) in persistent profile`,
          );
        } else if (!afterHasPpabwd) {
          this.logger.warn(
            `⚠️ Trust cookies (_ppabwd*) still missing after bootstrap`,
          );
        }
      } catch (bootErr: any) {
        this.logger.warn(
          `⚠️ Failed to bootstrap trust cookies: ${bootErr.message}`,
        );
      }

      if (data.groupSelection && groups.length === 0 && authToken) {
        this.logger.log(
          `🔄 Fetching merchant stores/groups via persistent browser...`,
        );
        try {
          // Use persistent browser for groupSelection — Axios always fails with ECONNRESET
          // due to TLS fingerprint mismatch (per burp analysis)
          const browserCtx = await this.getPersistentBrowser(session.fingerprint);
          const groupPage = await browserCtx.browser.newPage();
          await this.optimizePuppeteerPage(groupPage);
          try {
            await groupPage.setUserAgent(
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            );
            await groupPage.goto("https://business.phonepe.com/", {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            });

            // Inject merged cookies (includes trust cookies when available)
            const cookieList = this.parseCookiesForPuppeteer(mergedCookies || "");
            if (cookieList.length > 0) {
              await groupPage.setCookie(...cookieList);
            }

            // ── SESSION WARMING: Navigate to dashboard to trigger tracking cookies ──
            try {
              this.logger.log(`🔥 Warming session by navigating to dashboard...`);
              await groupPage.goto("https://business.phonepe.com/", {
                waitUntil: "networkidle2",
                timeout: 30000,
              });
              // Wait a bit for SPA to settle and set cookies
              await new Promise((resolve) => setTimeout(resolve, 2000));
            } catch (e: any) {
              this.logger.warn(`⚠️ Session warming navigation failed: ${e.message}`);
            }

            const browserFp = this.generateWebFingerprint(phoneNumber);

            // Use browser fetch for groupSelection (GET, per burp captures)
            const groupResult = await groupPage.evaluate(async ({ fp }) => {
              try {
                // INTERNAL CSRF EXTRACTION: Always match header to cookie
                const getCsrf = () => {
                  const match = document.cookie.match(/_X52F70K3N=([^;]+)/);
                  return match ? match[1] : "";
                };
                const currentCsrf = getCsrf();

                const res = await fetch(
                  "https://web-api.phonepe.com/apis/mi-web/v1/user/groupSelection",
                  {
                    method: "GET",
                    credentials: "include",
                    headers: {
                      Accept: "application/json, text/plain, */*",
                      "X-Csrf-Token": currentCsrf,
                      "X-App-Id": "oculus",
                      "X-Source-Type": "WEB",
                      "X-Source-Platform": "WEB",
                      Fingerprint: fp,
                      "X-Device-Fingerprint": "123",
                      Namespace: "insights",
                    },
                  },
                );
                const text = await res.text();
                return { status: res.status, body: text };
              } catch (e: any) {
                return { status: 0, body: e.message || String(e) };
              }
            }, { fp: browserFp });

            this.logger.log(
              `📋 [groupSelection] Browser result: ${groupResult.status}`,
            );

            if (groupResult.status === 200) {
              try {
                const fetchedGroups = JSON.parse(groupResult.body);
                if (Array.isArray(fetchedGroups)) {
                  this.logger.log(
                    `✅ Fetched ${fetchedGroups.length} stores/groups via browser`,
                  );
                  groups = fetchedGroups.map((item: any) => ({
                    groupId: item.userGroupNamespace?.groupId,
                    groupValue: item.userGroupNamespace?.groupValue,
                    groupName: item.merchantName,
                    externalReferenceId: item.userGroupNamespace?.clientUniqueId,
                  }));

                  // ── CRITICAL: Call /user/updateSession to scope the JWT to a merchant ──
                  // Without this, the session is unscoped and ALL transaction APIs return 403.
                  // Per burp: POST /user/updateSession with {"userGroupId": <groupId>}
                  const activeGroup = fetchedGroups.find(
                    (g: any) => g.userGroupNamespace?.status === "ACTIVE" && g.merchantName !== "Create New Business"
                  );
                  if (activeGroup?.userGroupNamespace?.groupValue) {
                    const groupValue = activeGroup.userGroupNamespace.groupValue;
                    const groupId = activeGroup.userGroupNamespace.groupId;
                    this.logger.log(
                      `🔗 Calling /user/updateSession to scope session to groupId=${groupId} groupValue=${groupValue} (${activeGroup.merchantName})`,
                    );

                    const updateResult = await groupPage.evaluate(async ({ ugid, fp }) => {
                      try {
                        const getCsrf = () => {
                          const match = document.cookie.match(/_X52F70K3N=([^;]+)/);
                          return match ? match[1] : "";
                        };
                        const currentCsrf = getCsrf();

                        const res = await fetch(
                          `https://web-api.phonepe.com/apis/mi-web/v1/user/updateSession`,
                          {
                            method: "POST",
                            credentials: "include",
                            headers: {
                              Accept: "application/json, text/plain, */*",
                              "X-Csrf-Token": currentCsrf,
                              "X-App-Id": "oculus",
                              "X-Source-Type": "WEB",
                              "X-Source-Platform": "WEB",
                              Fingerprint: fp,
                              "X-Device-Fingerprint": "123",
                              Namespace: "insights",
                              "Content-Type": "application/json",
                            },
                            body: JSON.stringify({ userGroupId: ugid }),
                          },
                        );
                        const text = await res.text();
                        return { status: res.status, body: text };
                      } catch (e: any) {
                        return { status: 0, body: e.message || String(e) };
                      }
                    }, { ugid: groupId, fp: browserFp });

                    this.logger.log(
                      `📋 [/user/updateSession] Result: ${updateResult.status}`,
                    );

                    if (updateResult.status === 200) {
                      // Capture cookies from BOTH domains (web-api for tokens, business for tracking)
                      const apiCookies = await groupPage.cookies("https://web-api.phonepe.com");
                      const bizCookies = await groupPage.cookies("https://business.phonepe.com");
                      const allCookies = [...apiCookies, ...bizCookies];

                      const seen = new Set<string>();
                      const unique = allCookies.filter((c: any) => {
                        if (seen.has(c.name)) return false;
                        seen.add(c.name);
                        return true;
                      });

                      const newMergedCookies = unique.map((c: any) => `${c.name}=${c.value}`).join("; ");
                      mergedCookies = newMergedCookies;

                      // Extract new tokens and CSRF
                      const newAToken = unique.find((c: any) => c.name === "MERCHANT_USER_A_TOKEN");
                      const newRToken = unique.find((c: any) => c.name === "MERCHANT_USER_R_TOKEN");
                      const newCsrfCookie = unique.find((c: any) => c.name === "_X52F70K3N");

                      if (newAToken) authToken = newAToken.value;
                      if (newRToken) refreshToken = newRToken.value;
                      if (newCsrfCookie) finalCsrfToken = newCsrfCookie.value;

                      this.logger.log(
                        `✅ Session scoped to merchant ${activeGroup.merchantName} (${activeGroup.userGroupNamespace.groupValue})`,
                      );
                      this.logger.debug(`🍪 New Cookies captured: ${unique.map(c => c.name).join(", ")}`);

                      // Parse updateSession response for group details
                      try {
                        const sessionData = JSON.parse(updateResult.body);
                        // Some responses include selected group info; cookies are the source of truth.
                      } catch { } // ignore parse errors
                    } else {
                      this.logger.warn(
                        `⚠️ /user/updateSession failed: ${updateResult.status} - ${updateResult.body?.substring(0, 200)}`,
                      );
                    }
                  }
                }
              } catch (parseErr: any) {
                this.logger.warn(`⚠️ Failed to parse groupSelection: ${parseErr.message}`);
              }
            } else {
              this.logger.warn(
                `⚠️ groupSelection failed: ${groupResult.status} - ${groupResult.body?.substring(0, 200)}`,
              );
            }
          } finally {
            await groupPage.close().catch(() => { });
            await browserCtx.browser.close().catch(() => { });
          }
        } catch (groupsErr: any) {
          this.logger.warn(`⚠️ Error fetching groups: ${groupsErr.message}`);
        }
      }

      return {
        success: true,
        message: "PhonePe OTP verified successfully via web API",
        accountDetails: {
          phoneNumber: data.phone || phoneNumber,
          name: data.roleName || "PhonePe Merchant",
          userId: data.userId,
          merchantId: data.groupValue,
          groupId: data.groupId,
          groupValue: data.groupValue,
          token: authToken || data.userId,
          refreshToken: refreshToken,
          groups: groups,
          merchantUserId: data.merchantUserId,
          csrfToken: finalCsrfToken,
          cookiesString: mergedCookies,
          fingerprint: session.fingerprint,
          method: "web-api",
        },
        groups: groups,
        // Only require store selection if we actually have multiple groups.
        // If groupSelection=true but fetching groups failed (timeout/ECONNRESET),
        // this will be false and the flow will auto-connect using the default store.
        requiresGroupSelection: data.groupSelection && groups.length > 1,
        method: "web-api",
      };
    } catch (error: any) {
      this.logger.error(`❌ PhonePe web verify failed: ${error.message}`);

      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Failed to verify OTP via PhonePe web API: ${error.message}`,
      );
    }
  }

  /**
   * Scope a web JWT to a specific merchant group using /user/updateSession.
   * Per Burp: POST /apis/mi-web/v1/user/updateSession with {"userGroupId": <groupId>}.
   */
  async updateWebSession(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    userGroupId: number,
    groupValue?: string,
  ): Promise<{
    token: string;
    refreshToken: string;
    csrfToken: string;
    cookiesString: string;
  }> {
    try {
      this.logger.log(
        `🌐 [Web API] Calling /user/updateSession (browser-based) for userGroupId=${userGroupId}`,
      );

      const browserCtx = await this.getPersistentBrowser(fingerprint);
      const page = await browserCtx.browser.newPage();
      await this.optimizePuppeteerPage(page);
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        );
        await page.goto("https://business.phonepe.com/", {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });

        // Inject cookies so the browser session is authenticated.
        const cookieList = this.parseCookiesForPuppeteer(cookies || "");
        if (cookieList.length > 0) {
          await page.setCookie(...cookieList);
        }

        const fpHeader = this.fingerprintForWebApi(cookies || "", fingerprint);

        const updateResult = await page.evaluate(async ({ ugid, fp, fallbackCsrf }) => {
          try {
            const getCsrf = () => {
              const match = document.cookie.match(/_X52F70K3N=([^;]+)/);
              return match ? match[1] : "";
            };
            const currentCsrf = getCsrf() || fallbackCsrf;

            const res = await fetch(
              `https://web-api.phonepe.com/apis/mi-web/v1/user/updateSession`,
              {
                method: "POST",
                credentials: "include",
                headers: {
                  Accept: "application/json, text/plain, */*",
                  "X-Csrf-Token": currentCsrf,
                  "X-App-Id": "oculus",
                  "X-Source-Type": "WEB",
                  "X-Source-Platform": "WEB",
                  Fingerprint: fp,
                  "X-Device-Fingerprint": "123",
                  Namespace: "insights",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ userGroupId: ugid }),
              },
            );
            const text = await res.text();
            return { status: res.status, body: text };
          } catch (e: any) {
            return { status: 0, body: e.message || String(e) };
          }
        }, { ugid: userGroupId, fp: fpHeader, fallbackCsrf: csrfToken || "" });

        this.logger.log(`📋 [updateWebSession] Browser result: ${updateResult.status}`);

        if (updateResult.status !== 200) {
          throw new BadRequestException(
            `updateSession failed: HTTP ${updateResult.status} - ${updateResult.body?.substring(0, 200)}`,
          );
        }

        // Capture the new session state
        const updatedCookies = await page.cookies("https://web-api.phonepe.com");
        const cookiesString = updatedCookies.map((c) => `${c.name}=${c.value}`).join("; ");

        const newAToken = updatedCookies.find((c) => c.name === "MERCHANT_USER_A_TOKEN")?.value || authToken;
        const newRToken = updatedCookies.find((c) => c.name === "MERCHANT_USER_R_TOKEN")?.value || "";
        const newCsrf = updatedCookies.find((c) => c.name === "_X52F70K3N")?.value || csrfToken;

        return {
          token: newAToken,
          refreshToken: newRToken,
          csrfToken: newCsrf,
          cookiesString,
        };
      } finally {
        await page.close().catch(() => { });
      }
    } catch (error: any) {
      this.logger.error(`❌ Web updateSession failed: ${error.message}`);
      throw error;
    }
  }

  private async fetchMetricsStatsWeb(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    from: number,
    to: number,
    groupValue?: string | null,
    refreshToken?: string,
  ): Promise<{
    csrfToken: string;
    cookiesString: string;
    refreshedToken: string | null;
    refreshedRefreshToken: string | null;
    tokenExpired?: boolean; // true when response is 412 OIM010
  }> {
    const url = `${this.webApiBase}/apis/mi-web/v3/transactions/metrics/stats`;

    const requestBody = {
      from,
      to,
      selectedDateType: "week",
      filters: {
        status: ["COMPLETED"],
      } as any,
      transactionType: "FORWARD",
    };

    let finalCookies = this.ensureF1P21N7InCookies(cookies || "", fingerprint);

    const syncCookie = (name: string, value: string) => {
      if (!value) return;
      const regex = new RegExp(`${name}=[^;]*(?:;|$)`);
      const newValue = `${name}=${value}${value.endsWith(";") ? "" : ";"}`;
      if (finalCookies.match(new RegExp(`${name}=`))) {
        finalCookies = finalCookies.replace(regex, newValue);
      } else {
        finalCookies = `${newValue} ${finalCookies}`.trim();
      }
    };

    if (csrfToken) syncCookie("_X52F70K3N", csrfToken);
    if (authToken) syncCookie("MERCHANT_USER_A_TOKEN", authToken);
    if (refreshToken) syncCookie("MERCHANT_USER_R_TOKEN", refreshToken);

    const bodyStr = JSON.stringify(requestBody);

    // Burp working captures for web-api metrics/list rely on cookie auth (A_TOKEN/R_TOKEN)
    // and do not send Authorization header.
    const headers = this.buildWebHeaders(
      finalCookies,
      csrfToken,
      fingerprint,
    );
    headers["Content-Length"] = bodyStr.length.toString();

    try {
      this.logger.log(`🔥 Warming session via metrics/stats...`);
      const { gotScraping } = await eval('import("got-scraping")');

      const rawResponse = await gotScraping({
        url: url,
        method: "POST",
        json: requestBody,
        headers: headers as any,
        timeout: { request: 15000 },
        throwHttpErrors: false,
        responseType: "json",
      });

      const response = {
        status: rawResponse.statusCode,
        headers: rawResponse.headers as Record<string, any>,
        data: rawResponse.body,
      };

      let updatedCsrf = response.headers["x-csrf-token"] || csrfToken;
      let updatedCookies = this.mergeCookies(
        finalCookies,
        response.headers["set-cookie"],
      );

      if (updatedCsrf) {
        updatedCookies = this.mergeCookies(
          updatedCookies,
          `_X52F70K3N=${updatedCsrf}`,
        );
      }

      const newAuthToken = this.extractTokenFromCookies(
        updatedCookies,
        "MERCHANT_USER_A_TOKEN",
      );
      const tokenChanged = newAuthToken && newAuthToken !== authToken;

      const newRefreshToken = this.extractTokenFromCookies(
        updatedCookies,
        "MERCHANT_USER_R_TOKEN",
      );
      const refreshTokenChanged =
        newRefreshToken && newRefreshToken !== refreshToken;

      const tokenExpired = response.status === 412;
      if (response.status !== 200) {
        const summary = this.extractFailureSummary(response.data);
        const signals = getPhonePeSessionSignals(updatedCookies, updatedCsrf);
        const isTransient = response.status === 401 && shouldTreatAsTransientPhonePeSessionDrift(signals);

        if (isTransient) {
          this.logger.log(
            `ℹ️ Warm metrics got status=${response.status} (transient CSRF drift; auto-healing with rotated CSRF token)`,
          );
        } else {
          this.logger.warn(
            `⚠️ Warm metrics non-200 status=${response.status} ${summary ? `[${summary}]` : ""} [signals ${this.buildSessionSignalSnapshot(updatedCookies, updatedCsrf)}]`,
          );
        }
      }
      this.logger.log(
        `🌡️ Session warmed: ${response.status} (CSRF Rotated: ${updatedCsrf !== csrfToken}${tokenChanged ? ", Token Refreshed" : ""}${refreshTokenChanged ? ", RT Rotated" : ""}${tokenExpired ? ", TOKEN EXPIRED" : ""})`,
      );

      return {
        csrfToken: updatedCsrf,
        cookiesString: updatedCookies,
        refreshedToken: tokenChanged ? newAuthToken : null,
        refreshedRefreshToken: refreshTokenChanged ? newRefreshToken : null,
        tokenExpired,
      };
    } catch (error: any) {
      this.logger.warn(`⚠️ Session warming failed: ${error.message}`);
      return {
        csrfToken,
        cookiesString: finalCookies,
        refreshedToken: null,
        refreshedRefreshToken: null,
      };
    }
  }

  async fetchTransactionHistoryWeb(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue?: string | null,
    size: number = 50,
    fromDate?: Date,
    toDate?: Date,
    isRetry: boolean = false,
    refreshToken?: string,
  ): Promise<any> {
    const key = this.sanitizeProfileKey(fingerprint || "default");
    return await this.withKeyLock(key, async () => {
      return this.fetchTransactionHistoryWebDirect(
        authToken,
        cookies,
        csrfToken,
        fingerprint,
        groupValue,
        size,
        fromDate,
        toDate,
        isRetry,
        refreshToken,
      );
    });
  }

  private async fetchTransactionHistoryWebDirect(
    authToken: string,
    cookies: string,
    csrfToken: string,
    fingerprint: string,
    groupValue?: string | null,
    size: number = 50,
    fromDate?: Date,
    toDate?: Date,
    isRetry: boolean = false,
    refreshToken?: string,
  ): Promise<any> {
    try {
      this.logger.log(
        `🌐 Fetching transactions via Web API V3 for merchant: ${groupValue || "All"} (isRetry: ${isRetry})`,
      );
      this.logger.log(
        `🚀 [PhonePeWebService] Executing FAST HTTP fetch (got-scraping) - NO BROWSER USED`,
      );

      const toTimestamp = toDate ? toDate.getTime() : Date.now();
      const fromTimestamp = fromDate
        ? fromDate.getTime()
        : toTimestamp - 7 * 24 * 60 * 60 * 1000;

      let effectiveAuthToken = authToken;
      let effectiveRefreshToken = refreshToken;
      let effectiveCsrf = csrfToken;
      let effectiveCookies = this.ensureF1P21N7InCookies(cookies || "", fingerprint);

      const forceHttp =
        String(process.env.PHONEPE_WEB_FORCE_HTTP || "true").toLowerCase() !==
        "false";

      const persistentEnabled =
        !forceHttp &&
        String(process.env.PHONEPE_PERSISTENT_BROWSER || "true").toLowerCase() !==
        "false";
      if (!isRetry && persistentEnabled) {
        this.logger.log(
          `🧭 Using persistent-browser PhonePe sync (fingerprint=${String(fingerprint || "").slice(0, 18)}...)`,
        );
        const browserRes = await this.fetchTransactionHistoryViaPersistentBrowser(
          authToken,
          cookies,
          csrfToken,
          fingerprint,
          groupValue,
          size,
          fromTimestamp,
          toTimestamp,
          refreshToken,
        );
        this.logger.log(
          `🧭 Persistent-browser result: ${browserRes?.success ? "SUCCESS" : "FAIL"}${browserRes?.error ? ` (${browserRes.error})` : ""}`,
        );
        if (browserRes?.success) {
          return browserRes;
        }
        // Do not hard-stop on browser-reported sessionExpired (e.g. list=412/warm=401).
        // Let the tiered warm/refresh flow below attempt recovery before declaring expiry.
        if (browserRes?.sessionExpired) {
          this.logger.warn(
            `⚠️ Persistent-browser reported sessionExpired; attempting tiered recovery flow before declaring reconnect required.`,
          );
        }
        // Warm/list may have rotated cookies in the jar even when list ≠ 200 — feed axios + ephemeral.
        if (browserRes?.cookiesString) {
          effectiveCookies = browserRes.cookiesString;
          const jarA = this.extractTokenFromCookies(
            effectiveCookies,
            "MERCHANT_USER_A_TOKEN",
          );
          const jarR = this.extractTokenFromCookies(
            effectiveCookies,
            "MERCHANT_USER_R_TOKEN",
          );
          if (jarA) effectiveAuthToken = jarA;
          if (jarR) effectiveRefreshToken = jarR;
        }
        if (browserRes?.csrfToken) {
          effectiveCsrf = browserRes.csrfToken;
        }
        // If persistent path failed, fall back to axios + refresh tiered flow below.
      }

      // Ephemeral Chromium + page fetch before axios reduces Node/axios fingerprint drift
      // (persistent profile cold, corrupt, or wedged). Tier 3 below still retries ephemeral after axios fails.
      if (!isRetry && !forceHttp) {
        const ephemeralBeforeAxios =
          String(
            process.env.PHONEPE_WEB_EPHEMERAL_BEFORE_AXIOS ?? "false",
          ).toLowerCase() === "true";
        if (ephemeralBeforeAxios) {
          this.logger.log(
            `🧭 Ephemeral browser fetch before axios (same-origin session trust)...`,
          );
          const ep = await this.fetchTransactionHistoryViaBrowser(
            effectiveAuthToken,
            effectiveCookies,
            effectiveCsrf,
            fingerprint,
            groupValue,
            size,
            fromTimestamp,
            toTimestamp,
            effectiveRefreshToken,
          );
          if (ep?.success && ep?.data) {
            return {
              success: true,
              data: ep.data,
              csrfToken: ep.csrfToken,
              cookiesString: ep.cookiesString,
              refreshedToken: ep.refreshedToken,
              refreshedRefreshToken: ep.refreshedRefreshToken,
            };
          }
        }
      }

      const diffDays = (toTimestamp - fromTimestamp) / (24 * 60 * 60 * 1000);
      const selectedDateType = diffDays <= 8 ? "week" : "custom";

      // Ensure we have CSRF from cookies if not passed (e.g. stale DB state)
      if (!effectiveCsrf && effectiveCookies) {
        const csrfFromCookie =
          this.extractTokenFromCookies(effectiveCookies, "_X52F70K3N") ||
          this.extractTokenFromCookies(effectiveCookies, "_CKB2N1BHVZ");
        if (csrfFromCookie) effectiveCsrf = csrfFromCookie;
      }

      // When access JWT is already dead, metrics/stats often returns CF004 (401) first — refresh first
      // using cookie jar + CSRF so warm/list see a live A_TOKEN when R_TOKEN is still valid.
      if (!isRetry && effectiveCsrf && effectiveCookies) {
        const jwtExpEarly = this.extractJwtExpiry(effectiveCookies);
        const secsEarly = jwtExpEarly
          ? Math.round(jwtExpEarly - Date.now() / 1000)
          : null;
        const cooldownKeyEarly = fingerprint?.slice(0, 40) || "default";
        const lastFailEarly =
          this.refreshFailureCooldown.get(cooldownKeyEarly) ?? 0;
        const inCooldownEarly =
          Date.now() - lastFailEarly < this.REFRESH_COOLDOWN_MS;
        if (
          secsEarly !== null &&
          secsEarly < 0 &&
          !inCooldownEarly
        ) {
          this.logger.log(
            `⏰ JWT already expired (${Math.abs(secsEarly)}s ago); refresh before metrics warm...`,
          );
          const earlyRefresh = await this.refreshWebSessionDirect(
            effectiveCookies,
            effectiveCsrf,
            fingerprint,
            effectiveRefreshToken,
          );
          if (
            earlyRefresh.refreshedToken ||
            earlyRefresh.refreshedRefreshToken
          ) {
            this.refreshFailureCooldown.delete(cooldownKeyEarly);
            effectiveCookies = earlyRefresh.cookiesString;
            effectiveCsrf = earlyRefresh.csrfToken;
            if (earlyRefresh.refreshedToken) {
              effectiveAuthToken = earlyRefresh.refreshedToken;
            }
            if (earlyRefresh.refreshedRefreshToken) {
              effectiveRefreshToken = earlyRefresh.refreshedRefreshToken;
            }
            this.logger.log(`✅ Session refreshed before metrics warm`);
          } else {
            // Do not set refresh cooldown here — warm may rotate CSRF; proactive refresh retries below.
            if (forceHttp) {
              this.logger.log(
                `ℹ️ Pre-warm refresh failed; continuing to metrics warm (may CF004)`,
              );
            } else {
              this.logger.warn(
                `⚠️ Pre-warm refresh failed; continuing to metrics warm (may CF004)`,
              );
            }
          }
        }
      }

      // SESSION WARMING FIRST: Call metrics/stats to get fresh CSRF before any refresh.
      // PhonePe /auth/refresh requires valid X-Csrf-Token; warming returns it even when JWT is expired.
      if (!isRetry) {
        const warmed = await this.fetchMetricsStatsWeb(
          effectiveAuthToken,
          effectiveCookies,
          effectiveCsrf,
          fingerprint,
          fromTimestamp,
          toTimestamp,
          groupValue,
          effectiveRefreshToken,
        );
        effectiveCsrf = warmed.csrfToken;
        effectiveCookies = warmed.cookiesString;
        if (warmed.refreshedToken) {
          effectiveAuthToken = warmed.refreshedToken;
        }
        if (warmed.refreshedRefreshToken) {
          effectiveRefreshToken = warmed.refreshedRefreshToken;
        }
        // Warm returned 412 (Token Expired). Try browser refresh before giving up — R_TOKEN may still be valid.
        if (warmed.tokenExpired) {
          this.logger.log(
            `🔄 412 from warm — attempting browser refresh before marking expired...`,
          );
          const refreshResult = await this.refreshWebSessionDirect(
            effectiveCookies,
            effectiveCsrf,
            fingerprint,
            effectiveRefreshToken,
          );
          if (refreshResult.refreshedToken || refreshResult.refreshedRefreshToken) {
            effectiveCookies = refreshResult.cookiesString;
            effectiveCsrf = refreshResult.csrfToken;
            if (refreshResult.refreshedToken) {
              effectiveAuthToken = refreshResult.refreshedToken;
            }
            if (refreshResult.refreshedRefreshToken) {
              effectiveRefreshToken = refreshResult.refreshedRefreshToken;
            }
            this.logger.log(`✅ Refresh recovered session after 412`);
          } else {
            this.logger.warn(
              `⚠️ Session expired (412 from warm). Reconnect required.`,
            );
            return {
              success: false,
              data: null,
              error: "Token Expired",
              sessionExpired: true,
            };
          }
        }
      }

      // PROACTIVE TOKEN REFRESH: when JWT is within jwtProactiveRefreshSeconds of expiry (default 15m).
      // Persistent-browser /auth/refresh runs first in refreshWebSessionDirect (Burp parity).
      const jwtExp = this.extractJwtExpiry(effectiveCookies);
      const secsLeft = jwtExp ? Math.round(jwtExp - Date.now() / 1000) : -9999;
      const cooldownKey = fingerprint?.slice(0, 40) || "default";
      const lastFail = this.refreshFailureCooldown.get(cooldownKey) ?? 0;
      const inCooldown = Date.now() - lastFail < this.REFRESH_COOLDOWN_MS;
      const shouldTryRefresh =
        secsLeft < this.jwtProactiveRefreshSeconds &&
        effectiveCsrf &&
        !inCooldown;

      if (shouldTryRefresh) {
        this.logger.log(
          `⏰ JWT ${secsLeft > 0 ? `expiring in ${secsLeft}s` : `expired ${Math.abs(secsLeft)}s ago`}, attempting session refresh...`,
        );

        const refreshResult = await this.refreshWebSessionDirect(
          effectiveCookies,
          effectiveCsrf,
          fingerprint,
          effectiveRefreshToken,
        );
        if (refreshResult.refreshedToken || refreshResult.refreshedRefreshToken) {
          this.refreshFailureCooldown.delete(cooldownKey); // Success clears cooldown
          effectiveCookies = refreshResult.cookiesString;
          effectiveCsrf = refreshResult.csrfToken;
          if (refreshResult.refreshedToken) {
            effectiveAuthToken = refreshResult.refreshedToken;
          }
          if (refreshResult.refreshedRefreshToken) {
            effectiveRefreshToken = refreshResult.refreshedRefreshToken;
          }
        } else {
          this.refreshFailureCooldown.set(cooldownKey, Date.now());
          if (forceHttp) {
            this.logger.log(
              `ℹ️ Refresh 401 — cooldown 2min. Continuing with warm.`,
            );
          } else {
            this.logger.warn(
              `⚠️ Refresh 401 — cooldown 2min. Continuing with warm.`,
            );
          }
        }
      }

      const transactionsUrl = `${this.webApiBase}/apis/mi-web/v3/transactions/list`;

      const requestBody = {
        offset: 0,
        size: 10,
        filters: {
          status: ["COMPLETED"],
        } as any,
        transactionType: "FORWARD",
        from: fromTimestamp,
        to: toTimestamp,
        selectedDateType: selectedDateType,
      };

      let finalCookies = effectiveCookies || "";

      if (!effectiveCsrf && finalCookies.includes("_X52F70K3N=")) {
        const match = finalCookies.match(/_X52F70K3N=([^;]+)/);
        if (match) effectiveCsrf = match[1];
      }

      const syncCookie = (name: string, value: string) => {
        if (!value) return;
        const regex = new RegExp(`${name}=[^;]*(?:;|$)`);
        const newValue = `${name}=${value}${value.endsWith(";") ? "" : ";"}`;
        if (finalCookies.match(new RegExp(`${name}=`))) {
          finalCookies = finalCookies.replace(regex, newValue);
        } else {
          finalCookies = `${newValue} ${finalCookies}`.trim();
        }
      };

      if (effectiveCsrf) syncCookie("_X52F70K3N", effectiveCsrf);
      if (effectiveAuthToken)
        syncCookie("MERCHANT_USER_A_TOKEN", effectiveAuthToken);
      if (effectiveRefreshToken)
        syncCookie("MERCHANT_USER_R_TOKEN", effectiveRefreshToken);

      const bodyStr = JSON.stringify(requestBody);

      const headers = this.buildWebHeaders(
        finalCookies,
        effectiveCsrf || "",
        fingerprint,
      );
      headers["Content-Length"] = bodyStr.length.toString();

      this.logger.log(
        `📤 Web API Sync: CSRF: ${effectiveCsrf ? effectiveCsrf.substring(0, 5) + "..." : "MISSING"}, ` +
        `Cookies: ${finalCookies.split(";").length}, Size: ${requestBody.size}`,
      );

      // Burp often hits /transactions/recent before list; from Node/axios it frequently
      // hangs or exceeds timeout, blocking the real list call for 12s+. Off by default;
      // set PHONEPE_WEB_AXIOS_RECENT_PREFLIGHT=true to experiment.
      const axiosRecentPreflight =
        String(
          process.env.PHONEPE_WEB_AXIOS_RECENT_PREFLIGHT || "",
        ).toLowerCase() === "true";
      if (axiosRecentPreflight) {
        try {
          const sessionId = this.extractJwtSessionId(finalCookies);
          const recentBody: Record<string, any> = {
            filters: {},
            lastTimestamp: toTimestamp,
          };
          if (sessionId) recentBody.sessionId = sessionId;
          const recentStarted = Date.now();
          const recentRes = await axios.post(
            `${this.webApiBase}/apis/mi-web/v1/transactions/recent`,
            recentBody,
            {
              headers,
              timeout: 6000,
              validateStatus: (status) => status < 500,
            },
          );
          if (recentRes.headers["x-csrf-token"]) {
            headers["X-Csrf-Token"] = recentRes.headers["x-csrf-token"];
          }
          const ingestAfterRecent =
            String(
              process.env.PHONEPE_WEB_BULK_INGEST_AFTER_RECENT || "",
            ).toLowerCase() === "true";
          const analyticsUserId =
            (process.env.PHONEPE_WEB_ANALYTICS_USER_ID || "").trim();
          const analyticsMerchantUserId =
            (process.env.PHONEPE_WEB_ANALYTICS_MERCHANT_USER_ID || "").trim();
          const merchantIdForIngest = (groupValue || "").trim();
          if (
            ingestAfterRecent &&
            recentRes.status >= 200 &&
            recentRes.status < 300 &&
            analyticsUserId &&
            analyticsMerchantUserId &&
            merchantIdForIngest
          ) {
            const latencySec = (Date.now() - recentStarted) / 1000;
            this.fireBulkIngestAfterRecentNonBlocking({
              cookiesString: finalCookies,
              csrfToken: String(headers["X-Csrf-Token"] || effectiveCsrf || ""),
              fingerprint,
              latencySec,
              merchantId: merchantIdForIngest,
              phonePeUserId: analyticsUserId,
              merchantUserId: analyticsMerchantUserId,
            });
          }
        } catch (e: any) {
          this.logger.debug(
            `transactions/recent preflight failed: ${e?.message}`,
          );
        }
      }

      const { gotScraping } = await eval('import("got-scraping")');
      const rawResponse = await gotScraping({
        url: transactionsUrl,
        method: "POST",
        json: requestBody,
        headers: headers as any,
        timeout: { request: 20000 },
        throwHttpErrors: false,
        responseType: "json",
      });

      const response = {
        status: rawResponse.statusCode,
        headers: rawResponse.headers as Record<string, any>,
        data: rawResponse.body,
      };

      this.logger.log(`📥 Web API Sync response: ${response.status}`);

      let newCsrf = response.headers["x-csrf-token"];
      let updatedCookies = this.mergeCookies(
        finalCookies,
        response.headers["set-cookie"],
      );

      if (newCsrf) {
        updatedCookies = this.mergeCookies(
          updatedCookies,
          `_X52F70K3N=${newCsrf}`,
        );
      } else {
        const match = updatedCookies.match(/_X52F70K3N=([^;]+)/);
        if (match && match[1]) {
          newCsrf = match[1];
        }
      }

      newCsrf = newCsrf || effectiveCsrf;

      // Check if this response itself refreshed the auth token via Set-Cookie
      const responseAuthToken = this.extractTokenFromCookies(
        updatedCookies,
        "MERCHANT_USER_A_TOKEN",
      );
      if (responseAuthToken && responseAuthToken !== effectiveAuthToken) {
        effectiveAuthToken = responseAuthToken;
        this.logger.log(
          "🔄 Auth token refreshed in transaction list response Set-Cookie",
        );
      }

      const responseRefreshToken = this.extractTokenFromCookies(
        updatedCookies,
        "MERCHANT_USER_R_TOKEN",
      );
      if (
        responseRefreshToken &&
        responseRefreshToken !== effectiveRefreshToken
      ) {
        effectiveRefreshToken = responseRefreshToken;
        this.logger.log(
          "🔄 Refresh token rotated in transaction list response Set-Cookie",
        );
      }

      if (response.status !== 200) {
        const failureSummary = this.extractFailureSummary(response.data);
        this.logger.warn(
          `⚠️ Web API transactions failed: status=${response.status}${failureSummary ? ` [${failureSummary}]` : ""} [signals ${this.buildSessionSignalSnapshot(updatedCookies, newCsrf)}]`,
        );

        if (!isRetry) {
          // Tiered Recovery Sequence
          let currentAuthToken = effectiveAuthToken;
          let currentCookies = updatedCookies;
          let currentCsrf = newCsrf;
          let currentRefreshToken = effectiveRefreshToken;

          // 1. CSRF RECOVERY: Only for 401 (invalid csrf). 412 often returns a new
          // x-csrf-token header that does not fix precondition — retrying caused wasted list calls.
          if (
            response.status === 401 &&
            newCsrf &&
            newCsrf !== effectiveCsrf
          ) {
            this.logger.log(`🔄 Recovery Tier 1: 401 + CSRF rotated, retrying...`);
            const retryRes = await this.fetchTransactionHistoryWebDirect(
              currentAuthToken, currentCookies, currentCsrf, fingerprint,
              groupValue, size, fromDate, toDate, true, currentRefreshToken
            );
            if (retryRes.success) return retryRes;

            // If retry failed, update state but keep going for deeper recovery
            if (retryRes.refreshedToken) currentAuthToken = retryRes.refreshedToken;
            if (retryRes.cookiesString) currentCookies = retryRes.cookiesString;
            if (retryRes.csrfToken) currentCsrf = retryRes.csrfToken;
          }

          // 2. TOKEN REFRESH RECOVERY: Try direct /auth/refresh
          if (response.status === 412 || response.status === 401) {
            this.logger.log(`🔄 Recovery Tier 2: Attempting direct token refresh...`);
            const refreshResult = await this.refreshWebSessionDirect(
              currentCookies, currentCsrf, fingerprint, currentRefreshToken
            );

            if (refreshResult.refreshedToken) {
              this.logger.log("✅ Token refreshed, retrying fetch...");
              const retryRes = await this.fetchTransactionHistoryWebDirect(
                refreshResult.refreshedToken, refreshResult.cookiesString, refreshResult.csrfToken,
                fingerprint, groupValue, size, fromDate, toDate, true,
                refreshResult.refreshedRefreshToken || currentRefreshToken
              );
              if (retryRes.success) return retryRes;

              currentAuthToken = refreshResult.refreshedToken;
              currentCookies = refreshResult.cookiesString;
              currentCsrf = refreshResult.csrfToken;
              currentRefreshToken = refreshResult.refreshedRefreshToken || currentRefreshToken;
            }
          }

          // 3. PUPPETEER FALLBACK: Real browser context
          if (!forceHttp) {
            this.logger.log(`🔄 Recovery Tier 3: Puppeteer fallback...`);
            const browserResult = await this.fetchTransactionHistoryViaBrowser(
              currentAuthToken, currentCookies, currentCsrf, fingerprint, groupValue,
              size, fromTimestamp, toTimestamp, currentRefreshToken
            );
            if (browserResult.success && browserResult.data) {
              return {
                ...browserResult,
                refreshedToken: currentAuthToken !== authToken ? currentAuthToken : undefined,
                refreshedRefreshToken: currentRefreshToken !== refreshToken ? currentRefreshToken : undefined,
                csrfToken: currentCsrf,
                cookiesString: currentCookies,
              };
            }
          } else {
            this.logger.log(`🔄 Recovery Tier 3: Pure HTTP mode enabled, skipping Puppeteer fallback.`);
          }
        }

        const is412 = response.status === 412;
        const signals412 = getPhonePeSessionSignals(updatedCookies, newCsrf);
        const transient412 =
          is412 && shouldTreatAsTransientPhonePeSessionDrift(signals412);
        return {
          success: false,
          data: null,
          error: `Web API returned status ${response.status}`,
          csrfToken: is412 ? csrfToken : newCsrf,
          cookiesString: is412 ? cookies : updatedCookies,
          refreshedToken: effectiveAuthToken !== authToken ? effectiveAuthToken : undefined,
          refreshedRefreshToken: effectiveRefreshToken !== refreshToken ? effectiveRefreshToken : undefined,
          // If we reached here, recovery tiers failed. Mark as expired if 412.
          sessionExpired: is412,
        };
      }

      const resultsArray =
        response.data?.data?.results ||
        response.data?.results ||
        response.data?.transactions ||
        [];
      const totalCount =
        response.data?.data?.totalResults ||
        response.data?.totalResults ||
        response.data?.totalTransactions ||
        resultsArray.length ||
        0;

      this.logger.log(`✅ Found ${totalCount} transactions via Web API`);

      return {
        success: true,
        data: {
          results: resultsArray,
          totalResults: totalCount,
          totalAmount: response.data?.data?.totalAmount || 0,
        },
        csrfToken: newCsrf,
        cookiesString: updatedCookies,
        refreshedToken:
          effectiveAuthToken !== authToken ? effectiveAuthToken : undefined,
        refreshedRefreshToken:
          effectiveRefreshToken !== refreshToken
            ? effectiveRefreshToken
            : undefined,
      };
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to fetch transactions via Web API: ${error.message}`,
      );
      return { success: false, data: null, error: error?.message };
    }
  }
  private async solveHCaptcha(
    sitekey: string,
    pageUrl: string,
    apiKey: string,
  ): Promise<string> {
    const submitResp = await axios.get(
      `http://2captcha.com/in.php?key=${apiKey}&method=hcaptcha&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`,
      { timeout: 10000 },
    );

    if (submitResp.data.status !== 1) {
      throw new Error(`2captcha submit failed: ${submitResp.data.request}`);
    }

    const requestId = submitResp.data.request;
    this.logger.log(`📤 2captcha request: ${requestId}`);

    for (let i = 0; i < 24; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const resultResp = await axios.get(
        `http://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`,
        { timeout: 10000 },
      );

      if (resultResp.data.status === 1) {
        return resultResp.data.request;
      }

      if (resultResp.data.request !== "CAPCHA_NOT_READY") {
        throw new Error(`2captcha error: ${resultResp.data.request}`);
      }

      this.logger.debug(`⏳ Captcha solving... (${i + 1}/24)`);
    }

    throw new Error("2captcha timeout after 120 seconds");
  }
}

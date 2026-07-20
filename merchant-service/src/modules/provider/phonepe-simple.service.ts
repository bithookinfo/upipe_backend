import {
  Injectable,
  Logger,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import axios from "axios";
import { PrismaService } from "../../prisma/prisma.service";
import { DeviceService } from "../device/device.service";
import { SendOtpDto } from "../../dto/phonepe-onboarding.dto";
import { PhonePeWebService } from "./phonepe-web.service";

@Injectable()
export class PhonePeSimpleService {
  private readonly logger = new Logger(PhonePeSimpleService.name);
  private readonly baseUrl = "https://web-api.phonepe.com";

  // In-memory cache: key = groupValue/merchantId, value = { data, timestamp }
  // Prevents redundant browser fetches when multiple crons fire simultaneously.
  private readonly txnCache = new Map<string, { data: any; ts: number }>();
  private readonly TXN_CACHE_TTL_MS = 12_000; // 12 seconds

  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceService: DeviceService,
    @Inject(forwardRef(() => PhonePeWebService))
    private readonly phonePeWebService: PhonePeWebService,
  ) {}

  private async fetchChecksum(
    path: string,
    payloadObj: any,
  ): Promise<string | undefined> {
    try {
      const endpoint = process.env.PHONEPE_CHECKSUM_ENDPOINT;
      if (!endpoint) {
        this.logger.warn(
          "PHONEPE_CHECKSUM_ENDPOINT not set — proceeding without x-request-sdk-checksum",
        );
        return undefined;
      }

      const payload =
        typeof payloadObj === "string"
          ? payloadObj
          : JSON.stringify(payloadObj);
      const trd = `${path}${payload}`;
      const url = `${endpoint}${encodeURIComponent(trd)}`;

      const resp = await axios.get(url, { timeout: 3000 });
      if (typeof resp.data === "string") {
        const trimmed =
          resp.data.length > 4 ? resp.data.substring(4) : resp.data;
        return trimmed;
      }
      if (resp?.data?.checksum) {
        return String(resp.data.checksum);
      }
      this.logger.warn(
        "Checksum endpoint returned unexpected response — skipping x-request-sdk-checksum",
      );
      return undefined;
    } catch (e: any) {
      const endpoint = process.env.PHONEPE_CHECKSUM_ENDPOINT || "";
      const errCode = e?.code ? ` code=${e.code}` : "";
      const errHost = e?.hostname ? ` host=${e.hostname}` : "";
      this.logger.error(
        `Checksum fetch failed — proceeding without x-request-sdk-checksum${endpoint ? ` endpoint=${endpoint}` : ""}${errCode}${errHost}`,
        e?.message ?? e,
      );
      return undefined;
    }
  }

  private generateRandomString(length: number, keys: string[]): string {
    let key = "";
    for (let i = 0; i < length; i++) {
      key += keys[Math.floor(Math.random() * keys.length)];
    }
    return key;
  }

  private generateAdviKey(): string {
    const keys = [
      "9",
      "8",
      "7",
      "6",
      "5",
      "4",
      "3",
      "2",
      "1",
      "0",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ];

    const mb = this.generateRandomString(8, keys);
    const md = this.generateRandomString(4, keys);
    const mc = this.generateRandomString(4, keys);
    const mh = this.generateRandomString(4, keys);
    const mf = this.generateRandomString(12, keys);

    return `${mb}-${md}-${mc}-${mh}-${mf}`;
  }

  private keygen(advid: string): string {
    const ket = "1lgVNAAtWyq06UfYjM/UBnJ5ZSA=";
    let str = "";
    for (let i = 0; i < 16; i++) {
      str += ket.charAt(i) + advid.charAt(i);
    }
    return str;
  }

  private encryptt(data: string, hkey: Buffer): string {
    const crypto = require("crypto");
    const cipher = crypto.createCipheriv("aes-128-ecb", hkey, null);
    cipher.setAutoPadding(true);
    const encrypted = Buffer.concat([
      cipher.update(data, "utf8"),
      cipher.final(),
    ]);
    return encrypted.toString("base64");
  }

  private fnalsing(advid: string, enc: string): string {
    const ket = enc;
    const adv = advid;

    const aa1 = ket.substring(0, 4);
    const a1 = ket.substring(4, 8);
    const a2 = ket.substring(8, 12);
    const a3 = ket.substring(12);

    const aa = adv.substring(0, 4);
    const ab = adv.substring(4, 8);
    const ac = adv.substring(8, 12);
    const ad = adv.substring(12, 16);

    const combined = `${aa}${aa1}${ab}${a1}${ac}${a2}${ad}${a3}`;
    return Buffer.from(combined).toString("base64");
  }

  private generateCustomChecksum(data: string): {
    checksum: string;
    farmRequestId: string;
  } {
    const crypto = require("crypto");
    const advikey = this.generateAdviKey();

    const keytry = this.keygen(advikey);
    // PHP sha1 returns 20 bytes, but AES-128 needs 16. PHP openssl_encrypt truncates automatically.
    // In Node, we MUST slice it manually.
    const aeskey = crypto
      .createHash("sha1")
      .update(keytry)
      .digest()
      .slice(0, 16);

    const dataHash = crypto.createHash("sha256").update(data).digest("base64");

    const milliseonds = Date.now();
    const payloadToEncrypt = `${milliseonds}###${dataHash}`;

    const encc = this.encryptt(payloadToEncrypt, aeskey);

    const finalSignature = this.fnalsing(advikey, encc);

    return { checksum: finalSignature, farmRequestId: advikey };
  }

  private generateRandomIP(): string {
    const octet = () => Math.floor(Math.random() * 256);
    return `${octet()}.${octet()}.${octet()}.${octet()}`;
  }

  private generateRandomUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      },
    );
  }

  private generateLongFingerprint(): string {
    const hash1 = this.generateRandomUUID().replace(/-/g, "").substring(0, 32);
    const hash2 = this.generateRandomUUID().replace(/-/g, "").substring(0, 32);
    const randomStr = this.generateRandomUUID().replace(/-/g, "");
    return `${hash1}.${hash2}.Xiaomi.${randomStr}`;
  }

  /**
   * Web counterpart of updatePhonePeSession.
   * Uses PhonePeWebService.updateWebSession (mi-web) to scope the web JWT to a specific group.
   */
  async updateWebSession(
    authToken: string,
    groupId: number,
    deviceFingerprint: string,
    fingerprint: string,
    cookies?: string[] | string,
    csrfToken?: string,
  ): Promise<{
    token: string;
    refreshToken: string;
    csrfToken: string;
    cookiesString: string;
  }> {
    const cookieStr = Array.isArray(cookies)
      ? cookies.join("; ")
      : cookies || "";

    this.logger.log(
      `🌐 [Web API] updateSession for groupId=${groupId} with web JWT`,
    );

    return this.phonePeWebService.updateWebSession(
      authToken,
      cookieStr,
      csrfToken || "",
      fingerprint,
      groupId,
    );
  }

  async sendOtp(data: SendOtpDto) {
    this.logger.log(
      `Sending OTP to ${data.phoneNumber} via PhonePe Android API`,
    );

    const deviceData =
      data.deviceData || this.deviceService.generateDeviceData();
    const fakeIP = this.generateRandomIP();
    const longFingerprint = this.generateLongFingerprint();
    const deviceFingerprint =
      deviceData.fingerprint ||
      `${this.generateRandomUUID().replace(/-/g, "").substring(0, 16)}c2RtNjM2-cWNvbQ-`;

    const url = `https://business-api.phonepe.com/apis/merchant-insights/v3/auth/sendOtp`;
    const bbk = "/apis/merchant-insights/v3/auth/sendOtp";

    const payload = {
      type: "OTP",
      phoneNumber: data.phoneNumber,
      deviceFingerprint: deviceFingerprint,
    };

    const checkPreferWebFlow =
      String(process.env.PHONEPE_USE_WEB_FLOW || "true").toLowerCase() !==
      "false";

    // Android API is blocked by PhonePe (APP_UPDATE_AND_RELOGIN_REQUIRED).
    // Skip the checksum fetch + Android attempt entirely when web flow is preferred.
    // Go straight to prepareWebSession (persistent browser) — sendOtpViaWeb is skipped
    // because it launches an expensive ephemeral browser (~9s) that always fails
    // when the captcha solver key is invalid or missing.
    if (checkPreferWebFlow) {
      this.logger.log(
        `🌐 Web flow preferred — going straight to prepareWebSession for ${data.phoneNumber}.`,
      );
      try {
        const prepResult = await this.phonePeWebService.prepareWebSession(
          data.phoneNumber,
        );
        return {
          success: true,
          requiresCaptcha: true,
          sitekey: prepResult.sitekey,
          sessionId: prepResult.sessionId,
          method: "web-api",
          message: "Captcha required. Please solve the captcha to proceed.",
        };
      } catch (webError: any) {
        this.logger.error(
          `❌ Web flow failed for ${data.phoneNumber}: ${webError.message}. Falling through to Android API as last resort.`,
        );
        // Fall through to Android API below as last resort
      }
    }

    const checksum = await this.fetchChecksum(bbk, JSON.stringify(payload));
    const preferWebFlow = checkPreferWebFlow;

    // If checksum is unavailable, Android API frequently fails with 400.
    // Prefer the web flow (captcha + web-api) instead of hard failing.
    if (!checksum && preferWebFlow) {
      this.logger.warn(
        `⚠️ No checksum available for PhonePe sendOtp. Falling back to web flow for ${data.phoneNumber}.`,
      );
      const prepResult = await this.phonePeWebService.prepareWebSession(
        data.phoneNumber,
      );
      return {
        success: true,
        requiresCaptcha: true,
        sitekey: prepResult.sitekey,
        sessionId: prepResult.sessionId,
        method: "web-api",
        message: "Captcha required. Please solve the captcha to proceed.",
      };
    }

    const headers: any = {
      Host: "business-api.phonepe.com",
      "x-farm-request-id": this.generateRandomUUID(),
      "x-app-id": "bd309814ea4c45078b9b25bd52a576de",
      "x-merchant-id": "PHONEPEBUSINESS",
      "x-source-type": "PB_APP",
      "x-source-platform": "ANDROID",
      "x-source-locale": "en",
      "x-source-version": "1290004046",
      fingerprint: longFingerprint,
      "x-device-fingerprint": deviceFingerprint,
      "x-app-version": "0.4.46",
      "content-type": "application/json; charset=utf-8",
      "accept-encoding": "gzip",
      "user-agent": "okhttp/3.12.13",
      "X-Forwarded-For": fakeIP,
    };

    if (checksum) {
      headers["x-request-sdk-checksum"] = checksum;
    }

    try {
      this.logger.debug(`PhonePe sendOtp URL: ${url}`);
      this.logger.debug(`PhonePe sendOtp payload: ${JSON.stringify(payload)}`);

      const curlCmd = `curl -v '${url}' \\
  -H 'Host: business-api.phonepe.com' \\
  -H 'x-source-type: PB_APP' \\
  -H 'x-source-platform: ANDROID' \\
  -H 'fingerprint: ${longFingerprint}' \\
  -H 'x-device-fingerprint: ${deviceFingerprint}' \\
  -H 'content-type: application/json; charset=utf-8' \\
  -H 'x-request-sdk-checksum: ${checksum || ""}' \\
  --data-raw '${JSON.stringify(payload)}'`;

      this.logger.debug(`🐛 TRY THIS CURL COMMAND:\n\n${curlCmd}\n\n`);

      const response = await axios.post(url, payload, { headers });

      this.logger.debug("PhonePe API Response:", {
        data: response.data,
        headers: response.headers,
      });

      const otpToken =
        response.data?.token ||
        response.data?.data?.token ||
        response.headers?.["x-verify-token"] ||
        response.headers?.["x-session-token"];

      if (!otpToken) {
        const responseBody =
          response.data?.message || JSON.stringify(response.data);
        this.logger.error(
          `No OTP token in response. Response: ${responseBody}`,
        );
        throw new BadRequestException(
          `Failed to get OTP session token. ${responseBody}`,
        );
      }

      this.logger.log(`PhonePe OTP sent successfully to ${data.phoneNumber}`, {
        otpToken: otpToken.substring(0, 4) + "****",
        expiry: response.data?.expiry,
      });

      return {
        success: true,
        token: otpToken,
        deviceFingerprint: deviceFingerprint,
        fingerprint: longFingerprint, // CRITICAL: Return long fingerprint for reuse
        message: response.data?.message || "OTP sent",
      };
    } catch (error: any) {
      const errorData = {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
        url: url,
        phoneNumber: data.phoneNumber,
      };

      this.logger.error("PhonePe sendOtp failed:", errorData);

      // If Android API fails (often 400/403) and web flow is enabled, fall back to web session + captcha.
      if (preferWebFlow && (error?.response?.status === 400 || error?.response?.status === 403)) {
        this.logger.warn(
          `⚠️ Android API sendOtp failed (HTTP ${error?.response?.status}). Falling back to web flow for ${data.phoneNumber}.`,
        );
        try {
          const prepResult = await this.phonePeWebService.prepareWebSession(
            data.phoneNumber,
          );
          this.logger.log(
            `✅ Web session prepared for ${data.phoneNumber}: sessionId=${prepResult.sessionId}`,
          );
          return {
            success: true,
            requiresCaptcha: true,
            sitekey: prepResult.sitekey,
            sessionId: prepResult.sessionId,
            method: "web-api",
            message: "Captcha required. Please solve the captcha to proceed.",
          };
        } catch (webError: any) {
          this.logger.error(
            `❌ Web session preparation also failed: ${webError.message}`,
          );
        }
      }

      if (
        error?.response?.data?.message
          ?.toLowerCase()
          .includes("can't register") ||
        error?.response?.data?.code === "USER_CREATION_BLOCKED" ||
        error?.response?.data?.code === "APP_UPDATE_AND_RELOGIN_REQUIRED"
      ) {
        this.logger.warn(
          `⚠️ Android API blocked OTP for ${data.phoneNumber} (code=${error?.response?.data?.code}). Preparing web session for UI captcha...`,
        );
        try {
          const prepResult = await this.phonePeWebService.prepareWebSession(
            data.phoneNumber,
          );
          this.logger.log(
            `✅ Web session prepared for ${data.phoneNumber}: sessionId=${prepResult.sessionId}`,
          );
          return {
            success: true,
            requiresCaptcha: true,
            sitekey: prepResult.sitekey,
            sessionId: prepResult.sessionId,
            method: "web-api",
            message: "Captcha required. Please solve the captcha to proceed.",
          };
        } catch (webError: any) {
          this.logger.error(
            `❌ Web session preparation also failed: ${webError.message}`,
          );
          throw new BadRequestException(
            "PhonePe is blocking this number. Both API and web portal approaches failed. Please try again later or use the official PhonePe Business app.",
          );
        }
      }

      if (error?.response?.status === 429) {
        throw new BadRequestException(
          "Too many OTP requests. Please try again after some time.",
        );
      }

      if (error?.response?.status === 403) {
        throw new BadRequestException(
          "PhonePe service temporarily unavailable (403). Please try again later.",
        );
      }

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `PhonePe Error: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "Failed to connect to PhonePe service. Please try again.",
      );
    }
  }

  /**
   * Proxy to PhonePeWebService.verifyOtpViaWeb for web API fallback flow.
   */
  async verifyOtpViaWeb(sessionId: string, otp: string, phoneNumber: string) {
    return this.phonePeWebService.verifyOtpViaWeb(sessionId, otp, phoneNumber);
  }

  /**
   * Proxy to PhonePeWebService.completeWebOtp for Phase 2 of UI captcha flow.
   */
  async completeOtpWithCaptcha(sessionId: string, captchaToken: string) {
    return this.phonePeWebService.completeWebOtp(sessionId, captchaToken);
  }

  async verifyOtp(
    phoneNumber: string,
    otp: string,
    otpToken: string,
    deviceFingerprint: string,
    fingerprint?: string, // Long fingerprint from sendOtp
    userId?: string,
  ) {
    this.logger.log(`Verifying PhonePe OTP for ${phoneNumber}`);

    const fakeIP = this.generateRandomIP();
    // CRITICAL FIX: PHP uses business-api.phonepe.com
    // Line 150 in phnpe/index.php: $url="https://business-api.phonepe.com$bbk";
    // Line 149: $bbk="/apis/merchant-insights/v3/auth/login";
    const url = `https://business-api.phonepe.com/apis/merchant-insights/v3/auth/login`;
    const bbk = "/apis/merchant-insights/v3/auth/login";

    // Use provided long fingerprint or generate a new one (for backwards compatibility)
    const longFingerprint = fingerprint || this.generateLongFingerprint();

    // PHP clientContext (lines 157 in phnpe/index.php) - complex structure
    // Simplified version for compatibility
    const milliseconds = Date.now();
    const fact2 = deviceFingerprint.substring(0, 16);
    const g1 = longFingerprint.split(".")[3] || "unknown";
    const osid = longFingerprint.split(".")[0] || "unknown";
    const xdhp = longFingerprint.split(".")[1] || "unknown";

    const clientContext = JSON.stringify({
      device: {
        identifier: {
          macAddress: "00:00:00:00:00:00",
          fact1: "",
          fact2: fact2,
          fact3: "NA",
          gd: { g1: g1 },
          omid: "Xiaomi",
          osid: osid,
          pid: "NA",
          xdhp: xdhp,
        },
        location: { latitude: 0, longitude: 0, confidence: 0, locs: -1 },
        network: {
          ipv4: fakeIP,
          ipv6: "NA",
          bssid: "NA",
          ssid: "<unknown ssid>",
          essid: "NA",
          ipm: 1,
        },
        cellularNetwork: { dualSim: false, towers: [] },
        security: {
          as: false,
          emulated: false,
          rooted: false,
          safetyNetScore: 0.5,
          dsec: 1,
          emuChk: false,
          rck: { a: false, b: "" },
          macct: {},
        },
        software: {
          os: {
            name: "Android",
            version: "30",
            manu: "Xiaomi",
            model: "Xiaomi",
            buildTime: String(milliseconds),
          },
        },
        call: { cs: 0, lcs: "0,", vcs: 0 },
        ui: { doa: 0, doaN: [] },
      },
    });

    const payload = {
      type: "OTP",
      clientContext: clientContext,
      deviceFingerprint: deviceFingerprint,
      otp: otp,
      token: otpToken,
      phoneNumber: phoneNumber,
    };

    const checksum = await this.fetchChecksum(bbk, JSON.stringify(payload));

    // Use Android headers matching PHP (line 163 in phnpe/index.php)
    const headers: Record<string, string> = {
      Host: "business-api.phonepe.com",
      "x-farm-request-id": this.generateRandomUUID(),
      "x-app-id": "bd309814ea4c45078b9b25bd52a576de",
      "x-merchant-id": "PHONEPEBUSINESS",
      "x-source-type": "PB_APP",
      "x-source-platform": "ANDROID",
      "x-source-locale": "en",
      "x-source-version": "1290004046",
      fingerprint: longFingerprint,
      "x-device-fingerprint": deviceFingerprint,
      "x-app-version": "0.4.46",
      "content-type": "application/json; charset=utf-8",
      "accept-encoding": "gzip",
      "user-agent": "okhttp/3.12.13",
      "X-Forwarded-For": fakeIP,
      ...(checksum ? { "x-request-sdk-checksum": checksum } : {}),
    };

    try {
      this.logger.debug(`PhonePe verifyOtp URL: ${url}`);
      this.logger.debug(
        `PhonePe verifyOtp payload: ${JSON.stringify(payload)}`,
      );
      if (checksum)
        this.logger.debug(`PhonePe verifyOtp checksum: ${checksum}`);

      const response = await axios.post(url, payload, { headers });

      this.logger.debug(
        `PhonePe verifyOtp response: ${JSON.stringify(response.data)}`,
      );
      // Capture x-response-token from headers - might be needed for updateSession
      const xResponseToken = response.headers["x-response-token"];
      if (xResponseToken) {
        this.logger.log(
          `📋 Captured x-response-token from verifyOtp: ${xResponseToken.substring(0, 30)}...`,
        );
      }

      // CAPTURE COOKIES - Critical for v1 endpoints
      const cookies = response.headers["set-cookie"];
      if (cookies) {
        this.logger.log(
          `🍪 Captured cookies from verifyOtp: ${JSON.stringify(cookies)}`,
        );
      }

      if (!response.data?.success) {
        throw new BadRequestException("PhonePe OTP verification failed");
      }

      const phonePeData = response.data.data || response.data;

      let extractedGroupId = phonePeData.groupId;
      let extractedGroupValue = phonePeData.groupValue;

      if (
        phonePeData.groupSelection &&
        phonePeData.groups &&
        phonePeData.groups.length > 0
      ) {
        const firstGroup = phonePeData.groups[0];
        extractedGroupId = firstGroup.groupId;
        extractedGroupValue = firstGroup.groupValue;
        this.logger.log(
          `📋 Multiple groups detected, using first group: ${extractedGroupValue} (ID: ${extractedGroupId})`,
        );
      }

      return {
        success: true,
        message: "PhonePe OTP verified successfully",
        accountDetails: {
          phoneNumber: phoneNumber,
          name: phonePeData.name || "PhonePe Merchant",
          userId: phonePeData.userId,
          merchantId: phonePeData.merchantId,
          groupId: extractedGroupId,
          groupValue: extractedGroupValue,
          token: response.data.token || otpToken,
          refreshToken: response.data.refreshToken,
          groups: phonePeData.groups, // Include all groups in accountDetails for later use
          xResponseToken: xResponseToken, // Add x-response-token for updateSession
          cookies: cookies, // Pass cookies for updateSession
        },
        groups: phonePeData.groups,
        requiresGroupSelection: phonePeData.groupSelection,
      };
    } catch (error: any) {
      this.logger.error("PhonePe verifyOtp failed", {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `PhonePe Error: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "PhonePe OTP verification failed. Please check your OTP and try again.",
      );
    }
  }

  async fetchTransactionHistory(
    sessionToken: string,
    deviceFingerprint: string,
    groupValue?: string | null,
    refreshToken?: string,
    size: number = 50,
    connectorId?: string,
    fromDate?: Date,
    toDate?: Date,
    fingerprint?: string, // Long fingerprint from sendOtp
    groupId?: string | number, // Group ID for multi-store scoping
    cookies?: string[] | string, // Captured cookies from verifyOtp
    csrfToken?: string, // CSRF for web
    method?: string, // 'web-api'
  ): Promise<any> {
    try {
      // Use provided long fingerprint or generate a new one
      const isWebSession =
        method === "web-api" || csrfToken || fingerprint?.startsWith("pbweb_");

      const webFallbackSeed =
        String(refreshToken || groupValue || sessionToken || deviceFingerprint || "");
      const longFingerprint =
        fingerprint ||
        (isWebSession
          ? this.phonePeWebService.generateWebFingerprint(webFallbackSeed)
          : this.generateLongFingerprint());

      this.logger.debug(
        `🔍 fetchTransactionHistory called with deviceFingerprint: ${deviceFingerprint}, fingerprint: ${longFingerprint?.substring(0, 30)}..., groupValue: ${groupValue}, method: ${method}`,
      );

      // --- Transaction cache: avoid redundant browser fetches ---
      const cacheKey = groupValue || connectorId || 'default';
      const cached = this.txnCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < this.TXN_CACHE_TTL_MS) {
        this.logger.debug(`⚡ [TxnCache] HIT for ${cacheKey} (age=${Date.now() - cached.ts}ms)`);
        return cached.data;
      }

      if (isWebSession) {
        const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
        const webResponse =
          await this.phonePeWebService.fetchTransactionHistoryWeb(
            sessionToken,
            cookieStr || "",
            csrfToken || "",
            longFingerprint,
            groupValue,
            size,
            fromDate,
            toDate,
            false, // isRetry
            refreshToken,
          );

        const result = {
          ...webResponse,
          refreshedFingerprint:
            longFingerprint !== fingerprint ? longFingerprint : undefined,
        };

        // Cache successful results (skip sessionExpired)
        if (!webResponse?.sessionExpired) {
          this.txnCache.set(cacheKey, { data: result, ts: Date.now() });
        }

        return result;
      }

      const fakeIP = this.generateRandomIP();
      let activeToken = sessionToken;
      let activeRefreshToken = refreshToken;

      if (refreshToken) {
        try {
          this.logger.debug("🔄 Refreshing PhonePe token...");
          const refreshResult = await this.refreshPhonePeToken(
            sessionToken,
            refreshToken,
            deviceFingerprint,
            longFingerprint, // Use long fingerprint
          );
          if (refreshResult) {
            activeToken = refreshResult.token;
            activeRefreshToken = refreshResult.refreshToken;
            this.logger.log("✅ PhonePe token refreshed successfully");
          }
        } catch (error: any) {
          this.logger.error("Token refresh failed:", error?.message);
          this.logger.warn("⚠️ Using existing token after refresh failure");
        }
      }

      // Note: Do NOT call updateSession after refresh - PhonePe returns 412 (Precondition Failed) when
      // re-scoping a refreshed token. Scope is established at connect time via updateSession; we rely
      // on x-user-group-id + merchantIds for the transactions request.

      const transactionsUrl = `${this.baseUrl}/apis/merchant-insights/v3/transactions/list`;
      const endpoint = "/apis/merchant-insights/v3/transactions/list";

      const defaultFromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const defaultToDate = new Date();

      const from = fromDate ? fromDate.getTime() : defaultFromDate.getTime();
      const to = toDate ? toDate.getTime() : defaultToDate.getTime();

      const requestBody: any = {
        transactionType: "FORWARD",
        filters: {
          status: ["COMPLETED"],
          merchantIds: groupValue ? [groupValue] : [],
          storeIds: [],
        },
        from,
        to,
        offset: 0,
        size,
      };
      const bodyString = JSON.stringify(requestBody);

      const { checksum, farmRequestId } = this.generateCustomChecksum(
        `${endpoint}${bodyString}`,
      );

      const headers: Record<string, string> = {
        Host: "business-api.phonepe.com",
        "x-farm-request-id": farmRequestId,
        "x-app-id": "bd309814ea4c45078b9b25bd52a576de",
        "x-merchant-id": "PHONEPEBUSINESS",
        "x-source-type": "PB_APP",
        "x-source-platform": "ANDROID",
        "x-source-locale": "en",
        "x-source-version": "1290004046",
        fingerprint: longFingerprint,
        "x-device-fingerprint": deviceFingerprint,
        "x-app-version": "0.4.46",
        "x-request-sdk-checksum": checksum,
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.13",
        "X-Forwarded-For": fakeIP,
        namespace: "oculus",
        authorization: `Bearer ${activeToken}`,
      };

      this.logger.log(
        `Fetching last ${size} PhonePe transactions from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`,
      );

      this.logger.debug(`🐛 Transactions Headers: ${JSON.stringify(headers)}`);
      this.logger.debug(`🐛 Transactions Body: ${bodyString}`);

      const response = await axios.post(transactionsUrl, bodyString, {
        headers,
        timeout: 10000,
        validateStatus: (status) => status < 500,
      });

      if (response.status !== 200) {
        const responseBody = response.data
          ? JSON.stringify(response.data)
          : response.statusText;
        this.logger.warn(
          `PhonePe API returned status ${response.status}. Response: ${responseBody}`,
        );
        if (response.status === 412) {
          if (groupValue) {
            this.logger.warn(
              `PhonePe 412 with merchantIds=[${groupValue}]. Precondition failed despite groupValue set - likely token scope (refreshed token) or checksum mismatch.`,
            );
          } else {
            this.logger.warn(
              `PhonePe 412: groupValue is missing in credentials; set it so merchantIds filter is non-empty.`,
            );
          }
        }
        return {
          success: false,
          data: null,
          error: `API returned status ${response.status}. ${response.data?.message || responseBody}`,
        };
      }

      const resultsArray =
        response.data?.data?.results || response.data?.results || [];
      const totalCount =
        response.data?.data?.totalResults ||
        response.data?.totalResults ||
        resultsArray.length ||
        0;

      this.logger.log(
        `Found ${totalCount} total PhonePe transactions (${resultsArray.length} in current response)`,
      );

      const androidResult = {
        success: true,
        refreshedToken: activeToken !== sessionToken ? activeToken : undefined,
        refreshedRefreshToken:
          activeRefreshToken !== refreshToken ? activeRefreshToken : undefined,
        data: {
          results: resultsArray,
          totalResults: totalCount,
          totalAmount: response.data?.data?.totalAmount || 0,
        },
      };

      // Cache for subsequent cron ticks
      this.txnCache.set(cacheKey, { data: androidResult, ts: Date.now() });

      return androidResult;
    } catch (error: any) {
      this.logger.error(
        "Failed to fetch PhonePe transaction history:",
        error?.message,
      );
      return { success: false, data: null, error: error?.message };
    }
  }

  async refreshPhonePeToken(
    oldToken: string,
    refreshToken: string,
    deviceFingerprint: string,
    fingerprint: string,
  ): Promise<{ token: string; refreshToken: string } | null> {
    try {
      const url = `https://business-api.phonepe.com/apis/merchant-insights/v1/auth/refresh`;
      const endpoint = "/apis/merchant-insights/v1/auth/refresh";
      const fakeIP = this.generateRandomIP();

      const body = "{}";
      const { checksum, farmRequestId } = this.generateCustomChecksum(
        `${endpoint}${body}`,
      );

      const headers = {
        Host: "business-api.phonepe.com",
        "x-refresh-token": refreshToken,
        "x-auth-token": oldToken,
        "x-farm-request-id": farmRequestId, // Use ID from checksum gen
        "x-app-id": "bd309814ea4c45078b9b25bd52a576de",
        "x-merchant-id": "PHONEPEBUSINESS",
        "x-source-type": "PB_APP",
        "x-source-platform": "ANDROID",
        "x-source-locale": "en",
        "x-source-version": "1290004046", // Matching working log
        fingerprint: fingerprint,
        "x-device-fingerprint": deviceFingerprint,
        "x-app-version": "0.4.46", // Matching working log
        "x-request-sdk-checksum": checksum,
        "content-type": "application/json; charset=utf-8",
        "content-length": "2",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.13",
        "X-Forwarded-For": fakeIP,
      };

      this.logger.debug("🔄 Refreshing PhonePe token...");
      const response = await axios.post(url, {}, { headers, timeout: 10000 });

      if (response.data?.token) {
        this.logger.log("✅ PhonePe token refreshed successfully");
        return {
          token: response.data.token,
          refreshToken: response.data.refreshToken || refreshToken, // Use new if available, else keep old
        };
      }

      this.logger.warn("PhonePe token refresh response missing token field");
      return { token: oldToken, refreshToken };
    } catch (error: any) {
      this.logger.error(
        "PhonePe token refresh failed:",
        error?.response?.data || error?.message,
      );
      return null;
    }
  }

  async updatePhonePeSession(
    token: string,
    userGroupId: string | number,
    deviceFingerprint: string,
    fingerprint?: string, // Long fingerprint from sendOtp
    xResponseToken?: string, // x-response-token from verifyOtp for CSRF-like auth
    cookies?: string[] | string, // Captured cookies from verifyOtp
    method?: string, // 'web-api' or 'android'
    groupValue?: string, // selected groupValue for web scoping
    csrfToken?: string, // CSRF token for web
  ): Promise<{ token: string; refreshToken: string; csrfToken?: string; cookiesString?: string } | null> {
    try {
      if (method === "web-api") {
        this.logger.log(`🌐 [Web API] Performing scoping via PhonePeWebService...`);
        const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
        const result = await this.phonePeWebService.updateWebSession(
          token,
          cookieStr || "",
          csrfToken || "",
          fingerprint || "",
          Number(userGroupId),
          groupValue,
        );
        return {
          token: result.token,
          refreshToken: result.refreshToken,
          csrfToken: result.csrfToken,
          cookiesString: result.cookiesString,
        };
      }

      // Use Android API with custom checksum (PHP match)
      const url = `https://business-api.phonepe.com/apis/merchant-insights/v1/user/updateSession`;
      const endpoint = "/apis/merchant-insights/v1/user/updateSession";
      const fakeIP = this.generateRandomIP();

      // Use provided long fingerprint or generate a new one
      const longFingerprint = fingerprint || this.generateLongFingerprint();

      // PHP sends userGroupId as number
      const payload = {
        userGroupId: Number(userGroupId),
      };
      const bodyString = JSON.stringify(payload);

      // Generate CUSTOM checksum matching PHP logic
      const { checksum, farmRequestId } = this.generateCustomChecksum(
        `${endpoint}${bodyString}`,
      );

      // Android Headers (Matching PHP)
      const headers: Record<string, string> = {
        Host: "business-api.phonepe.com",
        authorization: `Bearer ${token}`,
        "x-farm-request-id": farmRequestId, // Use ID from checksum gen
        "x-app-id": "bd309814ea4c45078b9b25bd52a576de",
        "x-merchant-id": "PHONEPEBUSINESS",
        "x-source-type": "PB_APP",
        "x-source-platform": "ANDROID",
        "x-source-locale": "en",
        "x-source-version": "1290004046", // Matching working log
        fingerprint: longFingerprint,
        "x-device-fingerprint": deviceFingerprint,
        "x-app-version": "0.4.46", // Matching working log
        "x-request-sdk-checksum": checksum,
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.13",
        "X-Forwarded-For": fakeIP,
      };

      this.logger.log(
        `🔄 =====================================================`,
      );
      this.logger.log(
        `🔄 UPDATE SESSION DEBUG - NOW USING ANDROID API (PHP MATCH)`,
      );
      this.logger.log(
        `🔄 =====================================================`,
      );
      this.logger.debug(`📍 URL: ${url}`);
      this.logger.debug(`📍 Endpoint: ${endpoint}`);
      this.logger.log(`📦 Payload: ${bodyString}`);
      this.logger.log(
        `   - userGroupId (type): ${typeof payload.userGroupId} = ${payload.userGroupId}`,
      );
      this.logger.log(
        `   - PHP sends: {"userGroupId":${userGroupId}} (number, no quotes)`,
      );

      this.logger.log(`🔑 Fingerprints:`);
      this.logger.log(`   - fingerprint (long): ${longFingerprint}`);
      this.logger.log(
        `   - x-device-fingerprint (short): ${deviceFingerprint}`,
      );
      this.logger.log(`   - PHP format check:`);
      this.logger.log(
        `     * Long has dots: ${longFingerprint?.includes(".") ? "YES ✅" : "NO ❌"}`,
      );
      this.logger.log(
        `     * Short has c2RtNjM2: ${deviceFingerprint?.includes("c2RtNjM2") ? "YES ✅" : "NO ❌"}`,
      );

      this.logger.log(
        `🎫 Token (first 50 chars): ${token?.substring(0, 50)}...`,
      );
      this.logger.log(`📝 Checksum: ${checksum || "NOT GENERATED"}`);
      this.logger.log(`🌐 Fake IP: ${fakeIP}`);
      this.logger.log(`🏷️ Farm Request ID: ${farmRequestId}`);
      this.logger.log(
        `🔄 =====================================================`,
      );

      // DEBUG: Print CURL command for manual testing
      this.logger.debug(`🐛 TRY THIS CURL COMMAND FOR updateSession:

curl -v '${url}' \\
  -H 'Host: business-api.phonepe.com' \\
  -H 'authorization: Bearer ${token}' \\
  -H 'x-farm-request-id: ${farmRequestId}' \\
  -H 'x-app-id: bd309814ea4c45078b9b25bd52a576de' \\
  -H 'x-merchant-id: PHONEPEBUSINESS' \\
  -H 'x-source-type: PB_APP' \\
  -H 'x-source-platform: ANDROID' \\
  -H 'x-source-locale: en' \\
  -H 'x-source-version: 1290004046' \\
  -H 'fingerprint: ${longFingerprint}' \\
  -H 'x-device-fingerprint: ${deviceFingerprint}' \\
  -H 'x-app-version: 0.4.46' \\
  -H 'content-type: application/json; charset=utf-8' \\
  ${checksum ? `-H 'x-request-sdk-checksum: ${checksum}' \\` : ""}
  --data-raw '${bodyString}'

`);

      const response = await axios.post(url, payload, {
        headers,
        timeout: 10000,
      });

      this.logger.log(`✅ Session Update Response Status: ${response.status}`);
      this.logger.log(
        `✅ Session Update Response Data: ${JSON.stringify(response.data)}`,
      );

      if (response.data?.token && response.data?.refreshToken) {
        this.logger.log(
          "✅ PhonePe session updated successfully - GOT NEW SCOPED TOKEN!",
        );
        this.logger.log(
          `   - New token (first 50): ${response.data.token.substring(0, 50)}...`,
        );
        this.logger.log(
          `   - groupValue from response: ${response.data.groupValue || "not returned"}`,
        );
        return {
          token: response.data.token,
          refreshToken: response.data.refreshToken,
        };
      }

      this.logger.warn("updateSession response missing token/refreshToken");
      this.logger.warn(`Response data: ${JSON.stringify(response.data)}`);
      return null;
    } catch (error: any) {
      this.logger.error("❌ updateSession FAILED - Full error details:");
      this.logger.error(`   - Error message: ${error?.message}`);
      this.logger.error(`   - HTTP Status: ${error?.response?.status}`);
      this.logger.error(`   - Status Text: ${error?.response?.statusText}`);
      this.logger.error(
        `   - Response Data: ${JSON.stringify(error?.response?.data)}`,
      );
      if (error?.response?.data?.message) {
        this.logger.error(
          `   - PhonePe Error Message: ${error?.response?.data?.message}`,
        );
      }
      if (error?.response?.data?.code) {
        this.logger.error(
          `   - PhonePe Error Code: ${error?.response?.data?.code}`,
        );
      }
      throw error;
    }
  }

  async fetchMerchantUpiId(
    sessionToken: string,
    deviceFingerprint: string,
    groupValue?: string,
    unitId?: string,
    refreshToken?: string,
    fingerprint?: string, // Long fingerprint from sendOtp
    groupId?: string | number, // Group ID for multi-store scoping
    cookies?: string[] | string, // Captured cookies from verifyOtp
    csrfToken?: string, // CSRF for web
    method?: string, // 'web-api'
  ): Promise<{
    upiId: string | null;
    transactions: any[];
    refreshedToken?: string;
    refreshedRefreshToken?: string;
    csrfToken?: string;
    cookiesString?: string;
  }> {
    this.logger.debug(
      `🔍 fetchMerchantUpiId called with: sessionToken: ${sessionToken?.substring(0, 20)}..., deviceFingerprint: ${deviceFingerprint}, fingerprint: ${fingerprint?.substring(0, 30)}..., groupValue: ${groupValue}, unitId: ${unitId}, groupId: ${groupId}, hasRefreshToken: ${!!refreshToken}, method: ${method}`,
    );

    try {
      // Fetch 5 transactions to find qrCodeId (like old backend)
      const response = await this.fetchTransactionHistory(
        sessionToken,
        deviceFingerprint,
        groupValue,
        refreshToken,
        5,
        undefined, // connectorId
        undefined, // fromDate
        undefined, // toDate
        fingerprint, // Pass long fingerprint
        groupId, // Pass groupId for multi-store scope
        cookies, // Pass cookies
        csrfToken, // CSRF for web
        method, // 'web-api'
      );

      this.logger.debug(
        "PhonePe transactions response for UPI ID:",
        JSON.stringify(response, null, 2),
      );

      // Extract qrCodeId from first transaction's merchantDetails
      // Matching old backend: results[0]['merchantDetails']['qrCodeId']
      const results = response.data?.results || [];
      let upiId: string | null = null;

      if (results && Array.isArray(results) && results.length > 0) {
        const firstTransaction = results[0];

        this.logger.debug(
          "First transaction for UPI extraction:",
          JSON.stringify(firstTransaction, null, 2),
        );

        // Get qrCodeId exactly as it comes from response
        const qrCodeId = firstTransaction?.merchantDetails?.qrCodeId;

        if (qrCodeId) {
          // PhonePe merchant IDs need @ybl suffix to be valid UPI VPAs
          // e.g., Q37601279 becomes Q37601279@ybl
          const fullUpiId = qrCodeId.includes("@")
            ? qrCodeId
            : `${qrCodeId}@ybl`;

          this.logger.log(
            `✅ Extracted merchant UPI ID from transactions: ${fullUpiId}`,
          );
          upiId = fullUpiId;
        } else {
          this.logger.warn(
            "qrCodeId not found in merchantDetails. Available fields:",
            firstTransaction.merchantDetails
              ? Object.keys(firstTransaction.merchantDetails)
              : "merchantDetails is undefined",
          );
        }
      } else {
        this.logger.warn("No transactions found to extract qrCodeId");
      }

      return {
        upiId,
        transactions: results,
        refreshedToken: response.refreshedToken,
        refreshedRefreshToken: response.refreshedRefreshToken,
        csrfToken: response.csrfToken,
        cookiesString: response.cookiesString,
      };
    } catch (error: any) {
      this.logger.error(
        "Failed to fetch merchant UPI ID from transactions API",
        {
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          data: error?.response?.data,
          message: error?.message,
        },
      );
      return {
        upiId: null,
        transactions: [],
        refreshedToken: undefined,
        refreshedRefreshToken: undefined,
        csrfToken: undefined,
        cookiesString: undefined,
      };
    }
  }

  /**
   * Proactively warm all active PhonePe sessions.
   * This is called by the heartbeat cron to prevent session expiration.
   */
  async warmAllSessions() {
    const legacyWarmerEnabled =
      String(process.env.PHONEPE_ENABLE_LEGACY_WARMER || "false").toLowerCase() ===
      "true";
    if (!legacyWarmerEnabled) {
      this.logger.debug(
        "Skipping legacy PhonePe warmer; keepalive cron is the single warmer authority.",
      );
      return;
    }

    this.logger.log("🔥 Warming all active PhonePe sessions...");
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: "PHONEPE",
          status: { not: "EXPIRED" },
        },
      });

      this.logger.log(`Found ${providers.length} active PhonePe providers to warm`);

      for (const provider of providers) {
        try {
          const credentials = provider.credentials as any;
          if (!credentials?.token || !credentials?.csrfToken) continue;

          const isWeb = credentials.method === 'web-api' || credentials.csrfToken || credentials.fingerprint?.startsWith('pbweb_');
          
          if (isWeb) {
            this.logger.log(`🌡️ Warming web session for provider ${provider.id}...`);
            const result = await this.phonePeWebService.warmWebSession(
              credentials.token,
              credentials.cookiesString || "",
              credentials.csrfToken,
              credentials.fingerprint || credentials.deviceFingerprint
            );

            if (result.csrfToken !== credentials.csrfToken || result.cookiesString !== credentials.cookiesString) {
              const latestProvider = await this.prisma.merchantProvider.findUnique({
                where: { id: provider.id },
                select: { credentials: true },
              });
              const latestCreds = (latestProvider?.credentials as any) || credentials;

              await this.prisma.merchantProvider.update({
                where: { id: provider.id },
                data: {
                  credentials: {
                    ...latestCreds,
                    csrfToken: result.csrfToken,
                    cookiesString: result.cookiesString,
                    credentials: {
                      ...(latestCreds.credentials || {}),
                      csrfToken: result.csrfToken,
                      cookiesString: result.cookiesString,
                    }
                  }
                }
              });
              this.logger.log(`✅ CSRF/Cookies rotated during warming for provider ${provider.id}`);
            }
          }
        } catch (error: any) {
          this.logger.warn(`Failed to warm provider ${provider.id}: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`❌ Global warming task failed: ${error.message}`);
    }
  }
}

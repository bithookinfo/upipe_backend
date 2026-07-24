import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ProviderType, MerchantProviderStatus, MerchantStatus } from "@prisma/client";
import { PhonePeSimpleService } from "./phonepe-simple.service";
import { PaytmSimpleService } from "./paytm-simple.service";
import { BharatPeSimpleService } from "./bharatpe-simple.service";
import { QuintusPaySimpleService } from "./quintuspay-simple.service";
import { HdfcVyaparService } from "./hdfc-vyapar.service";

@Injectable()
export class ProviderConnectionService {
  private readonly logger = new Logger(ProviderConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly phonePeService: PhonePeSimpleService,
    private readonly paytmService: PaytmSimpleService,
    private readonly bharatPeService: BharatPeSimpleService,
    private readonly quintusPayService: QuintusPaySimpleService,
    private readonly hdfcVyaparService: HdfcVyaparService,
  ) { }

  private validatePhoneNumber(phoneNumber: string): boolean {
    const phoneRegex = /^[6-9]\d{9}$/;
    return phoneRegex.test(phoneNumber);
  }

  /** Trigger a one-time backfill sync after connect/reconnect so we don't miss the gap during disconnect. */
  private triggerReconnectBackfill(
    merchantId: string,
    existingProvider: { lastSyncedAt?: Date | null; metadata?: unknown } | null,
  ) {
    const BACKFILL_BUFFER_MS = 30 * 60 * 1000;
    // Allow a wider safety net on reconnect (provider APIs still enforce their own limits).
    const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
    const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

    let fromTime: number;
    if (existingProvider?.lastSyncedAt && existingProvider.lastSyncedAt instanceof Date) {
      fromTime = existingProvider.lastSyncedAt.getTime() - BACKFILL_BUFFER_MS;
    } else if (existingProvider?.metadata && typeof existingProvider.metadata === "object" && existingProvider.metadata !== null && "lastSync" in existingProvider.metadata) {
      const lastSync = (existingProvider.metadata as { lastSync?: Date }).lastSync;
      fromTime = lastSync instanceof Date ? lastSync.getTime() - BACKFILL_BUFFER_MS : Date.now() - DEFAULT_LOOKBACK_MS;
    } else {
      fromTime = Date.now() - DEFAULT_LOOKBACK_MS;
    }
    const fromDate = new Date(Math.max(fromTime, Date.now() - MAX_LOOKBACK_MS));
    const toDate = new Date();

    const serviceUrl = process.env.MERCHANT_SERVICE_URL;
    if (!serviceUrl) {
      this.logger.warn("MERCHANT_SERVICE_URL not set, skipping reconnect backfill");
      return;
    }
    const axios = require("axios");
    const fromStr = fromDate.toISOString();
    const toStr = toDate.toISOString();
    axios
      .get(
        `${serviceUrl}/merchant/${merchantId}/transactions/sync-all?months=12`,
        { 
          timeout: 600000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        },
      )
      .then(() => {
        this.logger.log(
          `✅ Reconnect backfill (sync-all) completed for merchant ${merchantId} (${fromStr} to ${toStr})`,
        );
      })
      .catch((err: Error) => {
        this.logger.warn(
          `⚠️ Reconnect backfill failed for merchant ${merchantId}: ${err?.message}`,
        );
      });
  }

  private async checkExistingProvider(
    merchantId: string,
    providerType: ProviderType,
    accountIdentifier: string,
  ) {
    const existing = await this.prisma.merchantProvider.findFirst({
      where: {
        merchantId,
        providerType,
        accountIdentifier,
        isActive: true,
      },
    });

    if (existing) {
      throw new ConflictException(
        `${providerType} account ${accountIdentifier} is already connected to this merchant`,
      );
    }
  }

  /**
   * Option B: revive soft-deleted merchants on reconnect so merchantId stays stable
   * and existing orders/transactions remain linked to the same merchantId.
   */
  private async reviveMerchantIfDeleted(merchantId: string, db: any = this.prisma) {
    const merchant = await db.merchant.findUnique({
      where: { id: merchantId },
    });
    if (!merchant) return null;
    if (!merchant.deletedAt) return merchant;

    this.logger.log(`♻️ Reviving soft-deleted merchant: ${merchantId}`);
    return await db.merchant.update({
      where: { id: merchantId },
      data: {
        deletedAt: null,
        isActive: false,
        status: "PENDING" as any,
        statusReason: "Awaiting configuration after reconnect",
      },
    });
  }

  private async findReconnectProviderInOrg(
    organizationId: string,
    providerType: ProviderType,
    accountIdentifierCandidates: Array<string | null | undefined>,
    credentialMatch?: (credentials: any) => boolean,
    db: any = this.prisma,
  ) {
    for (const candidate of accountIdentifierCandidates.filter(
      (x): x is string => typeof x === "string" && x.trim().length > 0,
    )) {
      // Only target previously deleted merchants to avoid accidentally hijacking an active merchant
      const found = await db.merchantProvider.findFirst({
        where: {
          providerType,
          accountIdentifier: candidate,
          merchant: { organizationId, deletedAt: { not: null } },
        },
        // If multiple soft-deleted merchants used the same identifier (UPI/phone),
        // always revive the most recently created connection to match user expectations.
        orderBy: {
          createdAt: "desc",
        },
        include: { merchant: true },
      });
      if (found) return found;
    }

    if (credentialMatch) {
      const candidates = await db.merchantProvider.findMany({
        where: {
          providerType,
          merchant: { organizationId, deletedAt: { not: null } },
        },
        orderBy: {
          createdAt: "desc",
        },
        include: { merchant: true },
      });
      return (
        candidates.find((p) => {
          try {
            return credentialMatch((p as any).credentials);
          } catch {
            return false;
          }
        }) || null
      );
    }

    return null;
  }

  private isPlausibleUpiVpa(value: string | null | undefined): boolean {
    if (!value || typeof value !== "string") return false;
    const v = value.trim();
    if (!v || v.startsWith("PENDING_UPI_")) return false;
    return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{2,64}$/.test(v);
  }

  private isGenericMerchantName(name: string | null | undefined): boolean {
    if (!name) return true;
    const n = name.toLowerCase().trim();
    return (
      n.includes("merchant") ||
      n.includes("business") ||
      n.includes("store") ||
      n === "name" ||
      n === "unknown" ||
      n === "paytm merchant" ||
      n === "phonepe merchant" ||
      n === "bharatpe merchant" ||
      n.startsWith("gpay ") ||
      n.length < 3
    );
  }


  private extractReconnectStoredUpi(
    provider: {
      accountIdentifier: string;
      credentials?: unknown;
      metadata?: unknown;
    } | null | undefined,
  ): string | null {
    if (!provider) return null;
    const cred = provider.credentials as Record<string, unknown> | null;
    const meta = provider.metadata as Record<string, unknown> | null;
    const candidates = [
      cred?.merchantUpiId,
      cred?.upiId,
      provider.accountIdentifier,
      meta?.upiId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && this.isPlausibleUpiVpa(c)) return c.trim();
    }
    return null;
  }

  async checkDuplicatePhoneForProvider(
    phoneNumber: string,
    providerType: any,
    merchantIdToExclude: string | null
  ) {
    const whereClause: any = {
      providerType,
      merchant: {
        phone: phoneNumber,
        deletedAt: null,
      }
    };
    
    if (merchantIdToExclude && !merchantIdToExclude.startsWith("temp")) {
      whereClause.merchant.id = { not: merchantIdToExclude };
    }

    const existingConnection = await this.prisma.merchantProvider.findFirst({
      where: whereClause,
      include: {
        merchant: true
      }
    });

    if (existingConnection) {
      let orgName = existingConnection.merchant.organizationId;
      try {
        const axios = require("axios");
        const orgUrl = process.env.ORGANIZATION_SERVICE_URL;
        const orgRes = await axios.get(`${orgUrl}/organizations/${existingConnection.merchant.organizationId}`, {
          headers: { 
            "x-user-type": "SUPER_ADMIN",
            "x-organization-id": existingConnection.merchant.organizationId
          }
        });
        const payload = orgRes.data?.data;
        if (payload?.organization?.name) {
          orgName = payload.organization.name;
        } else if (payload?.name) {
          orgName = payload.name;
        }
      } catch (err: any) {
        this.logger.error(`Failed to fetch org name for ${existingConnection.merchant.organizationId}: ${err.message}`, err.response?.data);
      }
      
      throw new BadRequestException(
        `Failed to connect ${providerType} account. This phone number is already connected in another organization (${orgName}).`
      );
    }
  }

  async sendPhonePeOtp(
    merchantId: string | null,
    phoneNumber: string,
    organizationId?: string,
    isSuperAdmin?: boolean,
  ) {
    try {
      this.logger.log(`📱 Sending REAL PhonePe OTP to ${phoneNumber}`);

      // Check Limits (if organizationId provided)
      if (organizationId) {
        await this.checkProviderLimit(organizationId, "PHONEPE", isSuperAdmin);
      }

      if (!this.validatePhoneNumber(phoneNumber)) {
        throw new BadRequestException(
          "Phone number must be a valid 10-digit Indian mobile number starting with 6-9",
        );
      }

      await this.checkDuplicatePhoneForProvider(phoneNumber, ProviderType.PHONEPE, merchantId);

      const result = await this.phonePeService.sendOtp({ phoneNumber });

      this.logger.log(`✅ PhonePe OTP sent to ${phoneNumber} - REAL API`);
      return {
        success: true,
        message: result.requiresCaptcha
          ? "Captcha required. Please solve the captcha to proceed."
          : "OTP sent to your PhonePe registered mobile number",
        data: {
          otpToken: result.token,
          deviceFingerprint: result.deviceFingerprint,
          fingerprint: result.fingerprint, // CRITICAL: Return long fingerprint for reuse
          sessionId: result.sessionId, // Web API session ID (for web fallback)
          method: result.method, // 'web-api' if web fallback was used
          requiresCaptcha: result.requiresCaptcha || false, // true if UI captcha needed
          sitekey: result.sitekey, // hCaptcha sitekey for UI widget
          expiresIn: 300,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to send PhonePe OTP:`, error);

      if (error.message?.includes("can't register")) {
        throw new BadRequestException(
          "This phone number is not registered with PhonePe Business. Only PhonePe merchants can connect.",
        );
      }

      if (error.message?.includes("Too many")) {
        throw new BadRequestException(
          "Too many OTP requests. Please try again after some time.",
        );
      }

      throw error;
    }
  }

  /**
   * Complete PhonePe OTP send using user-provided captcha token (Phase 2 of web fallback).
   */
  async completePhonePeOtpWithCaptcha(sessionId: string, captchaToken: string) {
    try {
      this.logger.log(
        `🔐 Completing PhonePe OTP with captcha for session: ${sessionId}`,
      );
      const result = await this.phonePeService.completeOtpWithCaptcha(
        sessionId,
        captchaToken,
      );

      return {
        success: true,
        message: "OTP sent to your PhonePe registered mobile number",
        data: {
          otpToken: result.token,
          deviceFingerprint: result.deviceFingerprint,
          fingerprint: result.fingerprint,
          sessionId: result.sessionId,
          method: result.method,
          expiresIn: 300,
        },
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to complete PhonePe OTP with captcha:`,
        error,
      );
      throw error;
    }
  }

  async connectPhonePe(
    merchantId: string,
    data: {
      phoneNumber: string;
      otp: string;
      otpToken: string;
      deviceFingerprint: string;
      fingerprint?: string; // Long fingerprint from sendOtp
      organizationId?: string;
      sessionId?: string; // Web API session ID (for web fallback)
      method?: string; // 'web-api' if web fallback was used
      isSuperAdmin?: boolean;
    },
  ) {
    try {
      this.logger.log(
        `🔗 Verifying PhonePe OTP and connecting for merchant: ${merchantId}`,
      );

      let verificationResult: any;

      // Route to web API verify if the OTP was sent via web fallback
      if (data.sessionId?.startsWith("ppweb_") || data.method === "web-api") {
        this.logger.log(
          `🌐 Using web API verify for session: ${data.sessionId}`,
        );
        verificationResult = await this.phonePeService.verifyOtpViaWeb(
          data.sessionId!,
          data.otp,
          data.phoneNumber,
        );
      } else {
        verificationResult = await this.phonePeService.verifyOtp(
          data.phoneNumber,
          data.otp,
          data.otpToken,
          data.deviceFingerprint,
          data.fingerprint, // Pass long fingerprint
        );
      }

      if (!verificationResult?.success) {
        throw new BadRequestException(
          "PhonePe OTP verification failed. Please check your OTP and try again.",
        );
      }

      if (
        verificationResult.requiresGroupSelection ||
        (verificationResult.groups && verificationResult.groups.length > 1)
      ) {
        this.logger.log(
          `🏪 Multiple stores detected for ${data.phoneNumber}. Returning groups for selection.`,
        );
        return {
          success: true,
          requiresGroupSelection: true,
          groups: verificationResult.groups,
          accountDetails: verificationResult.accountDetails,
          message:
            "Multiple merchant stores found. Please select one to connect.",
        };
      }

      if (!data.organizationId) {
        throw new BadRequestException(
          "Organization ID is required. Please ensure you are logged in and have selected an organization.",
        );
      }

      const phonePeData: any = verificationResult.accountDetails;

      // Check Provider Limits first (fail fast)
      await this.checkProviderLimit(data.organizationId, "PHONEPE", data.isSuperAdmin);
      // NOTE: We intentionally delay duplicate-account checks and merchant create-limit checks
      // until after we have a stable accountIdentifier (UPI) and can revive a soft-deleted merchant on reconnect.

      // -----------------------------------------------------------------------
      // V2 UPDATE: MATCHING LEGACY BACKEND SESSION LOGIC
      // -----------------------------------------------------------------------
      let finalToken = phonePeData.token;
      let finalRefreshToken = phonePeData.refreshToken;

      // Extract group details just like legacy updateMerchantWithProvider
      // Legacy Code Reference: phonepe-hijack.service.ts Lines 174-196
      const unitId =
        phonePeData.externalReferenceId ||
        phonePeData.groups?.[0]?.externalReferenceId;
      const groupValue =
        phonePeData.groupValue || phonePeData.groups?.[0]?.groupValue;
      const groupId = phonePeData.groupId || phonePeData.groups?.[0]?.groupId;
      const groupName =
        phonePeData.groupName || phonePeData.groups?.[0]?.groupName || phonePeData.name;

      this.logger.log(
        `📊 Extracted Group Details: groupValue=${groupValue}, groupId=${groupId}, unitId=${unitId}`,
      );

      // Crucial Step: The legacy backend ALWAYS called updatePhonePeSession if a groupId was present.
      // This is what scopes the token to the specific merchant store (even if only 1 exists)
      // for the Android (business-api) flow.
      // NOTE: Skip for web-api flow — web JWT tokens are handled separately in the
      // connectPhonePeWithGroup path using the real mi-web updateSession endpoint.
      const isWebApiFlow =
        data.method === "web-api" || data.sessionId?.startsWith("ppweb_");

      // If this is a web-api flow, the PhonePeWebService sessionId embeds a proposed providerId:
      // ppweb_<providerId>_<timestamp>_<rand>
      const webProviderId =
        isWebApiFlow && typeof data.sessionId === "string"
          ? (() => {
            const parts = data.sessionId.split("_");
            // ["ppweb", "<uuid>", "<ts>", "<rand>"]
            return parts.length >= 2 ? parts[1] : null;
          })()
          : null;

      if (isWebApiFlow) {
        this.logger.log(
          `🌐 Web API flow detected in connectPhonePe — skipping Android updateSession`,
        );
      } else if (groupId) {
        this.logger.log(
          `🔄 Auto-Selecting store - calling updateSession with groupId: ${groupId}`,
        );
        try {
          const sessionResult = await this.phonePeService.updatePhonePeSession(
            phonePeData.token,
            groupId,
            data.deviceFingerprint, // Use deviceFingerprint passed from verifyOtp
          );

          if (sessionResult?.token) {
            finalToken = sessionResult.token;
            finalRefreshToken = sessionResult.refreshToken;
            this.logger.log(
              `✅ Session updated successfully with new token (Scoped to Store)`,
            );
          }
        } catch (error: any) {
          this.logger.error(
            "Failed to update PhonePe session (Auto-Select):",
            error?.message,
          );
          // We don't throw here for now, we try to proceed, but sync might fail
        }
      } else {
        this.logger.warn(
          `⚠️ No groupId found in account details - proceeding with unscoped token (Sync may fail)`,
        );
      }
      // -----------------------------------------------------------------------

      // Try to fetch real UPI ID from transactions
      // NOTE: Skip for web-api flow — Android API returns 401 with web JWT tokens
      let merchantUpiId: string | null = null;
      let initialTransactions: any[] = [];
      let merchantCreated = false;

      if (isWebApiFlow) {
        this.logger.log(
          `🌐 Web API flow — Attpending UPI ID detection from transactions...`,
        );
      }

      try {
        const fetchResult = await this.phonePeService.fetchMerchantUpiId(
          finalToken,
          data.deviceFingerprint,
          groupValue,
          undefined,
          finalRefreshToken,
          data.fingerprint, // Pass long fingerprint if available
          groupId, // Pass groupId if available
          undefined, // cookies for web managed via PhonePeWebService context
          phonePeData.csrfToken, // CSRF for web
          data.method, // Pass 'web-api' method
        );

        if (fetchResult.upiId) {
          this.logger.log(`✅ Using fetched UPI ID: ${fetchResult.upiId}`);
          merchantUpiId = fetchResult.upiId;
        } else {
          this.logger.warn(`⚠️ UPI ID not found in transactions`);
        }

        if (fetchResult.transactions) {
          initialTransactions = fetchResult.transactions;
        }
      } catch (upiError) {
        this.logger.warn(
          `Failed to fetch UPI ID during onboarding: ${upiError.message}`,
        );
      }

      // Reconnect: if PhonePe API did not return UPI, reuse VPA from last connection (same org + phone).
      if (!merchantUpiId && data.organizationId) {
        const prior = await this.findReconnectProviderInOrg(
          data.organizationId,
          ProviderType.PHONEPE,
          [],
          (cred) => cred?.phoneNumber === data.phoneNumber,
        );
        const restored = this.extractReconnectStoredUpi(prior);
        if (restored) {
          merchantUpiId = restored;
          this.logger.log(
            `♻️ Restored PhonePe UPI from prior connection for ${data.phoneNumber}`,
          );
        }
      }

      // accountIdentifier is required in DB. Use UPI when we have it; otherwise a placeholder until user adds UPI manually (no phone fallback).
      let accountIdentifier =
        merchantUpiId ||
        (phonePeData && (phonePeData.merchantUpiId || phonePeData.upiId)) ||
        `PENDING_UPI_${data.phoneNumber}`;

      // Option B: If this PhonePe account was previously connected under a soft-deleted merchant,
      // revive that merchant and reuse its merchantId to keep orders/transactions linked.
      const reconnectProvider = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.PHONEPE,
        [accountIdentifier],
        (cred) => cred?.phoneNumber === data.phoneNumber,
      );
      const merchantIdToUse = reconnectProvider?.merchantId || merchantId;

      // Reuse VPA already stored on this merchant's PhonePe row (active or revived — not only soft-deleted reconnect).
      const existingPhonePeRow =
        data.organizationId &&
          merchantIdToUse &&
          !String(merchantIdToUse).startsWith("temp")
          ? await this.prisma.merchantProvider.findFirst({
            where: {
              merchantId: merchantIdToUse,
              providerType: ProviderType.PHONEPE,
              merchant: { organizationId: data.organizationId },
            },
          })
          : null;

      if (!merchantUpiId && existingPhonePeRow) {
        const fromRow = this.extractReconnectStoredUpi(existingPhonePeRow);
        if (fromRow) {
          merchantUpiId = fromRow;
          this.logger.log(
            `♻️ Restored PhonePe UPI from existing DB row for merchant ${merchantIdToUse}`,
          );
          accountIdentifier =
            merchantUpiId ||
            (phonePeData && (phonePeData.merchantUpiId || phonePeData.upiId)) ||
            `PENDING_UPI_${data.phoneNumber}`;
        }
      }

      const requiresManualUpi = !merchantUpiId;
      if (requiresManualUpi) {
        this.logger.warn(
          `⚠️ UPI ID not found from API or DB. User must add UPI ID manually if needed.`,
        );
      }

      // Pre-check if we will need to create a new merchant (external call; do it outside transaction)
      const existingMerchantPre = await this.prisma.merchant.findFirst({
        where: { id: merchantIdToUse },
      });
      if (!existingMerchantPre) {
        await this.checkSubscriptionLimit(data.organizationId, "CREATE_MERCHANT", data.isSuperAdmin);
      }

      const duplicateExcludeProviderId =
        reconnectProvider?.id ?? existingPhonePeRow?.id;

      const txResult = await this.prisma.$transaction(async (tx) => {
        // Check for duplicate account globally (exclude the same provider if we are reconnecting/updating it)
        await this.checkDuplicateAccount(
          accountIdentifier,
          ProviderType.PHONEPE,
          duplicateExcludeProviderId,
          tx,
          data.isSuperAdmin,
        );

        let merchant = await tx.merchant.findFirst({
          where: { id: merchantIdToUse },
        });
        if (merchant?.deletedAt) {
          merchant = await this.reviveMerchantIfDeleted(merchantIdToUse, tx);
        }

        if (merchant && groupName) {
          // Update name if merchant already exists (reconnection/update)
          const currentIsGeneric = this.isGenericMerchantName(merchant.name);
          const newNameIsReal = !this.isGenericMerchantName(groupName);

          const dataToUpdate: any = { isPlatform: !!data.isSuperAdmin };

          if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
            this.logger.log(`📝 Updating existing merchant name to: ${groupName}`);
            dataToUpdate.name = groupName;
            dataToUpdate.businessName = groupName;
          } else {
            this.logger.log(`📝 Keeping existing custom merchant name: ${merchant.name}`);
          }

          merchant = await tx.merchant.update({
            where: { id: merchantIdToUse },
            data: dataToUpdate,
          });
        }
        let created = false;
        if (!merchant) {
          this.logger.log(`📝 Creating new merchant: ${groupName}`);
          merchant = await tx.merchant.create({
            data: {
              id: merchantIdToUse,
              organizationId: data.organizationId,
              name: groupName || "PhonePe Merchant",
              businessName: groupName || "PhonePe Merchant",
              phone: data.phoneNumber,
              status: "PENDING",
              verified: false,
              isActive: false,
              isPlatform: !!data.isSuperAdmin,
            },
          });
          created = true;
          this.logger.log(
            `✅ Merchant created: ${merchant.id} (requires configuration)`,
          );
        }

        const existingProvider = await tx.merchantProvider.findFirst({
          where: {
            merchantId: merchant.id,
            providerType: ProviderType.PHONEPE,
          },
        });

        const providerUpdate = {
          accountIdentifier,
          credentials: {
            otp: data.otp,
            otpToken: data.otpToken,
            deviceFingerprint: data.deviceFingerprint,
            phoneNumber: data.phoneNumber,
            merchantName: phonePeData.name,
            merchantUpiId: merchantUpiId,
            groupId: groupId,
            groupValue: groupValue,
            token: finalToken,
            refreshToken: finalRefreshToken,
            // Web API flow: persist cookie jar + CSRF so keepalive can run without relying
            // on the Chromium profile snapshot.
            ...(isWebApiFlow
              ? {
                csrfToken: phonePeData.csrfToken,
                cookiesString: phonePeData.cookiesString,
              }
              : {}),
            // Persist the web fingerprint so all future web-api calls reuse the same identity.
            ...(isWebApiFlow && phonePeData?.fingerprint
              ? { fingerprint: phonePeData.fingerprint }
              : {}),
            verifiedAt: new Date(),
            ...(isWebApiFlow ? { authMethod: "web-api" } : {}),
            ...(isWebApiFlow
              ? {
                credentials: {
                  ...(phonePeData.credentials || {}),
                  token: finalToken,
                  refreshToken: finalRefreshToken,
                  csrfToken: phonePeData.csrfToken,
                  cookiesString: phonePeData.cookiesString,
                },
              }
              : {}),
          },
          status: MerchantProviderStatus.ACTIVE,
          isActive: true,
          metadata: {
            connectedAt: new Date(),
            lastSync: new Date(),
            phonePeAccountDetails: phonePeData,
          },
        };

        const merchantProvider = existingProvider
          ? await tx.merchantProvider.update({
            where: { id: existingProvider.id },
            data: providerUpdate,
          })
          : await tx.merchantProvider.create({
            data: {
              ...(webProviderId ? { id: webProviderId } : {}),
              merchant: { connect: { id: merchant.id } },
              providerType: ProviderType.PHONEPE,
              ...providerUpdate,
            },
          });

        return {
          merchant,
          merchantProvider,
          existingProviderBefore: existingProvider,
          merchantCreated: created,
        };
      });

      const merchant = txResult.merchant;
      const merchantProvider = txResult.merchantProvider;
      const existingProvider = txResult.existingProviderBefore;
      merchantCreated = txResult.merchantCreated;

      this.logger.log(
        `✅ PhonePe connected successfully: ${merchantProvider.id}`,
      );

      // Save initial transactions in background
      if (initialTransactions.length > 0) {
        this.saveInitialPhonePeTransactions(
          merchant.id,
          merchantProvider.id,
          initialTransactions,
        ).catch((err) => {
          this.logger.error(
            `⚠️ Background initial transaction save failed:`,
            err.message,
          );
        });
      }

      // Reconnect backfill: sync from lastSyncedAt - buffer (or last 24h) to cover gap during disconnect
      this.triggerReconnectBackfill(merchant.id, existingProvider ?? null);

      // Update Subscription Usage
      if (merchantCreated) {
        this.updateSubscriptionUsage(
          data.organizationId,
          "CREATE_MERCHANT",
        ).catch((e) => this.logger.warn(e));
      }
      // Note: We don't have a 'CONNECT_PROVIDER' action in usage stats yet, maybe we should add?
      // For now, limits are checked via checkProviderLimit which counts existing connections.

      return {
        success: true,
        merchantId: merchant.id,
        requiresConfiguration: !merchant.verified,
        requiresManualUpi: requiresManualUpi,
        connection: {
          id: merchantProvider.id,
          providerType: merchantProvider.providerType,
          accountIdentifier: merchantProvider.accountIdentifier,
          status: merchantProvider.status,
          merchantName: phonePeData.name,
          upiId: merchantUpiId,
        },
        message: requiresManualUpi
          ? `PhonePe merchant connected. Please enter your UPI ID manually.`
          : `PhonePe merchant account "${phonePeData.name}" connected successfully`,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to connect PhonePe:`, error);

      if (error.message?.includes("verification failed")) {
        throw error; // Re-throw verification errors as-is
      }

      throw new BadRequestException(
        "Failed to connect PhonePe account. Please try again.",
      );
    }
  }

  async connectPhonePeWithGroup(
    merchantId: string,
    data: {
      phoneNumber: string;
      accountData: any;
      organizationId?: string;
      method?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    try {
      this.logger.log(
        `🔗 Connecting PhonePe with selected group for merchant: ${merchantId}`,
      );

      if (!data.organizationId) {
        throw new BadRequestException("Organization ID is required.");
      }

      const phonePeData = data.accountData;

      // Check Provider Limits first (fail fast)
      await this.checkProviderLimit(data.organizationId, "PHONEPE", data.isSuperAdmin);
      // NOTE: We intentionally delay duplicate-account checks and merchant create-limit checks
      // until after we have a stable accountIdentifier (UPI) and can revive a soft-deleted merchant on reconnect.

      // Try to fetch real UPI ID from transactions
      let merchantUpiId: string | null = null; // No fallback - ask user if not found
      let initialTransactions: any[] = [];
      let merchantCreated = false;

      // -----------------------------------------------------------------------
      // V2 UPDATE: MATCHING LEGACY BACKEND SESSION LOGIC
      // -----------------------------------------------------------------------
      let finalToken = phonePeData.token;
      let finalRefreshToken = phonePeData.refreshToken;
      const groupId = phonePeData.groupId || data.accountData.groupId;
      const isWebApiFlow =
        phonePeData.method === "web-api" ||
        data.accountData.method === "web-api" ||
        data.method === "web-api";

      // CRITICAL: Find the correct groupValue for the SELECTED groupId from groups array
      // The phonePeData.groupValue might be from the first group, not the selected one
      let selectedGroupValue = phonePeData.groupValue;
      let selectedGroupName = phonePeData.groupName || phonePeData.name;
      const groups = phonePeData.groups || data.accountData.groups || [];

      if (groupId && groups.length > 0) {
        const selectedGroup = groups.find((g: any) => g.groupId === groupId);
        if (selectedGroup) {
          selectedGroupValue = selectedGroup.groupValue;
          selectedGroupName = selectedGroup.groupName || selectedGroup.roleName || selectedGroupName;
          this.logger.log(
            `📋 Found group details for selected groupId ${groupId}: name=${selectedGroupName}, value=${selectedGroupValue}`,
          );
        } else {
          this.logger.warn(
            `⚠️ Could not find groupValue for groupId ${groupId}, using default: ${selectedGroupValue}`,
          );
        }
      }

      // -----------------------------------------------------------------------
      // For WEB-API flow, do NOT call Android refresh/updateSession (business-api).
      // The session is scoped via mi-web /user/updateSession and synced via persistent browser.
      // -----------------------------------------------------------------------
      const fingerprintToUse =
        phonePeData.fingerprint || data.accountData.fingerprint;
      const deviceFingerprintForSession =
        phonePeData.deviceFingerprint || data.accountData.deviceFingerprint;

      if (!isWebApiFlow) {
        // *** KEY FIX: REFRESH TOKEN FIRST (matching legacy PHP flow) ***
        this.logger.log(
          `🔄 STEP 1: Refreshing token BEFORE updateSession (PHP pattern)`,
        );
        try {
          const refreshResult = await this.phonePeService.refreshPhonePeToken(
            finalToken,
            finalRefreshToken,
            deviceFingerprintForSession,
            fingerprintToUse,
          );
          if (refreshResult) {
            this.logger.log(
              `✅ Token refreshed successfully BEFORE updateSession`,
            );
            this.logger.log(`   Old token: ${finalToken?.substring(0, 30)}...`);
            this.logger.log(
              `   New token: ${refreshResult.token?.substring(0, 30)}...`,
            );
            finalToken = refreshResult.token;
            finalRefreshToken = refreshResult.refreshToken;
          } else {
            this.logger.warn(
              `⚠️ Token refresh returned null, using original token`,
            );
          }
        } catch (refreshError: any) {
          this.logger.warn(
            `⚠️ Token refresh failed: ${refreshError.message}, using original token`,
          );
        }

        this.logger.log(
          `🔄 STEP 2: Attempting updateSession for groupId ${groupId}`,
        );
        this.logger.log(
          `📤 updateSession fingerprint (long): ${fingerprintToUse}`,
        );
        this.logger.log(
          `📤 updateSession deviceFingerprint (short): ${deviceFingerprintForSession}`,
        );
        this.logger.log(
          `📤 Using REFRESHED token: ${finalToken?.substring(0, 30)}...`,
        );

        const xResponseToken =
          phonePeData.xResponseToken || data.accountData.xResponseToken;
        const cookies = phonePeData.cookies || data.accountData.cookies;

        try {
          const sessionResult = await this.phonePeService.updatePhonePeSession(
            finalToken,
            groupId,
            deviceFingerprintForSession,
            fingerprintToUse,
            xResponseToken, // Pass x-response-token for CSRF-like auth
            cookies, // Pass cookies for persistent session
            data.method, // Pass 'web-api' method
            selectedGroupValue, // Pass the selected groupValue for web scoping
            phonePeData.csrfToken || data.accountData?.csrfToken, // Pass CSRF token
          );

          if (sessionResult) {
            this.logger.log(`✅ updateSession successful! Got new scoped token`);
            finalToken = sessionResult.token;
            finalRefreshToken = sessionResult.refreshToken;
          } else {
            this.logger.warn(
              `⚠️ updateSession returned null, using original token`,
            );
          }
        } catch (sessionError: any) {
          this.logger.warn(`⚠️ updateSession failed: ${sessionError.message}`);
          this.logger.warn(`   Falling back to using groupValue filter instead`);
        }
      } else {
        this.logger.log(
          `🌐 Web API flow: skipping Android refresh/updateSession noise`,
        );
      }

      this.logger.log(
        `🔄 Using groupValue ${selectedGroupValue} for store selection`,
      );
      // -----------------------------------------------------------------------

      // Try to fetch real UPI ID from transactions using the CORRECT groupValue
      // Reuse fingerprintToUse and deviceFingerprintForSession from updateSession call above
      this.logger.debug(
        `🔑 DeviceFingerprint for fetchMerchantUpiId: ${deviceFingerprintForSession}`,
      );
      this.logger.debug(
        `🔑 Fingerprint (long) for fetchMerchantUpiId: ${fingerprintToUse?.substring(0, 30)}...`,
      );
      this.logger.debug(
        `🔑 phonePeData.deviceFingerprint: ${phonePeData.deviceFingerprint}`,
      );
      this.logger.debug(
        `🔑 data.accountData.deviceFingerprint: ${data.accountData.deviceFingerprint}`,
      );

      try {
        // Use a 15-second timeout to prevent blocking the API gateway
        const fetchPromise = this.phonePeService.fetchMerchantUpiId(
          finalToken,
          deviceFingerprintForSession, // token/fingerprint from accountData
          selectedGroupValue, // Use the SELECTED group's value, not the default first one
          undefined,
          finalRefreshToken,
          fingerprintToUse, // Pass long fingerprint for API headers
          groupId, // Pass groupId for x-user-group-id header (multi-store scope bypass)
          phonePeData.cookiesString || data.accountData.cookiesString,
          phonePeData.csrfToken || data.accountData.csrfToken,
          phonePeData.method || data.accountData.method,
        );

        // Prevent UnhandledPromiseRejection if it fails AFTER the race timeout
        fetchPromise.catch((e) => this.logger.debug(`Background UPI fetch failed: ${e.message}`));

        const timeoutPromise = new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout of 15000ms exceeded for UPI fetch")), 15000)
        );

        const fetchResult = await Promise.race([fetchPromise, timeoutPromise]);

        if (fetchResult.upiId) {
          this.logger.log(
            `✅ Using fetched UPI ID (Group): ${fetchResult.upiId}`,
          );
          merchantUpiId = fetchResult.upiId;
        } else {
          this.logger.log(`⚠️ UPI ID not found in transactions (Group).`);
        }

        if (fetchResult.transactions) {
          initialTransactions = fetchResult.transactions;
        }
      } catch (upiError) {
        this.logger.warn(
          `Failed or timed out fetching UPI ID during group onboarding: ${upiError.message}. Proceeding with background sync.`,
        );
      }

      if (!merchantUpiId && data.organizationId) {
        const prior = await this.findReconnectProviderInOrg(
          data.organizationId,
          ProviderType.PHONEPE,
          [],
          (cred) => cred?.phoneNumber === data.phoneNumber,
        );
        const restored = this.extractReconnectStoredUpi(prior);
        if (restored) {
          merchantUpiId = restored;
          this.logger.log(
            `♻️ Restored PhonePe UPI (group flow) from prior connection for ${data.phoneNumber}`,
          );
        }
      }

      // Check if merchant exists, create if not
      // accountIdentifier is required in DB. Use UPI when we have it; otherwise a placeholder until user adds UPI manually.
      let accountIdentifier = merchantUpiId || `PENDING_UPI_${data.phoneNumber}`;

      // Option B: revive soft-deleted merchant on reconnect for this account
      const reconnectProvider = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.PHONEPE,
        [accountIdentifier],
        (cred) => cred?.phoneNumber === data.phoneNumber,
      );
      const merchantIdToUse = reconnectProvider?.merchantId || merchantId;

      const existingPhonePeRow =
        data.organizationId &&
          merchantIdToUse &&
          !String(merchantIdToUse).startsWith("temp")
          ? await this.prisma.merchantProvider.findFirst({
            where: {
              merchantId: merchantIdToUse,
              providerType: ProviderType.PHONEPE,
              merchant: { organizationId: data.organizationId },
            },
          })
          : null;

      if (!merchantUpiId && existingPhonePeRow) {
        const fromRow = this.extractReconnectStoredUpi(existingPhonePeRow);
        if (fromRow) {
          merchantUpiId = fromRow;
          this.logger.log(
            `♻️ Restored PhonePe UPI (group flow) from existing DB row for merchant ${merchantIdToUse}`,
          );
          accountIdentifier = merchantUpiId || `PENDING_UPI_${data.phoneNumber}`;
        }
      }

      const duplicateExcludeProviderId =
        reconnectProvider?.id ?? existingPhonePeRow?.id;

      // Pre-check if we will need to create a new merchant (external call; do it outside transaction)
      const existingMerchantPre = await this.prisma.merchant.findFirst({
        where: { id: merchantIdToUse },
      });
      if (!existingMerchantPre) {
        await this.checkSubscriptionLimit(data.organizationId, "CREATE_MERCHANT", data.isSuperAdmin);
      }

      const txResult = await this.prisma.$transaction(async (tx) => {
        await this.checkDuplicateAccount(
          accountIdentifier,
          ProviderType.PHONEPE,
          duplicateExcludeProviderId,
          tx,
          data.isSuperAdmin,
        );

        let merchant = await tx.merchant.findFirst({
          where: { id: merchantIdToUse },
        });
        if (merchant?.deletedAt) {
          merchant = await this.reviveMerchantIfDeleted(merchantIdToUse, tx);
        }

        if (merchant && selectedGroupName) {
          // Update name if merchant already exists (reconnection/update)
          const currentIsGeneric = this.isGenericMerchantName(merchant.name);
          const newNameIsReal = !this.isGenericMerchantName(selectedGroupName);

          const dataToUpdate: any = { isPlatform: !!data.isSuperAdmin };

          if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
            this.logger.log(`📝 Updating existing merchant name to: ${selectedGroupName}`);
            dataToUpdate.name = selectedGroupName;
            dataToUpdate.businessName = selectedGroupName;
          } else {
            this.logger.log(`📝 Keeping existing custom merchant name: ${merchant.name}`);
          }

          merchant = await tx.merchant.update({
            where: { id: merchantIdToUse },
            data: dataToUpdate,
          });
        }
        let created = false;
        if (!merchant) {
          this.logger.log(
            `📝 Creating new merchant: ${selectedGroupName || "PhonePe Merchant"}`,
          );
          merchant = await tx.merchant.create({
            data: {
              id: merchantIdToUse,
              organizationId: data.organizationId,
              name: selectedGroupName || "PhonePe Merchant",
              businessName: selectedGroupName || "PhonePe Merchant",
              phone: data.phoneNumber,
              status: "PENDING",
              verified: false,
              isActive: false,
              isPlatform: !!data.isSuperAdmin,
            },
          });
          created = true;
        }

        const existingProvider = await tx.merchantProvider.findFirst({
          where: {
            merchantId: merchant.id,
            providerType: ProviderType.PHONEPE,
          },
        });

        const providerUpdate = {
          accountIdentifier,
          credentials: {
            ...phonePeData,
            phoneNumber: data.phoneNumber,
            merchantUpiId: merchantUpiId,
            groupValue: selectedGroupValue,
            groupId: groupId,
            fingerprint: fingerprintToUse,
            csrfToken: phonePeData.csrfToken || data.accountData.csrfToken,
            cookiesString:
              phonePeData.cookiesString || data.accountData.cookiesString,
            method: phonePeData.method || data.accountData.method,
            verifiedAt: new Date(),
          },
          status: MerchantProviderStatus.ACTIVE,
          isActive: true,
          metadata: {
            connectedAt: new Date(),
            lastSync: new Date(),
            phonePeAccountDetails: phonePeData,
            groupSelection: true,
          },
        };

        const merchantProvider = existingProvider
          ? await tx.merchantProvider.update({
            where: { id: existingProvider.id },
            data: providerUpdate,
          })
          : await tx.merchantProvider.create({
            data: {
              merchantId: merchant.id,
              providerType: ProviderType.PHONEPE,
              ...providerUpdate,
            },
          });

        return {
          merchant,
          merchantProvider,
          existingProviderBefore: existingProvider,
          merchantCreated: created,
        };
      });

      const merchant = txResult.merchant;
      const merchantProvider = txResult.merchantProvider;
      const existingProvider = txResult.existingProviderBefore;
      merchantCreated = txResult.merchantCreated;

      this.logger.log(
        `✅ PhonePe connected successfully with group: ${merchantProvider.id}`,
      );

      // Save initial transactions in background
      if (initialTransactions.length > 0) {
        this.saveInitialPhonePeTransactions(
          merchant.id,
          merchantProvider.id,
          initialTransactions,
        ).catch((err) => {
          this.logger.error(
            `⚠️ Background initial transaction save failed (Group):`,
            err.message,
          );
        });
      }

      this.triggerReconnectBackfill(merchant.id, existingProvider ?? null);

      // Update Subscription Usage
      if (merchantCreated) {
        this.updateSubscriptionUsage(
          data.organizationId,
          "CREATE_MERCHANT",
        ).catch((e) => this.logger.warn(e));
      }

      return {
        success: true,
        merchantId: merchant.id,
        requiresConfiguration: !merchant.verified,
        connection: {
          id: merchantProvider.id,
          providerType: merchantProvider.providerType,
          accountIdentifier: merchantProvider.accountIdentifier,
          status: merchantProvider.status,
          merchantName: phonePeData.name,
          upiId: merchantUpiId,
        },
        requiresManualUpi: !merchantUpiId,
        message: `PhonePe merchant account connected successfully. Transactions are being synchronized in the background.`,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to connect PhonePe with group:`, error);
      throw new BadRequestException(
        "Failed to connect PhonePe account with selected group.",
      );
    }
  }

  async connectGPay(
    merchantId: string,
    data: {
      email: string;
      businessId: string;
      sessionData: any;
      isSuperAdmin?: boolean;
    },
  ) {
    try {
      this.logger.log(`🔗 Connecting GPay for merchant: ${merchantId}`);

      const merchantProvider = await this.prisma.merchantProvider.create({
        data: {
          merchantId,
          providerType: ProviderType.GPAY,
          accountIdentifier: data.email,
          credentials: {
            email: data.email,
            businessId: data.businessId,
            sessionData: data.sessionData,
          },
          status: MerchantProviderStatus.ACTIVE,
          metadata: {
            connectedAt: new Date(),
            lastSync: new Date(),
          },
        },
      });

      this.logger.log(`✅ GPay connected: ${merchantProvider.id}`);
      return {
        success: true,
        connection: merchantProvider,
        message: "GPay connected successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to connect GPay:`, error);
      throw new BadRequestException("Failed to connect GPay");
    }
  }

  async sendPaytmOtp(
    username: string,
    password: string,
    organizationId?: string,
    isSuperAdmin?: boolean,
  ) {
    try {
      this.logger.log(`📱 Sending Paytm OTP for ${username}`);

      // Check Limits
      if (organizationId) {
        await this.checkProviderLimit(organizationId, "PAYTM", isSuperAdmin);
      }

      // Skip provider check for send-otp (merchantId may not exist yet)

      const sessionId = `paytm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

      const result = await this.paytmService.sendOtp(
        username,
        password,
        userAgent,
        sessionId,
      );

      this.logger.log(`✅ Paytm OTP sent for ${username}`);
      return {
        success: true,
        message: "OTP sent to your Paytm registered mobile/email",
        data: {
          stateCode: result.stateCode,
          csrfToken: result.csrfToken,
          sessionId: result.sessionId,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to send Paytm OTP:`, error);

      if (error.message?.includes("Invalid credentials")) {
        throw new BadRequestException(
          "Invalid Paytm username or password. Please check your credentials.",
        );
      }

      throw new BadRequestException(
        "Failed to connect to Paytm. Please try again.",
      );
    }
  }

  async connectPaytm(
    merchantId: string,
    data: {
      username: string;
      password: string;
      otp: string;
      sessionId: string;
      organizationId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    try {
      this.logger.log(`🔗 Verifying Paytm OTP for merchant: ${merchantId}`);

      const verifyResult = await this.paytmService.verifyOtpWithPuppeteer(
        data.sessionId,
        data.otp,
      );

      if (!data.organizationId) {
        throw new BadRequestException(
          "Organization ID is required. Please ensure you are logged in and have selected an organization.",
        );
      }

      // Check Provider Limits first
      await this.checkProviderLimit(data.organizationId, "PAYTM", data.isSuperAdmin);

      const paytmCredMatch = (cred: any) => {
        const u = (data.username || "").trim();
        if (!u) return false;
        return (
          cred?.username === u ||
          cred?.phoneNumber === u ||
          cred?.loginId === u
        );
      };

      // Prefer soft-deleted row by login id so we can restore saved VPA before choosing accountIdentifier.
      let reconnectProvider = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.PAYTM,
        [],
        paytmCredMatch,
      );

      // Determine the best identifier to use
      let extractedMid: string | null = null;
      if (verifyResult.displayName) {
        const midMatch = verifyResult.displayName.match(/MID:\s*([^\s,]+)/i);
        if (midMatch) {
          extractedMid = midMatch[1];
          this.logger.log(`📋 Extracted MID from displayName: ${extractedMid}`);
        }
      }
      let accountIdentifier =
        verifyResult.upiId ||
        verifyResult.merchantId ||
        extractedMid ||
        data.username;

      const storedVpa = this.extractReconnectStoredUpi(reconnectProvider);
      const verifyUpiWeak =
        !this.isPlausibleUpiVpa(verifyResult.upiId) ||
        verifyResult.upiId === verifyResult.merchantId;
      if (storedVpa && verifyUpiWeak) {
        accountIdentifier = storedVpa;
        this.logger.log(`♻️ Restored Paytm VPA from prior connection`);
      }

      if (!accountIdentifier) {
        this.logger.error(
          `❌ No account identifier found. UPI: ${verifyResult.upiId}, MID: ${verifyResult.merchantId}, Extracted: ${extractedMid}, User: ${data.username}`,
        );
        throw new BadRequestException(
          "Could not identify Paytm account. Please try again.",
        );
      }

      this.logger.log(`✅ Using accountIdentifier: ${accountIdentifier}`);

      // Option B: if this Paytm account was previously connected under a soft-deleted merchant,
      // revive that merchant and reuse its merchantId to keep orders/transactions linked.
      if (!reconnectProvider) {
        reconnectProvider = await this.findReconnectProviderInOrg(
          data.organizationId,
          ProviderType.PAYTM,
          [
            accountIdentifier,
            verifyResult.upiId,
            verifyResult.merchantId,
            extractedMid,
          ].filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0,
          ),
          paytmCredMatch,
        );
      }
      const merchantIdToUse = reconnectProvider?.merchantId || merchantId;

      // Pre-check if we will need to create a new merchant (external call; do it outside transaction)
      const existingMerchantPre = await this.prisma.merchant.findFirst({
        where: { id: merchantIdToUse },
      });
      if (!existingMerchantPre) {
        await this.checkSubscriptionLimit(data.organizationId, "CREATE_MERCHANT", data.isSuperAdmin);
      }

      let merchantCreated = false;
      const txResult = await this.prisma.$transaction(async (tx) => {
        // Check for duplicate account globally (exclude the same provider if we are reconnecting/updating it)
        await this.checkDuplicateAccount(
          accountIdentifier,
          ProviderType.PAYTM,
          reconnectProvider?.id,
          tx,
          data.isSuperAdmin,
        );

        let merchant = await tx.merchant.findFirst({
          where: { id: merchantIdToUse },
        });

        if (merchant?.deletedAt) {
          merchant = await this.reviveMerchantIfDeleted(merchantIdToUse, tx);
        }

        if (merchant) {
          const currentIsGeneric = this.isGenericMerchantName(merchant.name);
          const newNameIsReal = verifyResult.displayName && !this.isGenericMerchantName(verifyResult.displayName);

          const dataToUpdate: any = { isPlatform: !!data.isSuperAdmin };

          if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
            this.logger.log(`📝 Syncing Paytm merchant name: ${verifyResult.displayName}`);
            dataToUpdate.name = verifyResult.displayName;
            dataToUpdate.businessName = verifyResult.displayName;
          } else {
            this.logger.log(`📝 Keeping existing custom Paytm merchant name: ${merchant.name}`);
          }

          merchant = await tx.merchant.update({
            where: { id: merchant.id },
            data: dataToUpdate,
          });
        } else {
          this.logger.log(
            `📝 Creating new merchant: ${verifyResult.displayName}`,
          );
          merchant = await tx.merchant.create({
            data: {
              id: merchantIdToUse,
              organizationId: data.organizationId,
              name: verifyResult.displayName || "Paytm Merchant",
              businessName: verifyResult.displayName || "Paytm Merchant",
              status: "PENDING", // Provider connected, awaiting configuration
              verified: false,
              isActive: false, // Inactive until configuration is done
              isPlatform: !!data.isSuperAdmin,
            },
          });
          merchantCreated = true;
          this.logger.log(
            `✅ Merchant created: ${merchant.id} (requires configuration)`,
          );
        }

        const existingConnector = await tx.merchantProvider.findFirst({
          where: {
            merchantId: merchantIdToUse,
            providerType: ProviderType.PAYTM,
          },
        });

        const prevCreds =
          (existingConnector?.credentials as Record<string, unknown>) || {};
        const connectorConfig = {
          ...prevCreds,
          ...verifyResult,
          upiId: verifyResult.upiId || prevCreds.upiId,
          username:
            (data.username && data.username.trim()) ||
            prevCreds.username ||
            (verifyResult as any).username,
          status: "Active",
          connectedAt: new Date().toISOString(),
          sessionExpired: false,
          lastError: null,
          lastErrorDate: null,
        };

        if (existingConnector) {
          this.logger.log(
            `🔄 Updating existing connector: ${existingConnector.id}`,
          );
          await tx.merchantProvider.update({
            where: { id: existingConnector.id },
            data: {
              accountIdentifier: accountIdentifier,
              credentials: connectorConfig,
              isActive: true,
              status: MerchantProviderStatus.ACTIVE,
            },
          });
          return {
            merchantId: merchant.id,
            providerId: existingConnector.id,
            merchantVerified: !!merchant.verified,
          };
        }

        this.logger.log(`📝 Creating new merchant provider`);
        const createdProvider = await tx.merchantProvider.create({
          data: {
            merchantId: merchantIdToUse,
            providerType: ProviderType.PAYTM,
            accountIdentifier: accountIdentifier,
            credentials: connectorConfig,
            isActive: true,
            status: MerchantProviderStatus.ACTIVE,
          },
        });
        return {
          merchantId: merchant.id,
          providerId: createdProvider.id,
          merchantVerified: !!merchant.verified,
        };
      });

      if (merchantCreated) {
        this.updateSubscriptionUsage(data.organizationId, "CREATE_MERCHANT").catch(
          (e) => this.logger.warn(e),
        );
      }

      this.logger.log(`🎉 Paytm connection complete!`);

      this.logger.log(`🚀 Triggering initial transaction history sync...`);
      this.syncPaytmTransactionsInBackground(txResult.merchantId).catch((err) => {
        this.logger.error(
          `⚠️ Background sync failed (non-blocking):`,
          err.message,
        );
      });

      const responseUpiId = this.isPlausibleUpiVpa(accountIdentifier)
        ? accountIdentifier
        : verifyResult.upiId;

      return {
        success: true,
        message:
          "Paytm connected successfully. Fetching transaction history in background...",
        merchantId: txResult.merchantId,
        requiresConfiguration: !txResult.merchantVerified, // Flag to indicate configuration needed
        upiId: responseUpiId,
        displayName: verifyResult.displayName,
        paytmMerchantId: verifyResult.merchantId,
      };
    } catch (error) {
      this.logger.error("❌ Paytm connection failed:", error);
      throw new BadRequestException(
        "Failed to connect Paytm: " + error.message,
      );
    }
  }

  private async syncPaytmTransactionsInBackground(merchantId: string) {
    try {
      this.logger.log(
        `📊 Starting background transaction sync for merchant: ${merchantId}`,
      );

      const { TransactionService } =
        await import("../transaction/transaction.service");
      const transactionService = new (TransactionService as any)(
        this.prisma,
        this.paytmService,
        this.phonePeService,
      );

      const elevenMonthsAgo = new Date();
      elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);
      const now = new Date();

      this.logger.log(
        `📅 Syncing transactions from ${elevenMonthsAgo.toISOString()} to ${now.toISOString()}`,
      );

      const merchant = await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { organizationId: true }
      });
      if (!merchant) {
        this.logger.error(`❌ Background sync failed: Merchant ${merchantId} not found`);
        return;
      }

      const result = await transactionService.syncAllTransactions(
        merchantId,
        merchant.organizationId,
        elevenMonthsAgo,
        now,
      );

      this.logger.log(
        `✅ Background sync completed: ${result.totalFetched} fetched, ${result.totalSaved} saved`,
      );
    } catch (error) {
      this.logger.error(`❌ Background transaction sync failed:`, error);
    }
  }

  private async checkSubscriptionLimit(organizationId: string, action: string, isSuperAdmin?: boolean) {
    if (isSuperAdmin) {
      this.logger.log(`🛡️ Super Admin bypass for ${action} in organization ${organizationId}`);
      return;
    }
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      const response = await axios.post(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/check-limits`,
        {
          action,
          isSuperAdmin,
        },
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );

      if (response.data && !response.data.allowed) {
        throw new BadRequestException(
          response.data.reason || `Subscription limit reached for ${action}`,
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(
        `Failed to check subscription limits: ${error.message}`,
      );
      if (error.response?.status === 400 || error.response?.status === 403) {
        throw new BadRequestException(
          error.response?.data?.message ||
          "Subscription limit validation failed",
        );
      }
    }
  }

  private async checkProviderLimit(
    organizationId: string,
    providerCode: string,
    isSuperAdmin?: boolean,
  ) {
    if (isSuperAdmin) {
      this.logger.log(`🛡️ Platform/SuperAdmin bypass for provider ${providerCode} in organization ${organizationId}`);
      return;
    }
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      // 1. Check if the merchant type requires an unlock and if the user has it
      const unlockResponse = await axios.get(
        `${subscriptionServiceUrl}/merchant-unlocks/organizations/${organizationId}/check/${providerCode}`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );

      if (!unlockResponse.data.unlocked) {
        throw new BadRequestException(
          unlockResponse.data.reason || `${providerCode} requires a one-time unlock. Please purchase the unlock from the merchant onboarding page.`
        );
      }

      // 2. Check if provider is included in the plan
      const response = await axios.get(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/provider-access/${providerCode}`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );

      if (response.data && response.data.allowed === false) {
        throw new BadRequestException(`Provider ${providerCode} is not available in your current subscription plan`);
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to check provider limits: ${error.message}`);
      // Fail open or closed? Closed is safer for limits.
      if (error.response?.status === 400 || error.response?.status === 403) {
        throw new BadRequestException(
          error.response?.data?.message || "Provider limit validation failed",
        );
      }
    }
  }

  /**
   * Ensures the same PhonePe/Paytm/... account (UPI ID) is not connected to a different active merchant.
   * When updating an existing provider (e.g. manual UPI entry), pass excludeProviderId so we don't
   * treat the current provider as a duplicate.
   * Providers under soft-deleted merchants (deletedAt set) are ignored so the same phone/UPI can reconnect.
   */
  private async checkDuplicateAccount(
    accountIdentifier: string,
    providerType: ProviderType,
    excludeProviderId?: string,
    db: any = this.prisma,
    isSuperAdmin: boolean = false,
  ) {
    if (isSuperAdmin) {
      this.logger.log(`🛡️ Bypassing duplicate account check for SuperAdmin/Platform`);
      return;
    }
    const where: any = {
      providerType,
      accountIdentifier,
      isActive: true,
      status: MerchantProviderStatus.ACTIVE,
      merchant: { deletedAt: null },
    };
    if (excludeProviderId) {
      where.id = { not: excludeProviderId };
    }
    const existing = await db.merchantProvider.findFirst({
      where,
      include: {
        merchant: true,
      },
    });

    if (existing) {
      let orgName = "";
      try {
        const axios = require("axios");
        const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
        if (orgServiceUrl) {
          const response = await axios.get(`${orgServiceUrl}/organizations/${existing.merchant.organizationId}`, {
            headers: { "x-user-type": "SUPER_ADMIN" },
            timeout: 3000
          });
          orgName = response.data?.data?.organization?.name || response.data?.data?.name || "";
        }
      } catch (error) {
        this.logger.warn(`Could not fetch organization name for ID ${existing.merchant.organizationId}: ${error.message}`);
      }

      const orgString = orgName ? ` in organization "${orgName}"` : ` in organization "Unknown"`;
      throw new BadRequestException(
        `This ${providerType} account (${accountIdentifier}) is already connected to merchant "${existing.merchant.name}"${orgString}.`,
      );
    }
  }

  private async updateSubscriptionUsage(
    organizationId: string,
    action: string,
  ) {
    try {
      const axios = require("axios");
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;

      await axios.post(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/update-usage`,
        {
          action,
        },
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
      );
    } catch (error) {
      this.logger.error(
        `Failed to update subscription usage: ${error.message}`,
      );
    }
  }

  private async saveInitialPhonePeTransactions(
    merchantId: string,
    providerId: string,
    transactions: any[],
  ) {
    try {
      this.logger.log(
        `📊 Starting initial transaction save for merchant: ${merchantId}`,
      );

      const { TransactionService } =
        await import("../transaction/transaction.service");
      const transactionService = new (TransactionService as any)(
        this.prisma,
        this.paytmService,
        this.phonePeService,
      );

      const savedCount =
        await transactionService.processAndSavePhonePeTransactions(
          merchantId,
          providerId,
          transactions,
        );

      this.logger.log(
        `✅ Initial transaction save completed: ${savedCount} saved`,
      );
    } catch (error) {
      this.logger.error(`❌ Initial transaction save failed:`, error);
    }
  }
  async getConnectedProviders(merchantId: string) {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          merchantId,
          isActive: true,
        },
        select: {
          id: true,
          providerType: true,
          accountIdentifier: true,
          status: true,
          lastUsedAt: true,
          createdAt: true,
          metadata: true,
        },
      });

      return {
        success: true,
        providers,
        total: providers.length,
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get providers for merchant ${merchantId}:`,
        error,
      );
      throw new BadRequestException("Failed to get connected providers");
    }
  }

  async disconnectProvider(merchantId: string, providerId: string) {
    try {
      await this.prisma.merchantProvider.update({
        where: {
          id: providerId,
          merchantId,
        },
        data: {
          status: MerchantProviderStatus.INACTIVE,
          isActive: false,
        },
      });

      this.logger.log(`✅ Provider disconnected: ${providerId}`);
      return {
        success: true,
        message: "Provider disconnected successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to disconnect provider:`, error);
      throw new BadRequestException("Failed to disconnect provider");
    }
  }

  async getProviderForPayment(
    merchantId: string,
    preferredProvider?: ProviderType,
  ) {
    try {
      const whereClause: any = {
        merchantId,
        isActive: true,
        status: MerchantProviderStatus.ACTIVE,
      };

      if (preferredProvider) {
        whereClause.providerType = preferredProvider;
      }

      const provider = await this.prisma.merchantProvider.findFirst({
        where: whereClause,
        orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
      });

      if (!provider) {
        return {
          success: false,
          message: "No active provider found for this merchant",
        };
      }

      await this.prisma.merchantProvider.update({
        where: { id: provider.id },
        data: { lastUsedAt: new Date() },
      });

      return {
        success: true,
        provider,
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get provider for payment:`, error);
      throw new BadRequestException("Failed to get provider for payment");
    }
  }
  async updateProvider(
    merchantId: string,
    providerId: string,
    data: { accountIdentifier?: string },
  ) {
    try {
      const provider = await this.prisma.merchantProvider.findFirst({
        where: {
          id: providerId,
          merchantId,
        },
      });

      if (!provider) {
        throw new BadRequestException("Provider connection not found");
      }

      if (data.accountIdentifier) {
        // Check for duplicates before updating (exclude this provider so saving same UPI on same connection is allowed)
        await this.checkDuplicateAccount(
          data.accountIdentifier,
          provider.providerType as ProviderType,
          provider.id,
        );

        await this.prisma.merchantProvider.update({
          where: { id: providerId },
          data: {
            accountIdentifier: data.accountIdentifier,
          },
        });
      }

      this.logger.log(`✅ Provider updated manually: ${providerId}`);
      return {
        success: true,
        message: "Provider updated successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update provider:`, error);
      throw new BadRequestException(
        error.message || "Failed to update provider",
      );
    }
  }

  // ==================== BharatPe Methods ====================

  /**
   * Send BharatPe OTP
   */
  async sendBharatPeOtp(
    merchantId: string | null,
    phoneNumber: string,
    organizationId?: string,
    isSuperAdmin?: boolean,
  ) {
    this.logger.log(`📱 Sending BharatPe OTP to ${phoneNumber}`);

    if (!this.validatePhoneNumber(phoneNumber)) {
      throw new BadRequestException("Invalid phone number format");
    }

    try {
      // Check limits
      if (organizationId) {
        await this.checkProviderLimit(organizationId, "bharatpe", isSuperAdmin);
      }
      // Step 1: Get CSRF tokens
      const tokens = await this.bharatPeService.fetchTokensAndCsrf();

      // Step 2: Send OTP
      const result = await this.bharatPeService.sendOtp(phoneNumber, tokens);

      return {
        success: true,
        message: result.message || "OTP sent successfully",
        uuid: result.uuid,
        tokens: tokens, // Return tokens for verify step
      };
    } catch (error: any) {
      this.logger.error(`❌ BharatPe OTP failed:`, error?.message);
      throw new BadRequestException(
        error?.message || "Failed to send BharatPe OTP",
      );
    }
  }

  /**
   * Connect BharatPe account after OTP verification
   */
  async connectBharatPe(
    merchantId: string,
    data: {
      phoneNumber: string;
      otp: string;
      uuid: string;
      tokens: { XSRF_TOKEN: string; bharatpe_session: string; _token: string };
      organizationId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    this.logger.log(`🔗 Connecting BharatPe for ${data.phoneNumber}`);

    if (!data.organizationId) {
      throw new BadRequestException("Organization ID is required");
    }

    try {
      // Step 1: Verify OTP
      const verifyResult = await this.bharatPeService.verifyOtp(
        data.phoneNumber,
        data.otp,
        data.uuid,
        data.tokens,
      );

      // Step 2: Get merchant info
      const merchantInfo = await this.bharatPeService.getMerchantInfo(
        verifyResult.accessToken,
      );
      this.logger.log(
        "🇧🇭 BHARATPE CONNECTION - MERCHANT INFO:",
        JSON.stringify(merchantInfo),
      );

      const reconnectByPhone = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.BHARATPE,
        [],
        (cred) => cred?.phoneNumber === data.phoneNumber,
      );

      // Step 3: Get UPI ID
      let upiId = await this.bharatPeService.getUpiId(
        merchantInfo.merchantId,
        verifyResult.accessToken,
      );
      this.logger.log("🇧🇭 BHARATPE CONNECTION - FETCHED UPI ID:", upiId);

      if (!this.isPlausibleUpiVpa(upiId)) {
        const restored = this.extractReconnectStoredUpi(reconnectByPhone);
        if (restored) {
          upiId = restored;
          this.logger.log(`♻️ Restored BharatPe UPI from prior connection`);
        }
      }

      // Step 4: Check subscription limits
      await this.checkProviderLimit(data.organizationId, "bharatpe", data.isSuperAdmin);

      // Prefer stable UPI VPA as identifier; fall back to phone number
      const accountIdentifier = upiId || data.phoneNumber;

      // Option B: if BharatPe was connected under a soft-deleted merchant, revive and reuse merchantId.
      let reconnectProvider = reconnectByPhone;
      if (!reconnectProvider) {
        reconnectProvider = await this.findReconnectProviderInOrg(
          data.organizationId,
          ProviderType.BHARATPE,
          [accountIdentifier, upiId].filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0,
          ),
          (cred) => cred?.phoneNumber === data.phoneNumber,
        );
      }

      const merchantIdToUse = reconnectProvider?.merchantId || merchantId;

      // Pre-check if we will need to create a new merchant (external call; do it outside transaction)
      const existingMerchantPre = await this.prisma.merchant.findFirst({
        where: { id: merchantIdToUse },
      });
      if (!existingMerchantPre) {
        await this.checkSubscriptionLimit(data.organizationId, "CREATE_MERCHANT", data.isSuperAdmin);
      }

      // Build session cookie for transactions API (required by BharatPe like in PHP flow)
      const cookie =
        data.tokens?.XSRF_TOKEN && data.tokens?.bharatpe_session
          ? `XSRF-TOKEN=${data.tokens.XSRF_TOKEN}; bharatpe_session=${data.tokens.bharatpe_session}`
          : undefined;

      const txResult = await this.prisma.$transaction(async (tx) => {
        await this.checkDuplicateAccount(
          accountIdentifier,
          ProviderType.BHARATPE,
          reconnectProvider?.id,
          tx,
        );

        let merchant = await tx.merchant.findFirst({
          where: { id: merchantIdToUse },
        });
        if (merchant?.deletedAt) {
          merchant = await this.reviveMerchantIfDeleted(merchantIdToUse, tx);
        }

        if (merchant) {
          const currentIsGeneric = this.isGenericMerchantName(merchant.name);
          const newNameIsReal = merchantInfo.name && !this.isGenericMerchantName(merchantInfo.name);

          const dataToUpdate: any = { isPlatform: !!data.isSuperAdmin };

          if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
            this.logger.log(`📝 Syncing BharatPe merchant name: ${merchantInfo.name}`);
            dataToUpdate.name = merchantInfo.name;
            dataToUpdate.businessName = merchantInfo.name;
          } else {
            this.logger.log(`📝 Keeping existing custom BharatPe merchant name: ${merchant.name}`);
          }

          merchant = await tx.merchant.update({
            where: { id: merchant.id },
            data: dataToUpdate,
          });
        } else {
          merchant = await tx.merchant.create({
            data: {
              id: merchantIdToUse,
              name: merchantInfo.name || data.phoneNumber,
              businessName: merchantInfo.name || data.phoneNumber,
              organizationId: data.organizationId,
              status: "PENDING",
              isActive: false,
              isPlatform: !!data.isSuperAdmin,
            },
          });
          this.logger.log(`📝 Created new merchant: ${merchant.id}`);
        }

        const existingProvider = await tx.merchantProvider.findFirst({
          where: { merchantId: merchant.id, providerType: ProviderType.BHARATPE },
        });

        const providerData = {
          merchantId: merchant.id,
          providerType: ProviderType.BHARATPE,
          accountIdentifier, // phone number for stable reconnect
          status: MerchantProviderStatus.ACTIVE,
          isActive: true,
          credentials: {
            merchantId: merchantInfo.merchantId || (merchantInfo as any).mid,
            accessToken: verifyResult.accessToken,
            phoneNumber: data.phoneNumber,
            ...(cookie && { cookie }),
          },
          metadata: {
            upiId: upiId || null,
            merchantName: merchantInfo.name,
          },
        };

        const provider = existingProvider
          ? await tx.merchantProvider.update({
            where: { id: existingProvider.id },
            data: providerData,
          })
          : await tx.merchantProvider.create({ data: providerData });

        return {
          merchantId: merchant.id,
          providerId: provider.id,
          merchantName: merchant.name,
        };
      });

      this.logger.log(
        `✅ BharatPe connected successfully: ${txResult.providerId}`,
      );

      // Reconnect backfill: sync from lastSyncedAt - buffer (or last 7d) to cover gap during disconnect
      this.triggerReconnectBackfill(txResult.merchantId, reconnectProvider ?? null);

      return {
        success: true,
        message: "BharatPe connected successfully",
        merchantId: txResult.merchantId,
        providerId: txResult.providerId,
        upiId: upiId,
        bharatPeMerchantId: merchantInfo.merchantId,
      };
    } catch (error: any) {
      this.logger.error(`❌ BharatPe connection failed:`, error?.message);
      throw new BadRequestException(
        error?.message || "Failed to connect BharatPe",
      );
    }
  }

  // ==================== QuintusPay Methods ====================

  /**
   * Send QuintusPay OTP
   */
  async sendQuintusOtp(
    merchantId: string | null,
    phoneNumber: string,
    organizationId?: string,
    isSuperAdmin?: boolean,
  ) {
    this.logger.log(`📱 Sending QuintusPay OTP to ${phoneNumber}`);

    if (!this.validatePhoneNumber(phoneNumber)) {
      throw new BadRequestException("Invalid phone number format");
    }

    try {
      if (organizationId) {
        await this.checkProviderLimit(organizationId, "quintus", isSuperAdmin);
      }
      
      const result = await this.quintusPayService.sendOtp(phoneNumber);

      return {
        success: true,
        message: result.message || "OTP sent successfully",
      };
    } catch (error: any) {
      this.logger.error(`❌ QuintusPay OTP failed:`, error?.message);
      throw new BadRequestException(
        error?.message || "Failed to send QuintusPay OTP",
      );
    }
  }

  /**
   * Connect QuintusPay account after OTP verification
   */
  async connectQuintus(
    merchantId: string,
    data: {
      phoneNumber: string;
      otp: string;
      organizationId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    this.logger.log(`🔗 Connecting QuintusPay for ${data.phoneNumber}`);

    if (!data.organizationId) {
      throw new BadRequestException("Organization ID is required");
    }

    try {
      const verifyResult = await this.quintusPayService.verifyOtp(
        data.phoneNumber,
        data.otp,
      );

      const upiId = await this.quintusPayService.getUpiId(
        verifyResult.accessToken,
      );

      await this.checkProviderLimit(data.organizationId, "quintus", data.isSuperAdmin);

      const accountIdentifier = upiId || data.phoneNumber;
      
      const reconnectByPhone = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.QUINTUS,
        [],
        (cred) => cred?.phoneNumber === data.phoneNumber,
      );

      let reconnectProvider = reconnectByPhone;
      if (!reconnectProvider) {
        reconnectProvider = await this.findReconnectProviderInOrg(
          data.organizationId,
          ProviderType.QUINTUS,
          [accountIdentifier, upiId].filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0,
          ),
          (cred) => cred?.phoneNumber === data.phoneNumber,
        );
      }

      const merchantIdToUse = reconnectProvider?.merchantId || merchantId;

      const existingMerchantPre = await this.prisma.merchant.findFirst({
        where: { id: merchantIdToUse },
      });
      
      if (!existingMerchantPre) {
        await this.checkSubscriptionLimit(data.organizationId, "CREATE_MERCHANT", data.isSuperAdmin);
      }

      const user = verifyResult.user || {};
      const docDetails = user.document_details || {};
      
      const actualBusinessName = docDetails.businessName || docDetails.settlementAccountName;
      const merchantName = actualBusinessName || user.merchant_name || user.email || data.phoneNumber;
      
      const email = docDetails.emailId || user.email;
      const phone = docDetails.mobileNumber || user.mobile || data.phoneNumber;
      const address = [docDetails.Address_Line_1, docDetails.Address_Line_2].filter(Boolean).join(", ");
      const city = docDetails.city;
      const state = docDetails.stateCode;
      const pincode = docDetails.pincode;
      const gstin = docDetails.gstNumber;
      const pan = docDetails.pan;

      const txResult = await this.prisma.$transaction(async (tx) => {
        await this.checkDuplicateAccount(
          accountIdentifier,
          ProviderType.QUINTUS,
          reconnectProvider?.id,
          tx,
        );

        let merchant = await tx.merchant.findFirst({
          where: { id: merchantIdToUse },
        });
        
        if (merchant?.deletedAt) {
          merchant = await this.reviveMerchantIfDeleted(merchantIdToUse, tx);
        }

        const dataToUpdate: any = { isPlatform: !!data.isSuperAdmin };
        
        if (email) dataToUpdate.email = email;
        if (phone) dataToUpdate.phone = phone;
        if (address) dataToUpdate.address = address;
        if (city) dataToUpdate.city = city;
        if (state) dataToUpdate.state = state;
        if (pincode) dataToUpdate.pincode = pincode;
        if (gstin) dataToUpdate.gstin = gstin;
        if (pan) dataToUpdate.pan = pan;

        if (merchant) {
          const currentIsGeneric = this.isGenericMerchantName(merchant.name) || merchant.name.includes('@');
          const newNameIsReal = merchantName && !this.isGenericMerchantName(merchantName) && !merchantName.includes('@');

          if (newNameIsReal && (currentIsGeneric || !merchant.name)) {
            dataToUpdate.name = merchantName;
            dataToUpdate.businessName = actualBusinessName || merchantName;
          }

          merchant = await tx.merchant.update({
            where: { id: merchant.id },
            data: dataToUpdate,
          });
        } else {
          merchant = await tx.merchant.create({
            data: {
              id: merchantIdToUse,
              name: merchantName,
              businessName: actualBusinessName || merchantName,
              organizationId: data.organizationId,
              status: "PENDING",
              isActive: false,
              isPlatform: !!data.isSuperAdmin,
              ...dataToUpdate
            },
          });
        }

        const existingProvider = await tx.merchantProvider.findFirst({
          where: { merchantId: merchant.id, providerType: ProviderType.QUINTUS },
        });

        const providerData = {
          merchantId: merchant.id,
          providerType: ProviderType.QUINTUS,
          accountIdentifier,
          status: MerchantProviderStatus.ACTIVE,
          isActive: true,
          credentials: {
            accessToken: verifyResult.accessToken,
            refreshToken: verifyResult.refreshToken,
            phoneNumber: data.phoneNumber,
            quintusUserId: user._id
          },
          metadata: {
            upiId: upiId || null,
            merchantName: merchantName,
          },
        };

        const provider = existingProvider
          ? await tx.merchantProvider.update({
            where: { id: existingProvider.id },
            data: providerData,
          })
          : await tx.merchantProvider.create({ data: providerData });

        return {
          merchantId: merchant.id,
          providerId: provider.id,
          merchantName: merchant.name,
        };
      });

      this.logger.log(
        `✅ QuintusPay connected successfully: ${txResult.providerId}`,
      );

      this.triggerReconnectBackfill(txResult.merchantId, reconnectProvider ?? null);

      return {
        success: true,
        message: "QuintusPay connected successfully",
        merchantId: txResult.merchantId,
        providerId: txResult.providerId,
        upiId: upiId,
      };
    } catch (error: any) {
      this.logger.error(`❌ QuintusPay connection failed:`, error?.message);
      throw new BadRequestException(
        error?.message || "Failed to connect QuintusPay",
      );
    }
  }

  async sendHdfcOtp(
    merchantId: string | null,
    phoneNumber: string,
    organizationId?: string,
    isSuperAdmin: boolean = false,
  ) {
    this.logger.log(`📱 Sending HDFC OTP for: ${phoneNumber}`);

    if (!this.validatePhoneNumber(phoneNumber)) {
      throw new BadRequestException("Invalid mobile number format");
    }

    try {
      const result = await this.hdfcVyaparService.sendOtp(phoneNumber);

      return {
        success: true,
        message: "OTP sent successfully via HDFC Vyapar",
        sessionId: result.data.sessionId,
        deviceId: result.data.deviceId,
      };
    } catch (error: any) {
      this.logger.error("❌ HDFC OTP send failed:", error);
      throw new BadRequestException(
        error.message || "Failed to send HDFC OTP",
      );
    }
  }

  async connectHdfc(
    merchantId: string,
    data: {
      phoneNumber: string;
      otp: string;
      mPin?: string;
      sessionId: string;
      deviceId: string;
      organizationId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    this.logger.log(`🔗 Connecting HDFC Vyapar for ${data.phoneNumber}`);

    if (!data.organizationId) {
      throw new BadRequestException("Organization ID is required");
    }

    try {
      // Check limits
      await this.checkProviderLimit(data.organizationId, "hdfc", data.isSuperAdmin);

      // Verify OTP
      const verifyResult = await this.hdfcVyaparService.verifyOtp(
        data.phoneNumber,
        data.otp,
        data.sessionId,
        data.deviceId,
        data.mPin,
      );

      if (!verifyResult || !verifyResult.success) {
        throw new BadRequestException("Invalid OTP or verification failed");
      }
      
      const sessionData = {
          sessionId: verifyResult.sessionId,
          deviceId: verifyResult.deviceId,
          mobileNumber: data.phoneNumber,
          ...(data.mPin ? { mPin: data.mPin } : {}),
      };

      const upiId = verifyResult.upiId || data.phoneNumber; // Uses extracted VPA or fallback
      const accountIdentifier = upiId;

      let reconnectProvider = await this.findReconnectProviderInOrg(
        data.organizationId,
        ProviderType.HDFC,
        [accountIdentifier],
      );

      const txResult = await this.prisma.$transaction(
        async (tx) => {
          let merchant = await tx.merchant.findUnique({
            where: { id: merchantId },
          });

          const merchantData = (verifyResult as any).merchantData;
          let dataToUpdate: any = {};
          let merchantName = `HDFC Merchant ${data.phoneNumber.slice(-4)}`;

          if (merchantData) {
            const actualBusinessName = merchantData.companyName || merchantData.dba || merchantData.merchantName || merchantData.merchantProfile?.legalName;
            if (actualBusinessName && !this.isGenericMerchantName(actualBusinessName)) {
                merchantName = actualBusinessName;
                dataToUpdate.businessName = actualBusinessName;
                // Only override name if current is generic or doesn't exist
                if (!merchant || this.isGenericMerchantName(merchant.name)) {
                    dataToUpdate.name = actualBusinessName;
                }
            }
            if (merchantData.address) dataToUpdate.address = merchantData.address;
            if (merchantData.city) dataToUpdate.city = merchantData.city;
            if (merchantData.pinCode || merchantData.pincode) dataToUpdate.pincode = merchantData.pinCode || merchantData.pincode;
            if (merchantData.state) dataToUpdate.state = merchantData.state;
          }

          if (!merchant) {
            merchant = await tx.merchant.create({
              data: {
                id: merchantId,
                name: merchantName,
                organizationId: data.organizationId,
                phone: data.phoneNumber,
                isActive: true,
                ...dataToUpdate
              },
            });
          } else if (Object.keys(dataToUpdate).length > 0) {
            merchant = await tx.merchant.update({
               where: { id: merchantId },
               data: dataToUpdate
            });
          }

          const existingProvider = await tx.merchantProvider.findFirst({
            where: { merchantId: merchant.id, providerType: ProviderType.HDFC },
          });

          if (existingProvider && existingProvider.status === "ACTIVE") {
            throw new ConflictException(
              "HDFC SmartHub Vyapar account is already connected",
            );
          }

          const merchantProvider = await tx.merchantProvider.upsert({
            where: {
              merchantId_providerType: {
                merchantId: merchant.id,
                providerType: ProviderType.HDFC,
              },
            },
            create: {
              merchant: { connect: { id: merchant.id } },
              providerType: ProviderType.HDFC,
              accountIdentifier,
              credentials: sessionData,
              status: "ACTIVE",
            },
            update: {
              status: "ACTIVE",
              credentials: sessionData,
            },
          });

          return { merchantId: merchant.id, providerId: merchantProvider.id };
        },
        { maxWait: 15000, timeout: 30000 },
      );

      this.logger.log(`✅ HDFC Vyapar connected successfully: ${txResult.providerId}`);

      this.triggerReconnectBackfill(txResult.merchantId, reconnectProvider ?? null);

      return {
        success: true,
        message: "HDFC SmartHub Vyapar connected successfully",
        merchantId: txResult.merchantId,
        providerId: txResult.providerId,
        upiId: upiId,
      };
    } catch (error: any) {
      this.logger.error(`❌ HDFC connection failed:`, error?.message);
      throw new BadRequestException(
        error?.message || "Failed to connect HDFC Vyapar",
      );
    }
  }
}

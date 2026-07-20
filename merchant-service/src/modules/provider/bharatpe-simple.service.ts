import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Cron } from "@nestjs/schedule";
import { MerchantProviderStatus, ProviderType } from "@prisma/client";
import axios from "axios";

@Injectable()
export class BharatPeSimpleService {
  private readonly logger = new Logger(BharatPeSimpleService.name);

  private readonly enterpriseUrl = "https://enterprise.bharatpe.in";
  private readonly merchantApiUrl = "https://api-merchant.bharatpe.in";
  private readonly paymentsUrl = "https://payments-tesseract.bharatpe.in";

  constructor(private readonly prisma: PrismaService) {}

  @Cron("0 */15 * * * *", { name: "bharatpe-keepalive-inactive-merchants" })
  async keepaliveBharatPeSessions() {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.BHARATPE,
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

      this.logger.log(`💓 BharatPe Keepalive: Warming ${providers.length} active BharatPe provider(s) to prevent idle expiration...`);

      const now = new Date();
      // Fetch just a 1-minute window to keep it lightweight
      const fromDate = new Date(now.getTime() - 60000);

      for (const p of providers) {
        try {
          const creds: any = p.credentials || {};
          if (creds.accessToken && creds.merchantId) {
            await this.fetchTransactionHistory(creds.merchantId, creds.accessToken, creds.cookie, fromDate, now);
          }
        } catch (error: any) {
          this.logger.warn(`⚠️ BharatPe Keepalive failed for ${p.id}: ${error?.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`❌ BharatPe Keepalive cron failed: ${error?.message}`);
    }
  }

  async fetchTokensAndCsrf(): Promise<{
    XSRF_TOKEN: string;
    bharatpe_session: string;
    _token: string;
  }> {
    this.logger.log("🔐 Fetching BharatPe CSRF tokens...");

    try {
      const response = await axios.get(`${this.enterpriseUrl}/`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        },
        maxRedirects: 5,
      });

      const html = response.data as string;
      const cookies = response.headers["set-cookie"] || [];

      const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/);
      const _token = tokenMatch ? tokenMatch[1] : "";

      let XSRF_TOKEN = "";
      let bharatpe_session = "";

      for (const cookie of cookies) {
        const xsrfMatch = cookie.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrfMatch) {
          XSRF_TOKEN = xsrfMatch[1];
        }
        const sessionMatch = cookie.match(/bharatpe_session=([^;]+)/);
        if (sessionMatch) {
          bharatpe_session = sessionMatch[1];
        }
      }

      if (!XSRF_TOKEN || !bharatpe_session || !_token) {
        this.logger.error("Failed to extract all required tokens");
        this.logger.debug(`XSRF_TOKEN: ${XSRF_TOKEN ? "found" : "missing"}`);
        this.logger.debug(
          `bharatpe_session: ${bharatpe_session ? "found" : "missing"}`,
        );
        this.logger.debug(`_token: ${_token ? "found" : "missing"}`);
        throw new BadRequestException("Failed to fetch BharatPe CSRF tokens");
      }

      this.logger.log("✅ BharatPe CSRF tokens fetched successfully");
      this.logger.debug(`XSRF_TOKEN: ${XSRF_TOKEN.substring(0, 20)}...`);

      return { XSRF_TOKEN, bharatpe_session, _token };
    } catch (error: any) {
      this.logger.error("Failed to fetch BharatPe tokens:", error?.message);
      throw new BadRequestException(
        "Failed to connect to BharatPe. Please try again.",
      );
    }
  }

  async sendOtp(
    phoneNumber: string,
    tokens: { XSRF_TOKEN: string; bharatpe_session: string; _token: string },
  ): Promise<{ success: boolean; uuid: string; message: string }> {
    this.logger.log(`📱 Sending BharatPe OTP to ${phoneNumber}`);

    const url = `${this.enterpriseUrl}/v1/api/user/requestotp`;

    const postData = new URLSearchParams({
      mobile: phoneNumber,
      _token: tokens._token,
    }).toString();

    try {
      const response = await axios.post(url, postData, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Origin: this.enterpriseUrl,
          Referer: `${this.enterpriseUrl}/`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Cookie: `XSRF-TOKEN=${tokens.XSRF_TOKEN}; bharatpe_session=${tokens.bharatpe_session}`,
        },
      });

      this.logger.debug(
        `BharatPe sendOtp response: ${JSON.stringify(response.data)}`,
      );

      if (response.data?.success === false) {
        throw new BadRequestException(
          response.data?.message || "Failed to send OTP",
        );
      }

      const uuid = response.data?.data?.uuid || response.data?.uuid || "";

      if (!uuid) {
        this.logger.warn("No UUID in response, OTP might still have been sent");
      }

      this.logger.log(`✅ BharatPe OTP sent successfully to ${phoneNumber}`);

      return {
        success: true,
        uuid: uuid,
        message: response.data?.message || "OTP sent successfully",
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error("BharatPe sendOtp failed:", {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `BharatPe: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "Failed to send BharatPe OTP. Please try again.",
      );
    }
  }

  async verifyOtp(
    phoneNumber: string,
    otp: string,
    uuid: string,
    tokens: { XSRF_TOKEN: string; bharatpe_session: string; _token: string },
  ): Promise<{
    success: boolean;
    accessToken: string;
    merchantId?: string;
    message: string;
  }> {
    this.logger.log(`🔐 Verifying BharatPe OTP for ${phoneNumber}`);

    const url = `${this.enterpriseUrl}/v1/api/user/verifyotp`;

    const postData = new URLSearchParams({
      mobile: phoneNumber,
      uuid: uuid,
      otp: otp,
      _token: tokens._token,
    }).toString();

    try {
      const response = await axios.post(url, postData, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Origin: this.enterpriseUrl,
          Referer: `${this.enterpriseUrl}/`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Cookie: `XSRF-TOKEN=${tokens.XSRF_TOKEN}; bharatpe_session=${tokens.bharatpe_session}`,
        },
      });

      this.logger.debug(
        `BharatPe verifyOtp response: ${JSON.stringify(response.data)}`,
      );

      if (response.data?.success === false) {
        throw new BadRequestException(
          response.data?.message || "OTP verification failed",
        );
      }

      const accessToken = response.data?.data?.accessToken || "";

      if (!accessToken) {
        throw new BadRequestException(
          "Failed to get access token from BharatPe",
        );
      }

      this.logger.log(
        `✅ BharatPe OTP verified successfully for ${phoneNumber}`,
      );

      return {
        success: true,
        accessToken: accessToken,
        message: "OTP verified successfully",
      };
    } catch (error: any) {
      this.logger.error("BharatPe verifyOtp failed:", {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `BharatPe Error: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "BharatPe OTP verification failed. Please try again.",
      );
    }
  }

  async getMerchantInfo(accessToken: string): Promise<{
    merchantId: string;
    name: string;
    phone: string;
  }> {
    this.logger.log("📋 Fetching BharatPe merchant info...");

    const url = `${this.merchantApiUrl}/merchant/v3/getmerchantinfo`;

    try {
      const response = await axios.get(url, {
        headers: {
          Accept: "application/json, text/javascript, */*; q=0.01",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
          token: accessToken,
          Origin: this.enterpriseUrl,
          Referer: `${this.enterpriseUrl}/`,
        },
      });

      this.logger.debug(
        `BharatPe getMerchantInfo response: ${JSON.stringify(response.data)}`,
      );

      if (!response.data?.data?.merchantId) {
        throw new BadRequestException(
          "Failed to get merchant info from BharatPe",
        );
      }

      const merchantData = response.data.data;

      this.logger.log(
        `✅ BharatPe merchant info fetched: ${merchantData.merchantId}`,
      );

      return {
        merchantId: merchantData.merchantId,
        name: merchantData.merchantName || merchantData.businessName,
        phone: merchantData.phone || merchantData.mobile || "",
      };
    } catch (error: any) {
      this.logger.error("BharatPe getMerchantInfo failed:", error?.message);
      throw new BadRequestException("Failed to get BharatPe merchant info");
    }
  }

  async getUpiId(merchantId: string, accessToken: string): Promise<string> {
    this.logger.log(
      `🔍 Fetching BharatPe UPI ID for merchant ${merchantId}...`,
    );

    const url = `${this.paymentsUrl}/api/merchant/v1/downloadQr?merchantId=${merchantId}`;

    try {
      const response = await axios.get(url, {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36",
          Token: accessToken,
        },
      });

      this.logger.debug(
        `BharatPe downloadQr response: ${JSON.stringify(response.data)}`,
      );

      if (!response.data?.status || !response.data?.data?.url) {
        this.logger.warn("No QR URL in response");
        return "";
      }

      const qrUrl = response.data.data.url;

      // Decode QR URL to extract UPI ID using ZXing API
      const zxingUrl = `https://zxing.org/w/decode?u=${encodeURIComponent(qrUrl)}`;

      const zxingResponse = await axios.get(zxingUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      const zxingHtml = zxingResponse.data as string;
      const upiMatch = zxingHtml.match(/upi:\/\/pay\?pa=([^&]+)/);

      if (upiMatch) {
        const upiId = decodeURIComponent(upiMatch[1]);
        this.logger.log(`✅ BharatPe UPI ID found: ${upiId}`);
        return upiId;
      }

      this.logger.warn(`Could not extract UPI ID from QR for merchant ${merchantId}, using fallback pattern`);
      return `BHARATPE.${merchantId}@fbpe`;
    } catch (error: any) {
      this.logger.error(`BharatPe getUpiId failed for merchant ${merchantId}: ${error?.message}, using fallback pattern`);
      return `BHARATPE.${merchantId}@fbpe`;
    }
  }

  async fetchTransactionHistory(
    merchantId: string,
    accessToken: string,
    cookie?: string,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<any> {
    this.logger.log(
      `📊 Fetching BharatPe transactions for merchant ${merchantId}...`,
    );

    const from = fromDate
      ? fromDate.toISOString().split("T")[0]
      : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
    const to = toDate
      ? toDate.toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    const headers: Record<string, string> = {
      token: accessToken,
      Token: accessToken, // Some BharatPe endpoints appear picky in practice
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
    };
    if (cookie) {
      headers["Cookie"] = cookie;
    }

    try {
      const url = `${this.paymentsUrl}/api/v1/merchant/transactions?module=PAYMENT_QR&merchantId=${merchantId}&sDate=${from}&eDate=${to}`;
      this.logger.debug(
        `BharatPe transactions request: module=PAYMENT_QR, merchantId=${merchantId}, sDate=${from}, eDate=${to}`,
      );
      const response = await axios.get(url, {
        headers,
        timeout: 120000,
      });
      const data = response.data;
      this.logger.debug(
        `BharatPe transactions response (PAYMENT_QR): ${JSON.stringify(data)}`,
      );

      let transactions: any[] = [];
      if (data?.status === true && data?.message === "SUCCESS") {
        transactions = data?.data?.transactions || [];
      }

      if (data?.status === true && data?.message === "SUCCESS") {
        if (transactions.length > 0) {
          this.logger.log(
            `✅ Found ${transactions.length} BharatPe transactions`,
          );
        } else {
          this.logger.debug("✅ BharatPe responded with 0 transactions");
        }
        return {
          success: true,
          data: {
            results: transactions,
            totalResults: transactions.length,
          },
        };
      }

      this.logger.warn("BharatPe transactions API returned non-success");
      return {
        success: false,
        data: null,
        error: data?.message || "Failed to fetch transactions",
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const respData = error?.response?.data;
      const url = error?.config?.url;

      this.logger.error("BharatPe fetchTransactionHistory failed:", {
        message: error?.message,
        status,
        url,
        response: respData,
      });

      // If token is invalid / expired, signal authError so callers can stop sync and mark provider
      if (status === 401) {
        return {
          success: false,
          authError: true,
          data: null,
          error: "BHARATPE_AUTH_EXPIRED",
        };
      }

      return {
        success: false,
        data: null,
        error:
          respData?.message ||
          respData?.error ||
          error?.message ||
          "BharatPe transactions request failed",
      };
    }
  }

  async initiateConnection(phoneNumber: string): Promise<{
    success: boolean;
    uuid: string;
    tokens: { XSRF_TOKEN: string; bharatpe_session: string; _token: string };
    message: string;
  }> {
    this.logger.log(`🚀 Initiating BharatPe connection for ${phoneNumber}`);

    const tokens = await this.fetchTokensAndCsrf();

    const otpResult = await this.sendOtp(phoneNumber, tokens);

    return {
      success: true,
      uuid: otpResult.uuid,
      tokens: tokens,
      message: otpResult.message,
    };
  }

  async completeConnection(
    phoneNumber: string,
    otp: string,
    uuid: string,
    tokens: { XSRF_TOKEN: string; bharatpe_session: string; _token: string },
  ): Promise<{
    success: boolean;
    merchantId: string;
    merchantName: string;
    upiId: string;
    accessToken: string;
  }> {
    this.logger.log(`✅ Completing BharatPe connection for ${phoneNumber}`);

    const verifyResult = await this.verifyOtp(phoneNumber, otp, uuid, tokens);

    const merchantInfo = await this.getMerchantInfo(verifyResult.accessToken);

    const upiId = await this.getUpiId(
      merchantInfo.merchantId,
      verifyResult.accessToken,
    );

    return {
      success: true,
      merchantId: merchantInfo.merchantId,
      merchantName: merchantInfo.name,
      upiId: upiId,
      accessToken: verifyResult.accessToken,
    };
  }
}

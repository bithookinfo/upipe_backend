import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Cron } from "@nestjs/schedule";
import { MerchantProviderStatus, ProviderType } from "@prisma/client";
import axios from "axios";

@Injectable()
export class QuintusPaySimpleService {
  private readonly logger = new Logger(QuintusPaySimpleService.name);

  private readonly apiUrl = "https://bapa-api.quintustech.in";

  constructor(private readonly prisma: PrismaService) {}

  @Cron("0 */15 * * * *", { name: "quintuspay-keepalive-inactive-merchants" })
  async keepaliveQuintusPaySessions() {
    try {
      const providers = await this.prisma.merchantProvider.findMany({
        where: {
          providerType: ProviderType.QUINTUS,
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

      this.logger.log(`💓 QuintusPay Keepalive: Warming ${providers.length} active QuintusPay provider(s) to prevent idle expiration...`);

      const now = new Date();
      // Fetch just a 1-minute window to keep it lightweight
      const fromDate = new Date(now.getTime() - 60000);

      for (const p of providers) {
        try {
          const creds: any = p.credentials || {};
          if (creds.accessToken) {
            await this.fetchTransactionHistory(creds.accessToken, fromDate, now);
          }
        } catch (error: any) {
          this.logger.warn(`⚠️ QuintusPay Keepalive failed for ${p.id}: ${error?.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`❌ QuintusPay Keepalive cron failed: ${error?.message}`);
    }
  }

  async sendOtp(phoneNumber: string): Promise<{ success: boolean; message: string }> {
    this.logger.log(`📱 Sending QuintusPay OTP to ${phoneNumber}`);

    const url = `${this.apiUrl}/api/qt/user/sendOtp`;

    const postData = {
      authid: phoneNumber,
    };

    try {
      const response = await axios.post(url, postData, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Origin": this.apiUrl,
          "Referer": `${this.apiUrl}/`,
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
        },
      });

      this.logger.debug(
        `QuintusPay sendOtp response: ${JSON.stringify(response.data)}`,
      );

      if (response.data?.success === false) {
        throw new BadRequestException(
          response.data?.message || "Failed to send OTP",
        );
      }

      this.logger.log(`✅ QuintusPay OTP sent successfully to ${phoneNumber}`);

      return {
        success: true,
        message: response.data?.message || "OTP sent successfully",
      };
    } catch (error: any) {
      this.logger.error("QuintusPay sendOtp failed:", {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `QuintusPay: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "Failed to send QuintusPay OTP. Please try again.",
      );
    }
  }

  async verifyOtp(
    phoneNumber: string,
    otp: string,
  ): Promise<{
    success: boolean;
    accessToken: string;
    refreshToken: string;
    user: any;
    message: string;
  }> {
    this.logger.log(`🔐 Verifying QuintusPay OTP for ${phoneNumber}`);

    const url = `${this.apiUrl}/api/qt/user/verifyOtp`;

    const postData = {
      authid: phoneNumber,
      otp: otp,
    };

    try {
      const response = await axios.post(url, postData, {
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "Origin": this.apiUrl,
          "Referer": `${this.apiUrl}/`,
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
        },
      });

      this.logger.debug(
        `QuintusPay verifyOtp response: ${JSON.stringify(response.data)}`,
      );

      if (response.data?.success === false) {
        throw new BadRequestException(
          response.data?.message || "OTP verification failed",
        );
      }

      const accessToken = response.data?.accessToken || "";
      const refreshToken = response.data?.refreshToken || "";
      const user = response.data?.user || {};

      if (!accessToken) {
        throw new BadRequestException(
          "Failed to get access token from QuintusPay",
        );
      }

      this.logger.log(
        `✅ QuintusPay OTP verified successfully for ${phoneNumber}`,
      );

      return {
        success: true,
        accessToken,
        refreshToken,
        user,
        message: "OTP verified successfully",
      };
    } catch (error: any) {
      this.logger.error("QuintusPay verifyOtp failed:", {
        status: error?.response?.status,
        data: error?.response?.data,
        message: error?.message,
      });

      if (error?.response?.data?.message) {
        throw new BadRequestException(
          `QuintusPay Error: ${error.response.data.message}`,
        );
      }

      throw new BadRequestException(
        "QuintusPay OTP verification failed. Please try again.",
      );
    }
  }

  async getUpiId(accessToken: string): Promise<string> {
    this.logger.log(`🔍 Fetching QuintusPay UPI ID...`);

    const url = `${this.apiUrl}/api/qt/user/fetchQr`;

    try {
      const response = await axios.get(url, {
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "Origin": this.apiUrl,
          "Referer": `${this.apiUrl}/`,
          "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
        },
      });

      this.logger.debug(
        `QuintusPay fetchQr response: ${JSON.stringify(response.data)}`,
      );

      if (!response.data?.data?.vpa) {
        this.logger.warn("No VPA in response");
        return "";
      }

      const vpa = response.data.data.vpa;
      this.logger.log(`✅ QuintusPay UPI ID found: ${vpa}`);
      return vpa;
    } catch (error: any) {
      this.logger.error(`QuintusPay getUpiId failed: ${error?.message}`);
      return "";
    }
  }

  async fetchTransactionHistory(
    accessToken: string,
    fromDate?: Date,
    toDate?: Date,
  ): Promise<any> {
    this.logger.log(
      `📊 Fetching QuintusPay transactions...`,
    );

    const from = fromDate
      ? fromDate.toISOString().split("T")[0]
      : new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
    const to = toDate
      ? toDate.toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0];

    try {
      const url = `${this.apiUrl}/api/qt/transaction/getList`;
      
      const requests = [
        axios.post(url, {
          startDate: from,
          endDate: to,
          transactionType: ["SELLER_SETTLEMENT"],
          selectedStatus: []
        }, {
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
            "Origin": this.apiUrl,
            "Referer": `${this.apiUrl}/`,
            "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
          }
        }),
        axios.post(url, {
          startDate: from,
          endDate: to,
          transactionType: ["UPI_RESOLUTION"],
          selectedStatus: []
        }, {
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
            "Origin": this.apiUrl,
            "Referer": `${this.apiUrl}/`,
            "User-Agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36",
          }
        })
      ];

      const responses = await Promise.allSettled(requests);
      
      let allTransactions: any[] = [];
      let anySuccess = false;
      let lastError = null;

      for (const result of responses) {
        if (result.status === "fulfilled") {
          const data = result.value.data;
          if (data?.success === true && data?.data) {
            anySuccess = true;
            if (Array.isArray(data.data)) {
              allTransactions = [...allTransactions, ...data.data];
            }
          }
        } else {
          lastError = result.reason;
        }
      }

      if (anySuccess) {
        this.logger.log(
          `✅ Found ${allTransactions.length} QuintusPay transactions`,
        );
        return {
          success: true,
          data: {
            results: allTransactions,
            totalResults: allTransactions.length,
          },
        };
      }

      if (lastError) {
        throw lastError;
      }

      this.logger.warn("QuintusPay transactions API returned non-success for all queries");
      return {
        success: false,
        data: null,
        error: "Failed to fetch transactions",
      };
    } catch (error: any) {
      const status = error?.response?.status;
      const respData = error?.response?.data;
      
      this.logger.error("QuintusPay fetchTransactionHistory failed:", {
        message: error?.message,
        status,
        response: respData,
      });

      if (status === 401 || status === 403) {
        return {
          success: false,
          authError: true,
          data: null,
          error: "QUINTUSPAY_AUTH_EXPIRED",
        };
      }

      return {
        success: false,
        data: null,
        error:
          respData?.message ||
          error?.message ||
          "QuintusPay transactions request failed",
      };
    }
  }

  async initiateConnection(phoneNumber: string): Promise<{
    success: boolean;
    message: string;
  }> {
    this.logger.log(`🚀 Initiating QuintusPay connection for ${phoneNumber}`);
    return await this.sendOtp(phoneNumber);
  }

  async completeConnection(
    phoneNumber: string,
    otp: string,
  ): Promise<{
    success: boolean;
    merchantId: string;
    merchantName: string;
    upiId: string;
    accessToken: string;
    refreshToken: string;
    user: any;
  }> {
    this.logger.log(`✅ Completing QuintusPay connection for ${phoneNumber}`);

    const verifyResult = await this.verifyOtp(phoneNumber, otp);
    const upiId = await this.getUpiId(verifyResult.accessToken);
    
    // QuintusPay user object contains merchant details
    const user = verifyResult.user;
    
    return {
      success: true,
      merchantId: user._id || phoneNumber, // Fallback to phone number if ID not present
      merchantName: user.merchant_name || user.email || phoneNumber,
      upiId: upiId,
      accessToken: verifyResult.accessToken,
      refreshToken: verifyResult.refreshToken,
      user: user
    };
  }
}

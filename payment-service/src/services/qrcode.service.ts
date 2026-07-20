import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma.service";
import { PaymentLinkService } from "./payment-link.service";
import * as QRCode from "qrcode";
import axios from "axios";

@Injectable()
export class QrcodeService {
  private readonly logger = new Logger(QrcodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private paymentLinkService: PaymentLinkService,
  ) { }

  private generateUpiDeepLinks(
    merchantVPA: string,
    amount: string,
    txnRef: string,
    merchantName: string,
    note: string,
  ) {
    const sanitizedNote = note.replace(/[^a-zA-Z0-9 ]/g, "");

    // BharatPe P2PM merchants: their PSP validates incoming `tr` against
    // BharatPe-generated references (e.g. "8n0m1e1z7e56666...").  Our
    // custom order ID as `tr` causes "declined by receiver's bank".
    // Omit tr/mc/mode so the payment flows as a simple P2P transfer,
    // which is how the 93+ successful direct payments work.
    const isBharatPe = /@fbpe/i.test(merchantVPA) || /bharatpe/i.test(merchantVPA);

    const params: Record<string, string> = {
      pa: merchantVPA,
      pn: merchantName,
      am: amount,
      cu: "INR",
      tn: sanitizedNote || `Pay To ${merchantName}`,
    };

    if (!isBharatPe) {
      params.tr = txnRef;
      params.mc = "5411";
      params.mode = "00";
    }

    const upiParams = new URLSearchParams(params);

    const baseUpi = `upi://pay?${upiParams.toString()}`;

    const isMerchantVpa = /^Q\d+@/i.test(merchantVPA) || isBharatPe;

    let phonePeIntent = '';
    if (merchantVPA) {
      const phonepePayload = {
        contact: {
          cbsName: merchantName, //merchant name showing in the phonepe
          nickName: merchantName,
          vpa: merchantVPA,
          type: "VPA",
        },
        p2pPaymentCheckoutParams: {
          note: txnRef.replace(/[^a-zA-Z0-9]/g, ""), //transaction reference
          isByDefaultKnownContact: true,
          enableSpeechToText: false,
          allowAmountEdit: false,
          showQrCodeOption: false,
          disableViewHistory: true,
          shouldShowUnsavedContactBanner: false,
          isRecurring: false,
          checkoutType: "DEFAULT",
          transactionContext: "p2p",
          initialAmount: parseFloat(amount) * 100,
          disableNotesEdit: true,
          showKeyboard: false,
          currency: "INR",
          shouldShowMaskedNumber: true,
        },
      };
      const phonepeBase64 = Buffer.from(JSON.stringify(phonepePayload), "utf8").toString("base64");
      phonePeIntent = `phonepe://native?data=${phonepeBase64}&id=p2ppayment`;
    }

    const paytmIntent = `paytmmp://pay?${upiParams.toString()}`;

    const tezIntent = `tez://upi/pay?${upiParams.toString()}`;

    return {
      upi: baseUpi,
      phonePe: phonePeIntent,
      paytm: paytmIntent,
      gpay: tezIntent,
      webPaymentsApi: {
        supportedMethods: "https://tez.google.com/pay",
        data: {
          pa: merchantVPA,
          pn: merchantName,
          tn: sanitizedNote || `Pay To ${merchantName}`,
          ...(isBharatPe ? {} : { tr: txnRef, mc: "5411" }),
        },
      },
    };
  }

  async getMerchantVPA(
    merchantId: string,
    providerId?: string,
    includeDeleted: boolean = false,
  ): Promise<string | null> {
    try {
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;

      const response = await axios.get(`${merchantServiceUrl}/merchant/${merchantId}${includeDeleted ? '?includeDeleted=true' : ''}`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } });
      const merchant = response.data?.merchant || response.data;

      console.log(`🔍 [QR Service] Getting VPA for merchant ${merchantId}:`, {
        merchantId,
        providerId,
        hasProviders: !!merchant?.providers,
        providerCount: merchant?.providers?.length || 0,
      });

      if (!merchant) {
        console.error("❌ [QR Service] Merchant not found");
        this.logger.error(
          `Merchant ${merchantId} not found in Merchant Service`,
        );
        return null;
      }

      let vpa: string | null = null;

      if (merchant.upiId) {
        vpa = merchant.upiId;
        console.log(`📱 [QR Service] Found VPA from merchant.upiId:`, vpa);
      }

      // Get VPA from specific provider or any active one
      if (providerId) {
        const targetProvider = merchant.providers.find(
          (p: any) => p.id === providerId,
        );
        if (targetProvider) {
          const credentials = (targetProvider.credentials as any) || {};
          vpa =
            credentials.merchantUpiId ||
            credentials.upiId ||
            targetProvider.accountIdentifier;
          console.log(
            `📱 [QR Service] Found VPA from provider ${providerId}:`,
            vpa,
          );
        }
      }

      // Fallback: find any active provider
      if (!vpa && merchant.providers?.length > 0) {
        for (const provider of merchant.providers) {
          if (!provider.isActive) continue;

          const credentials = (provider.credentials as any) || {};
          const possibleVpa =
            credentials.merchantUpiId ||
            credentials.upiId ||
            provider.accountIdentifier;

          if (possibleVpa && possibleVpa !== "Not configured") {
            vpa = possibleVpa;
            console.log(
              `📱 [QR Service] Found VPA from active provider ${provider.id}:`,
              vpa,
            );
            break;
          }
        }
      }

      if (vpa && vpa !== "Not configured") {
        console.log(
          `✅ [QR Service] Final VPA for merchant ${merchantId}:`,
          vpa,
        );
        return vpa;
      }

      this.logger.warn(`No VPA found for merchant ${merchantId}`);
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch merchant VPA: ${error.message}`);
      return null;
    }
  }

  async createQrCode(orderId: string, expiresInMinutes: number = 5, force: boolean = false) {
    try {
      this.logger.log(`Looking for order: ${orderId}`);

      const order = await this.prisma.order.findFirst({
        where: {
          OR: [{ id: orderId }, { externalOrderId: orderId }],
        },
      });

      if (!order) {
        throw new BadRequestException(`Order not found with ID: ${orderId}`);
      }

      // Get merchant VPA
      let merchantVPA: string | null = null;
      if (order.merchantId) {
        merchantVPA = await this.getMerchantVPA(
          order.merchantId,
          order.providerId || undefined,
          (order.metadata as any)?.isPlatform === true,
        );
      }

      // Fallback (e.g. if we had user info, but we don't have user table here easily)
      if (!merchantVPA) {
        // Try to use a default or throw
        // For now, let's allow it to proceed with a placeholder or fail?
        // If we fail, the user can't pay.
        // Realistically, the merchant MUST have a VPA.
        // Let's log severe warning and maybe use organization VPA if we could default?
        // For now, let's error if no VPA, as payment cannot proceed.
        throw new BadRequestException("Merchant UPI ID not configured.");
      }

      const paymentLink = await this.paymentLinkService.createPaymentLink(
        order.id,
        expiresInMinutes,
        true,
        force,
      );

      // Generate UPI deep links for all apps using helper method
      const merchantName = "Upipe Merchant";
      const txnNote = order.externalOrderId;
      const deepLinks = this.generateUpiDeepLinks(
        merchantVPA,
        order.amount.toString(),
        order.externalOrderId,
        merchantName,
        txnNote,
      );

      console.log(`🔗 [QR Service] Generated UPI Deep Links:`, {
        upi: deepLinks.upi,
        gpay: deepLinks.gpay.substring(0, 80) + "...",
      });

      const qrCodeDataUrl = await QRCode.toDataURL(deepLinks.upi, {
        type: "image/png",
        margin: 1,
        width: 300,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });

      await this.prisma.paymentLink.update({
        where: { id: paymentLink.id },
        data: { qrData: deepLinks.upi },
      });

      return {
        success: true,
        qrCode: {
          dataUrl: qrCodeDataUrl,
          paymentLink: paymentLink.linkToken,
          expiresAt: paymentLink.expiresAt,
          upiString: deepLinks.upi,
          deepLinks: {
            upi: deepLinks.upi,
            phonePe: deepLinks.phonePe,
            paytm: deepLinks.paytm,
            gpay: deepLinks.gpay,
          },
          webPaymentsApi: deepLinks.webPaymentsApi,
          state: paymentLink.state || "GENERATED",
        },
        order: {
          id: order.externalOrderId,
          amount: order.amount,
          currency: order.currency,
        },
        merchantVPA: merchantVPA,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create QR code: ${errorMessage}`);
      throw new BadRequestException(errorMessage);
    }
  }

  async getQrCode(linkToken: string, scanData?: any) {
    try {
      const paymentLink = await this.prisma.paymentLink.findUnique({
        where: { linkToken },
        include: {
          order: true, // simplified include
        },
      });

      if (!paymentLink) {
        throw new BadRequestException("Payment link not found");
      }

      if (paymentLink.expiresAt && paymentLink.expiresAt < new Date()) {
        await this.updateQrState(paymentLink.id, "EXPIRED");
        throw new BadRequestException("QR code has expired");
      }

      if (paymentLink.isSingleUse && paymentLink.state === "COMPLETED") {
        // Using state enum check roughly
        throw new BadRequestException("Payment already completed");
      }

      if (scanData) {
        await this.logQrScan(paymentLink.id, scanData);
      }

      // If first scan on mobile, mark as SCANNED
      if (paymentLink.scannedCount === 0 && scanData?.deviceType === "mobile") {
        await this.updateQrState(paymentLink.id, "SCANNED");
      }

      // Re-fetch VPA to ensure up to date (or could store it on link)
      const merchantVPA = await this.getMerchantVPA(
        paymentLink.order.merchantId,
        paymentLink.order.providerId || undefined,
        (paymentLink.order.metadata as any)?.isPlatform === true,
      );

      if (!merchantVPA) {
        throw new BadRequestException("Merchant UPI ID missing");
      }
      // UPI deep links for all apps
      const merchantName = "Upipe Merchant";
      const txnNote = paymentLink.order.externalOrderId;
      const deepLinks = this.generateUpiDeepLinks(
        merchantVPA,
        paymentLink.order.amount.toString(),
        paymentLink.order.externalOrderId,
        merchantName,
        txnNote,
      );

      const qrCodeDataUrl = await QRCode.toDataURL(deepLinks.upi, {
        width: 300,
        margin: 1,
      });

      return {
        success: true,
        qrCode: {
          dataUrl: qrCodeDataUrl,
          url: qrCodeDataUrl,
          upiString: deepLinks.upi,
          deepLinks: {
            upi: deepLinks.upi,
            phonePe: deepLinks.phonePe,
            paytm: deepLinks.paytm,
            gpay: deepLinks.gpay,
          },
          webPaymentsApi: deepLinks.webPaymentsApi,
          paymentLink: paymentLink.linkToken,
        },
        merchantVPA,
      };
    } catch (error) {
      this.logger.error(`Get QR Error: ${error}`);
      throw error;
    }
  }

  async updateQrState(paymentLinkId: string, newState: any) {
    await this.prisma.paymentLink.update({
      where: { id: paymentLinkId },
      data: {
        state: newState,
        scannedCount: { increment: newState === "SCANNED" ? 1 : 0 },
      },
    });

    if (newState === "EXPIRED") {
      const paymentLink = await this.prisma.paymentLink.findUnique({
        where: { id: paymentLinkId },
        select: {
          orderId: true,
          order: {
            select: {
              status: true,
              externalOrderId: true,
            },
          },
        },
      });

      if (paymentLink?.orderId && paymentLink.order.status === "PENDING") {
        await this.prisma.order.update({
          where: { id: paymentLink.orderId },
          data: {
            status: "EXPIRED",
            updatedAt: new Date(),
          },
        });
        this.logger.log(
          `Order ${paymentLink.orderId} marked as EXPIRED due to link expiration`,
        );
      }
    }
  }

  async logQrScan(paymentLinkId: string, scanData: any) {
    try {
      // await this.prisma.qrScanLog.create({
      //     data: {
      //         paymentLinkId,
      //         ipAddress: scanData.ipAddress,
      //         userAgent: scanData.userAgent,
      //         deviceType: scanData.deviceType,
      //         scanSource: 'api'
      //     }
      // });
    } catch (e) {
      console.error("Failed to log scan", e);
    }
  }

  /** Grace period (ms) after link expiry before marking EXPIRED. Reduces race where
   *  customer pays just before expiry but transaction sync hasn't run yet. */
  private static readonly EXPIRY_GRACE_MS = 5 * 60 * 1000; // 5 minutes

  @Cron(CronExpression.EVERY_MINUTE)
  async checkExpiredLinks() {
    try {
      const now = new Date();
      const graceCutoff = new Date(
        now.getTime() - QrcodeService.EXPIRY_GRACE_MS,
      );

      const expiredLinks = await this.prisma.paymentLink.findMany({
        where: {
          expiresAt: {
            lt: graceCutoff,
          },
          state: {
            notIn: ["EXPIRED", "COMPLETED"],
          },
        },
        select: {
          id: true,
          orderId: true,
          linkToken: true,
          expiresAt: true,
        },
      });

      if (expiredLinks.length > 0) {
        this.logger.log(
          `Found ${expiredLinks.length} expired payment links to update`,
        );

        for (const link of expiredLinks) {
          await this.updateQrState(link.id, "EXPIRED");
          this.logger.log(
            `Marked payment link ${link.linkToken} and order ${link.orderId} as EXPIRED`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Error checking expired links: ${error.message}`);
    }
  }
}

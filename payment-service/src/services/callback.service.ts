import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma.service";
import { OrderEventsService } from "./order-events.service";
import axios from "axios";
import * as crypto from "crypto";

@Injectable()
export class CallbackService {
  private readonly logger = new Logger(CallbackService.name);
  private readonly webhookSecret: string;
  private readonly organizationServiceUrl: string;
  private readonly notificationServiceUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderEvents: OrderEventsService,
  ) {
    this.webhookSecret = process.env.WEBHOOK_SECRET;
    this.organizationServiceUrl = process.env.ORGANIZATION_SERVICE_URL || "";
    this.notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL || "";

    if (
      !this.webhookSecret ||
      this.webhookSecret === "upipe-webhook-secret-change-in-production"
    ) {
      this.logger.error(
        "🚨 WEBHOOK_SECRET environment variable not set or using default!",
      );
      this.logger.error(
        "Set a secure WEBHOOK_SECRET in .env file before deploying to production",
      );
      throw new Error("WEBHOOK_SECRET must be configured");
    }

    this.logger.log("✅ Webhook secret configured");
  }

  /**
   * Trigger webhook immediately for a specific order.
   * Used by provider webhooks when payment is completed.
   * Uses atomic DB lock to prevent duplicate sends from concurrent webhooks.
   */
  async triggerWebhookForOrder(orderId: string) {
    // Atomic lock: only one process can claim this webhook send
    const locked = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        webhookSent: false,
        webhookFailed: false,
        callbackUrl: { not: null },
      },
      data: {
        webhookSent: true,
      },
    });

    if (locked.count === 0) {
      this.logger.debug(
        `Webhook for order ${orderId} already claimed or not eligible`,
      );
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      this.logger.warn(
        `Cannot trigger webhook: order ${orderId} not found after lock`,
      );
      return;
    }

    if (!order.callbackUrl) {
      this.logger.debug(
        `Skipping webhook for ${order.externalOrderId}: no callbackUrl configured`,
      );
      await this.prisma.order.update({
        where: { id: orderId },
        data: { webhookSent: false },
      });
      return;
    }

    await this.sendWebhookToMerchant(order);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sendPendingWebhooks() {
    try {
      this.logger.debug("🔍 Checking for pending webhooks...");

      const callbackLogs = await this.prisma.callbackLog.findMany({
        where: {
          success: false,
          retryCount: { lt: 3 },
          nextRetryAt: { lte: new Date() },
        },
        orderBy: { createdAt: "asc" },
        take: 20,
      });

      const pendingOrders = await this.prisma.order.findMany({
        where: {
          status: "COMPLETED",
          webhookSent: false,
          webhookFailed: false, // Exclude permanently failed webhooks
          callbackUrl: {
            not: null,
          },
        },
        take: 50, // Process max 50 new webhooks per minute
      });

      const totalPending = pendingOrders.length + callbackLogs.length;

      if (totalPending === 0) {
        this.logger.debug("No pending webhooks to send");
        return;
      }

      this.logger.log(
        `📤 Found ${pendingOrders.length} new webhooks and ${callbackLogs.length} retries to send`,
      );

      // Process retries first
      const retryResults = await Promise.allSettled(
        callbackLogs.map((log) => this.retryWebhook(log)),
      );

      const results = await Promise.allSettled(
        pendingOrders.map(async (order) => {
          const existingLog = await this.prisma.callbackLog.findFirst({
            where: { orderId: order.id },
          });

          if (existingLog) {
            return;
          }

          return this.sendWebhookToMerchant(order);
        }),
      );

      const successful = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;
      const retriesSuccessful = retryResults.filter(
        (r) => r.status === "fulfilled",
      ).length;
      const retriesFailed = retryResults.filter(
        (r) => r.status === "rejected",
      ).length;

      this.logger.log(
        `✅ New: ${successful} successful, ${failed} failed | Retries: ${retriesSuccessful} successful, ${retriesFailed} failed`,
      );
    } catch (error) {
      this.logger.error("Failed to process pending webhooks:", error);
    }
  }

  private async retryWebhook(log: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: log.orderId },
    });

    if (!order) {
      this.logger.warn(
        `Order ${log.orderId} not found for retry log ${log.id}`,
      );
      // Mark log as processed to avoid infinite retries for non-existent orders
      await this.prisma.callbackLog.update({
        where: { id: log.id },
        data: { success: true, retryCount: log.retryCount + 1 },
      });
      return;
    }

    if (order.webhookSent || order.webhookFailed) {
      this.logger.debug(
        `Skipping retry for ${order.externalOrderId}, webhook status: ${order.webhookSent ? "SENT" : "FAILED"}`,
      );
      await this.prisma.callbackLog.update({
        where: { id: log.id },
        data: { nextRetryAt: null },
      });
      return;
    }

    // Mark the current log as processed for retry purposes so it's not picked up again
    // The new attempt will create its own log entry with a new schedule if it fails
    await this.prisma.callbackLog.update({
      where: { id: log.id },
      data: { nextRetryAt: null },
    });

    this.logger.debug(
      `🔄 Retrying webhook for order ${order.externalOrderId} (attempt ${log.retryCount + 1})`,
    );
    await this.sendWebhookToMerchant(order, log.retryCount + 1);
  }

  private async sendWebhookToMerchant(order: any, retryCount: number = 0) {
    const startTime = Date.now();

    try {
      this.logger.log(
        `📨 Sending webhook for order ${order.externalOrderId} to ${order.callbackUrl}`,
      );

      const transaction = await this.prisma.transaction.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: "desc" },
      });

      const metadata: any = order.metadata || {};

      const txnTimestamp: Date =
        (transaction?.completedAt as Date) ||
        (transaction?.createdAt as Date) ||
        (order.completedAt as Date) ||
        (order.createdAt as Date);

      const createdAtIso = txnTimestamp
        ? txnTimestamp.toISOString()
        : new Date().toISOString();
      const txnDate = createdAtIso.slice(0, 10);

      const providerResp = transaction?.providerResponse as any;
      const payerVpa = transaction?.customerContact || providerResp?.payerVpa || providerResp?.payerVPA || providerResp?.vpa || providerResp?.payerAccount || "";

      const payload = {
        amount: parseFloat(order.amount.toString()),
        client_txn_id: order.clientReferenceId || order.externalOrderId || "",
        createdAt: createdAtIso,
        customer_email: order.customerEmail || "",
        customer_mobile: order.customerMobile || "",
        customer_name: order.customerName || "",
        customer_vpa: payerVpa,
        id: order.externalOrderId,
        p_info: order.description || "",
        redirect_url: order.redirectUrl || "",
        remark: order.remark || metadata.remark || "Transaction processed",
        status: order.status === "COMPLETED" ? "success" : "failure",
        txnAt: txnDate,
        udf1: metadata.udf1 || "",
        udf2: metadata.udf2 || "",
        udf3: metadata.udf3 || "",
        upi_txn_id:
          transaction?.utr || transaction?.externalTransactionId || order.utr || "",
      };



      const payloadString = JSON.stringify(payload);

      const response = await axios.post(order.callbackUrl, payload, {
        timeout: 10000,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Upipe-Webhook/1.0",
          "X-Upipe-Signature": this.generateHmacSignature(payloadString),
          "X-Upipe-Retry": retryCount.toString(),
        },
      });

      const duration = Date.now() - startTime;

      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          webhookSent: true,
          webhookFailed: false,
          webhookFailureReason: null,
        },
      });
      await this.prisma.callbackLog.create({
        data: {
          orderId: order.id,
          callbackUrl: order.callbackUrl,
          payload: payload,
          response: response.data,
          statusCode: response.status,
          success: true,
          retryCount: retryCount,
        },
      });

      this.logger.log(
        `✅ Webhook sent successfully for ${order.externalOrderId} (${duration}ms)`,
      );
      this.orderEvents.broadcastOrderUpdated(order.id, order.organizationId, {
        externalOrderId: order.externalOrderId,
        isPlatform: (order.metadata as any)?.isPlatform,
      });
      await this.trySendOrderCompletionEmail(order);
      await this.trySendPushNotification(order);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.message || "Unknown error";
      const statusCode = error.response?.status || null;

      this.logger.error(
        `❌ Webhook failed for ${order.externalOrderId}: ${errorMessage} (${duration}ms)${retryCount > 0 ? ` [Retry #${retryCount}]` : ""}`,
      );

      const nextRetryMinutes = Math.pow(2, retryCount);
      const nextRetryAt = new Date(Date.now() + nextRetryMinutes * 60 * 1000);

      await this.prisma.callbackLog.create({
        data: {
          orderId: order.id,
          callbackUrl: order.callbackUrl,
          payload: {
            status: order.status,
            orderId: order.externalOrderId,
            amount: parseFloat(order.amount.toString()),
          },
          response: error.response?.data || { error: errorMessage },
          statusCode: statusCode,
          success: false,
          retryCount: retryCount,
          nextRetryAt: retryCount < 2 ? nextRetryAt : null,
        },
      });

      if (retryCount >= 2) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            webhookSent: false,
            webhookFailed: true,
            webhookFailureReason: `Failed after ${retryCount + 1} attempts: ${errorMessage}`,
          },
        });
        this.logger.warn(
          `⚠️ Max retries reached for ${order.externalOrderId}, marked as failed`,
        );
      } else {
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            webhookSent: false,
          },
        });
      }
    }
  }

  private generateHmacSignature(payloadString: string): string {
    return crypto
      .createHmac("sha256", this.webhookSecret)
      .update(payloadString)
      .digest("hex");
  }

  /**
   * If org has orderCompletionEmail enabled, send one email per completed order.
   * Respects per-organization toggle so high-volume merchants can disable.
   */
  private async trySendOrderCompletionEmail(order: any): Promise<void> {
    if (!this.organizationServiceUrl || !this.notificationServiceUrl) return;
    if (order.status !== "COMPLETED") return;

    try {
      const settingsRes = await axios.get(
        `${this.organizationServiceUrl.replace(/\/$/, "")}/organizations/${order.organizationId}/settings`,
        { timeout: 5000, validateStatus: () => true, headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } },
      );
      const data = settingsRes.data?.data ?? settingsRes.data;
      const customSettings =
        data?.settings?.customSettings ?? data?.customSettings ?? {};
      const orderCompletionEmail =
        customSettings?.notifications?.orderCompletionEmail;
      if (!orderCompletionEmail) return;

      const toEmail =
        data?.settings?.contact?.email ??
        data?.contact?.email ??
        order.customerEmail;
      if (!toEmail || typeof toEmail !== "string") {
        this.logger.debug(
          `Order completion email skipped for ${order.externalOrderId}: no org/customer email`,
        );
        return;
      }

      await axios.post(
        `${this.notificationServiceUrl.replace(/\/$/, "")}/internal/send/email`,
        {
          to: toEmail,
          type: "order_completion",
          data: {
            orderId: order.externalOrderId,
            amount: order.amount?.toString() ?? "",
            customerName: order.customerName ?? "",
          },
        },
        { timeout: 5000, validateStatus: () => true,
            headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        },
      );
    } catch (err: any) {
      this.logger.warn(
        `Order completion email failed for ${order.externalOrderId}: ${err?.message || err}`,
      );
    }
  }

  private async trySendPushNotification(order: any): Promise<void> {
    if (!this.notificationServiceUrl || order.status !== "COMPLETED") return;
    if ((order.metadata as any)?.isPlatform) return; // Skip push for subscriptions
    const frontendUrl = (
      process.env.FRONTEND_URL ||
      process.env.CLIENT_ADMIN_URL ||
      ""
    ).replace(/\/$/, "");
    try {
      await axios.post(
        `${this.notificationServiceUrl.replace(/\/$/, "")}/internal/push/send`,
        {
          organizationId: order.organizationId,
          payload: {
            title: "Order completed",
            body: `Order ${order.externalOrderId || order.id} completed.`,
            url: frontendUrl
              ? `${frontendUrl}/orders${order.externalOrderId ? `/${order.externalOrderId}` : ""}`
              : undefined,
          },
        },
        { timeout: 5000, validateStatus: () => true,
            headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        },
      );
    } catch (err: any) {
      this.logger.debug(
        `Push notification failed for ${order.externalOrderId}: ${err?.message || err}`,
      );
    }
  }

  async resendWebhook(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new Error("Order not found");
    }

    if (!order.callbackUrl) {
      throw new Error("No callback URL configured for this order");
    }

    this.logger.log(
      `🔄 Manual webhook resend requested for ${order.externalOrderId}`,
    );

    await this.prisma.order.update({
      where: { id: orderId },
      data: { webhookSent: false },
    });

    return { success: true, message: "Webhook queued for resend" };
  }

  async resendWebhookNow(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new Error("Order not found");
    }

    if (!order.callbackUrl) {
      throw new Error("No callback URL configured for this order");
    }

    this.logger.log(`🔄 Immediate webhook resend for ${order.externalOrderId}`);

    await this.sendWebhookToMerchant(order, 0);
    return { success: true, message: "Webhook sent" };
  }
}

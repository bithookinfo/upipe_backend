import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { OrderStatus, PaymentMethod, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { PaytmChecksum } from '../utils/paytmChecksum';
import { verifyPhonePeChecksum } from '../utils/phonepeChecksum';
import { CallbackService } from './callback.service';
import { OrderEventsService } from './order-events.service';
export interface WebhookPayload {
  orderId: string;
  transactionId: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'CANCELLED';
  amount: number;
  gatewayResponse: any;
  utr?: string;
  paymentMethod?: string;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly merchantServiceUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly callbackService: CallbackService,
    private readonly orderEvents: OrderEventsService,
  ) {
    this.merchantServiceUrl = this.configService.get<string>('MERCHANT_SERVICE_URL');
  }

  async handlePaytmWebhook(payload: any, headers: any): Promise<void> {
    try {
      this.logger.log('Processing Paytm webhook');

      // 1. Verify Signature
      const isValid = await this.verifyPaytmSignature(payload);
      if (!isValid) {
        this.logger.warn('Invalid Paytm webhook signature');
        throw new UnauthorizedException('Invalid Paytm webhook signature');
      }

      const webhookData = this.parsePaytmWebhook(payload);
      await this.updateOrderFromWebhook(webhookData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Paytm webhook processing failed:', errorMessage);
      throw error;
    }
  }

  async handlePhonePeWebhook(payload: any, headers: any): Promise<void> {
    try {
      this.logger.log('Processing PhonePe webhook');

      const base64Response = payload.response;
      if (!base64Response) {
        throw new Error('Missing response field in PhonePe webhook');
      }

      const decodedBuffer = Buffer.from(base64Response, 'base64');
      const decodedJson = JSON.parse(decodedBuffer.toString('utf8'));

      this.logger.debug(`Decoded PhonePe payload for order ${decodedJson.data?.merchantTransactionId || 'unknown'}`);

      const signature = headers['x-verify'];

      if (signature) {
        const isValid = await this.verifyPhonePeSignature(base64Response, signature, decodedJson.data?.merchantId);
        if (!isValid) {
          this.logger.warn('Invalid PhonePe webhook signature');
          throw new UnauthorizedException('Invalid PhonePe webhook signature');
        } else {
          this.logger.log('✅ PhonePe signature verified');
        }
      } else {
        this.logger.warn('Missing x-verify header');
        throw new UnauthorizedException('Missing x-verify header');
      }

      const webhookData = this.parsePhonePeWebhook(decodedJson);
      await this.updateOrderFromWebhook(webhookData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('PhonePe webhook processing failed:', errorMessage);
      throw error;
    }
  }

  async handleBharatPeWebhook(payload: any, headers: any): Promise<void> {
    try {
      this.logger.log('Processing BharatPe webhook');

      const signature = headers['x-verify'] || headers['x-signature'];
      const isValid = await this.verifyBharatPeSignature(payload, signature);
      if (!isValid) {
        this.logger.warn('Invalid BharatPe webhook signature');
        throw new UnauthorizedException('Invalid BharatPe webhook signature');
      }

      const webhookData = this.parseBharatPeWebhook(payload);
      await this.updateOrderFromWebhook(webhookData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('BharatPe webhook processing failed:', errorMessage);
      throw error;
    }
  }

  private async getMerchantCredentials(merchantId: string, providerType: string): Promise<any> {
    try {
      // Internal call to merchant-service
      const url = `${this.merchantServiceUrl}/merchant/${merchantId}/credentials`;
      const response = await axios.post(
        url, 
        { providerType },
        { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '' } }
      );

      if (response.data?.success && response.data?.credentials?.length > 0) {
        return response.data.credentials[0]; // Assuming first active credential
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch credentials for ${merchantId}:`, error.message);
      return null;
    }
  }

  private async verifyPaytmSignature(payload: any): Promise<boolean> {
    try {
      const orderId = payload.ORDERID;
      if (!orderId) return false;

      const order = await this.prisma.order.findFirst({
        where: { externalOrderId: orderId },
        select: { merchantId: true }
      });

      if (!order) {
        this.logger.warn(`Order ${orderId} not found for signature verification`);
        return false;
      }

      const providerData = await this.getMerchantCredentials(order.merchantId, 'paytm');
      if (!providerData) {
        this.logger.warn('No Paytm credentials found for verification');
        return false;
      }

      const merchantKey = providerData.credentials?.merchantKey || providerData.credentials?.key;
      if (!merchantKey) return false;

      const checksum = payload.CHECKSUMHASH;
      if (!checksum) return false;

      return PaytmChecksum.verifySignature(payload, merchantKey, checksum);
    } catch (error) {
      this.logger.error('Paytm signature verification failed:', error);
      return false;
    }
  }

  private async verifyPhonePeSignature(base64Response: string, signature: string, merchantId: string): Promise<boolean> {
    try {
      if (!merchantId) return false;

      // We need to find the merchant in our system.
      // PhonePe sends the PARENT merchant ID usually, or search by provider identifier.
      // Easiest is to search our MerchantProvider table where accountIdentifier matches or metadata matches.
      // BUT 'getMerchantCredentials' needs valid Upipe 'merchantId'.

      // OPTION 1: Use 'merchantId' from payload if it matches Upipe's internal ID (unlikely).
      // OPTION 2: Use an existing Order to map back to Merchant?
      // PhonePe payload has 'merchantTransactionId' which is our Order ID.

      // Let's decode payload to get order ID first (already decoded in caller).
      // Logic moved to here:

      // The caller passed 'merchantId' from PhonePe payload. Ideally we need Upipe's merchantId.
      // Let's rely on finding the ORDER first.

      const decodedBuffer = Buffer.from(base64Response, 'base64');
      const json = JSON.parse(decodedBuffer.toString());
      const orderId = json.data?.merchantTransactionId;

      if (!orderId) return false;

      const order = await this.prisma.order.findFirst({
        where: { externalOrderId: orderId },
        select: { merchantId: true }
      });

      if (!order) return false;

      const providerData = await this.getMerchantCredentials(order.merchantId, 'phonepe');
      if (!providerData) return false;

      const saltKey = providerData.credentials?.saltKey || providerData.credentials?.key;
      const saltIndex = providerData.credentials?.saltIndex || "1";

      if (!saltKey) return false;

      return verifyPhonePeChecksum(base64Response, saltKey, saltIndex, signature);

    } catch (error) {
      this.logger.error('PhonePe signature verification failed:', error);
      return false;
    }
  }

  private async verifyBharatPeSignature(payload: any, signature: string): Promise<boolean> {
    if (!signature) return false;
    let secret = this.configService.get<string>('BHARATPE_WEBHOOK_SECRET');
    
    try {
      const orderId = payload.orderId;
      if (orderId) {
        const order = await this.prisma.order.findFirst({
          where: { externalOrderId: orderId },
          select: { merchantId: true }
        });
        
        if (order) {
          const providerData = await this.getMerchantCredentials(order.merchantId, 'bharatpe');
          if (providerData?.credentials?.webhookSecret) {
            secret = providerData.credentials.webhookSecret;
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to fetch merchant specific BharatPe secret: ${e.message}`);
    }

    if (!secret) {
      this.logger.error('No BharatPe webhook secret found in config or merchant credentials');
      return false;
    }
    
    const computedSignature = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    
    try {
      const a = Buffer.from(computedSignature);
      const b = Buffer.from(signature);
      
      if (a.length !== b.length) {
        return false;
      }
      
      return crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  }

  private async updateOrderFromWebhook(webhookData: WebhookPayload): Promise<void> {
    try {
      // Find order by external order ID
      const order = await this.prisma.order.findFirst({
        where: { externalOrderId: webhookData.orderId },
      });

      if (!order) {
        this.logger.warn(`Order not found for webhook: ${webhookData.orderId}`);
        return;
      }

      // Map webhook status to order status
      let orderStatus = this.mapWebhookStatusToOrderStatus(webhookData.status);

      if (orderStatus === OrderStatus.COMPLETED) {
        if (Math.abs(Number(order.amount) - Number(webhookData.amount)) > 0.01) {
          this.logger.error(`🚨 AMOUNT MISMATCH for ${order.externalOrderId}: Requested ₹${order.amount}, Paid ₹${webhookData.amount}. Preventing auto-complete!`);
          orderStatus = OrderStatus.PROCESSING; // Revert back to processing
        }
      }

      // Update order and create transaction atomically
      await this.prisma.$transaction(async (prisma) => {
        await prisma.order.update({
          where: { externalOrderId: webhookData.orderId },
          data: {
            status: orderStatus,
            updatedAt: new Date(),
          },
        });

        await prisma.transaction.upsert({
          where: {
            externalTransactionId: webhookData.transactionId
          },
          create: {
            orderId: order.id,
            merchantId: order.merchantId,
            providerId: order.providerId || 'webhook-provider',
            externalTransactionId: webhookData.transactionId,
            amount: webhookData.amount,
            netAmount: webhookData.amount,
            currency: 'INR',
            status: webhookData.status === 'SUCCESS' ? TransactionStatus.SUCCESS : TransactionStatus.FAILED,
            paymentMethod: PaymentMethod.UPI,
            providerCode: webhookData.paymentMethod || 'WEBHOOK',
            providerResponse: webhookData.gatewayResponse,
            utr: webhookData.utr,
            completedAt: webhookData.status === 'SUCCESS' ? new Date() : null,
            failedAt: webhookData.status === 'FAILED' ? new Date() : null,
          },
          update: {
            status: webhookData.status === 'SUCCESS' ? TransactionStatus.SUCCESS : TransactionStatus.FAILED,
            providerResponse: webhookData.gatewayResponse,
            utr: webhookData.utr,
            completedAt: webhookData.status === 'SUCCESS' ? new Date() : null,
            failedAt: webhookData.status === 'FAILED' ? new Date() : null,
            updatedAt: new Date(),
          },
        });
      });

      this.logger.log(`✅ Order ${webhookData.orderId} updated to status: ${orderStatus}`);

      // Fire merchant webhook immediately on successful payment.
      if (orderStatus === OrderStatus.COMPLETED && order.callbackUrl) {
        try {
          await this.callbackService.triggerWebhookForOrder(order.id);
        } catch (err) {
          this.logger.error(
            `Failed to trigger merchant webhook for ${order.externalOrderId}:`,
            err,
          );
          // Cron-based retries will still pick this up later.
        }
      }
      if (orderStatus === OrderStatus.COMPLETED) {
        this.orderEvents.broadcastOrderUpdated(order.id, order.organizationId, {
          externalOrderId: order.externalOrderId,
        });
      }
    } catch (error) {
      this.logger.error(`Failed to update order ${webhookData.orderId}:`, error);
      throw error;
    }
  }

  private mapWebhookStatusToOrderStatus(webhookStatus: string): OrderStatus {
    switch (webhookStatus) {
      case 'SUCCESS':
        return OrderStatus.COMPLETED;
      case 'FAILED':
        return OrderStatus.FAILED;
      case 'PENDING':
        return OrderStatus.PROCESSING;
      case 'CANCELLED':
        return OrderStatus.CANCELLED;
      default:
        return OrderStatus.PROCESSING;
    }
  }

  private parsePaytmWebhook(payload: any): WebhookPayload {
    return {
      orderId: payload.ORDERID || payload.orderId,
      transactionId: payload.TXNID || payload.transactionId,
      status: payload.STATUS === 'TXN_SUCCESS' ? 'SUCCESS' : 'FAILED',
      amount: parseFloat(payload.TXNAMOUNT || payload.amount),
      gatewayResponse: payload,
      utr: payload.BANKTXNID,
      paymentMethod: 'PAYTM',
    };
  }

  private parsePhonePeWebhook(decodedPayload: any): WebhookPayload {
    return {
      orderId: decodedPayload.data?.merchantTransactionId || decodedPayload.orderId,
      transactionId: decodedPayload.data?.transactionId || decodedPayload.transactionId,
      status: decodedPayload.code === 'PAYMENT_SUCCESS' ? 'SUCCESS' : 'FAILED',
      amount: decodedPayload.data?.amount ? decodedPayload.data.amount / 100 : decodedPayload.amount,
      gatewayResponse: decodedPayload,
      utr: decodedPayload.data?.utr,
      paymentMethod: 'PHONEPE',
    };
  }

  private parseBharatPeWebhook(payload: any): WebhookPayload {
    return {
      orderId: payload.orderId,
      transactionId: payload.transactionId,
      status: payload.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      amount: parseFloat(payload.amount),
      gatewayResponse: payload,
      utr: payload.utr,
      paymentMethod: 'BHARATPE',
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { WebhookService } from './webhook.service';
import { InAppNotificationsService } from './in-app-notifications.service';
import { OrderStatus } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';
import { PaytmChecksum } from '../utils/paytmChecksum';

@Injectable()
export class CronService {
    private readonly logger = new Logger(CronService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly webhookService: WebhookService,
        private readonly configService: ConfigService,
        private readonly inAppNotifications: InAppNotificationsService,
    ) { }

    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async cleanupOldNotifications() {
        try {
            const deleted = await this.inAppNotifications.deleteOlderThan(14);
            if (deleted > 0) {
                this.logger.log(`Cleaned up ${deleted} in-app notifications older than 14 days`);
            }
        } catch (err: any) {
            this.logger.warn(`In-app notification cleanup failed: ${err?.message || err}`);
        }
    }

    /** Phase 4: Nightly reconciliation — match orders to transactions by UTR/orderId, fix orphans, detect platform vs walk-in */
    @Cron(CronExpression.EVERY_DAY_AT_2AM)
    async nightlyReconciliation() {
        this.logger.log('🔄 Running nightly order–transaction reconciliation...');
        try {
            const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days

            // 1) Orders that are not COMPLETED but have a SUCCESS transaction (by orderId or Order.utr) → mark COMPLETED and set Order.utr
            const nonCompletedOrders = await this.prisma.order.findMany({
                where: {
                    status: { in: ['PENDING', 'PROCESSING', 'EXPIRED'] },
                    createdAt: { gte: since },
                },
                select: { id: true, externalOrderId: true, utr: true, amount: true },
            });

            if (nonCompletedOrders.length === 0) {
                this.logger.log('No pending orders found for reconciliation.');
                return;
            }

            const orderIds = nonCompletedOrders.map(o => o.id);
            const utrs = nonCompletedOrders.filter(o => o.utr).map(o => o.utr as string);

            const successTransactions = await this.prisma.transaction.findMany({
                where: {
                    status: 'SUCCESS',
                    OR: [
                        { orderId: { in: orderIds } },
                        ...(utrs.length > 0 ? [{ utr: { in: utrs } }] : [])
                    ]
                },
                select: { id: true, orderId: true, utr: true, amount: true },
                orderBy: { id: 'asc' }
            });

            // Build in-memory lookup maps preserving the findFirst logic (only set if not exists)
            const txnsByOrderId = new Map<string, any>();
            const txnsByUtr = new Map<string, any>();

            for (const txn of successTransactions) {
                if (txn.orderId && !txnsByOrderId.has(txn.orderId)) {
                    txnsByOrderId.set(txn.orderId, txn);
                }
                if (txn.utr && !txnsByUtr.has(txn.utr)) {
                    txnsByUtr.set(txn.utr, txn);
                }
            }

            let fixedCount = 0;
            for (const order of nonCompletedOrders) {
                // Mimic the exact current matching logic: orderId OR utr
                let successTxn = txnsByOrderId.get(order.id);
                if (!successTxn && order.utr) {
                    successTxn = txnsByUtr.get(order.utr);
                }

                if (!successTxn) continue;
                if (successTxn.orderId !== order.id && successTxn.orderId !== null) continue; // UTR match but linked to another order — skip
                
                if (Math.abs(Number(order.amount) - Number(successTxn.amount)) > 0.01) {
                    this.logger.error(`AMOUNT MISMATCH in nightlyReconciliation: Order ${order.externalOrderId} requested ₹${order.amount}, but transaction was ₹${successTxn.amount}. Skipping!`);
                    continue;
                }
                await this.prisma.order.update({
                    where: { id: order.id },
                    data: {
                        status: OrderStatus.COMPLETED,
                        completedAt: new Date(),
                        ...(successTxn.utr ? { utr: successTxn.utr } : {}),
                    },
                });
                fixedCount++;
                this.logger.log(`Reconciliation: marked order ${order.externalOrderId} COMPLETED (had SUCCESS txn)`);
            }

            // 2) Report: orders with no transaction (potential missed sync)
            const ordersWithoutTxn = await this.prisma.order.findMany({
                where: {
                    status: { in: ['PENDING', 'PROCESSING', 'EXPIRED'] },
                    createdAt: { gte: since },
                    transactions: { none: {} },
                },
                select: { id: true, externalOrderId: true, createdAt: true },
                take: 100,
            });

            // 3) Report: SUCCESS transactions with no orderId (walk-in)
            const txnsWithoutOrder = await this.prisma.transaction.findMany({
                where: {
                    status: 'SUCCESS',
                    orderId: null,
                    createdAt: { gte: since },
                },
                select: { id: true, externalTransactionId: true, utr: true, amount: true, createdAt: true },
                take: 100,
            });

            this.logger.log(
                `Reconciliation done. Fixed ${fixedCount} orders. ` +
                `Orders without txn: ${ordersWithoutTxn.length}; Walk-in txns (no order): ${txnsWithoutOrder.length}`,
            );
            if (ordersWithoutTxn.length > 0) {
                this.logger.debug(`Sample orders without transaction: ${ordersWithoutTxn.slice(0, 5).map((o) => o.externalOrderId).join(', ')}`);
            }
            if (txnsWithoutOrder.length > 0) {
                this.logger.debug(`Sample walk-in txns: ${txnsWithoutOrder.slice(0, 5).map((t) => t.externalTransactionId).join(', ')}`);
            }
        } catch (err: any) {
            this.logger.error(`Nightly reconciliation failed: ${err?.message || err}`);
        }
    }

    @Cron(CronExpression.EVERY_5_MINUTES)
    async handlePendingOrders() {
        this.logger.log('🔄 Running Pending Orders Cron Job...');

        try {
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000); // 10 mins ago
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);   // 1 hour ago (don't check very old orders)


            const pendingOrders = await this.prisma.order.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: {
                        lt: tenMinutesAgo,
                        gt: oneHourAgo
                    }
                    // externalOrderId is required, so all orders have it
                },
                take: 20
            });

            this.logger.log(`Found ${pendingOrders.length} pending orders to check.`);

            for (const order of pendingOrders) {
                await this.checkOrderStatus(order);
                // Small delay to be nice to APIs
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

        } catch (error) {
            this.logger.error('❌ Error in handlePendingOrders cron:', error);
        }
    }

    private async checkOrderStatus(order: any) {
        try {
            this.logger.debug(`Checking status for Order: ${order.externalOrderId} (${order.providerId || 'Unknown Provider'})`);

            // 1. Identify Provider (logic depends on how we stored provider info)
            // We can try to guess from providerId or a stored 'providerCode' if we added it to Order.
            // Current Order schema has 'providerId' (uuid).

            // We need to fetch credentials first to know the provider type or use the providerId link.
            // But fetching credentials requires knowing the type or just getting all.
            // Let's rely on 'getMerchantCredentials' which we will implement here to inspect the provider.

            // Better approach: We need to know WHICH provider to query.
            // If we don't have this, we have to try all or look up the specific provider linked to the order.
            // Let's assume we can fetch the provider type via the credential endpoint if we pass the providerId?
            // No, the credential endpoint takes providerType as filter.

            // HACK: For now, let's try to check based on what we know.
            // If order.metadata has something, use it.
            // OR, query merchant service to get the provider details for this specific order's providerId.

            // Let's implement a 'getProviderById' internal helper?
            // Too complex for now. Let's iterate types: PhonePe, Paytm.

            // Trying PhonePe first (most common)
            const phonePeCreds = await this.getMerchantCredentials(order.merchantId, 'phonepe');
            if (phonePeCreds && phonePeCreds.isActive) {
                // Try PhonePe Status Check
                const status = await this.checkPhonePeStatus(order, phonePeCreds);
                if (status === 'COMPLETED' || status === 'FAILED') {
                    await this.updateOrderStatus(order.id, status, 'PHONEPE');
                    return;
                }
            }

            // Try Paytm
            const paytmCreds = await this.getMerchantCredentials(order.merchantId, 'paytm');
            if (paytmCreds && paytmCreds.isActive) {
                // Try Paytm Status Check
                const status = await this.checkPaytmStatus(order, paytmCreds);
                if (status === 'COMPLETED' || status === 'FAILED') {
                    await this.updateOrderStatus(order.id, status, 'PAYTM');
                    return;
                }
            }

        } catch (err) {
            this.logger.error(`Failed to check status for ${order.externalOrderId}`, err);
        }
    }

    private async checkPhonePeStatus(order: any, credentials: any): Promise<string | null> {
        try {
            const merchantId = credentials.credentials?.merchantId;
            const saltKey = credentials.credentials?.saltKey || credentials.credentials?.key;
            const saltIndex = credentials.credentials?.saltIndex || "1";
            const txnId = order.externalOrderId;

            if (!merchantId || !saltKey) return null;

            // PhonePe Status API: /pg/v1/status/{merchantId}/{merchantTransactionId}
            const path = `/pg/v1/status/${merchantId}/${txnId}`;
            const stringToHash = path + saltKey;
            const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
            const xVerify = sha256 + "###" + saltIndex;

            // Host depends on Env (UAT vs Prod)
            // Assuming Prod for now or config based.
            const host = credentials.credentials?.isSandbox ? 'https://api-preprod.phonepe.com/apis/pg-sandbox' : 'https://api.phonepe.com/apis/hermes';

            const response = await axios.get(`${host}${path}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-MERCHANT-ID': merchantId,
                    'X-VERIFY': xVerify
                },
                validateStatus: () => true
            });

            if (response.data?.code === 'PAYMENT_SUCCESS') {
                const paidAmount = Number(response.data?.data?.amount) / 100;
                if (Math.abs(Number(order.amount) - paidAmount) > 0.01) {
                    this.logger.error(`AMOUNT MISMATCH from PhonePe PG: Order ${order.externalOrderId} requested ₹${order.amount}, but PG reported ₹${paidAmount}`);
                    return null;
                }
                return 'COMPLETED';
            } else if (response.data?.code === 'PAYMENT_ERROR') {
                return 'FAILED';
            }

            return null;
        } catch (e) {
            this.logger.error(`PhonePe status check error for ${order.externalOrderId}: ${e.message}`);
            return null;
        }
    }

    private async checkPaytmStatus(order: any, credentials: any): Promise<string | null> {
        try {
            const mid = credentials.credentials?.mid || credentials.credentials?.merchantId;
            const mkey = credentials.credentials?.merchantKey || credentials.credentials?.key;
            const orderId = order.externalOrderId;

            if (!mid || !mkey) return null;

            // Paytm Status API
            // Need Checksum
            const paytmParams = {
                MID: mid,
                ORDERID: orderId,
            };

            const checksum = PaytmChecksum.generateSignature(paytmParams, mkey);
            (paytmParams as any).CHECKSUMHASH = checksum;

            const host = credentials.credentials?.isSandbox ? 'https://securegw-stage.paytm.in' : 'https://securegw.paytm.in';

            const response = await axios.post(`${host}/order/status`, paytmParams, {
                headers: { 'Content-Type': 'application/json' }
            });

            if (response.data?.STATUS === 'TXN_SUCCESS') {
                const paidAmount = Number(response.data?.TXNAMOUNT);
                if (Math.abs(Number(order.amount) - paidAmount) > 0.01) {
                    this.logger.error(`AMOUNT MISMATCH from Paytm PG: Order ${order.externalOrderId} requested ₹${order.amount}, but PG reported ₹${paidAmount}`);
                    return null;
                }
                return 'COMPLETED';
            } else if (response.data?.STATUS === 'TXN_FAILURE') {
                return 'FAILED';
            }

            return null;
        } catch (e) {
            this.logger.error(`Paytm status check error for ${order.externalOrderId}: ${e.message}`);
            return null;
        }
    }

    private async updateOrderStatus(orderId: string, status: OrderStatus, provider: string) {
        this.logger.log(`✅ Updating Order ${orderId} to ${status} via Cron (${provider})`);

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { merchantId: true, amount: true }
        });

        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: status,
                updatedAt: new Date(),
                ...(status === OrderStatus.COMPLETED ? { completedAt: new Date() } : {}),
                ...(status === OrderStatus.FAILED ? { failedAt: new Date() } : {})
            }
        });

        // NOTE: Merchant usage is updated by order-status-cron.service.ts in merchant-service
        // Do NOT update usage here to prevent double counting

        // Also update Transaction table if needed (simplified here)
    }

    private async getMerchantCredentials(merchantId: string, providerType: string): Promise<any> {
        try {
            const merchantServiceUrl = this.configService.get<string>('MERCHANT_SERVICE_URL');
            const url = `${merchantServiceUrl}/merchant/${merchantId}/credentials`;
            const response = await axios.post(url, { providerType }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } });

            if (response.data?.success && response.data?.credentials?.length > 0) {
                return response.data.credentials[0];
            }
            return null;
        } catch (error) {
            this.logger.error(`Failed to fetch credentials for merchant ${merchantId}, provider ${providerType}: ${error.message}`);
            return null;
        }
    }
}

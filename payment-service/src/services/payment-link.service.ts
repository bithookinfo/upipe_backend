import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import * as crypto from 'crypto';
import axios from 'axios';

@Injectable()
export class PaymentLinkService {
    private readonly logger = new Logger(PaymentLinkService.name);

    constructor(private readonly prisma: PrismaService) { }

    private generateLinkToken(): string {
        return crypto.randomBytes(16).toString('hex');
    }

    private generateShortUrl(): string {
        return crypto.randomBytes(8).toString('hex');
    }

    async checkOrderStatus(orderId: string) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                status: true,
                organizationId: true,
                merchantId: true,
                providerId: true,
                externalOrderId: true,
                amount: true,
                currency: true,
                customerName: true,
                customerMobile: true,
                paymentMethod: true,
                completedAt: true,
                utr: true,
            }
        });

        if (!order) {
            throw new BadRequestException('Order not found');
        }

        // If order is COMPLETED, ensure a Transaction record exists
        if (order.status === 'COMPLETED') {
            try {
                const existingTxn = await this.prisma.transaction.findFirst({
                    where: { orderId: order.id }
                });

                if (!existingTxn) {
                    await this.prisma.transaction.create({
                        data: {
                            orderId: order.id,
                            merchantId: order.merchantId,
                            providerId: order.providerId || 'order-payment',
                            externalTransactionId: order.externalOrderId,
                            amount: order.amount,
                            netAmount: order.amount,
                            currency: order.currency || 'INR',
                            status: 'SUCCESS',
                            paymentMethod: order.paymentMethod || 'UPI',
                            providerCode: 'ORDER',
                            customerName: order.customerName,
                            customerContact: order.customerMobile,
                            completedAt: order.completedAt || new Date(),
                        }
                    });
                    this.logger.log(`✅ Created Transaction for completed order: ${order.externalOrderId}`);

                    // Update subscription usage
                    try {
                        const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;
                        await axios.post(`${subscriptionServiceUrl}/real-subscriptions/organizations/${order.organizationId}/update-usage`, {
                            action: 'PROCESS_TRANSACTION',
                            data: {
                                amount: Number(order.amount)
                            }
                        }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN, 'x-organization-id': order.organizationId } });
                        this.logger.log(`✅ Updated subscription usage for org ${order.organizationId}`);
                    } catch (err) {
                        this.logger.warn(`Failed to update subscription usage: ${err.message}`);
                    }
                }
            } catch (error) {
                this.logger.warn(`Could not create transaction for order ${order.id}: ${error.message}`);
            }
        }

        let utr = order.utr || null;
        if (!utr && order.status === 'COMPLETED') {
            try {
                const txn = await this.prisma.transaction.findFirst({
                    where: { orderId: order.id },
                    select: { utr: true }
                });
                if (txn) {
                    utr = txn.utr;
                }
            } catch (e) {
                // ignore
            }
        }

        return {
            status: order.status.toLowerCase(),
            orderId: order.id,
            utr: utr
        };
    }

    async createPaymentLink(
        orderId: string,
        expiresInMinutes: number = 5,
        isSingleUse: boolean = true,
        force: boolean = false
    ): Promise<any> {
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: orderId },
            });

            if (!order) {
                throw new Error('Order not found');
            }

            const existingLink = await this.prisma.paymentLink.findFirst({
                where: { orderId },
            });

            const isExpired = existingLink?.expiresAt && existingLink.expiresAt < new Date();

            // If we have a valid link and NOT forcing a refresh, return it
            if (existingLink && !isExpired && !force) {
                return existingLink;
            }

            const linkToken = this.generateLinkToken();
            const shortUrl = this.generateShortUrl();
            const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
            const baseUrl = process.env.PUBLIC_API_URL;
            const longUrl = `${baseUrl}/payment/${linkToken}`;

            if (existingLink) {
                if (order.status === 'EXPIRED') {
                    await this.prisma.order.update({
                        where: { id: order.id },
                        data: { status: 'PENDING' }
                    });
                }

                // Update existing link with fresh data (because it's expired or forced)
                return await this.prisma.paymentLink.update({
                    where: { id: existingLink.id },
                    data: {
                        linkToken,
                        shortUrl,
                        longUrl,
                        expiresAt,
                        isActive: true,
                        state: 'GENERATED'
                    },
                    include: {
                        order: {
                            select: {
                                id: true,
                                externalOrderId: true,
                                amount: true,
                                currency: true,
                                customerEmail: true,
                                customerMobile: true,
                                status: true
                            },
                        },
                    },
                });
            }

            const paymentLink = await this.prisma.paymentLink.create({
                data: {
                    linkToken,
                    orderId,
                    shortUrl,
                    longUrl,
                    expiresAt,
                    isSingleUse,
                    isActive: true,
                },
                include: {
                    order: {
                        select: {
                            externalOrderId: true,
                            amount: true,
                            currency: true,
                            customerEmail: true,
                            customerMobile: true,
                        },
                    },
                },
            });

            this.logger.log(
                `Payment link created for order ${order.externalOrderId}: ${linkToken}`,
            );

            return paymentLink;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.error(
                `Failed to create payment link for order ${orderId}: ${errorMessage}`,
            );
            throw new BadRequestException(
                `Failed to create payment link: ${errorMessage}`,
            );
        }
    }

    async getPaymentLink(linkToken: string) {
        try {
            const paymentLink = await this.prisma.paymentLink.findUnique({
                where: { linkToken },
                include: {
                    order: {
                        select: {
                            id: true,
                            externalOrderId: true,
                            amount: true,
                            currency: true,
                            status: true,
                            customerEmail: true,
                            customerMobile: true,
                            customerName: true,
                            description: true,
                            createdAt: true,
                            merchantId: true,
                            providerId: true,
                            paymentMethod: true,
                            callbackUrl: true,
                            redirectUrl: true
                        },
                    },
                },
            });

            if (!paymentLink) {
                throw new BadRequestException('Payment link not found');
            }

            if (!paymentLink.isActive) {
                throw new BadRequestException('Payment link is no longer active');
            }

            if (paymentLink.expiresAt && paymentLink.expiresAt < new Date()) {
                await this.prisma.paymentLink.update({
                    where: { id: paymentLink.id },
                    data: { isActive: false },
                });
                throw new BadRequestException('Payment link has expired');
            }

            if (paymentLink.isSingleUse && paymentLink.state === 'COMPLETED') {
                throw new BadRequestException('Payment link has already been used');
            }
            return {
                success: true,
                paymentLink,
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to get payment link: ${errorMessage}`);
            throw new BadRequestException(
                `Failed to get payment link: ${errorMessage}`,
            );
        }
    }
}

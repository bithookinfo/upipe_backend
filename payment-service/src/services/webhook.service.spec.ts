import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { PrismaService } from '../prisma.service';
import { OrderStatus, TransactionStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CallbackService } from './callback.service';
import { OrderEventsService } from './order-events.service';
import {
    createMockPrismaService,
    createMockOrder,
    createMockPaytmWebhook,
    createMockPhonePeWebhook,
    createMockBharatPeWebhook,
} from '../../test/utils/test-helpers';

describe('WebhookService', () => {
    let service: WebhookService;
    let prismaService: any;
    let callbackService: { triggerWebhookForOrder: jest.Mock };

    beforeEach(async () => {
        // Create mock Prisma service
        prismaService = createMockPrismaService();
        callbackService = {
            triggerWebhookForOrder: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WebhookService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn().mockReturnValue('http://merchant-service'),
                    },
                },
                {
                    provide: CallbackService,
                    useValue: callbackService,
                },
                {
                    provide: OrderEventsService,
                    useValue: {
                        broadcastOrderUpdated: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<WebhookService>(WebhookService);

        // Suppress logger output during tests
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ============================================================================
    // PAYTM WEBHOOK TESTS
    // ============================================================================

    describe('handlePaytmWebhook', () => {
        it('should successfully process a Paytm success webhook', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                externalOrderId: 'ORD_123',
                amount: 100,
            });
            const webhookPayload = createMockPaytmWebhook({
                ORDERID: 'ORD_123',
                TXNID: 'TXN_456',
                STATUS: 'TXN_SUCCESS',
                TXNAMOUNT: '100.00',
                BANKTXNID: 'BANK_789',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({ ...mockOrder, status: OrderStatus.COMPLETED });
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.findFirst).toHaveBeenCalledWith({
                where: { externalOrderId: 'ORD_123' },
            });
            expect(prismaService.order.update).toHaveBeenCalledWith({
                where: { externalOrderId: 'ORD_123' },
                data: {
                    status: OrderStatus.COMPLETED,
                    updatedAt: expect.any(Date),
                },
            });
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { externalTransactionId: 'TXN_456' },
                    create: expect.objectContaining({
                        externalTransactionId: 'TXN_456',
                        amount: 100,
                        status: TransactionStatus.SUCCESS,
                        providerCode: 'PAYTM',
                        utr: 'BANK_789',
                    }),
                })
            );
        });

        it('should handle Paytm failed transaction', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_FAIL' });
            const webhookPayload = createMockPaytmWebhook({
                ORDERID: 'ORD_FAIL',
                STATUS: 'TXN_FAILURE',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.update).toHaveBeenCalledWith({
                where: { externalOrderId: 'ORD_FAIL' },
                data: {
                    status: OrderStatus.FAILED,
                    updatedAt: expect.any(Date),
                },
            });
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        status: TransactionStatus.FAILED,
                        failedAt: expect.any(Date),
                        completedAt: null,
                    }),
                })
            );
        });

        it('should handle order not found gracefully', async () => {
            // Arrange
            const webhookPayload = createMockPaytmWebhook({ ORDERID: 'NON_EXISTENT' });
            prismaService.order.findFirst.mockResolvedValue(null);

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.findFirst).toHaveBeenCalled();
            expect(prismaService.order.update).not.toHaveBeenCalled();
            expect(prismaService.transaction.upsert).not.toHaveBeenCalled();
        });

        it('should throw error on Paytm webhook processing failure', async () => {
            // Arrange
            const webhookPayload = createMockPaytmWebhook();
            prismaService.order.findFirst.mockRejectedValue(new Error('Database error'));

            // Act & Assert
            await expect(service.handlePaytmWebhook(webhookPayload, {}))
                .rejects
                .toThrow('Database error');
        });
    });

    // ============================================================================
    // PHONEPE WEBHOOK TESTS
    // ============================================================================

    describe('handlePhonePeWebhook', () => {
        it('should successfully process a PhonePe success webhook', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                externalOrderId: 'ORD_PE_123',
                amount: 100,
            });
            const webhookPayload = createMockPhonePeWebhook({
                code: 'PAYMENT_SUCCESS',
                data: {
                    merchantTransactionId: 'ORD_PE_123',
                    transactionId: 'PE_TXN_456',
                    amount: 10000, // 100 rupees in paise
                    utr: 'PE_UTR_789',
                },
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({ ...mockOrder, status: OrderStatus.COMPLETED });
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePhonePeWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.findFirst).toHaveBeenCalledWith({
                where: { externalOrderId: 'ORD_PE_123' },
            });
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { externalTransactionId: 'PE_TXN_456' },
                    create: expect.objectContaining({
                        amount: 100, // Converted from paise
                        status: TransactionStatus.SUCCESS,
                        providerCode: 'PHONEPE',
                        utr: 'PE_UTR_789',
                    }),
                })
            );
        });

        it('should handle PhonePe failed payment', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_PE_FAIL' });
            const webhookPayload = createMockPhonePeWebhook({
                code: 'PAYMENT_ERROR',
                data: {
                    merchantTransactionId: 'ORD_PE_FAIL',
                },
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePhonePeWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: OrderStatus.FAILED,
                    }),
                })
            );
        });

        it('should correctly convert PhonePe amount from paise to rupees', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_AMT' });
            const webhookPayload = createMockPhonePeWebhook({
                data: {
                    merchantTransactionId: 'ORD_AMT',
                    amount: 25050, // 250.50 rupees
                },
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePhonePeWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        amount: 250.5,
                    }),
                })
            );
        });
    });

    // ============================================================================
    // BHARATPE WEBHOOK TESTS
    // ============================================================================

    describe('handleBharatPeWebhook', () => {
        it('should successfully process a BharatPe success webhook', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                externalOrderId: 'ORD_BP_123',
                amount: 100,
            });
            const webhookPayload = createMockBharatPeWebhook({
                orderId: 'ORD_BP_123',
                transactionId: 'BP_TXN_456',
                status: 'SUCCESS',
                amount: '100.00',
                utr: 'BP_UTR_789',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({ ...mockOrder, status: OrderStatus.COMPLETED });
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handleBharatPeWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        externalTransactionId: 'BP_TXN_456',
                        amount: 100,
                        status: TransactionStatus.SUCCESS,
                        providerCode: 'BHARATPE',
                        utr: 'BP_UTR_789',
                    }),
                })
            );
        });

        it('should handle BharatPe failed payment', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_BP_FAIL' });
            const webhookPayload = createMockBharatPeWebhook({
                orderId: 'ORD_BP_FAIL',
                status: 'FAILED',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handleBharatPeWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: OrderStatus.FAILED,
                    }),
                })
            );
        });
    });

    // ============================================================================
    // TRANSACTION UPSERT TESTS
    // ============================================================================

    describe('Transaction Upsert Logic', () => {
        it('should create new transaction if not exists', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_NEW' });
            const webhookPayload = createMockPaytmWebhook({ ORDERID: 'ORD_NEW', TXNID: 'NEW_TXN' });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { externalTransactionId: 'NEW_TXN' },
                    create: expect.objectContaining({
                        orderId: mockOrder.id,
                        merchantId: mockOrder.merchantId,
                        externalTransactionId: 'NEW_TXN',
                    }),
                    update: expect.any(Object),
                })
            );
        });

        it('should update existing transaction on duplicate webhook', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_DUP' });
            const webhookPayload = createMockPaytmWebhook({
                ORDERID: 'ORD_DUP',
                TXNID: 'DUP_TXN',
                STATUS: 'TXN_SUCCESS',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    update: expect.objectContaining({
                        status: TransactionStatus.SUCCESS,
                        completedAt: expect.any(Date),
                        updatedAt: expect.any(Date),
                    }),
                })
            );
        });
    });

    // ============================================================================
    // STATUS MAPPING TESTS
    // ============================================================================

    describe('Status Mapping', () => {
        it.each([
            ['SUCCESS', OrderStatus.COMPLETED],
            ['FAILED', OrderStatus.FAILED],
        ])('should map webhook status %s to order status %s', async (webhookStatus, expectedOrderStatus) => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_STATUS' });

            // Map Jest status to Paytm status format
            let paytmStatus = 'TXN_FAILURE';
            if (webhookStatus === 'SUCCESS') paytmStatus = 'TXN_SUCCESS';
            else if (webhookStatus === 'PENDING') paytmStatus = 'TXN_PENDING';
            else if (webhookStatus === 'CANCELLED') paytmStatus = 'TXN_CANCELLED';
            else if (webhookStatus === 'FAILED') paytmStatus = 'TXN_FAILURE';

            const webhookPayload = {
                ORDERID: 'ORD_STATUS',
                TXNID: 'TXN_STATUS',
                STATUS: paytmStatus,
                TXNAMOUNT: '100.00',
            };

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: expectedOrderStatus,
                    }),
                })
            );
        });
    });

    // ============================================================================
    // ERROR HANDLING TESTS
    // ============================================================================

    describe('Error Handling', () => {
        it('should log error and rethrow on database failure', async () => {
            // Arrange
            const webhookPayload = createMockPaytmWebhook();
            const dbError = new Error('Database connection failed');
            prismaService.order.findFirst.mockRejectedValue(dbError);

            const loggerSpy = jest.spyOn(Logger.prototype, 'error');

            // Act & Assert
            await expect(service.handlePaytmWebhook(webhookPayload, {}))
                .rejects
                .toThrow('Database connection failed');

            expect(loggerSpy).toHaveBeenCalled();
        });

        it('should handle malformed Paytm payload gracefully', async () => {
            // Arrange
            const malformedPayload = { INVALID: 'data' };
            const mockOrder = createMockOrder({ externalOrderId: undefined });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);

            // Act
            await service.handlePaytmWebhook(malformedPayload, {});

            // Assert - should not crash, just log warning
            expect(prismaService.order.findFirst).toHaveBeenCalled();
        });

        it('should handle malformed PhonePe payload gracefully', async () => {
            // Arrange
            const malformedPayload = {
                response: Buffer.from(JSON.stringify({ code: 'SUCCESS' })).toString('base64'),
            };

            // Act
            await service.handlePhonePeWebhook(malformedPayload, {});

            // Assert - should not crash
            expect(prismaService.order.findFirst).toHaveBeenCalled();
        });
    });

    // ============================================================================
    // WEBHOOK SIGNATURE VERIFICATION TESTS
    // ============================================================================

    describe('Signature Verification', () => {
        it('should process webhook even with invalid signature in development', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_SIG' });
            const webhookPayload = createMockPaytmWebhook({ ORDERID: 'ORD_SIG' });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert - should still process despite signature verification warning
            expect(prismaService.order.update).toHaveBeenCalled();
        });
    });

    // ============================================================================
    // INTEGRATION EDGE CASES
    // ============================================================================

    describe('Edge Cases', () => {
        it('should handle concurrent webhooks for same order', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_CONCURRENT' });
            const webhook1 = createMockPaytmWebhook({ ORDERID: 'ORD_CONCURRENT', TXNID: 'TXN_1' });
            const webhook2 = createMockPaytmWebhook({ ORDERID: 'ORD_CONCURRENT', TXNID: 'TXN_2' });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await Promise.all([
                service.handlePaytmWebhook(webhook1, {}),
                service.handlePaytmWebhook(webhook2, {}),
            ]);

            // Assert
            expect(prismaService.order.update).toHaveBeenCalledTimes(2);
            expect(prismaService.transaction.upsert).toHaveBeenCalledTimes(2);
        });

        it('should handle zero amount transactions', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_ZERO', amount: 0 });
            const webhookPayload = createMockPaytmWebhook({
                ORDERID: 'ORD_ZERO',
                TXNAMOUNT: '0.00',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        amount: 0,
                    }),
                })
            );
        });

        it('should handle missing UTR gracefully', async () => {
            // Arrange
            const mockOrder = createMockOrder({ externalOrderId: 'ORD_NO_UTR' });
            const webhookPayload = createMockPaytmWebhook({
                ORDERID: 'ORD_NO_UTR',
                BANKTXNID: undefined,
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({});
            prismaService.transaction.upsert.mockResolvedValue({});

            // Act
            await service.handlePaytmWebhook(webhookPayload, {});

            // Assert
            expect(prismaService.transaction.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    create: expect.objectContaining({
                        utr: undefined,
                    }),
                })
            );
        });
    });
});

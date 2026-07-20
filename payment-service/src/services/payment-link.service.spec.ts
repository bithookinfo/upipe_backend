import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger } from '@nestjs/common';
import { PaymentLinkService } from './payment-link.service';
import { PrismaService } from '../prisma.service';
import { OrderStatus } from '@prisma/client';
import {
    createMockPrismaService,
    createMockOrder,
    createMockPaymentLink,
    createMockTransaction,
} from '../../test/utils/test-helpers';
import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PaymentLinkService', () => {
    let service: PaymentLinkService;
    let prismaService: any;

    beforeEach(async () => {
        // Create mock Prisma service
        prismaService = createMockPrismaService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PaymentLinkService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
            ],
        }).compile();

        service = module.get<PaymentLinkService>(PaymentLinkService);

        // Suppress logger output
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ============================================================================
    // PAYMENT LINK CREATION TESTS
    // ============================================================================

    describe('createPaymentLink', () => {
        it('should create a new payment link for valid order', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-123',
                externalOrderId: 'EXT_ORD_123',
                amount: 100,
            });
            const mockPaymentLink = createMockPaymentLink({
                orderId: mockOrder.id,
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null); // No existing link
            prismaService.paymentLink.count.mockResolvedValue(10);
            prismaService.paymentLink.create.mockResolvedValue({
                ...mockPaymentLink,
                order: {
                    externalOrderId: mockOrder.externalOrderId,
                    amount: mockOrder.amount,
                    currency: mockOrder.currency,
                    customerEmail: mockOrder.customerEmail,
                    customerPhone: mockOrder.customerPhone,
                },
            } as any);

            // Act
            const result = await service.createPaymentLink('order-123', 5, true);

            // Assert
            expect(prismaService.order.findUnique).toHaveBeenCalledWith({
                where: { id: 'order-123' },
            });
            expect(prismaService.paymentLink.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        orderId: 'order-123',
                        isSingleUse: true,
                        isActive: true,
                        linkToken: expect.any(String),
                        shortUrl: expect.any(String),
                        expiresAt: expect.any(Date),
                    }),
                    include: expect.any(Object),
                })
            );
            expect(result).toHaveProperty('linkToken');
        });

        it('should return existing active payment link if already exists', async () => {
            // Arrange
            const mockOrder = createMockOrder({ id: 'order-existing' });
            const existingLink = createMockPaymentLink({ orderId: 'order-existing' });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(existingLink);

            // Act
            const result = await service.createPaymentLink('order-existing');

            // Assert
            expect(prismaService.paymentLink.findFirst).toHaveBeenCalledWith({
                where: {
                    orderId: 'order-existing',
                },
            });
            expect(prismaService.paymentLink.create).not.toHaveBeenCalled();
            expect(result).toEqual(existingLink);
        });

        it('should throw BadRequestException if order not found', async () => {
            // Arrange
            prismaService.order.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.createPaymentLink('non-existent'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.createPaymentLink('non-existent'))
                .rejects
                .toThrow('Order not found');
        });

        it('should generate unique link token', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);

            const createdLinks: any[] = [];
            prismaService.paymentLink.create.mockImplementation((args: any) => {
                createdLinks.push(args.data);
                return Promise.resolve({
                    ...args.data,
                    id: `link-${createdLinks.length}`,
                    order: {},
                });
            });

            // Act
            const link1 = await service.createPaymentLink(mockOrder.id);
            const link2 = await service.createPaymentLink(mockOrder.id);

            // Assert
            expect(createdLinks[0].linkToken).toBeTruthy();
            expect(createdLinks[1].linkToken).toBeTruthy();
            expect(createdLinks[0].linkToken).not.toEqual(createdLinks[1].linkToken);
        });

        it('should set correct expiration time', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            const expiresInMinutes = 10;
            const beforeTime = Date.now() + expiresInMinutes * 60 * 1000 - 1000;

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);

            let capturedExpiresAt: Date;
            prismaService.paymentLink.create.mockImplementation((args: any) => {
                capturedExpiresAt = args.data.expiresAt;
                return Promise.resolve({ ...args.data, id: 'link-1', order: {} });
            });

            // Act
            await service.createPaymentLink(mockOrder.id, expiresInMinutes);

            const afterTime = Date.now() + expiresInMinutes * 60 * 1000 + 1000;

            // Assert
            expect(capturedExpiresAt!.getTime()).toBeGreaterThanOrEqual(beforeTime);
            expect(capturedExpiresAt!.getTime()).toBeLessThanOrEqual(afterTime);
        });

        it('should handle single-use flag correctly', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);
            prismaService.paymentLink.create.mockResolvedValue({
                id: 'link-1',
                isSingleUse: false,
                order: {},
            });

            // Act
            await service.createPaymentLink(mockOrder.id, 5, false);

            // Assert
            expect(prismaService.paymentLink.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        isSingleUse: false,
                    }),
                })
            );
        });

        it('should handle database errors gracefully', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);
            prismaService.paymentLink.create.mockRejectedValue(new Error('Database error'));

            // Act & Assert
            await expect(service.createPaymentLink(mockOrder.id))
                .rejects
                .toThrow(BadRequestException);
        });
    });

    // ============================================================================
    // PAYMENT LINK RETRIEVAL TESTS
    // ============================================================================

    describe('getPaymentLink', () => {
        it('should retrieve active payment link successfully', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
            const mockLink = createMockPaymentLink({
                linkToken: 'valid-token',
                isActive: true,
                expiresAt: futureDate,
                state: 'GENERATED',
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });

            // Act
            const result = await service.getPaymentLink('valid-token');

            // Assert
            expect(result.success).toBe(true);
            expect(result.paymentLink).toHaveProperty('linkToken', 'valid-token');
            expect(result.paymentLink).toHaveProperty('order');
        });

        it('should throw BadRequestException if payment link not found', async () => {
            // Arrange
            prismaService.paymentLink.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.getPaymentLink('non-existent-token'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.getPaymentLink('non-existent-token'))
                .rejects
                .toThrow('Payment link not found');
        });

        it('should throw BadRequestException if payment link is inactive', async () => {
            // Arrange
            const mockLink = createMockPaymentLink({
                linkToken: 'inactive-token',
                isActive: false,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });

            // Act & Assert
            await expect(service.getPaymentLink('inactive-token'))
                .rejects
                .toThrow('Payment link is no longer active');
        });

        it('should expire and deactivate expired payment link', async () => {
            // Arrange
            const pastDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
            const mockLink = createMockPaymentLink({
                id: 'link-expired',
                linkToken: 'expired-token',
                isActive: true,
                expiresAt: pastDate,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });
            prismaService.paymentLink.update.mockResolvedValue({});

            // Act & Assert
            await expect(service.getPaymentLink('expired-token'))
                .rejects
                .toThrow('Payment link has expired');

            expect(prismaService.paymentLink.update).toHaveBeenCalledWith({
                where: { id: 'link-expired' },
                data: { isActive: false },
            });
        });

        it('should reject already used single-use payment link', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockLink = createMockPaymentLink({
                linkToken: 'used-token',
                isActive: true,
                isSingleUse: true,
                state: 'COMPLETED',
                expiresAt: futureDate,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });

            // Act & Assert
            await expect(service.getPaymentLink('used-token'))
                .rejects
                .toThrow('Payment link has already been used');
        });

        it('should allow reuse of non-single-use payment link', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockLink = createMockPaymentLink({
                linkToken: 'reusable-token',
                isActive: true,
                isSingleUse: false,
                state: 'COMPLETED',
                expiresAt: futureDate,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });

            // Act
            const result = await service.getPaymentLink('reusable-token');

            // Assert
            expect(result.success).toBe(true);
        });
    });

    // ============================================================================
    // ORDER STATUS CHECK TESTS
    // ============================================================================

    describe('checkOrderStatus', () => {
        it('should return order status for existing order', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-status',
                status: OrderStatus.PENDING,
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);

            // Act
            const result = await service.checkOrderStatus('order-status');

            // Assert
            expect(result).toEqual({ status: 'pending' });
        });

        it('should throw BadRequestException if order not found', async () => {
            // Arrange
            prismaService.order.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.checkOrderStatus('non-existent'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.checkOrderStatus('non-existent'))
                .rejects
                .toThrow('Order not found');
        });

        it('should create transaction for completed order without transaction', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-completed',
                status: OrderStatus.COMPLETED,
                externalOrderId: 'EXT_COMPLETED',
                amount: 100,
                organizationId: 'org-123',
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.findFirst.mockResolvedValue(null); // No existing transaction
            prismaService.transaction.create.mockResolvedValue({});

            // Mock subscription service call
            mockedAxios.post.mockResolvedValue({ data: { success: true } });
            process.env.SUBSCRIPTION_SERVICE_URL = 'http://localhost:3104';

            // Act
            const result = await service.checkOrderStatus('order-completed');

            // Assert
            expect(prismaService.transaction.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    orderId: 'order-completed',
                    merchantId: mockOrder.merchantId,
                    externalTransactionId: 'EXT_COMPLETED',
                    amount: 100,
                    status: 'SUCCESS',
                }),
            });
            expect(result.status).toBe('completed');
        });

        it('should update subscription usage after transaction creation', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-sub',
                status: OrderStatus.COMPLETED,
                organizationId: 'org-456',
                amount: 250,
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.findFirst.mockResolvedValue(null);
            prismaService.transaction.create.mockResolvedValue({});

            mockedAxios.post.mockResolvedValue({ data: {} });
            process.env.SUBSCRIPTION_SERVICE_URL = 'http://localhost:3104';

            // Act
            await service.checkOrderStatus('order-sub');

            // Assert
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'http://localhost:3104/real-subscriptions/organizations/org-456/update-usage',
                {
                    action: 'PROCESS_TRANSACTION',
                    data: { amount: 250 },
                }
            );
        });

        it('should handle subscription update failure gracefully', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-sub-fail',
                status: OrderStatus.COMPLETED,
                organizationId: 'org-789',
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.findFirst.mockResolvedValue(null);
            prismaService.transaction.create.mockResolvedValue({});

            mockedAxios.post.mockRejectedValue(new Error('Subscription service down'));
            process.env.SUBSCRIPTION_SERVICE_URL = 'http://localhost:3104';

            // Act
            const result = await service.checkOrderStatus('order-sub-fail');

            // Assert - should not throw, just log warning
            expect(result.status).toBe('completed');
        });

        it('should not create duplicate transaction if one exists', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-has-txn',
                status: OrderStatus.COMPLETED,
            });
            const existingTransaction = createMockTransaction({
                orderId: 'order-has-txn',
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.findFirst.mockResolvedValue(existingTransaction);

            // Act
            await service.checkOrderStatus('order-has-txn');

            // Assert
            expect(prismaService.transaction.create).not.toHaveBeenCalled();
        });

        it('should handle transaction creation errors gracefully', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-txn-error',
                status: OrderStatus.COMPLETED,
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.findFirst.mockResolvedValue(null);
            prismaService.transaction.create.mockRejectedValue(new Error('DB error'));

            // Act
            const result = await service.checkOrderStatus('order-txn-error');

            // Assert - should not throw, just log warning
            expect(result.status).toBe('completed');
        });

        it('should return status for non-completed orders without creating transaction', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-pending',
                status: OrderStatus.PENDING,
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);

            // Act
            const result = await service.checkOrderStatus('order-pending');

            // Assert
            expect(prismaService.transaction.findFirst).not.toHaveBeenCalled();
            expect(prismaService.transaction.create).not.toHaveBeenCalled();
            expect(result.status).toBe('pending');
        });
    });

    // ============================================================================
    // EDGE CASES AND ERROR HANDLING
    // ============================================================================

    describe('Edge Cases', () => {
        it('should handle very short expiration time', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);
            prismaService.paymentLink.create.mockResolvedValue({
                id: 'link-1',
                order: {},
            });

            // Act
            await service.createPaymentLink(mockOrder.id, 1); // 1 minute

            // Assert
            expect(prismaService.paymentLink.create).toHaveBeenCalled();
        });

        it('should handle very long expiration time', async () => {
            // Arrange
            const mockOrder = createMockOrder();
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);
            prismaService.paymentLink.create.mockResolvedValue({
                id: 'link-1',
                order: {},
            });

            // Act
            await service.createPaymentLink(mockOrder.id, 1440); // 24 hours

            // Assert
            expect(prismaService.paymentLink.create).toHaveBeenCalled();
        });

        it('should handle null expiresAt (no expiration)', async () => {
            // Arrange
            const mockLink = createMockPaymentLink({
                linkToken: 'no-expiry',
                isActive: true,
                expiresAt: null,
                state: 'GENERATED',
            });

            prismaService.paymentLink.findUnique.mockResolvedValue({
                ...mockLink,
                order: createMockOrder(),
            });

            // Act
            const result = await service.getPaymentLink('no-expiry');

            // Assert
            expect(result.success).toBe(true);
            expect(prismaService.paymentLink.update).not.toHaveBeenCalled();
        });

        it('should handle concurrent payment link creation', async () => {
            // Arrange
            const mockOrder = createMockOrder({ id: 'order-concurrent' });
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.paymentLink.findFirst.mockResolvedValue(null);
            prismaService.paymentLink.count.mockResolvedValue(0);
            prismaService.paymentLink.create.mockResolvedValue({
                id: 'link-1',
                order: {},
            });

            // Act
            const results = await Promise.all([
                service.createPaymentLink('order-concurrent'),
                service.createPaymentLink('order-concurrent'),
            ]);

            // Assert
            expect(results).toHaveLength(2);
        });
    });
});

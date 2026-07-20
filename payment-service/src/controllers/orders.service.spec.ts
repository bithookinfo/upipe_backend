import { Test, TestingModule } from '@nestjs/testing';
import { OrdersService } from './simple-orders.controller';
import { PrismaService } from '../prisma.service';
import { QrcodeService } from '../services/qrcode.service';
import { ConfigService } from '@nestjs/config';
import { HealthMonitorService } from '../services/health-monitor.service';
import { CallbackService } from '../services/callback.service';
import { OrderEventsService } from '../services/order-events.service';
import { createMockPrismaService, createMockOrder } from '../../test/utils/test-helpers';

describe('OrdersService', () => {
    let service: OrdersService;
    let prismaService: any;
    let qrcodeService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.order.findFirst = prismaService.order.findUnique;
        prismaService.order.aggregate = jest.fn().mockResolvedValue({ _sum: { amount: 0 } });
        prismaService.paymentLink = {
            updateMany: jest.fn(),
        };
        prismaService.transaction = {
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
        };
        qrcodeService = {
            createQrCode: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrdersService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: QrcodeService,
                    useValue: qrcodeService,
                },
                {
                    provide: HealthMonitorService,
                    useValue: { logSuccess: jest.fn(), logFailure: jest.fn() },
                },
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn().mockReturnValue('http://localhost') },
                },
                {
                    provide: CallbackService,
                    useValue: { triggerWebhookForOrder: jest.fn().mockResolvedValue({}) },
                },
                {
                    provide: OrderEventsService,
                    useValue: { broadcastOrderUpdated: jest.fn() },
                },
            ],
        }).compile();

        service = module.get<OrdersService>(OrdersService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getOrders', () => {
        it('should return paginated orders', async () => {
            const mockOrders = [createMockOrder(), createMockOrder()];
            prismaService.order.findMany.mockResolvedValue(mockOrders);
            prismaService.order.count.mockResolvedValue(2);

            const result = await service.getOrders(1, 20);

            expect(result.success).toBe(true);
            expect(result.orders).toHaveLength(2);
            expect(result.pagination.total).toBe(2);
        });

        it('should filter by merchant', async () => {
            prismaService.order.findMany.mockResolvedValue([]);
            prismaService.order.count.mockResolvedValue(0);

            await service.getOrders(1, 20, undefined, 'merchant-123');

            expect(prismaService.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ merchantId: 'merchant-123' }),
                })
            );
        });

        it('should filter by payment app', async () => {
            prismaService.order.findMany.mockResolvedValue([]);
            prismaService.order.count.mockResolvedValue(0);

            await service.getOrders(1, 20, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'PhonePe');

            expect(prismaService.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        transactions: expect.objectContaining({
                            some: expect.objectContaining({
                                paymentApp: expect.objectContaining({ contains: 'PhonePe' })
                            })
                        })
                    }),
                })
            );
        });
    });

    describe('createOrder', () => {
        it('should create order successfully', async () => {
            const orderData = {
                merchantId: 'merchant-123',
                organizationId: 'org-123',
                amount: 1000,
                currency: 'INR',
                customerName: 'John Doe',
            };

            process.env.PUBLIC_API_URL = 'http://localhost:3000';
            process.env.MERCHANT_SERVICE_URL = 'http://localhost:3001';

            // Mock axios for merchant, API key, and subscription validations
            const axios = require('axios');
            jest.spyOn(axios, 'get').mockImplementation((url: string) => {
                if (url.includes('/real-subscriptions/organizations/')) {
                    return Promise.resolve({
                        data: {
                            subscription: {
                                status: 'ACTIVE',
                            }
                        }
                    });
                }
                return Promise.resolve({
                    data: { canGenerate: true, message: 'Validation passed' },
                });
            });
            jest.spyOn(axios, 'post').mockImplementation((url: string) => {
                if (url.includes('/validate-transaction')) {
                    return Promise.resolve({
                        data: { canProcess: true }
                    });
                }
                return Promise.resolve({
                    data: { valid: true, organization: { id: 'org-123', name: 'Test Org' } },
                });
            });

            prismaService.order.create.mockResolvedValue(
                createMockOrder({ ...orderData, externalOrderId: 'EXT123' }),
            );
            qrcodeService.createQrCode.mockResolvedValue({
                qrCode: {
                    paymentLink: 'payment-link-123',
                    deepLinks: {
                        upi: 'upi://pay?...',
                        phonePe: 'phonepe://pay?...',
                        paytm: 'paytmmp://pay?...',
                        gpay: 'tez://upi/pay?...',
                    },
                },
                merchantVPA: 'test@upi',
            });

            const result = await service.createOrder(orderData);

            expect(result.code).toBe(2000);
            expect(result.status).toBe(true);
            expect(result.msg).toBe('Order Created');
            expect(result.data).toBeDefined();
            expect(result.data?.payment_url).toContain('payment-link-123');
            expect(result.data?.session_id).toBe('payment-link-123');
            expect(result.data?.order_id).toBe('EXT123');
            expect(result.data?.upi_intent.bhim_link).toBeDefined();
        });

        it('should require merchantId or connectorId', async () => {
            const result = await service.createOrder({ amount: 1000 });

            expect(result.status).toBe(false);
            expect(result.msg).toContain('merchantId or connectorId');
        });
    });

    describe('getOrder', () => {
        it('should return order by id', async () => {
            const mockOrder = createMockOrder({ id: 'order-123' });
            prismaService.order.findUnique.mockResolvedValue(mockOrder);

            const result = await service.getOrder('order-123');

            expect(result.success).toBe(true);
            expect(result.order.id).toBe('order-123');
        });

        it('should return error if order not found', async () => {
            prismaService.order.findUnique.mockResolvedValue(null);

            const result = await service.getOrder('nonexistent');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Order not found');
        });
    });

    describe('updateOrderStatus', () => {
        it('should update order status', async () => {
            const mockOrder = createMockOrder({ id: 'order-123', status: 'PENDING' });
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({ ...mockOrder, status: 'COMPLETED' });
            prismaService.paymentLink.updateMany.mockResolvedValue({ count: 1 });

            const result = await service.updateOrderStatus('order-123', 'COMPLETED');

            expect(result.success).toBe(true);
            expect(prismaService.order.update).toHaveBeenCalled();
        });
    });

    describe('deleteOrder', () => {
        it('should delete pending order', async () => {
            const mockOrder = createMockOrder({ status: 'PENDING' });
            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.transaction.deleteMany.mockResolvedValue({ count: 0 });
            prismaService.order.delete.mockResolvedValue(mockOrder);

            const result = await service.deleteOrder('order-123');

            expect(result.success).toBe(true);
            expect(prismaService.order.delete).toHaveBeenCalled();
        });

        it('should not delete completed order', async () => {
            const mockOrder = createMockOrder({ status: 'COMPLETED' });
            prismaService.order.findUnique.mockResolvedValue(mockOrder);

            const result = await service.deleteOrder('order-123');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Cannot delete completed orders');
        });
    });

    describe('syncTransaction', () => {
        it('should sync transaction successfully', async () => {
            prismaService.order.findFirst.mockResolvedValue(null);
            prismaService.transaction.findFirst.mockResolvedValue(null);
            prismaService.transaction.create.mockResolvedValue({});

            const result = await service.syncTransaction({
                externalOrderId: 'EXT123',
                merchantId: 'merchant-123',
                amount: 1000,
                status: 'COMPLETED',
            });

            expect(result.success).toBe(true);
            expect(prismaService.transaction.create).toHaveBeenCalled();
        });
    });
});

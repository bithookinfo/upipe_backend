import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.controller';
import { PrismaService } from '../prisma.service';
import { InAppNotificationsService } from '../services/in-app-notifications.service';
import { createMockPrismaService, createMockOrder } from '../../test/utils/test-helpers';

describe('DashboardService', () => {
    let service: DashboardService;
    let prismaService: any;
    let inAppNotificationsService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.order.groupBy = jest.fn();
        prismaService.order.aggregate = jest.fn();
        prismaService.transaction.aggregate = jest.fn();

        inAppNotificationsService = {
            create: jest.fn(),
            list: jest.fn(),
            markAsRead: jest.fn(),
            markAllAsRead: jest.fn(),
            deleteOlderThan: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DashboardService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: InAppNotificationsService,
                    useValue: inAppNotificationsService,
                },
            ],
        }).compile();

        service = module.get<DashboardService>(DashboardService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getDashboardStats', () => {
        it('should return dashboard statistics', async () => {
            const mockStatusGroups = [
                { status: 'COMPLETED', _count: { _all: 1 }, _sum: { amount: 1000 } },
                { status: 'PENDING', _count: { _all: 1 }, _sum: { amount: 500 } },
                { status: 'FAILED', _count: { _all: 1 }, _sum: { amount: 300 } },
            ];

            prismaService.order.groupBy.mockResolvedValue(mockStatusGroups);
            prismaService.order.aggregate.mockResolvedValue({
                _count: { _all: 0 },
                _sum: { amount: 0 },
            });
            prismaService.order.count.mockResolvedValue(0);
            prismaService.order.findMany.mockResolvedValue([]);

            const result = await service.getDashboardStats('7d', undefined, undefined, 'org-123');

            expect(result.overview.totalOrders).toBe(3);
            expect(result.overview.successOrders).toBe(1);
            expect(result.overview.pendingOrders).toBe(1);
            expect(result.overview.failedOrders).toBe(1);
            expect(result.amounts.totalAmount).toBe(1800);
        });

        it('should handle custom date range', async () => {
            prismaService.order.groupBy.mockResolvedValue([]);
            prismaService.order.aggregate.mockResolvedValue({
                _count: { _all: 0 },
                _sum: { amount: 0 },
            });
            prismaService.order.count.mockResolvedValue(0);
            prismaService.order.findMany.mockResolvedValue([]);

            const result = await service.getDashboardStats('7d', '2024-01-01', '2024-01-31', 'org-123');

            expect(prismaService.order.groupBy).toHaveBeenCalled();
            expect(result.overview.totalOrders).toBe(0);
        });

        it('should calculate success rate correctly', async () => {
            const mockStatusGroups = [
                { status: 'COMPLETED', _count: { _all: 2 }, _sum: { amount: 2000 } },
                { status: 'FAILED', _count: { _all: 1 }, _sum: { amount: 500 } },
                { status: 'PENDING', _count: { _all: 1 }, _sum: { amount: 500 } },
            ];

            prismaService.order.groupBy.mockResolvedValue(mockStatusGroups);
            prismaService.order.aggregate.mockResolvedValue({
                _count: { _all: 0 },
                _sum: { amount: 0 },
            });
            prismaService.order.count.mockResolvedValue(0);
            prismaService.order.findMany.mockResolvedValue([]);

            const result = await service.getDashboardStats('7d', undefined, undefined, 'org-123');

            expect(result.overview.successRate).toBe(50);
        });
    });

    describe('getDashboardTransactions', () => {
        it('should return paginated transactions', async () => {
            const mockOrders = [
                { id: 'order-1', transactions: [{ utr: 'UTR123' }] },
            ];

            prismaService.order.findMany.mockResolvedValue(mockOrders);
            prismaService.order.count.mockResolvedValue(1);

            const result = await service.getDashboardTransactions(1, 50, undefined, 'org-123');

            expect(result.success).toBe(true);
            expect(result.transactions).toHaveLength(1);
            expect(result.pagination.total).toBe(1);
        });

        it('should filter by merchantId', async () => {
            prismaService.order.findMany.mockResolvedValue([]);
            prismaService.order.count.mockResolvedValue(0);

            await service.getDashboardTransactions(1, 50, 'merchant-123', 'org-123');

            expect(prismaService.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ merchantId: 'merchant-123', organizationId: 'org-123' }),
                })
            );
        });
    });

    describe('getTransactionStats', () => {
        it('should return transaction statistics', async () => {
            prismaService.transaction.count.mockResolvedValue(100);
            prismaService.transaction.aggregate.mockResolvedValue({ _sum: { amount: 50000 } });

            const result = await service.getTransactionStats();

            expect(result.success).toBe(true);
            expect(result.stats.totalTransactions).toBe(100);
            expect(result.stats.totalAmount).toBe(50000);
        });
    });
});

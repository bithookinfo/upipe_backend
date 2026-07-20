import { Test, TestingModule } from '@nestjs/testing';
import { CallbackService } from './callback.service';
import { PrismaService } from '../prisma.service';
import { OrderEventsService } from './order-events.service';
import { Logger } from '@nestjs/common';
import {
    createMockPrismaService,
    createMockOrder,
} from '../../test/utils/test-helpers';

describe('CallbackService', () => {
    let service: CallbackService;
    let prismaService: any;
    let orderEventsService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.callbackLog = {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };

        orderEventsService = {
            addClient: jest.fn(),
            removeClient: jest.fn(),
            broadcastOrderUpdated: jest.fn(),
        };

        // Mock environment variable
        process.env.WEBHOOK_SECRET = 'test-webhook-secret-12345';

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CallbackService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: OrderEventsService,
                    useValue: orderEventsService,
                },
            ],
        }).compile();

        service = module.get<CallbackService>(CallbackService);

        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('resendWebhook', () => {
        it('should queue webhook for resend', async () => {
            const orderId = 'order-123';
            const mockOrder = createMockOrder({
                id: orderId,
                callbackUrl: 'https://merchant.com/webhook',
            });

            prismaService.order.findUnique.mockResolvedValue(mockOrder);
            prismaService.order.update.mockResolvedValue({
                ...mockOrder,
                webhookSent: false,
            });

            const result = await service.resendWebhook(orderId);

            expect(result.success).toBe(true);
            expect(prismaService.order.update).toHaveBeenCalled();
        });

        it('should throw error if order not found', async () => {
            prismaService.order.findUnique.mockResolvedValue(null);

            await expect(service.resendWebhook('nonexistent'))
                .rejects
                .toThrow('Order not found');
        });
    });

    describe('sendPendingWebhooks', () => {
        it('should process pending webhooks', async () => {
            prismaService.callbackLog.findMany.mockResolvedValue([]);
            prismaService.order.findMany.mockResolvedValue([]);

            await service.sendPendingWebhooks();

            expect(prismaService.callbackLog.findMany).toHaveBeenCalled();
        });
    });
});

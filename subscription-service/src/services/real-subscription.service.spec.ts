import { Test, TestingModule } from '@nestjs/testing';
import { RealSubscriptionService } from './real-subscription.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import {
    createMockPrismaService,
    createMockSubscriptionPlan,
    createMockSubscription,
} from '../../test/utils/test-helpers';

describe('RealSubscriptionService', () => {
    let service: RealSubscriptionService;
    let prismaService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RealSubscriptionService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
            ],
        }).compile();

        service = module.get<RealSubscriptionService>(RealSubscriptionService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getSubscriptionPlans', () => {
        it('should return all subscription plans', async () => {
            const mockPlans = [
                createMockSubscriptionPlan({ code: 'FREE' }),
                createMockSubscriptionPlan({ code: 'BASIC', price: 999 }),
            ];
            const mockPlansWithProviders = mockPlans.map(p => ({
                ...p,
                providerAccess: [],
            }));

            prismaService.subscriptionPlan.findMany.mockResolvedValue(mockPlansWithProviders);

            const result = await service.getSubscriptionPlans();

            expect(result.plans).toHaveLength(2);
            expect(result.plans[0].code).toBe('FREE');
        });
    });

    describe('getOrganizationSubscription', () => {
        it('should return subscription for organization', async () => {
            const orgId = 'org-123';
            const mockSubscription = {
                ...createMockSubscription({ organizationId: orgId }),
                plan: { ...createMockSubscriptionPlan(), providerAccess: [] },
                usage: [],
            };

            prismaService.orgSubscription.findUnique.mockResolvedValue(mockSubscription);

            const result = await service.getOrganizationSubscription(orgId);

            expect(result.success).toBe(true);
            expect(result.subscription.organizationId).toBe(orgId);
        });

        it('should return failure if no subscription found', async () => {
            prismaService.orgSubscription.findUnique.mockResolvedValue(null);

            const result = await service.getOrganizationSubscription('org-123');

            expect(result.success).toBe(false);
        });
    });

    describe('createOrganizationSubscription', () => {
        it('should create new subscription', async () => {
            const orgId = 'org-123';
            const planId = 'plan-free';
            const mockPlan = { ...createMockSubscriptionPlan({ id: planId }), providerAccess: [] };
            const mockSubscription = {
                ...createMockSubscription({ organizationId: orgId }),
                plan: mockPlan,
            };

            prismaService.subscriptionPlan.findUnique.mockResolvedValue(mockPlan);
            prismaService.orgSubscription.findUnique.mockResolvedValue(null);
            prismaService.orgSubscription.upsert.mockResolvedValue(mockSubscription);
            prismaService.subscriptionUsage.upsert.mockResolvedValue({});

            const result = await service.createOrganizationSubscription(orgId, planId, {});

            expect(result.subscription.organizationId).toBe(orgId);
            expect(prismaService.orgSubscription.upsert).toHaveBeenCalled();
        });

        it('should return idempotent success when already on the same active plan', async () => {
            const orgId = 'org-123';
            const planId = 'plan-pro';
            const mockPlan = { ...createMockSubscriptionPlan({ id: planId }), providerAccess: [] };
            const existing = {
                ...createMockSubscription({ organizationId: orgId, planId, status: 'ACTIVE' }),
                startDate: new Date(),
                trialEndsAt: null,
            };
            const loaded = {
                ...existing,
                plan: mockPlan,
            };

            prismaService.subscriptionPlan.findUnique.mockResolvedValue(mockPlan);
            prismaService.orgSubscription.findUnique
                .mockResolvedValueOnce(existing)
                .mockResolvedValueOnce(loaded);

            const result = await service.createOrganizationSubscription(orgId, planId, {});

            expect(result.success).toBe(true);
            expect(result.message).toBe('Already subscribed to this plan');
            expect(prismaService.orgSubscription.upsert).not.toHaveBeenCalled();
        });

        it('should upsert when switching from one active plan to another', async () => {
            const orgId = 'org-123';
            const oldPlanId = 'plan-basic';
            const newPlanId = 'plan-pro';
            const mockPlan = { ...createMockSubscriptionPlan({ id: newPlanId }), providerAccess: [] };
            const existing = {
                ...createMockSubscription({ organizationId: orgId, planId: oldPlanId, status: 'ACTIVE' }),
                startDate: new Date(),
                trialEndsAt: null,
            };
            const mockSubscription = {
                ...createMockSubscription({ organizationId: orgId, planId: newPlanId, status: 'ACTIVE' }),
                plan: mockPlan,
            };

            prismaService.subscriptionPlan.findUnique.mockResolvedValue(mockPlan);
            prismaService.orgSubscription.findUnique.mockResolvedValue(existing);
            prismaService.orgSubscription.upsert.mockResolvedValue(mockSubscription);
            prismaService.subscriptionUsage.upsert.mockResolvedValue({});

            const result = await service.createOrganizationSubscription(orgId, newPlanId, {});

            expect(result.success).toBe(true);
            expect(prismaService.orgSubscription.upsert).toHaveBeenCalled();
        });
    });

    describe('updateSubscriptionUsage', () => {
        it('should increment transaction count', async () => {
            const orgId = 'org-123';
            const mockSubscription = {
                id: 'sub-123',
                organizationId: orgId,
                plan: { ...createMockSubscriptionPlan(), providerAccess: [] },
                usage: [],
                customLimits: null,
            };

            prismaService.orgSubscription.findUnique.mockResolvedValue(mockSubscription);
            prismaService.subscriptionUsage.upsert.mockResolvedValue({ transactionsCount: 1 });

            const result = await service.updateSubscriptionUsage(orgId, 'PROCESS_TRANSACTION');

            expect(result.success).toBe(true);
            expect(prismaService.subscriptionUsage.upsert).toHaveBeenCalled();
        });
    });

    describe('checkSubscriptionLimits', () => {
        it('should return allowed if within limits', async () => {
            const orgId = 'org-123';
            const mockSubscription = {
                id: 'sub-123',
                organizationId: orgId,
                status: 'ACTIVE',
                trialEndsAt: null,
                limits: { maxTransactions: 1000 },
                currentUsage: { transactionsCount: 50 },
                plan: createMockSubscriptionPlan({ maxTransactions: 1000 }),
                usage: [{ transactionsCount: 50 }],
                customLimits: null,
            };

            prismaService.orgSubscription.findUnique.mockResolvedValue({
                ...mockSubscription,
                plan: { ...createMockSubscriptionPlan(), providerAccess: [] },
            });

            const result = await service.checkSubscriptionLimits(orgId, 'PROCESS_TRANSACTION');

            expect(result.allowed).toBe(true);
        });
    });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InternalSubscriptionsController } from './internal-subscriptions.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('InternalSubscriptionsController', () => {
  let controller: InternalSubscriptionsController;
  let prismaService: PrismaService;
  let configService: ConfigService;

  const mockPrismaService = {
    orgSubscription: {
      findFirst: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalSubscriptionsController],
      providers: [
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<InternalSubscriptionsController>(InternalSubscriptionsController);
    prismaService = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
    
    // Default valid token setup
    mockConfigService.get.mockReturnValue('valid-token');
    
    // Reset date mock
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should throw 500 if INTERNAL_TOKEN env is missing', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      await expect(
        controller.validateAssignment('sub-1', 'valid-token', 'org-1')
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 401 if x-internal-token is missing', async () => {
      await expect(
        controller.validateAssignment('sub-1', undefined, 'org-1')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw 401 if x-internal-token is wrong', async () => {
      await expect(
        controller.validateAssignment('sub-1', 'wrong-token', 'org-1')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw 400 if x-organization-id is missing', async () => {
      await expect(
        controller.validateAssignment('sub-1', 'valid-token', undefined)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('validateAssignment', () => {
    const baseSubscription = {
      id: 'sub-1',
      organizationId: 'org-1',
      status: 'ACTIVE',
      startDate: new Date('2020-01-01'),
      endDate: new Date('2030-01-01'),
      plan: {
        id: 'plan-1',
        name: 'Business',
        code: 'BUSINESS'
      }
    };

    it('should throw 404 if subscription is unknown or belongs to another organization', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue(null);
      await expect(
        controller.validateAssignment('sub-1', 'valid-token', 'org-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should return assignable: true for UNASSIGNED + valid dates', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        status: 'UNASSIGNED'
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(true);
      expect(res.reasonCode).toBeNull();
      
      // Ensure it excludes unnecessary fields (like customLimits, purchase payment metadata, etc - these are omitted via Prisma select)
      expect(res.subscription).not.toHaveProperty('customLimits');
      expect(res.subscription).not.toHaveProperty('purchaseId');
    });

    it('should return assignable: true for ACTIVE + valid dates', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        status: 'ACTIVE'
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(true);
      expect(res.reasonCode).toBeNull();
    });

    it('should return assignable: false for EXPIRED status', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        status: 'EXPIRED'
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(false);
      expect(res.reasonCode).toBe('SUBSCRIPTION_EXPIRED');
    });

    it('should return assignable: false if endDate already passed', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        endDate: new Date('2020-12-31') // Past date
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(false);
      expect(res.reasonCode).toBe('SUBSCRIPTION_EXPIRED');
    });

    it('should return assignable: false if startDate is in future', async () => {
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        startDate: new Date('2099-01-01') // Future date
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(false);
      expect(res.reasonCode).toBe('SUBSCRIPTION_NOT_STARTED');
    });

    it('should ensure maxMerchants is NOT validated/checked (always assignable)', async () => {
      // The implementation doesn't fetch maxMerchants or count merchants.
      // This test just ensures the response is assignable: true without caring about counts.
      mockPrismaService.orgSubscription.findFirst.mockResolvedValue({
        ...baseSubscription,
        status: 'ACTIVE'
      });
      const res = await controller.validateAssignment('sub-1', 'valid-token', 'org-1');
      expect(res.assignable).toBe(true);
    });
  });
});

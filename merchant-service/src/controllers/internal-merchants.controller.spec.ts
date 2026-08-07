import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InternalMerchantsController } from './internal-merchants.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('InternalMerchantsController', () => {
  let controller: InternalMerchantsController;
  let prismaService: PrismaService;
  let configService: ConfigService;

  const mockPrismaService = {
    merchant: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalMerchantsController],
      providers: [
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<InternalMerchantsController>(InternalMerchantsController);
    prismaService = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
    
    // Default valid token setup
    mockConfigService.get.mockReturnValue('valid-token');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('should throw 500 if INTERNAL_TOKEN env is missing', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      await expect(
        controller.getSubscriptionAssignment('merchant-1', 'valid-token', 'org-1')
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw 401 if x-internal-token is missing', async () => {
      await expect(
        controller.getSubscriptionAssignment('merchant-1', undefined, 'org-1')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw 401 if x-internal-token is wrong', async () => {
      await expect(
        controller.getSubscriptionAssignment('merchant-1', 'wrong-token', 'org-1')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw 400 if x-organization-id is missing', async () => {
      await expect(
        controller.getSubscriptionAssignment('merchant-1', 'valid-token', undefined)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getSubscriptionAssignment', () => {
    it('should throw 404 if merchant belongs to another organization (or is soft-deleted)', async () => {
      mockPrismaService.merchant.findFirst.mockResolvedValue(null);
      await expect(
        controller.getSubscriptionAssignment('merchant-1', 'valid-token', 'org-1')
      ).rejects.toThrow(NotFoundException);
    });

    it('should return assigned: true for an existing assigned merchant', async () => {
      mockPrismaService.merchant.findFirst.mockResolvedValue({
        id: 'merchant-1',
        organizationId: 'org-1',
        orgSubscriptionId: 'sub-1',
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
      });

      const res = await controller.getSubscriptionAssignment('merchant-1', 'valid-token', 'org-1');
      expect(res.assigned).toBe(true);
      expect(res.orgSubscriptionId).toBe('sub-1');
      expect(res.merchantId).toBe('merchant-1');
    });

    it('should return assigned: false for an existing unassigned merchant', async () => {
      mockPrismaService.merchant.findFirst.mockResolvedValue({
        id: 'merchant-1',
        organizationId: 'org-1',
        orgSubscriptionId: null,
        status: 'ACTIVE',
        isActive: true,
        deletedAt: null,
      });

      const res = await controller.getSubscriptionAssignment('merchant-1', 'valid-token', 'org-1');
      expect(res.assigned).toBe(false);
      expect(res.orgSubscriptionId).toBeNull();
    });
  });

  describe('getMerchantsBySubscription', () => {
    it('should include inactive, non-deleted merchants and never contain credentials or metadata', async () => {
      mockPrismaService.merchant.findMany.mockResolvedValue([
        {
          id: 'merchant-1',
          name: 'Merchant 1',
          businessName: 'Business 1',
          organizationId: 'org-1',
          orgSubscriptionId: 'sub-1',
          isActive: false, // inactive but not deleted
          status: 'INACTIVE',
        },
      ]);

      const res = await controller.getMerchantsBySubscription('sub-1', 'valid-token', 'org-1');
      
      expect(res.success).toBe(true);
      expect(res.count).toBe(1);
      expect(res.merchants[0].isActive).toBe(false);
      
      // Ensure credentials/metadata are not in the response (they shouldn't be mapped)
      expect(res.merchants[0]).not.toHaveProperty('credentials');
      expect(res.merchants[0]).not.toHaveProperty('metadata');
      
      // Verify prisma call args
      expect(mockPrismaService.merchant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            orgSubscriptionId: 'sub-1',
            deletedAt: null,
          }
        })
      );
    });

    it('should exclude soft-deleted merchants', async () => {
      mockPrismaService.merchant.findMany.mockResolvedValue([]);
      
      const res = await controller.getMerchantsBySubscription('sub-1', 'valid-token', 'org-1');
      expect(res.count).toBe(0);

      // Verify that deletedAt: null is strictly enforced
      expect(mockPrismaService.merchant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
          })
        })
      );
    });
  });
});

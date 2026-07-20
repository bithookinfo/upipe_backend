import { Test, TestingModule } from "@nestjs/testing";
import { MerchantService } from "./merchant.service";
import { PrismaService } from "../../prisma/prisma.service";
import { NotFoundException } from "@nestjs/common";
import {
  createMockPrismaService,
  createMockMerchant,
} from "../../../test/utils/test-helpers";
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("MerchantService", () => {
  let service: MerchantService;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
      ],
    }).compile();

    service = module.get<MerchantService>(MerchantService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("getAllMerchants", () => {
    it("should return list of all merchants", async () => {
      const mockMerchants = [
        {
          ...createMockMerchant(),
          config: null,
          category: null,
          providers: [],
        },
        {
          ...createMockMerchant(),
          config: null,
          category: null,
          providers: [],
        },
      ];
      prismaService.merchant.findMany.mockResolvedValue(mockMerchants);

      const result = await service.getAllMerchants();

      expect(result).toHaveLength(2);
      expect(prismaService.merchant.findMany).toHaveBeenCalled();
    });
  });

  describe("getMerchant", () => {
    it("should return merchant by id", async () => {
      const mockMerchant = {
        ...createMockMerchant({ id: "merchant-123" }),
        config: null,
        category: null,
        providers: [],
      };
      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);

      const result = await service.getMerchant("merchant-123");

      expect(result.success).toBe(true);
      expect(result.merchant.id).toBe("merchant-123");
    });

    it("should throw NotFoundException if merchant not found", async () => {
      prismaService.merchant.findUnique.mockResolvedValue(null);

      await expect(service.getMerchant("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getMerchantsByOrganization", () => {
    it("should return merchants for organization", async () => {
      const orgId = "org-123";
      const mockMerchants = [
        {
          ...createMockMerchant({ organizationId: orgId }),
          config: null,
          category: null,
        },
      ];
      prismaService.merchant.findMany.mockResolvedValue(mockMerchants);

      const result = await service.getMerchantsByOrganization(orgId);

      expect(result.success).toBe(true);
      expect(result.merchants).toHaveLength(1);
      expect(result.merchants[0].organizationId).toBe(orgId);
    });
  });

  describe("createMerchant", () => {
    it("should create new merchant", async () => {
      const createDto = {
        organizationId: "org-123",
        name: "Test Merchant",
        businessName: "Test Business",
        email: "test@merchant.com",
      };
      const mockMerchant = createMockMerchant(createDto);

      // Mock subscription check (axios call)
      mockedAxios.get.mockResolvedValue({
        data: { allowed: true },
      });
      mockedAxios.post.mockResolvedValue({
        data: { success: true },
      });

      prismaService.merchant.create.mockResolvedValue(mockMerchant);

      const result = await service.createMerchant(createDto);

      expect(result.success).toBe(true);
      expect(result.merchant.name).toBe("Test Merchant");
      expect(prismaService.merchant.create).toHaveBeenCalled();
    });
  });

  describe("validateMerchantForTransaction", () => {
    it("should return canProcess true for valid merchant", async () => {
      const merchantId = "merchant-123";
      const amount = 100;
      const mockMerchant = {
        ...createMockMerchant({
          id: merchantId,
          status: "ACTIVE",
          isActive: true,
          verified: true,
        }),
        config: {
          openTime: "00:00",
          closeTime: "23:59",
          dailyMaxAmount: 10000,
          dailyMaxTxnCount: 100,
          monthlyMaxAmount: 100000,
          currentDailyAmount: 0,
          currentDailyTxnCount: 0,
          currentMonthlyAmount: 0,
          currentMonthlyTxnCount: 0,
          lastDailyReset: new Date(),
        },
        category: { name: "E-Commerce" },
      };

      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);

      const result = await service.validateMerchantForTransaction(
        merchantId,
        amount,
      );

      expect(result.canProcess).toBe(true);
      expect(result.merchant).toBeDefined();
    });

    it("should return canProcess false if merchant not found", async () => {
      prismaService.merchant.findUnique.mockResolvedValue(null);

      const result = await service.validateMerchantForTransaction(
        "nonexistent",
        100,
      );

      expect(result.canProcess).toBe(false);
      expect(result.reason).toBe("MERCHANT_NOT_FOUND");
    });

    it("should return canProcess false if merchant inactive", async () => {
      const mockMerchant = {
        ...createMockMerchant({ isActive: false }),
        config: null,
        category: null,
      };
      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);

      const result = await service.validateMerchantForTransaction(
        "merchant-123",
        100,
      );

      expect(result.canProcess).toBe(false);
      expect(result.reason).toBe("MERCHANT_INACTIVE");
    });
  });
});

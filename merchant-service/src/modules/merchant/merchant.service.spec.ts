import { Test, TestingModule } from "@nestjs/testing";
import { MerchantService } from "./merchant.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { NotFoundException, BadRequestException, ServiceUnavailableException, InternalServerErrorException } from "@nestjs/common";
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
  let configService: any;

  beforeEach(async () => {
    prismaService = createMockPrismaService();
    prismaService.merchant.findFirst = jest.fn();
    mockedAxios.isAxiosError = jest.fn().mockReturnValue(false) as any;
    configService = {
      get: jest.fn().mockImplementation((key) => {
        if (key === 'PLAN_ASSIGNMENT_ENFORCEMENT_ENABLED') return 'false';
        if (key === 'SUBSCRIPTION_SERVICE_URL') return 'http://subscription-service';
        if (key === 'INTERNAL_TOKEN') return 'valid-token';
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MerchantService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
        {
          provide: ConfigService,
          useValue: configService,
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

  describe("createMerchant", () => {
    const createDto = {
      organizationId: "org-1",
      name: "New Merchant",
      status: "PENDING",
      isSuperAdmin: false,
    };

    it("should create a new merchant successfully with null plan if flag is false and no plan supplied", async () => {
      configService.get.mockImplementation((k) => k === 'PLAN_ASSIGNMENT_ENFORCEMENT_ENABLED' ? 'false' : undefined);
      prismaService.merchant.create.mockResolvedValue({ id: "m-new", ...createDto, orgSubscriptionId: null });

      const result = await service.createMerchant(createDto as any);

      expect(result.success).toBe(true);
      expect(prismaService.merchant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orgSubscriptionId: null }),
      });
    });

    it("should throw 400 if enforcement is true, plan is missing, and not a platform merchant", async () => {
      configService.get.mockImplementation((k) => k === 'PLAN_ASSIGNMENT_ENFORCEMENT_ENABLED' ? 'true' : undefined);
      await expect(service.createMerchant(createDto as any)).rejects.toThrow(BadRequestException);
    });

    it("should create a platform merchant with null plan even if enforcement is true", async () => {
      configService.get.mockImplementation((k) => k === 'PLAN_ASSIGNMENT_ENFORCEMENT_ENABLED' ? 'true' : undefined);
      prismaService.merchant.create.mockResolvedValue({ id: "m-new", ...createDto, isPlatform: true, orgSubscriptionId: null });

      const result = await service.createMerchant({ ...createDto, isSuperAdmin: true } as any);

      expect(result.success).toBe(true);
      expect(prismaService.merchant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orgSubscriptionId: null, isPlatform: true }),
      });
    });

    it("should throw 503 if subscription-service configuration is missing", async () => {
      configService.get.mockReturnValue(undefined); // No token or URL
      await expect(service.createMerchant({ ...createDto, orgSubscriptionId: "sub-1" } as any))
        .rejects.toThrow(ServiceUnavailableException);
    });

    it("should validate and persist valid plan from same organization", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { assignable: true } });
      prismaService.merchant.create.mockResolvedValue({ id: "m-new", ...createDto, orgSubscriptionId: "sub-1" });

      const result = await service.createMerchant({ ...createDto, orgSubscriptionId: "sub-1" } as any);

      expect(result.success).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalled();
      expect(prismaService.merchant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orgSubscriptionId: "sub-1" }),
      });
    });

    it("should reject cross-organization plan with 404 SUBSCRIPTION_NOT_FOUND", async () => {
      (mockedAxios.isAxiosError as any).mockReturnValueOnce(true);
      const axiosError: any = new Error('Not found');
      axiosError.isAxiosError = true;
      axiosError.response = { status: 404 };
      mockedAxios.get.mockRejectedValueOnce(axiosError);
      await expect(service.createMerchant({ ...createDto, orgSubscriptionId: "sub-x" } as any))
        .rejects.toThrow(NotFoundException);
    });

    it("should reject expired/future plan with 400 SUBSCRIPTION_NOT_ASSIGNABLE", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { assignable: false, reasonCode: "SUBSCRIPTION_EXPIRED" } });
      await expect(service.createMerchant({ ...createDto, orgSubscriptionId: "sub-exp" } as any))
        .rejects.toThrow(BadRequestException);
    });

    it("should not partially assign if prisma create fails", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { assignable: true } });
      prismaService.merchant.create.mockRejectedValueOnce(new Error("DB Error"));

      await expect(service.createMerchant({ ...createDto, orgSubscriptionId: "sub-1" } as any))
        .rejects.toThrow(InternalServerErrorException);
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
      prismaService.merchant.findFirst.mockResolvedValue(mockMerchant);

      const result = await service.getMerchant("merchant-123", "org-123");

      expect(result.success).toBe(true);
      expect(result.merchant.id).toBe("merchant-123");
    });

    it("should throw NotFoundException if merchant not found", async () => {
      prismaService.merchant.findFirst.mockResolvedValue(null);

      await expect(service.getMerchant("nonexistent", "org-123")).rejects.toThrow(
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

      prismaService.merchant.findFirst.mockResolvedValue(mockMerchant);

      const result = await service.validateMerchantForTransaction(
        merchantId,
        "org-123",
        amount,
      );

      expect(result.canProcess).toBe(true);
      expect(result.merchant).toBeDefined();
    });

    it("should return canProcess false if merchant not found", async () => {
      prismaService.merchant.findFirst.mockResolvedValue(null);

      const result = await service.validateMerchantForTransaction(
        "nonexistent",
        "org-123",
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
      prismaService.merchant.findFirst.mockResolvedValue(mockMerchant);

      const result = await service.validateMerchantForTransaction(
        "merchant-123",
        "org-123",
        100,
      );

      expect(result.canProcess).toBe(false);
      expect(result.reason).toBe("MERCHANT_INACTIVE");
    });
  });
});

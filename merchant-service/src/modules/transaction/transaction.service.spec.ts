import { Test, TestingModule } from "@nestjs/testing";
import { TransactionService } from "./transaction.service";
import { PrismaService } from "../../prisma/prisma.service";
import { PaytmSimpleService } from "../provider/paytm-simple.service";
import { PhonePeSimpleService } from "../provider/phonepe-simple.service";
import { BharatPeSimpleService } from "../provider/bharatpe-simple.service";
import { QuintusPaySimpleService } from "../provider/quintuspay-simple.service";
import { HdfcVyaparService } from "../provider/hdfc-vyapar.service";
import { GpayService } from "../gpay/gpay.service";
import { NotFoundException } from "@nestjs/common";
import {
  createMockPrismaService,
  createMockProvider,
} from "../../../test/utils/test-helpers";

describe("TransactionService", () => {
  let service: TransactionService;
  let prismaService: any;
  let paytmService: any;
  let phonepeService: any;
  let bharatpeService: any;
  let gpayService: any;

  beforeEach(async () => {
    prismaService = createMockPrismaService();
    paytmService = {
      fetchTransactionHistory: jest.fn(),
    };
    phonepeService = {
      fetchTransactionHistory: jest.fn(),
    };
    bharatpeService = {
      fetchTransactionHistory: jest.fn(),
    };
    gpayService = {
      fetchTransactionHistory: jest.fn(),
    };
    const quintusPayService = {
      fetchTransactionHistory: jest.fn(),
    };
    const hdfcService = {
      fetchTransactionHistory: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
        {
          provide: PaytmSimpleService,
          useValue: paytmService,
        },
        {
          provide: PhonePeSimpleService,
          useValue: phonepeService,
        },
        {
          provide: BharatPeSimpleService,
          useValue: bharatpeService,
        },
        {
          provide: QuintusPaySimpleService,
          useValue: quintusPayService,
        },
        {
          provide: GpayService,
          useValue: gpayService,
        },
        {
          provide: HdfcVyaparService,
          useValue: hdfcService,
        },
      ],
    }).compile();

    service = module.get<TransactionService>(TransactionService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("getTransactions", () => {
    it("should fetch transactions for valid merchant", async () => {
      const merchantId = "merchant-123";
      const mockMerchant = { id: merchantId, name: "Test Merchant" };

      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              transactions: [],
              pagination: { page: 1, limit: 50, total: 0 },
            }),
        }),
      ) as any;

      const result = await service.getTransactions(merchantId, "org-1");

      expect(result.success).toBe(true);
      expect(prismaService.merchant.findFirst).toHaveBeenCalledWith({
        where: { id: merchantId, organizationId: "org-1", deletedAt: null },
      });
    });

    it("should throw NotFoundException if merchant not found", async () => {
      prismaService.merchant.findFirst.mockResolvedValue(null);

      await expect(
        service.getTransactions("nonexistent", "org-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("syncTransactions", () => {
    it("should sync transactions from providers", async () => {
      const merchantId = "merchant-123";
      const mockMerchant = {
        id: merchantId,
        organizationId: "org-1",
        providers: [createMockProvider()],
      };

      prismaService.merchant.findFirst.mockResolvedValue(mockMerchant as any);
      paytmService.fetchTransactionHistory.mockResolvedValue({
        success: true,
        transactions: [],
      });

      const result = await service.syncTransactions(
        merchantId,
        "org-1",
        new Date(),
        new Date(),
      );

      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
    });

    it("should handle sync failures gracefully", async () => {
      const merchantId = "merchant-123";
      const mockMerchant = {
        id: merchantId,
        organizationId: "org-1",
        providers: [createMockProvider()],
      };

      prismaService.merchant.findFirst.mockResolvedValue(mockMerchant as any);
      paytmService.fetchTransactionHistory.mockRejectedValue(
        new Error("API Error"),
      );

      const result = await service.syncTransactions(
        merchantId,
        "org-1",
        new Date(),
        new Date(),
      );

      expect(result.success).toBe(true);
      expect(result.results[0].success).toBe(false);
    });
  });

  describe("getTransactionStats", () => {
    it("should return stats for merchant", async () => {
      const merchantId = "merchant-123";
      prismaService.merchant.findFirst.mockResolvedValue({
        id: merchantId,
        organizationId: "org-1",
      } as any);

      const result = await service.getTransactionStats(merchantId, "org-1");

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
    });
  });
});

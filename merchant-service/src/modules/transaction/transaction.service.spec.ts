import { Test, TestingModule } from "@nestjs/testing";
import { TransactionService } from "./transaction.service";
import { PrismaService } from "../../prisma/prisma.service";
import { PaytmSimpleService } from "../provider/paytm-simple.service";
import { PhonePeSimpleService } from "../provider/phonepe-simple.service";
import { BharatPeSimpleService } from "../provider/bharatpe-simple.service";
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
          provide: GpayService,
          useValue: gpayService,
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

      const result = await service.getTransactions(merchantId);

      expect(result.success).toBe(true);
      expect(prismaService.merchant.findUnique).toHaveBeenCalledWith({
        where: { id: merchantId },
      });
    });

    it("should throw NotFoundException if merchant not found", async () => {
      prismaService.merchant.findUnique.mockResolvedValue(null);

      await expect(service.getTransactions("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("syncTransactions", () => {
    it("should sync transactions from providers", async () => {
      const merchantId = "merchant-123";
      const mockMerchant = {
        id: merchantId,
        providers: [createMockProvider()],
      };

      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);
      paytmService.fetchTransactionHistory.mockResolvedValue({
        success: true,
        transactions: [],
      });

      const result = await service.syncTransactions(
        merchantId,
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
        providers: [createMockProvider()],
      };

      prismaService.merchant.findUnique.mockResolvedValue(mockMerchant);
      paytmService.fetchTransactionHistory.mockRejectedValue(
        new Error("API Error"),
      );

      const result = await service.syncTransactions(
        merchantId,
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
      prismaService.merchant.findUnique.mockResolvedValue({
        id: merchantId,
      });

      const result = await service.getTransactionStats(merchantId);

      expect(result.success).toBe(true);
      expect(result.stats).toBeDefined();
    });
  });
});

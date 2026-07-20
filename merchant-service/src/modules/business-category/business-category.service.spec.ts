import { Test, TestingModule } from "@nestjs/testing";
import { BusinessCategoryService } from "./business-category.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ConflictException, NotFoundException } from "@nestjs/common";

describe("BusinessCategoryService", () => {
  let service: BusinessCategoryService;
  let prismaService: any;

  beforeEach(async () => {
    prismaService = {
      businessCategory: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      merchant: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessCategoryService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
      ],
    }).compile();

    service = module.get<BusinessCategoryService>(BusinessCategoryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("createCategory", () => {
    it("should create new category", async () => {
      const mockCategory = {
        id: "cat-1",
        name: "Electronics",
        code: "ELECTRONICS",
        isActive: true,
      };

      prismaService.businessCategory.findUnique.mockResolvedValue(null);
      prismaService.businessCategory.create.mockResolvedValue(mockCategory);

      const result = await service.createCategory({
        name: "Electronics",
        code: "electronics",
        description: "Electronics stores",
      });

      expect(result.success).toBe(true);
      expect(result.category.code).toBe("ELECTRONICS");
    });

    it("should throw ConflictException for duplicate code", async () => {
      const existing = { id: "cat-1", code: "RETAIL" };
      prismaService.businessCategory.findUnique.mockResolvedValue(existing);

      await expect(
        service.createCategory({ name: "Retail", code: "RETAIL" }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("getCategories", () => {
    it("should return all categories", async () => {
      const mockCategories = [
        { id: "cat-1", name: "Retail", code: "RETAIL", isActive: true },
        { id: "cat-2", name: "Food", code: "FOOD", isActive: true },
      ];

      prismaService.businessCategory.findMany.mockResolvedValue(mockCategories);

      const result = await service.getCategories();

      expect(result.success).toBe(true);
      expect(result.categories).toHaveLength(2);
    });

    it("should filter by search term", async () => {
      prismaService.businessCategory.findMany.mockResolvedValue([]);

      await service.getCategories({ search: "electronics" });

      expect(prismaService.businessCategory.findMany).toHaveBeenCalled();
    });

    it("should include merchant count when requested", async () => {
      const categoriesWithMerchants = [
        {
          id: "cat-1",
          name: "Retail",
          merchants: [{ id: "m1" }, { id: "m2" }],
        },
      ];

      prismaService.businessCategory.findMany.mockResolvedValue(
        categoriesWithMerchants,
      );

      const result = await service.getCategories({ includeCount: true });

      expect(result.categories[0].merchantCount).toBe(2);
    });
  });

  describe("getCategory", () => {
    it("should return category with merchants", async () => {
      const mockCategory = {
        id: "cat-1",
        name: "Retail",
        merchants: [{ id: "m1" }, { id: "m2" }],
      };

      prismaService.businessCategory.findUnique.mockResolvedValue(mockCategory);

      const result = await service.getCategory("cat-1");

      expect(result.success).toBe(true);
      expect(result.category.merchantCount).toBe(2);
    });

    it("should throw NotFoundException for invalid category", async () => {
      prismaService.businessCategory.findUnique.mockResolvedValue(null);

      await expect(service.getCategory("invalid-id")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateCategory", () => {
    it("should update category details", async () => {
      const updated = { id: "cat-1", name: "Updated Name", isActive: true };
      prismaService.businessCategory.update.mockResolvedValue(updated);

      const result = await service.updateCategory("cat-1", {
        name: "Updated Name",
      });

      expect(result.success).toBe(true);
      expect(prismaService.businessCategory.update).toHaveBeenCalled();
    });
  });

  describe("deleteCategory", () => {
    it("should delete category without active merchants", async () => {
      prismaService.merchant.count.mockResolvedValue(0);
      prismaService.businessCategory.delete.mockResolvedValue({
        id: "cat-1",
      });

      const result = await service.deleteCategory("cat-1");

      expect(result.success).toBe(true);
    });

    it("should throw ConflictException if category has active merchants", async () => {
      prismaService.merchant.count.mockResolvedValue(5);

      await expect(service.deleteCategory("cat-1")).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("getMerchantsByCategory", () => {
    it("should return paginated merchants for category", async () => {
      const mockMerchants = [
        { id: "m1", categoryId: "cat-1", name: "Merchant 1" },
      ];

      prismaService.merchant.findMany.mockResolvedValue(mockMerchants);
      prismaService.merchant.count.mockResolvedValue(1);

      const result = await service.getMerchantsByCategory("cat-1", {
        page: 1,
        limit: 20,
      });

      expect(result.success).toBe(true);
      expect(result.merchants).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });
});

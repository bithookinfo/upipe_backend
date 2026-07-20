import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class BusinessCategoryService {
  private readonly logger = new Logger(BusinessCategoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createPredefinedCategories() {
    try {
      this.logger.log("🏷️ Creating predefined business categories...");

      const predefinedCategories = [
        {
          name: "Retail Store",
          code: "RETAIL",
          description: "General retail and shopping stores",
        },
        {
          name: "Restaurant & Food",
          code: "RESTAURANT",
          description: "Restaurants, cafes, food delivery",
        },
        {
          name: "Grocery & Supermarket",
          code: "GROCERY",
          description: "Grocery stores and supermarkets",
        },
        {
          name: "Medical & Healthcare",
          code: "MEDICAL",
          description: "Hospitals, clinics, pharmacies",
        },
        {
          name: "Petrol Pump & Fuel",
          code: "PETROL",
          description: "Petrol pumps and fuel stations",
        },
        {
          name: "Electronics & Mobile",
          code: "ELECTRONICS",
          description: "Electronics and mobile stores",
        },
        {
          name: "Fashion & Clothing",
          code: "FASHION",
          description: "Clothing and fashion stores",
        },
        {
          name: "Education & Training",
          code: "EDUCATION",
          description: "Schools, colleges, training centers",
        },
        {
          name: "Beauty & Salon",
          code: "BEAUTY",
          description: "Beauty parlors and salons",
        },
        {
          name: "Travel & Transport",
          code: "TRAVEL",
          description: "Travel agencies and transport",
        },
        {
          name: "Services & Repairs",
          code: "SERVICES",
          description: "Service providers and repairs",
        },
        { name: "Other", code: "OTHER", description: "Other business types" },
      ];

      const createdCategories = [];
      for (const category of predefinedCategories) {
        try {
          const existing = await this.prisma.businessCategory.findUnique({
            where: { code: category.code },
          });

          if (!existing) {
            const created = await this.prisma.businessCategory.create({
              data: {
                name: category.name,
                code: category.code,
                description: category.description,
                isActive: true,
                sortOrder: createdCategories.length,
              },
            });
            createdCategories.push(created);
            this.logger.log(`✅ Created category: ${category.name}`);
          }
        } catch (error) {
          this.logger.warn(`Category ${category.code} already exists`);
        }
      }

      return {
        success: true,
        message: "Predefined categories initialized",
        createdCount: createdCategories.length,
        categories: createdCategories,
      };
    } catch (error) {
      this.logger.error("❌ Failed to create predefined categories:", error);
      throw new InternalServerErrorException("Failed to initialize categories");
    }
  }

  // CREATE CUSTOM CATEGORY
  async createCategory(data: {
    name: string;
    code: string;
    description?: string;
    icon?: string;
  }) {
    try {
      this.logger.log(`🏷️ Creating custom category: ${data.name}`);

      // Check if code already exists
      const existing = await this.prisma.businessCategory.findUnique({
        where: { code: data.code.toUpperCase() },
      });

      if (existing) {
        throw new ConflictException(
          `Category with code '${data.code}' already exists`,
        );
      }

      const category = await this.prisma.businessCategory.create({
        data: {
          name: data.name,
          code: data.code.toUpperCase(),
          description: data.description,
          icon: data.icon,
          isActive: true,
          sortOrder: 999, // Custom categories at the end
        },
      });

      this.logger.log(`✅ Custom category created: ${category.id}`);
      return {
        success: true,
        category,
        message: "Category created successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create category:`, error);
      if (error instanceof ConflictException) throw error;
      throw new InternalServerErrorException("Failed to create category");
    }
  }

  // GET ALL CATEGORIES WITH FILTERS
  async getCategories(filters?: {
    search?: string;
    isActive?: boolean;
    includeCount?: boolean;
  }) {
    try {
      const where: any = {};

      if (filters?.isActive !== undefined) {
        where.isActive = filters.isActive;
      }

      if (filters?.search) {
        where.OR = [
          { name: { contains: filters.search } },
          { description: { contains: filters.search } },
          { code: { contains: filters.search } },
        ];
      }

      let categories;

      if (filters?.includeCount) {
        categories = await this.prisma.businessCategory.findMany({
          where,
          include: {
            _count: {
              select: { merchants: true },
            },
            merchants: {
              select: { id: true },
              where: { isActive: true },
            },
          },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        });
      } else {
        categories = await this.prisma.businessCategory.findMany({
          where,
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        });
      }

      // Add merchant count if requested
      const categoriesWithCount = categories.map((category: any) => ({
        ...category,
        merchantCount: filters?.includeCount
          ? (category._count?.merchants ?? category.merchants?.length ?? 0)
          : undefined,
        merchants: undefined, // Remove merchants array from response
      }));

      return {
        success: true,
        categories: categoriesWithCount,
        total: categories.length,
      };
    } catch (error) {
      this.logger.error("❌ Failed to get categories:", error);
      throw new InternalServerErrorException("Failed to retrieve categories");
    }
  }

  // GET CATEGORY BY ID
  async getCategory(categoryId: string) {
    try {
      const category = await this.prisma.businessCategory.findUnique({
        where: { id: categoryId },
        include: {
          merchants: {
            select: {
              id: true,
              name: true,
              businessName: true,
              status: true,
              isActive: true,
              createdAt: true,
            },
            where: { isActive: true },
            orderBy: { createdAt: "desc" },
            take: 10, // Latest 10 merchants
          },
        },
      });

      if (!category) {
        throw new NotFoundException(`Category ${categoryId} not found`);
      }

      return {
        success: true,
        category: {
          ...category,
          merchantCount: category.merchants.length,
        },
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get category ${categoryId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Failed to retrieve category");
    }
  }

  // UPDATE CATEGORY
  async updateCategory(
    categoryId: string,
    data: {
      name?: string;
      description?: string;
      icon?: string;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    try {
      this.logger.log(`🏷️ Updating category: ${categoryId}`);

      const category = await this.prisma.businessCategory.update({
        where: { id: categoryId },
        data: {
          name: data.name,
          description: data.description,
          icon: data.icon,
          isActive: data.isActive,
          sortOrder: data.sortOrder,
          updatedAt: new Date(),
        },
      });

      return {
        success: true,
        category,
        message: "Category updated successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update category ${categoryId}:`, error);
      throw new InternalServerErrorException("Failed to update category");
    }
  }

  // GET MERCHANTS BY CATEGORY
  async getMerchantsByCategory(
    categoryId: string,
    filters?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: string;
    },
  ) {
    try {
      const { page = 1, limit = 20, search, status } = filters || {};
      const skip = (page - 1) * limit;

      const where: any = {
        categoryId,
        isActive: true,
      };

      if (status) {
        where.status = status;
      }

      if (search) {
        where.OR = [
          { name: { contains: search } },
          { businessName: { contains: search } },
          { email: { contains: search } },
        ];
      }

      const [merchants, total] = await Promise.all([
        this.prisma.merchant.findMany({
          where,
          include: {
            config: {
              select: {
                dailyMaxAmount: true,
                monthlyMaxAmount: true,
                currentDailyAmount: true,
                currentMonthlyAmount: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip,
          take: limit,
        }),
        this.prisma.merchant.count({ where }),
      ]);

      return {
        success: true,
        merchants,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error(
        `❌ Failed to get merchants for category ${categoryId}:`,
        error,
      );
      throw new InternalServerErrorException(
        "Failed to retrieve category merchants",
      );
    }
  }

  // DELETE CATEGORY (hard delete when no merchants, otherwise reject)
  async deleteCategory(categoryId: string) {
    try {
      this.logger.log(`🗑️ Deleting category: ${categoryId}`);

      const merchantCount = await this.prisma.merchant.count({
        where: { categoryId },
      });

      if (merchantCount > 0) {
        throw new ConflictException(
          `Cannot delete category with ${merchantCount} merchants. Remove or reassign merchants first.`,
        );
      }

      await this.prisma.businessCategory.delete({
        where: { id: categoryId },
      });

      return {
        success: true,
        message: "Category deleted successfully",
      };
    } catch (error) {
      this.logger.error(`❌ Failed to delete category ${categoryId}:`, error);
      if (error instanceof ConflictException) throw error;
      throw new InternalServerErrorException("Failed to delete category");
    }
  }
}

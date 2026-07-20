import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { BusinessCategoryService } from "./business-category.service";

@ApiTags("Business Categories")
@Controller("business-categories")
export class BusinessCategoryController {
  constructor(private readonly categoryService: BusinessCategoryService) {}

  @Post("initialize")
  @ApiOperation({
    summary: "Initialize predefined business categories",
    description:
      "Create all standard business categories (Retail, Restaurant, etc.)",
  })
  @ApiResponse({
    status: 201,
    description: "Predefined categories initialized",
  })
  async initializePredefinedCategories() {
    return this.categoryService.createPredefinedCategories();
  }

  @Post()
  @ApiOperation({
    summary: "Create custom business category",
    description: "Create a custom category for specific business types",
  })
  @ApiResponse({ status: 201, description: "Category created successfully" })
  async createCategory(
    @Body()
    createCategoryDto: {
      name: string;
      code: string;
      description?: string;
      icon?: string;
    },
  ) {
    return this.categoryService.createCategory(createCategoryDto);
  }

  @Get()
  @ApiOperation({
    summary: "Get all business categories",
    description: "Get categories with optional filtering and merchant counts",
  })
  @ApiResponse({
    status: 200,
    description: "Categories retrieved successfully",
  })
  @ApiQuery({
    name: "search",
    required: false,
    description: "Search in name, description, code",
  })
  @ApiQuery({
    name: "isActive",
    required: false,
    description: "Filter by active status",
  })
  @ApiQuery({
    name: "includeCount",
    required: false,
    description: "Include merchant count per category",
  })
  async getCategories(
    @Query("search") search?: string,
    @Query("isActive") isActive?: string,
    @Query("includeCount") includeCount?: string,
  ) {
    const filters = {
      search,
      isActive: isActive ? isActive === "true" : undefined,
      includeCount: includeCount === "true",
    };
    return this.categoryService.getCategories(filters);
  }

  @Get(":categoryId")
  @ApiOperation({
    summary: "Get category details",
    description: "Get category with merchant list",
  })
  @ApiResponse({ status: 200, description: "Category retrieved successfully" })
  @ApiResponse({ status: 404, description: "Category not found" })
  @ApiParam({ name: "categoryId", description: "Category ID" })
  async getCategory(@Param("categoryId") categoryId: string) {
    return this.categoryService.getCategory(categoryId);
  }

  @Put(":categoryId")
  @ApiOperation({
    summary: "Update business category",
    description: "Update category name, description, or status",
  })
  @ApiResponse({ status: 200, description: "Category updated successfully" })
  @ApiResponse({ status: 404, description: "Category not found" })
  @ApiParam({ name: "categoryId", description: "Category ID" })
  async updateCategory(
    @Param("categoryId") categoryId: string,
    @Body()
    updateCategoryDto: {
      name?: string;
      description?: string;
      icon?: string;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.categoryService.updateCategory(categoryId, updateCategoryDto);
  }

  @Delete(":categoryId")
  @ApiOperation({
    summary: "Deactivate business category",
    description: "Soft delete category (only if no active merchants)",
  })
  @ApiResponse({
    status: 200,
    description: "Category deactivated successfully",
  })
  @ApiResponse({ status: 409, description: "Category has active merchants" })
  @ApiParam({ name: "categoryId", description: "Category ID" })
  async deleteCategory(@Param("categoryId") categoryId: string) {
    return this.categoryService.deleteCategory(categoryId);
  }

  @Get(":categoryId/merchants")
  @ApiOperation({
    summary: "Get merchants by category",
    description: "Get all merchants in a specific category with pagination",
  })
  @ApiResponse({
    status: 200,
    description: "Category merchants retrieved successfully",
  })
  @ApiParam({ name: "categoryId", description: "Category ID" })
  @ApiQuery({ name: "page", required: false, description: "Page number" })
  @ApiQuery({ name: "limit", required: false, description: "Items per page" })
  @ApiQuery({
    name: "search",
    required: false,
    description: "Search merchants",
  })
  @ApiQuery({
    name: "status",
    required: false,
    description: "Filter by merchant status",
  })
  async getMerchantsByCategory(
    @Param("categoryId") categoryId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
    @Query("status") status?: string,
  ) {
    const filters = {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 20,
      search,
      status,
    };
    return this.categoryService.getMerchantsByCategory(categoryId, filters);
  }
}

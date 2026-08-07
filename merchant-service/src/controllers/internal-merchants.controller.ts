import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Patch,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

@Controller("internal/merchants")
export class InternalMerchantsController {
  private readonly logger = new Logger(InternalMerchantsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private validateInternalRequest(
    internalToken?: string,
    organizationId?: string,
  ): string {
    const expectedToken =
      this.configService.get<string>("INTERNAL_TOKEN");

    if (!expectedToken) {
      this.logger.error("INTERNAL_TOKEN is not configured");

      throw new InternalServerErrorException(
        "Internal authentication is not configured",
      );
    }

    if (!internalToken || internalToken !== expectedToken) {
      throw new UnauthorizedException("Invalid internal token");
    }

    if (!organizationId) {
      throw new BadRequestException(
        "x-organization-id header is required",
      );
    }

    return organizationId;
  }

  @Get(":merchantId/subscription-assignment")
  async getSubscriptionAssignment(
    @Param("merchantId") merchantId: string,
    @Headers("x-internal-token") internalToken?: string,
    @Headers("x-organization-id") requestOrganizationId?: string,
  ) {
    const organizationId = this.validateInternalRequest(
      internalToken,
      requestOrganizationId,
    );

    // Query with tenant scope directly. This avoids leaking whether a merchant
    // exists in another organization.
    const merchant = await this.prisma.merchant.findFirst({
      where: {
        id: merchantId,
        organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        orgSubscriptionId: true,
        status: true,
        isActive: true,
        deletedAt: true,
      },
    });

    if (!merchant) {
      throw new NotFoundException("Merchant not found");
    }

    return {
      success: true,
      merchantId: merchant.id,
      organizationId: merchant.organizationId,
      orgSubscriptionId: merchant.orgSubscriptionId,
      assigned: Boolean(merchant.orgSubscriptionId),
      merchantStatus: merchant.status,
      isActive: merchant.isActive,
      isDeleted: false,
    };
  }

  @Get("by-subscription/:orgSubscriptionId")
  async getMerchantsBySubscription(
    @Param("orgSubscriptionId") orgSubscriptionId: string,
    @Headers("x-internal-token") internalToken?: string,
    @Headers("x-organization-id") requestOrganizationId?: string,
  ) {
    const organizationId = this.validateInternalRequest(
      internalToken,
      requestOrganizationId,
    );

    const merchants = await this.prisma.merchant.findMany({
      where: {
        organizationId,
        orgSubscriptionId,
        deletedAt: null,
        // Do not filter isActive. Inactive but non-deleted merchants still
        // block subscription deletion because their assignment remains.
      },
      select: {
        id: true,
        name: true,
        businessName: true,
        organizationId: true,
        orgSubscriptionId: true,
        isActive: true,
        status: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return {
      success: true,
      organizationId,
      orgSubscriptionId,
      count: merchants.length,
      merchants,
    };
  }

  @Patch(":merchantId/subscription-assignment")
  async updateSubscriptionAssignment(
    @Param("merchantId") merchantId: string,
    @Body() body: { orgSubscriptionId: string },
    @Headers("x-internal-token") internalToken?: string,
  ) {
    if (internalToken !== process.env.INTERNAL_TOKEN) {
      throw new ForbiddenException("Invalid internal token");
    }

    const merchant = await this.prisma.merchant.update({
      where: { id: merchantId },
      data: { orgSubscriptionId: body.orgSubscriptionId },
    });

    return {
      success: true,
      merchantId: merchant.id,
      orgSubscriptionId: merchant.orgSubscriptionId,
    };
  }
}
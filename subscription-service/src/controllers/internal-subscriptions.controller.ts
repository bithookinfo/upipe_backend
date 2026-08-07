import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

@Controller("internal/subscriptions")
export class InternalSubscriptionsController {
  private readonly logger = new Logger(InternalSubscriptionsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private validateInternalRequest(
    internalToken?: string,
    organizationId?: string,
  ): string {
    const expectedToken = this.configService.get<string>("INTERNAL_TOKEN");

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
      throw new BadRequestException("x-organization-id header is required");
    }

    return organizationId;
  }

  @Get(":orgSubscriptionId/assignment-validation")
  async validateAssignment(
    @Param("orgSubscriptionId") orgSubscriptionId: string,
    @Headers("x-internal-token") internalToken?: string,
    @Headers("x-organization-id") requestOrganizationId?: string,
  ) {
    const organizationId = this.validateInternalRequest(
      internalToken,
      requestOrganizationId,
    );

    const subscription = await this.prisma.orgSubscription.findFirst({
      where: {
        id: orgSubscriptionId,
        organizationId,
      },
      select: {
        id: true,
        organizationId: true,
        status: true,
        startDate: true,
        endDate: true,
        plan: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new NotFoundException("Subscription not found");
    }

    const now = new Date();

    if (subscription.status === "EXPIRED") {
      return {
        success: true,
        assignable: false,
        reasonCode: "SUBSCRIPTION_EXPIRED",
        message: "This purchased subscription is expired.",
        subscription,
      };
    }
    
    if (subscription.status !== "UNASSIGNED" && subscription.status !== "ACTIVE") {
      return {
        success: true,
        assignable: false,
        reasonCode: "SUBSCRIPTION_STATUS_NOT_ASSIGNABLE",
        message: "This purchased subscription is not in an assignable status.",
        subscription,
      };
    }

    if (subscription.startDate > now) {
      return {
        success: true,
        assignable: false,
        reasonCode: "SUBSCRIPTION_NOT_STARTED",
        message: "This purchased subscription has not started yet.",
        subscription,
      };
    }

    if (subscription.endDate && subscription.endDate <= now) {
      return {
        success: true,
        assignable: false,
        reasonCode: "SUBSCRIPTION_EXPIRED",
        message: "This purchased subscription has expired based on its end date.",
        subscription,
      };
    }

    // Assignable!
    return {
      success: true,
      assignable: true,
      reasonCode: null,
      subscription,
    };
  }
}

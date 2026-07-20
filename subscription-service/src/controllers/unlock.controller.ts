import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Headers,
  OnModuleInit,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiParam } from "@nestjs/swagger";
import { UnlockService } from "../services/unlock.service";

@ApiTags("Merchant Unlocks")
@Controller("merchant-unlocks")
export class UnlockController implements OnModuleInit {
  constructor(private readonly unlockService: UnlockService) { }

  private validateAccess(id: string, reqOrgId?: string, isSuperAdmin?: string, userType?: string) {
    if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    if (reqOrgId && reqOrgId === id) return;
    throw new ForbiddenException("Access denied");
  }

  async onModuleInit() {
    try {
      await this.unlockService.seedUnlockProducts();
    } catch (error) {
      console.error("Failed to seed unlock products:", error);
    }
  }

  @Get("products")
  @ApiOperation({ summary: "Get available merchant unlock products" })
  async getProducts() {
    return this.unlockService.getUnlockProducts();
  }

  @Get("organizations/:organizationId")
  @ApiOperation({ summary: "Get all unlocks for an organization" })
  @ApiParam({ name: "organizationId" })
  async getOrgUnlocks(
    @Param("organizationId") organizationId: string,
    @Headers("x-organization-id") reqOrgId?: string,
    @Headers("x-user-type") userType?: string,
    @Headers("x-is-super-admin") isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.unlockService.getOrganizationUnlocks(organizationId, isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN');
  }

  @Get("organizations/:organizationId/check/:merchantType")
  @ApiOperation({ summary: "Check if a merchant type is unlocked" })
  @ApiParam({ name: "organizationId" })
  @ApiParam({ name: "merchantType" })
  async checkUnlock(
    @Param("organizationId") organizationId: string,
    @Param("merchantType") merchantType: string,
    @Headers("x-organization-id") reqOrgId?: string,
    @Headers("x-user-type") userType?: string,
    @Headers("x-is-super-admin") isSuperAdmin?: string,
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.unlockService.checkMerchantTypeUnlocked(
      organizationId,
      merchantType,
      isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN',
    );
  }

  // ─── PURCHASE FLOW ─────────────────────────────────────

  @Post("organizations/:organizationId/purchase")
  @ApiOperation({ summary: "Initiate an unlock purchase" })
  @ApiParam({ name: "organizationId" })
  async purchaseUnlock(
    @Param("organizationId") organizationId: string,
    @Body() body: { merchantType: string },
  ) {
    return this.unlockService.purchaseUnlock(
      organizationId,
      body.merchantType,
    );
  }

  @Post("payment-callback")
  @ApiOperation({ summary: "Handle unlock payment callback" })
  async handlePaymentCallback(@Body() body: any) {
    return this.unlockService.handleUnlockPaymentCallback(body);
  }

  // ─── SUPER-ADMIN ───────────────────────────────────────

  @Post("organizations/:organizationId/grant")
  @ApiOperation({ summary: "Super-admin: grant a free unlock" })
  @ApiParam({ name: "organizationId" })
  async grantUnlock(
    @Param("organizationId") organizationId: string,
    @Body() body: { merchantType: string },
  ) {
    return this.unlockService.grantUnlock(
      organizationId,
      body.merchantType,
    );
  }

  @Post("organizations/:organizationId/revoke")
  @ApiOperation({ summary: "Super-admin: revoke an unlock" })
  @ApiParam({ name: "organizationId" })
  async revokeUnlock(
    @Param("organizationId") organizationId: string,
    @Body() body: { merchantType: string },
  ) {
    return this.unlockService.revokeUnlock(
      organizationId,
      body.merchantType,
    );
  }

  // ─── METRICS ───────────────────────────────────────────

  @Get("metrics")
  @ApiOperation({ summary: "Get unlock metrics (super-admin)" })
  async getMetrics() {
    return this.unlockService.getUnlockMetrics();
  }

  // ─── PRODUCT MANAGEMENT (SUPER-ADMIN) ──────────────────

  @Get("products/all")
  @ApiOperation({ summary: "Get all unlock products including inactive" })
  async getAllProducts() {
    return this.unlockService.getAllUnlockProducts();
  }

  @Patch("products/:id")
  @ApiOperation({ summary: "Update an unlock product" })
  @ApiParam({ name: "id" })
  async updateProduct(
    @Param("id") id: string,
    @Body()
    body: {
      price?: number;
      displayName?: string;
      description?: string;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.unlockService.updateUnlockProduct(id, body);
  }
}

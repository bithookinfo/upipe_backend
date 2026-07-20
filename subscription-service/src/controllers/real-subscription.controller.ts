import { Controller, Get, Post, Body, Param, Query, OnModuleInit, Headers, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { RealSubscriptionService } from '../services/real-subscription.service';

@ApiTags('Real Subscription Management')
@Controller('real-subscriptions')
export class RealSubscriptionController implements OnModuleInit {
  constructor(private readonly realSubscriptionService: RealSubscriptionService) {}

  private validateAccess(id: string, reqOrgId?: string, isSuperAdmin?: string, userType?: string) {
    if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    if (reqOrgId && reqOrgId === id) return;
    throw new ForbiddenException("Access denied");
  }

  async onModuleInit() {
    try {
      await this.realSubscriptionService.seedSubscriptionPlans();
    } catch (error) {
      console.error('Failed to seed subscription plans:', error);
    }
  }

  // ─── PLANS ─────────────────────────────────────────────────

  @Get('plans')
  @ApiOperation({ summary: 'Get all subscription plans' })
  async getPlans() {
    return this.realSubscriptionService.getSubscriptionPlans();
  }

  // ─── ORG SUBSCRIPTION (SLOT-BASED) ─────────────────────────

  @Get('organizations/:organizationId')
  @ApiOperation({ summary: 'Get organization subscription slots' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async getOrganizationSubscription(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.getOrganizationSubscription(organizationId, isSuperAdmin === 'true');
  }

  @Post('organizations/:organizationId/assign-trial')
  @ApiOperation({ summary: 'Assign a free trial subscription to an organization' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async assignTrial(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.assignTrialSubscription(organizationId);
  }

  // ─── PURCHASE FLOW ─────────────────────────────────────────

  @Post('organizations/:organizationId/purchase')
  @ApiOperation({ summary: 'Initiate a plan purchase (creates payment order + QR)' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async initiatePurchase(
    @Param('organizationId') organizationId: string,
    @Body() body: { planId: string; quantity: number },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.initiatePurchase(
      organizationId,
      body.planId,
      body.quantity || 1
    );
  }

  @Post('organizations/:organizationId/bulk-renew')
  @ApiOperation({ summary: 'Initiate bulk renewal for multiple slots' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async initiateBulkRenew(
    @Param('organizationId') organizationId: string,
    @Body() body: { slotIds: string[] },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.initiateBulkRenew(
      organizationId,
      body.slotIds
    );
  }

  @Post('payment-callback')
  @ApiOperation({ summary: 'Internal: payment-service callback on order completion' })
  async handlePaymentCallback(@Body() body: any) {
    const result = await this.realSubscriptionService.handlePaymentCallback(body);
    if (!result.success) {
      const { BadRequestException } = require('@nestjs/common');
      throw new BadRequestException(result.message);
    }
    return result;
  }

  // ─── MERCHANT SLOT MANAGEMENT ──────────────────────────────

  @Get('organizations/:organizationId/can-connect')
  @ApiOperation({ summary: 'Check if org can connect a new merchant (has unassigned slots)' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async canConnectMerchant(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.checkCanConnectMerchant(organizationId);
  }

  @Post('organizations/:organizationId/assign-slot')
  @ApiOperation({ summary: 'Assign an available slot to a merchant' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async assignSlot(
    @Param('organizationId') organizationId: string,
    @Body() body: { merchantId: string, slotId?: string },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.assignSlotToMerchant(organizationId, body.merchantId, body.slotId);
  }

  @Post('organizations/:organizationId/unassign-slot')
  @ApiOperation({ summary: 'Free a slot when merchant is deleted' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async unassignSlot(
    @Param('organizationId') organizationId: string,
    @Body() body: { merchantId: string },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.unassignSlot(body.merchantId);
  }

  // ─── PROVIDER ACCESS ───────────────────────────────────────

  @Get('organizations/:organizationId/provider-access/:providerCode')
  @ApiOperation({ summary: 'Check provider access for current plan' })
  async checkProviderAccess(
    @Param('organizationId') organizationId: string,
    @Param('providerCode') providerCode: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    const result = await this.realSubscriptionService.checkProviderAccess(organizationId, providerCode, isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN');
    return { success: true, providerCode, ...result };
  }

  // ─── HISTORY ───────────────────────────────────────────────

  @Get('organizations/:organizationId/history')
  @ApiOperation({ summary: 'Get subscription history' })
  async getSubscriptionHistory(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.getSubscriptionHistory(organizationId);
  }

  @Get('organizations/:organizationId/purchases')
  @ApiOperation({ summary: 'Get purchase history for an organization' })
  async getPurchaseHistory(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.getPurchaseHistory(organizationId);
  }

  
  @Post('organizations/:organizationId/simulate-notification')
  @ApiOperation({ summary: 'Simulate expiry or renewal notifications for testing' })
  async simulateNotification(
    @Param('organizationId') organizationId: string,
    @Body() body: { type: 'expiry' | 'renewal', slotId?: string },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.simulateNotification(organizationId, body.type, body.slotId);
  }

  // ─── EXPIRING SLOTS ────────────────────────────────────────

  @Get('organizations/:organizationId/expiring-slots')
  @ApiOperation({ summary: 'Get subscription slots expiring within 48 hours' })
  @ApiParam({ name: 'organizationId', description: 'Organization ID' })
  async getExpiringSlots(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    return this.realSubscriptionService.getExpiringSlots(organizationId);
  }

  // ─── USAGE STATS (backward compat) ─────────────────────────

  @Get('organizations/:organizationId/usage-stats')
  @ApiOperation({ summary: 'Get usage statistics (slot-based)' })
  async getUsageStats(
    @Param('organizationId') organizationId: string,
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    const subscriptionData = await this.realSubscriptionService.getOrganizationSubscription(organizationId, isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN');

    if (!subscriptionData.success || !subscriptionData.subscription) {
      return { success: false, message: 'No subscription found' };
    }

    const { subscription, summary } = subscriptionData;
    const limits = subscription.limits;

    return {
      success: true,
      stats: {
        currentMonth: {
          usersCreated: 0,
          merchantsCreated: summary?.activeSlots || 0,
          transactionsCount: 0,
          apiCallsCount: 0,
        },
        limits,
        subscription: {
          plan: subscription.plan.name,
          status: subscription.status,
        },
      },
    };
  }

  // ─── CHECK LIMITS (backward compat for payment-service) ────

  @Post('organizations/:organizationId/check-limits')
  @ApiOperation({ summary: 'Check subscription limits (backward compat)' })
  async checkLimits(
    @Param('organizationId') organizationId: string,
    @Body() body: { action: string; data?: any; isSuperAdmin?: boolean },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    if (body.isSuperAdmin) {
      return { success: true, allowed: true, reason: 'Super Admin Bypass' };
    }

    // For merchant creation, use slot-based check
    if (body.action === 'CREATE_MERCHANT') {
      const result = await this.realSubscriptionService.checkCanConnectMerchant(organizationId);
      return { success: true, allowed: result.allowed, reason: result.message };
    }

    // For other actions, check if org has any active subscription
    const subData = await this.realSubscriptionService.getOrganizationSubscription(organizationId);
    if (!subData.success) {
      return { success: true, allowed: false, reason: 'No active subscription' };
    }

    return { success: true, allowed: true };
  }

  // ─── UPDATE USAGE (backward compat — now a no-op) ──────────

  @Post('organizations/:organizationId/update-usage')
  @ApiOperation({ summary: 'Update usage and check limits' })
  async updateUsage(
    @Param('organizationId') organizationId: string,
    @Body() body: { action: string; data?: any },
    @Headers('x-organization-id') reqOrgId?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string,
    @Headers('x-internal-token') internalToken?: string
  ) {
    if (!internalToken || internalToken !== process.env.INTERNAL_TOKEN) {
      this.validateAccess(organizationId, reqOrgId, isSuperAdmin, userType);
    }
    if (body.action === 'PROCESS_TRANSACTION') {
      try {
        await this.realSubscriptionService.processTransactionEvent(organizationId);
      } catch (error) {
        // Log but don't fail the request, we don't want to break payment flow
        console.error(`Failed to process transaction event for org ${organizationId}:`, error);
      }
    }
    
    // Usage tracking via slots now, but we use the above hook for Milestone Alerts
    return { success: true, message: `Usage tracking via slots now (action: ${body.action})`, timestamp: new Date() };
  }

  // ─── SEED ──────────────────────────────────────────────────

  @Post('seed-plans')
  @ApiOperation({ summary: 'Manually seed subscription plans' })
  async seedPlans() {
    try {
      await this.realSubscriptionService.seedSubscriptionPlans();
      return { success: true, message: 'Subscription plans seeded successfully' };
    } catch (error) {
      return { success: false, message: 'Failed to seed subscription plans', error: error.message };
    }
  }

  @Get('purchases/:purchaseId')
  @ApiOperation({ summary: 'Get details for a specific purchase' })
  async getPurchaseDetails(
    @Param('purchaseId') purchaseId: string,
    @Query('force') force?: string,
  ) {
    return this.realSubscriptionService.getPurchaseDetails(purchaseId, force === 'true');
  }
}

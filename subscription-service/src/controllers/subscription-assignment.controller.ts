import { Controller, Get, Post, Patch, Put, Param, Body, Query, Headers, ForbiddenException, Ip, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RealSubscriptionService } from '../services/real-subscription.service';
import { logAuditActivity } from '../utils/audit.util';

@Controller('subscriptions')
@ApiTags('Subscriptions (Super-Admin)')
export class SubscriptionAssignmentController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly subscriptionService: RealSubscriptionService,
    ) {}

    private validateSuperAdmin(isSuperAdmin?: string, userType?: string) {
        if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
        throw new ForbiddenException("Super admin access required");
    }

    @Get('plans')
    @ApiOperation({ summary: 'Get all subscription plans' })
    async getAllPlans(
        @Query('activeOnly') activeOnly?: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        const userTypeUpper = userType?.toUpperCase();
        const isAdmin = isSuperAdmin === 'true' || userTypeUpper === 'SUPER_ADMIN' || userTypeUpper === 'SUPERADMIN';
        const onlyActive = !isAdmin || activeOnly === 'true';
        const plans = await this.prisma.subscriptionPlan.findMany({
            where: onlyActive ? { isActive: true } : undefined,
            include: { providerAccess: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
        });
        return { success: true, data: plans };
    }

    @Post('plans')
    @ApiOperation({ summary: 'Create a subscription plan' })
    async createPlan(
        @Body() body: any,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const plan = await this.prisma.subscriptionPlan.create({
            data: {
                name: body.name,
                code: body.code || body.name.toUpperCase().replace(/\s+/g, '_'),
                description: body.description || null,
                price: body.price || 0,
                billingCycle: body.billingCycle || 'MONTHLY',
                maxUsers: body.maxUsers || 5,
                maxMerchants: body.maxMerchants || 3,
                maxTransactions: body.maxTransactions || 1000,
                maxApiCalls: body.maxApiCalls || 10000,
                features: body.features || null,
                isActive: body.isActive ?? true,
                isFeatured: body.isFeatured ?? false,
                sortOrder: body.sortOrder || 0,
                durationDays: body.durationDays || 28,
                isPublic: body.isPublic ?? true,
                isTrial: body.isTrial ?? false,
                providerAccess: {
                    create: body.providerAccess?.map((pa: any) => ({
                        providerCode: pa.providerCode,
                        isIncluded: pa.isIncluded ?? true,
                    })) || []
                }
            },
            include: { providerAccess: true }
        });
        return { success: true, data: plan };
    }

    @Patch('plans/:id')
    @ApiOperation({ summary: 'Update a subscription plan' })
    async updatePlan(
        @Param('id') id: string,
        @Body() body: any,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
        if (!plan) return { success: false, message: 'Plan not found', data: null };

        const updated = await this.prisma.$transaction(async (tx) => {
            // Update plan basics
            const p = await tx.subscriptionPlan.update({
                where: { id },
                data: {
                    ...(body.name != null && { name: body.name }),
                    ...(body.description != null && { description: body.description }),
                    ...(body.price != null && { price: body.price }),
                    ...(body.maxUsers != null && { maxUsers: body.maxUsers }),
                    ...(body.maxMerchants != null && { maxMerchants: body.maxMerchants }),
                    ...(body.maxTransactions != null && { maxTransactions: body.maxTransactions }),
                    ...(body.maxApiCalls != null && { maxApiCalls: body.maxApiCalls }),
                    ...(body.isActive != null && { isActive: body.isActive }),
                    ...(body.isFeatured != null && { isFeatured: body.isFeatured }),
                    ...(body.sortOrder != null && { sortOrder: body.sortOrder }),
                    ...(body.billingCycle != null && { billingCycle: body.billingCycle }),
                    ...(body.features != null && { features: body.features }),
                    ...(body.durationDays != null && { durationDays: body.durationDays }),
                    ...(body.isPublic != null && { isPublic: body.isPublic }),
                    ...(body.isTrial != null && { isTrial: body.isTrial }),
                }
            });

            // Update provider access if provided
            if (body.providerAccess && Array.isArray(body.providerAccess)) {
                // Delete existing
                await tx.subscriptionProviderAccess.deleteMany({
                    where: { planId: id }
                });

                // Create new
                await tx.subscriptionProviderAccess.createMany({
                    data: body.providerAccess.map((pa: any) => ({
                        planId: id,
                        providerCode: pa.providerCode,
                        isIncluded: pa.isIncluded ?? true,
                    }))
                });
            }

            return tx.subscriptionPlan.findUnique({
                where: { id },
                include: { providerAccess: true }
            });
        });

        return { success: true, data: updated };
    }

    @Delete('plans/:id')
    @ApiOperation({ summary: 'Delete a subscription plan' })
    async deletePlan(
        @Param('id') id: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        
        // Ensure plan exists
        const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
        if (!plan) return { success: false, message: 'Plan not found', data: null };

        // Delete plan (provider access will cascade if configured, or we can manually delete)
        await this.prisma.$transaction(async (tx) => {
            await tx.subscriptionProviderAccess.deleteMany({
                where: { planId: id }
            });
            await tx.subscriptionPlan.delete({
                where: { id }
            });
        });

        return { success: true, message: 'Plan deleted successfully' };
    }

    // ─── ORG SUBSCRIPTION (SLOT-BASED) ───────────────────────

    @Get('organization/:organizationId')
    @ApiOperation({ summary: 'Get organization subscription slots' })
    async getOrganizationSubscription(
        @Param('organizationId') organizationId: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const result = await this.subscriptionService.getOrganizationSubscription(organizationId);
        return { success: true, data: result };
    }

    // ─── DIRECT ASSIGN (SUPER-ADMIN) ─────────────────────────

    @Post('assign')
    @ApiOperation({ summary: 'Directly assign N subscription slots to an organization (no payment)' })
    async assignSubscription(
        @Body() body: {
            organizationId: string;
            planId: string;
            quantity?: number;
            durationMonths?: number;
        },
        @Headers('x-user-type') userType?: string,
        @Headers('x-user-id') userId?: string,
        @Headers("user-agent") userAgent?: string,
        @Ip() ipAddress?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const result = await this.subscriptionService.directAssignSlots(
            body.organizationId,
            body.planId,
            body.quantity || 1,
        );

        if (userId) {
            await logAuditActivity(
                "SUBSCRIPTION_ASSIGNED",
                body.organizationId,
                "ORGANIZATION",
                userId,
                userType || "USER",
                body.organizationId,
                ipAddress,
                userAgent,
                { planId: body.planId, quantity: body.quantity || 1 }
            );
        }

        return result;
    }

    // ─── PURCHASES ───────────────────────────────────────────

    @Get('purchases')
    @ApiOperation({ summary: 'List all subscription purchases (all orgs)' })
    async getAllPurchases(
        @Query('status') status?: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        return this.subscriptionService.getAllPurchases(status);
    }

    // ─── SLOT EDITING ────────────────────────────────────────

    @Patch('slots/:id')
    @ApiOperation({ summary: 'Edit specific slot dates' })
    async updateSlotDates(
        @Param('id') id: string,
        @Body() body: { startDate?: string; endDate?: string },
        @Headers('x-user-type') userType?: string,
        @Headers('x-user-id') userId?: string,
        @Headers("user-agent") userAgent?: string,
        @Ip() ipAddress?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const result = await this.subscriptionService.updateSlotDates(id, body.startDate, body.endDate);

        if (userId && result?.slot?.organizationId) {
            await logAuditActivity(
                "SLOT_UPDATED",
                id,
                "SUBSCRIPTION_SLOT",
                userId,
                userType || "USER",
                result.slot.organizationId,
                ipAddress,
                userAgent,
                { startDate: body.startDate, endDate: body.endDate }
            );
        }

        return result;
    }

    // ─── PLATFORM CONFIG ─────────────────────────────────────

    @Get('platform-config/payment-merchant')
    @ApiOperation({ summary: 'Get the platform merchant used for subscription payments' })
    async getPaymentMerchantConfig(
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const config = await this.subscriptionService.getPlatformConfig('subscription_payment_merchant');
        return { success: true, data: config };
    }

    @Put('platform-config/payment-merchant')
    @ApiOperation({ summary: 'Set/update the platform merchant for subscription payments' })
    async setPaymentMerchantConfig(
        @Body() body: {
            merchantId: string;
            connectorId?: string;
            organizationId?: string;
        },
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        await this.subscriptionService.setPlatformConfig('subscription_payment_merchant', {
            merchantId: body.merchantId,
            connectorId: body.connectorId || null,
            organizationId: body.organizationId || null,
        });
        return { success: true, message: 'Payment merchant configuration updated' };
    }
}

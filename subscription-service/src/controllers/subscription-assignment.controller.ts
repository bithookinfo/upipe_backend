import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Headers, Query, Ip, HttpException, HttpStatus,ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RealSubscriptionService } from '../services/real-subscription.service';
import { logAuditActivity } from '../utils/audit.util';
import axios from 'axios';

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
            where: {
                ...(onlyActive ? { isActive: true } : {}),
                deletedAt: null
            },
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
                durationDays: body.durationDays || null,
                isPublic: body.isPublic ?? true,
                isTrial: body.isTrial ?? false,
                providerAccess: {
                    create: body.providerAccess?.map((pa: any) => ({
                        providerCode: pa.providerCode,
                        isIncluded: pa.isIncluded ?? true,
                        slotsCount: pa.slotsCount ?? 1,
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

        // Check if this is a metadata-only update (e.g., toggling visibility/features)
        const isMetadataOnlyUpdate = Object.keys(body).every(key => 
            ['isActive', 'isPublic', 'isFeatured', 'sortOrder'].includes(key)
        );

        if (!isMetadataOnlyUpdate) {
            // Plan edit protection for core fields
            const activeSubscriptions = await this.prisma.orgSubscription.findMany({
                where: {
                    planId: id,
                    status: 'ACTIVE',
                    OR: [
                        { endDate: null },
                        { endDate: { gt: new Date() } }
                    ]
                },
                select: { organizationId: true },
                distinct: ['organizationId'],
                take: 26
            });

            if (activeSubscriptions.length > 0) {
                const orgIds = activeSubscriptions.map(s => s.organizationId);
                const organizations = [];
                
                try {
                    const orgUrl = process.env.ORGANIZATION_SERVICE_URL;
                    if (orgUrl) {
                        for (const orgId of orgIds.slice(0, 25)) {
                            try {
                               const res = await axios.get(`${orgUrl}/organizations/${orgId}`, {
                                 headers: { 'x-user-type': 'SUPER_ADMIN' }
                               });
                               organizations.push({
                                   id: orgId,
                                   name: res.data?.data?.organization?.name || res.data?.data?.name || orgId
                               });
                            } catch (e) {
                               organizations.push({ id: orgId, name: orgId });
                            }
                        }
                    } else {
                        organizations.push(...orgIds.slice(0, 25).map(id => ({ id, name: id })));
                    }
                } catch (err) {
                   organizations.push(...orgIds.slice(0, 25).map(id => ({ id, name: id })));
                }

                throw new HttpException({
                    code: 'PLAN_IN_USE',
                    message: 'This plan cannot be edited because it is currently being used by organizations.',
                    activeOrganizationCount: activeSubscriptions.length > 25 ? 26 : activeSubscriptions.length,
                    organizations: organizations,
                    hasMore: activeSubscriptions.length > 25
                }, HttpStatus.CONFLICT);
            }

            const billingCycle = body.billingCycle || plan.billingCycle;
            if (billingCycle !== 'LIFETIME') {
                const newDurationDays = body.durationDays !== undefined ? body.durationDays : plan.durationDays;
                if (newDurationDays == null || typeof newDurationDays !== 'number' || !Number.isInteger(newDurationDays) || newDurationDays <= 0 || newDurationDays > 3650) {
                    return { success: false, message: 'durationDays is mandatory and must be a positive integer (max 3650) for non-lifetime plans', data: null };
                }
            }
        }

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
                        slotsCount: pa.slotsCount ?? 1,
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

    @Get('plans/:id/usage')
    @ApiOperation({ summary: 'Check if a plan is in use' })
    async getPlanUsage(
        @Param('id') id: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        
        // Ensure plan exists
        const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
        if (!plan) return { success: false, message: 'Plan not found', data: null };

        const activeSubscriptions = await this.prisma.orgSubscription.findMany({
            where: {
                planId: id
            },
            select: { organizationId: true },
            distinct: ['organizationId'],
            take: 26
        });

        if (activeSubscriptions.length === 0) {
            return { success: true, data: { inUse: false } };
        }

        const orgIds = activeSubscriptions.map(s => s.organizationId);
        const organizations = [];
        
        try {
            const orgUrl = process.env.ORGANIZATION_SERVICE_URL;
            if (orgUrl) {
                for (const orgId of orgIds.slice(0, 25)) {
                    try {
                       const axios = require('axios');
                       const res = await axios.get(`${orgUrl}/organizations/${orgId}`, {
                         headers: { 'x-user-type': 'SUPER_ADMIN' }
                       });
                       organizations.push({
                           id: orgId,
                           name: res.data?.data?.organization?.name || res.data?.data?.name || orgId
                       });
                    } catch (e) {
                       organizations.push({ id: orgId, name: orgId });
                    }
                }
            } else {
                for (const orgId of orgIds.slice(0, 25)) {
                    organizations.push({ id: orgId, name: orgId });
                }
            }
        } catch (e) {
            console.error('Error fetching org details', e);
        }

        const message = activeSubscriptions.length > 25
            ? `Plan is currently actively assigned to ${activeSubscriptions.length}+ organizations and cannot be deleted.`
            : `Plan is currently actively assigned to ${activeSubscriptions.length} organizations and cannot be deleted.`;
            
        return {
            success: true,
            data: {
                inUse: true,
                message,
                organizations
            }
        };
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

        const activeSubscriptions = await this.prisma.orgSubscription.findMany({
            where: {
                planId: id
            },
            select: { organizationId: true },
            distinct: ['organizationId'],
            take: 26
        });

        if (activeSubscriptions.length > 0) {
            const orgIds = activeSubscriptions.map(s => s.organizationId);
            const organizations = [];
            
            try {
                const orgUrl = process.env.ORGANIZATION_SERVICE_URL;
                if (orgUrl) {
                    for (const orgId of orgIds.slice(0, 25)) {
                        try {
                           const axios = require('axios');
                           const res = await axios.get(`${orgUrl}/organizations/${orgId}`, {
                             headers: { 'x-user-type': 'SUPER_ADMIN' }
                           });
                           organizations.push({
                               id: orgId,
                               name: res.data?.data?.organization?.name || res.data?.data?.name || orgId
                           });
                        } catch (e) {
                           organizations.push({ id: orgId, name: orgId });
                        }
                    }
                } else {
                    organizations.push(...orgIds.slice(0, 25).map(id => ({ id, name: id })));
                }
            } catch (err) {
               organizations.push(...orgIds.slice(0, 25).map(id => ({ id, name: id })));
            }

            throw new HttpException({
                code: 'PLAN_IN_USE',
                message: 'This plan cannot be deleted because it is currently being used by active organizations.',
                activeOrganizationCount: activeSubscriptions.length > 25 ? 26 : activeSubscriptions.length,
                organizations: organizations,
                hasMore: activeSubscriptions.length > 25
            }, HttpStatus.CONFLICT);
        }

        const hasSubscriptions = await this.prisma.orgSubscription.findFirst({
            where: { planId: id }
        });
        const hasHistory = await this.prisma.subscriptionHistory.findFirst({
            where: { planId: id }
        });
        const hasPurchases = await this.prisma.subscriptionPurchase.findFirst({
            where: { planId: id }
        });

        if (hasSubscriptions || hasHistory || hasPurchases) {
            await this.prisma.subscriptionPlan.update({
                where: { id },
                data: {
                    isActive: false,
                    deletedAt: new Date()
                }
            });
            return { success: true, message: 'Plan archived successfully' };
        }

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
        @Body() body: { startDate?: string; endDate?: string; planId?: string; status?: string; autoRenew?: boolean },
        @Headers('x-user-type') userType?: string,
        @Headers('x-user-id') userId?: string,
        @Headers("user-agent") userAgent?: string,
        @Ip() ipAddress?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        const result = await this.subscriptionService.updateSlotDates(id, body.startDate, body.endDate, body.planId, body.status, body.autoRenew);

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

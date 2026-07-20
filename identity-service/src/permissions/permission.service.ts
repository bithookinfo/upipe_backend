import {
    Injectable,
    Logger,
    NotFoundException,
    ConflictException,
    InternalServerErrorException
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

const ALL_PERMISSIONS = {
    ORG_VIEW: { code: 'org:view', name: 'View Organization', category: 'ORGANIZATION', service: 'organization-service' },
    ORG_UPDATE: { code: 'org:update', name: 'Update Organization', category: 'ORGANIZATION', service: 'organization-service' },
    ORG_DELETE: { code: 'org:delete', name: 'Delete Organization', category: 'ORGANIZATION', service: 'organization-service' },
    ORG_SETTINGS_VIEW: { code: 'org:settings:view', name: 'View Organization Settings', category: 'ORGANIZATION', service: 'organization-service' },
    ORG_SETTINGS_UPDATE: { code: 'org:settings:update', name: 'Update Organization Settings', category: 'ORGANIZATION', service: 'organization-service' },

    USER_VIEW: { code: 'user:view', name: 'View Users', category: 'USERS', service: 'organization-service' },
    USER_CREATE: { code: 'user:create', name: 'Create Users', category: 'USERS', service: 'organization-service' },
    USER_INVITE: { code: 'user:invite', name: 'Invite Users', category: 'USERS', service: 'organization-service' },
    USER_UPDATE: { code: 'user:update', name: 'Update Users', category: 'USERS', service: 'organization-service' },
    USER_DELETE: { code: 'user:delete', name: 'Delete Users', category: 'USERS', service: 'organization-service' },
    USER_DEACTIVATE: { code: 'user:deactivate', name: 'Deactivate Users', category: 'USERS', service: 'organization-service' },
    USER_ACTIVATE: { code: 'user:activate', name: 'Activate Users', category: 'USERS', service: 'organization-service' },

    ROLE_VIEW: { code: 'role:view', name: 'View Roles', category: 'ROLES', service: 'organization-service' },
    ROLE_CREATE: { code: 'role:create', name: 'Create Roles', category: 'ROLES', service: 'organization-service' },
    ROLE_UPDATE: { code: 'role:update', name: 'Update Roles', category: 'ROLES', service: 'organization-service' },
    ROLE_DELETE: { code: 'role:delete', name: 'Delete Roles', category: 'ROLES', service: 'organization-service' },
    ROLE_ASSIGN: { code: 'role:assign', name: 'Assign Roles', category: 'ROLES', service: 'organization-service' },

    MERCHANT_VIEW: { code: 'merchant:view', name: 'View Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_CREATE: { code: 'merchant:create', name: 'Create Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_UPDATE: { code: 'merchant:update', name: 'Update Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_DELETE: { code: 'merchant:delete', name: 'Delete Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_CONFIGURE: { code: 'merchant:configure', name: 'Configure Merchant Limits', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_VERIFY: { code: 'merchant:verify', name: 'Verify Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_BLOCK: { code: 'merchant:block', name: 'Block Merchants', category: 'MERCHANTS', service: 'merchant-service' },
    MERCHANT_UNBLOCK: { code: 'merchant:unblock', name: 'Unblock Merchants', category: 'MERCHANTS', service: 'merchant-service' },

    PAYMENT_VIEW: { code: 'payment:view', name: 'View Payments', category: 'PAYMENTS', service: 'payment-service' },
    PAYMENT_CREATE: { code: 'payment:create', name: 'Create Payments', category: 'PAYMENTS', service: 'payment-service' },
    PAYMENT_REFUND: { code: 'payment:refund', name: 'Refund Payments', category: 'PAYMENTS', service: 'payment-service' },
    PAYMENT_SETTLE: { code: 'payment:settle', name: 'Settle Payments', category: 'PAYMENTS', service: 'payment-service' },
    PAYMENT_EXPORT: { code: 'payment:export', name: 'Export Payments', category: 'PAYMENTS', service: 'payment-service' },

    ANALYTICS_VIEW: { code: 'analytics:view', name: 'View Analytics', category: 'ANALYTICS', service: 'organization-service' },
    ANALYTICS_EXPORT: { code: 'analytics:export', name: 'Export Analytics', category: 'ANALYTICS', service: 'organization-service' },
    REPORT_VIEW: { code: 'report:view', name: 'View Reports', category: 'ANALYTICS', service: 'organization-service' },
    REPORT_CREATE: { code: 'report:create', name: 'Create Reports', category: 'ANALYTICS', service: 'organization-service' },
    REPORT_EXPORT: { code: 'report:export', name: 'Export Reports', category: 'ANALYTICS', service: 'organization-service' },

    SUBSCRIPTION_VIEW: { code: 'subscription:view', name: 'View Subscription', category: 'BILLING', service: 'organization-service' },
    SUBSCRIPTION_UPDATE: { code: 'subscription:update', name: 'Update Subscription', category: 'BILLING', service: 'organization-service' },
    SUBSCRIPTION_CANCEL: { code: 'subscription:cancel', name: 'Cancel Subscription', category: 'BILLING', service: 'organization-service' },
    BILLING_VIEW: { code: 'billing:view', name: 'View Billing', category: 'BILLING', service: 'organization-service' },
    BILLING_UPDATE: { code: 'billing:update', name: 'Update Billing', category: 'BILLING', service: 'organization-service' },
    INVOICE_VIEW: { code: 'invoice:view', name: 'View Invoices', category: 'BILLING', service: 'organization-service' },
    INVOICE_DOWNLOAD: { code: 'invoice:download', name: 'Download Invoices', category: 'BILLING', service: 'organization-service' },

    API_KEY_VIEW: { code: 'api_key:view', name: 'View API Keys', category: 'API', service: 'organization-service' },
    API_KEY_CREATE: { code: 'api_key:create', name: 'Create API Keys', category: 'API', service: 'organization-service' },
    API_KEY_REVOKE: { code: 'api_key:revoke', name: 'Revoke API Keys', category: 'API', service: 'organization-service' },
    WEBHOOK_VIEW: { code: 'webhook:view', name: 'View Webhooks', category: 'API', service: 'organization-service' },
    WEBHOOK_CREATE: { code: 'webhook:create', name: 'Create Webhooks', category: 'API', service: 'organization-service' },
    WEBHOOK_UPDATE: { code: 'webhook:update', name: 'Update Webhooks', category: 'API', service: 'organization-service' },
    WEBHOOK_DELETE: { code: 'webhook:delete', name: 'Delete Webhooks', category: 'API', service: 'organization-service' },

    AUDIT_VIEW: { code: 'audit:view', name: 'View Audit Logs', category: 'AUDIT', service: 'organization-service' },
    AUDIT_EXPORT: { code: 'audit:export', name: 'Export Audit Logs', category: 'AUDIT', service: 'organization-service' }
};

@Injectable()
export class PermissionService {
    private readonly logger = new Logger(PermissionService.name);

    constructor(private readonly prisma: PrismaService) { }

    async seedPermissions() {
        try {
            this.logger.log('🔑 Seeding permissions to database...');

            const permissions = Object.values(ALL_PERMISSIONS);
            let created = 0;
            let updated = 0;

            for (const perm of permissions) {
                const existing = await this.prisma.permission.findUnique({
                    where: { code: perm.code }
                });

                if (!existing) {
                    await this.prisma.permission.create({
                        data: {
                            id: randomUUID(),
                            code: perm.code,
                            name: perm.name,
                            category: perm.category,
                            service: perm.service,
                            isActive: true
                        }
                    });
                    created++;
                } else if (!existing.isActive) {
                    await this.prisma.permission.update({
                        where: { id: existing.id },
                        data: { isActive: true }
                    });
                    updated++;
                }
            }

            this.logger.log(`✅ Permissions seeded: ${created} created, ${updated} activated`);
            return {
                success: true,
                created,
                updated,
                total: permissions.length
            };
        } catch (error) {
            this.logger.error('❌ Failed to seed permissions:', error);
            throw new InternalServerErrorException('Failed to seed permissions');
        }
    }

    async getAllPermissions(filters?: { category?: string; service?: string }) {
        try {
            const where: any = { isActive: true };

            if (filters?.category) where.category = filters.category;
            if (filters?.service) where.service = filters.service;

            const permissions = await this.prisma.permission.findMany({
                where,
                orderBy: [
                    { category: 'asc' },
                    { name: 'asc' }
                ]
            });

            return {
                success: true,
                permissions,
                total: permissions.length
            };
        } catch (error) {
            this.logger.error('❌ Failed to get permissions:', error);
            throw new InternalServerErrorException('Failed to retrieve permissions');
        }
    }

    async checkPermission(userId: string, organizationId: string, permissionCode: string): Promise<boolean> {
        try {
            const permission = await this.prisma.permission.findUnique({
                where: { code: permissionCode }
            });

            if (!permission) {
                this.logger.warn(`Permission code '${permissionCode}' not found`);
                return false;
            }

            const userPermission = await this.prisma.userPermission.findFirst({
                where: {
                    userId,
                    organizationId,
                    permissionId: permission.id,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } }
                    ]
                }
            });

            return !!userPermission;
        } catch (error) {
            this.logger.error(`❌ Failed to check permission:`, error);
            return false;
        }
    }

    async grantPermission(data: {
        userId: string;
        organizationId: string;
        permissionCode: string;
        grantedBy?: string;
        grantedVia?: string;
        roleId?: string;
        expiresAt?: Date;
    }) {
        try {
            const permission = await this.prisma.permission.findUnique({
                where: { code: data.permissionCode }
            });

            if (!permission) {
                throw new NotFoundException(`Permission '${data.permissionCode}' not found`);
            }

            const existing = await this.prisma.userPermission.findFirst({
                where: {
                    userId: data.userId,
                    organizationId: data.organizationId,
                    permissionId: permission.id
                }
            });

            if (existing) {
                return {
                    success: true,
                    message: 'Permission already granted',
                    userPermission: existing
                };
            }

            const userPermission = await this.prisma.userPermission.create({
                data: {
                    id: randomUUID(),
                    userId: data.userId,
                    organizationId: data.organizationId,
                    permissionId: permission.id,
                    grantedBy: data.grantedBy,
                    grantedVia: data.grantedVia || 'direct',
                    roleId: data.roleId,
                    expiresAt: data.expiresAt
                }
            });

            this.logger.log(`✅ Granted permission '${data.permissionCode}' to user ${data.userId}`);
            return {
                success: true,
                message: 'Permission granted successfully',
                userPermission
            };
        } catch (error) {
            this.logger.error(`❌ Failed to grant permission:`, error);
            if (error instanceof NotFoundException) throw error;
            throw new InternalServerErrorException('Failed to grant permission');
        }
    }

    async grantMultiplePermissions(data: {
        userId: string;
        organizationId: string;
        permissionCodes: string[];
        grantedBy?: string;
        roleId?: string;
    }) {
        try {
            this.logger.log(`🔑 Granting ${data.permissionCodes.length} permissions to user ${data.userId}`);

            const results = [];
            for (const code of data.permissionCodes) {
                const result = await this.grantPermission({
                    userId: data.userId,
                    organizationId: data.organizationId,
                    permissionCode: code,
                    grantedBy: data.grantedBy,
                    grantedVia: 'role',
                    roleId: data.roleId
                });
                results.push(result);
            }

            return {
                success: true,
                granted: results.filter(r => r.success).length,
                total: data.permissionCodes.length
            };
        } catch (error) {
            this.logger.error(`❌ Failed to grant multiple permissions:`, error);
            throw new InternalServerErrorException('Failed to grant permissions');
        }
    }

    // REVOKE PERMISSION FROM USER
    async revokePermission(userId: string, organizationId: string, permissionCode: string) {
        try {
            const permission = await this.prisma.permission.findUnique({
                where: { code: permissionCode }
            });

            if (!permission) {
                throw new NotFoundException(`Permission '${permissionCode}' not found`);
            }

            await this.prisma.userPermission.deleteMany({
                where: {
                    userId,
                    organizationId,
                    permissionId: permission.id
                }
            });

            this.logger.log(`✅ Revoked permission '${permissionCode}' from user ${userId}`);
            return {
                success: true,
                message: 'Permission revoked successfully'
            };
        } catch (error) {
            this.logger.error(`❌ Failed to revoke permission:`, error);
            if (error instanceof NotFoundException) throw error;
            throw new InternalServerErrorException('Failed to revoke permission');
        }
    }

    // GET USER PERMISSIONS
    async getUserPermissions(userId: string, organizationId: string) {
        try {
            const userPermissions = await this.prisma.userPermission.findMany({
                where: {
                    userId,
                    organizationId,
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } }
                    ]
                },
                include: {
                    permission: true
                }
            });

            return {
                success: true,
                permissions: userPermissions.map(up => ({
                    ...up.permission,
                    grantedAt: up.grantedAt,
                    grantedVia: up.grantedVia,
                    roleId: up.roleId
                })),
                total: userPermissions.length
            };
        } catch (error) {
            this.logger.error(`❌ Failed to get user permissions:`, error);
            throw new InternalServerErrorException('Failed to retrieve user permissions');
        }
    }

    // REVOKE ALL PERMISSIONS FOR USER IN ORG (when user removed)
    async revokeAllUserPermissions(userId: string, organizationId: string) {
        try {
            const result = await this.prisma.userPermission.deleteMany({
                where: {
                    userId,
                    organizationId
                }
            });

            this.logger.log(`✅ Revoked all permissions for user ${userId} in org ${organizationId}`);
            return {
                success: true,
                revoked: result.count
            };
        } catch (error) {
            this.logger.error(`❌ Failed to revoke all permissions:`, error);
            throw new InternalServerErrorException('Failed to revoke permissions');
        }
    }
}

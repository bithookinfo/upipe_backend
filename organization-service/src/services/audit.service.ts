import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { randomUUID } from 'crypto';
import axios from 'axios';

export interface AuditLogData {
    organizationId?: string;
    action: string;
    performedBy: string;
    performedByType?: string;
    entityId?: string;
    entityType?: string;
    metadata?: any;
    reason?: string;
    ipAddress?: string;
}

@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Log an audit event
     */
    async log(data: AuditLogData): Promise<void> {
        try {
            await this.prisma.audit_logs.create({
                data: {
                    id: randomUUID(),
                    organization_id: data.organizationId || null,
                    action: data.action,
                    performed_by: data.performedBy,
                    performed_by_type: data.performedByType || 'SUPER_ADMIN',
                    entity_id: data.entityId || null,
                    entity_type: data.entityType || null,
                    metadata: data.metadata ? JSON.stringify(data.metadata) : null,
                    reason: data.reason || null,
                    ip_address: data.ipAddress || null,
                },
            });

            this.logger.log(`Audit log created: ${data.action} by ${data.performedBy}`);
        } catch (error) {
            this.logger.error('Failed to create audit log:', error);
            // Don't throw - audit logging should not break the main flow
        }
    }

    /**
     * Helper to enrich logs with user details and human-readable descriptions
     */
    private async enrichLogs(logs: any[], orgMap?: Map<string, string>) {
        if (logs.length === 0) return [];

        // 1. Collect unique user IDs
        const userIds = [...new Set(logs.map(log => log.performed_by).filter(Boolean))];
        const userMap = new Map<string, { name: string, email: string }>();

        // 2. Fetch users from identity-service
        if (userIds.length > 0 && process.env.IDENTITY_SERVICE_URL) {
            try {
                const response = await axios.post(
                    `${process.env.IDENTITY_SERVICE_URL}/users/internal/batch`,
                    { userIds },
                    { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }
                );
                
                if (response.data?.success && Array.isArray(response.data.data)) {
                    response.data.data.forEach((user: any) => {
                        userMap.set(user.id, { name: user.name, email: user.email });
                    });
                }
            } catch (err) {
                this.logger.warn(`Failed to fetch user details for audit logs: ${err.message}`);
            }
        }

        const merchantIds = [...new Set(logs.filter(l => l.entity_type === 'MERCHANT' || l.entity_type === 'merchant').map(log => log.entity_id).filter(Boolean))];
        const merchantMap = new Map<string, string>();
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;

        if (merchantIds.length > 0 && merchantServiceUrl) {
            try {
                const response = await axios.post(
                    `${merchantServiceUrl}/merchant/internal/batch`,
                    { merchantIds },
                    { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }
                );
                
                if (response.data?.success && Array.isArray(response.data.data)) {
                    response.data.data.forEach((merchant: any) => {
                        merchantMap.set(merchant.id, merchant.name);
                    });
                }
            } catch (err) {
                this.logger.warn(`Failed to fetch merchant details for audit logs: ${err.message}`);
            }
        }

        // 3. Map logs and generate descriptions
        return logs.map(log => {
            const metadata = log.metadata ? JSON.parse(log.metadata) : null;
            const performedByUser = userMap.get(log.performed_by) || { name: 'Unknown User', email: '' };
            const orgName = orgMap && log.organization_id ? orgMap.get(log.organization_id) : undefined;
            
            let description = `Performed action: ${log.action}`;
            
            switch (log.action) {
                case 'ORGANIZATION_CREATED':
                    description = `Created organization "${metadata?.name || 'Unknown'}"`;
                    break;
                case 'ORGANIZATION_UPDATED':
                    description = `Updated organization settings`;
                    break;
                case 'ORGANIZATION_ACTIVATED':
                    description = `Activated organization`;
                    break;
                case 'ORGANIZATION_SUSPENDED':
                    description = `Suspended organization`;
                    break;
                case 'MERCHANT_CREATED':
                    description = `Created merchant "${merchantMap.get(log.entity_id) || metadata?.merchantName || 'Unknown'}"`;
                    break;
                case 'MERCHANT_UPDATED':
                    description = `Updated merchant "${merchantMap.get(log.entity_id) || metadata?.merchantName || 'Unknown'}" configuration`;
                    break;
                case 'MERCHANT_ACTIVATED':
                    description = `Activated merchant "${merchantMap.get(log.entity_id) || 'Unknown'}"`;
                    break;
                case 'MERCHANT_DEACTIVATED':
                    description = `Deactivated merchant "${merchantMap.get(log.entity_id) || 'Unknown'}". Reason: ${metadata?.reason || 'Not specified'}`;
                    break;
                case 'MERCHANT_DELETED':
                    description = `Deleted merchant "${merchantMap.get(log.entity_id) || 'Unknown'}"`;
                    break;
                case 'MERCHANT_CONNECT':
                    description = `Connected merchant "${merchantMap.get(log.entity_id) || 'Unknown'}"`;
                    break;
                case 'MERCHANT_DISCONNECT':
                    description = `Disconnected merchant "${merchantMap.get(log.entity_id) || 'Unknown'}"`;
                    break;
                case 'PROVIDER_CONNECTED':
                    description = `Connected ${metadata?.providerType || 'payment'} provider`;
                    break;
                case 'PROVIDER_DISCONNECTED':
                    description = `Disconnected ${metadata?.providerType || 'payment'} provider`;
                    break;
                case 'LIMIT_CHANGE':
                    description = `Updated limits — Daily: ₹${metadata?.newLimits?.dailyLimit || 'N/A'}, Monthly: ₹${metadata?.newLimits?.monthlyLimit || 'N/A'}`;
                    break;
                case 'SUBSCRIPTION_ASSIGNED':
                    description = `Assigned subscription (Plan: ${metadata?.planId || 'Unknown'}, Qty: ${metadata?.quantity || 1})`;
                    break;
                case 'SUBSCRIPTION_UPDATED':
                    description = `Updated subscription`;
                    break;
                case 'SLOT_UPDATED':
                    description = `Updated subscription slot dates`;
                    break;
                case 'USER_LOGIN':
                    description = `User logged in`;
                    break;
                case 'TICKET_STATUS_CHANGE':
                    description = `Changed ticket status to ${metadata?.status || 'Unknown'}`;
                    break;
                case 'TICKET_REPLY':
                    description = `Replied to support ticket`;
                    break;
            }

            return {
                ...log,
                description,
                organization_name: orgName,
                performed_by_user: performedByUser,
                metadata,
            };
        });
    }

    /**
     * Get audit logs for an organization
     */
    async getOrganizationLogs(
        organizationId: string,
        options?: {
            action?: string;
            limit?: number;
            offset?: number;
        },
    ) {
        try {
            const where: any = { organization_id: organizationId };
            if (options?.action) {
                where.action = options.action;
            }

            const logs = await this.prisma.audit_logs.findMany({
                where,
                orderBy: { created_at: 'desc' },
                take: options?.limit || 50,
                skip: options?.offset || 0,
            });

            const total = await this.prisma.audit_logs.count({ where });

            const enrichedLogs = await this.enrichLogs(logs);

            return {
                success: true,
                data: enrichedLogs,
                pagination: {
                    total,
                    limit: options?.limit || 50,
                    offset: options?.offset || 0,
                },
            };
        } catch (error) {
            this.logger.error('Failed to fetch audit logs:', error);
            return {
                success: false,
                data: [],
                error: 'Failed to fetch audit logs',
            };
        }
    }

    /**
     * Get all audit logs (super admin view)
     */
    async getAllLogs(options?: {
        action?: string;
        limit?: number;
        offset?: number;
    }) {
        try {
            const where: any = {};
            if (options?.action) {
                where.action = options.action;
            }

            const logs = await this.prisma.audit_logs.findMany({
                where,
                orderBy: { created_at: 'desc' },
                take: options?.limit || 100,
                skip: options?.offset || 0,
            });

            const orgIds = [...new Set(logs.map(log => log.organization_id).filter(Boolean))];
            const orgs = await this.prisma.organizations.findMany({
                where: { id: { in: orgIds as string[] } },
                select: { id: true, name: true }
            });
            const orgMap = new Map(orgs.map(org => [org.id, org.name]));

            const total = await this.prisma.audit_logs.count({ where });

            const enrichedLogs = await this.enrichLogs(logs, orgMap);

            return {
                success: true,
                data: enrichedLogs,
                pagination: {
                    total,
                    limit: options?.limit || 100,
                    offset: options?.offset || 0,
                },
            };
        } catch (error) {
            this.logger.error('Failed to fetch all audit logs:', error);
            return {
                success: false,
                data: [],
                error: 'Failed to fetch audit logs',
            };
        }
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAuditLogDto {
    superAdminId: string;
    action: string;
    entityType: string;
    entityId: string;
    details?: any;
    ipAddress?: string;
    userAgent?: string;
}

export interface QueryAuditLogsDto {
    superAdminId?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
}

@Injectable()
export class AuditService {
    private readonly logger = new Logger(AuditService.name);

    constructor(private prisma: PrismaService) { }

    /**
     * Create an audit log entry
     */
    async log(dto: CreateAuditLogDto) {
        try {
            const auditLog = await this.prisma.auditLog.create({
                data: {
                    superAdminId: dto.superAdminId,
                    action: dto.action,
                    entityType: dto.entityType,
                    entityId: dto.entityId,
                    details: dto.details || null,
                    ipAddress: dto.ipAddress,
                    userAgent: dto.userAgent,
                },
            });

            this.logger.debug(`📝 Audit log created: ${dto.action} by ${dto.superAdminId}`);

            return auditLog;
        } catch (error) {
            this.logger.error(`Failed to create audit log: ${error.message}`);
            // Don't throw - audit logging should not break the main flow
            return null;
        }
    }

    /**
     * Query audit logs with filters
     */
    async query(query: QueryAuditLogsDto) {
        const where: any = {};

        if (query.superAdminId) {
            where.superAdminId = query.superAdminId;
        }

        if (query.action) {
            where.action = query.action;
        }

        if (query.entityType) {
            where.entityType = query.entityType;
        }

        if (query.entityId) {
            where.entityId = query.entityId;
        }

        if (query.startDate || query.endDate) {
            where.createdAt = {};
            if (query.startDate) {
                where.createdAt.gte = query.startDate;
            }
            if (query.endDate) {
                where.createdAt.lte = query.endDate;
            }
        }

        const [logs, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where,
                include: {
                    superAdmin: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            role: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                take: query.limit || 50,
                skip: query.offset || 0,
            }),
            this.prisma.auditLog.count({ where }),
        ]);

        return {
            data: logs,
            total,
            limit: query.limit || 50,
            offset: query.offset || 0,
        };
    }

    /**
     * Get recent activity (last N logs)
     */
    async getRecentActivity(limit: number = 10) {
        return this.prisma.auditLog.findMany({
            include: {
                superAdmin: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    /**
     * Get stats for audit logs
     */
    async getStats() {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const [totalLogs, todayLogs, monthlyLogs, actionBreakdown] = await Promise.all([
            this.prisma.auditLog.count(),
            this.prisma.auditLog.count({
                where: { createdAt: { gte: today } },
            }),
            this.prisma.auditLog.count({
                where: { createdAt: { gte: thisMonth } },
            }),
            this.prisma.auditLog.groupBy({
                by: ['action'],
                _count: true,
                orderBy: { _count: { action: 'desc' } },
                take: 10,
            }),
        ]);

        return {
            totalLogs,
            todayLogs,
            monthlyLogs,
            topActions: actionBreakdown.map((item) => ({
                action: item.action,
                count: item._count,
            })),
        };
    }

    /**
     * Get login history (sessions)
     */
    async getLoginHistory(type?: string, limit: number = 50, offset: number = 0) {
        const where: any = {};
        if (type === 'super_admin') {
            where.superAdminId = { not: null };
        } else if (type === 'user') {
            where.userId = { not: null };
        }

        const [sessions, total] = await Promise.all([
            this.prisma.session.findMany({
                where,
                include: {
                    user: {
                        select: { id: true, name: true, email: true }
                    },
                    superAdmin: {
                        select: { id: true, name: true, email: true, role: true }
                    }
                },
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: offset
            }),
            this.prisma.session.count({ where })
        ]);

        return {
            data: sessions,
            total,
            limit,
            offset
        };
    }
}

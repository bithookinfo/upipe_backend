import { Controller, Get, Param, Query } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Controller('stats')
export class StatsController {
    constructor(private prisma: PrismaService) { }

    @Get()
    async getGlobalStats(
        @Query('fromDate') fromDate?: string,
        @Query('toDate') toDate?: string,
    ) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let dateFilter: any = undefined;
        if (fromDate || toDate) {
            dateFilter = {};
            if (fromDate) {
                const start = new Date(fromDate);
                start.setHours(0, 0, 0, 0);
                dateFilter.gte = start;
            }
            if (toDate) {
                const end = new Date(toDate);
                end.setHours(23, 59, 59, 999);
                dateFilter.lte = end;
            }
        }

        const [totalTransactions, todayTransactions, completedOrders, todayCompletedOrders] = await Promise.all([
            this.prisma.order.count({
                where: fromDate || toDate ? { createdAt: dateFilter } : {}
            }),
            this.prisma.order.count({ where: { createdAt: { gte: today } } }),
            this.prisma.order.findMany({
                where: { 
                    status: 'COMPLETED',
                    ...(fromDate || toDate ? { createdAt: dateFilter } : {})
                },
                select: { amount: true, metadata: true }
            }),
            this.prisma.order.findMany({
                where: { 
                    status: 'COMPLETED',
                    createdAt: { gte: today }
                },
                select: { amount: true }
            }),
        ]);

        let platformRev = 0;
        let merchantVol = 0;

        completedOrders.forEach(order => {
            const isPlatform = (order.metadata as any)?.isPlatform === true;
            const amount = Number(order.amount || 0);
            if (isPlatform) {
                platformRev += amount;
            } else {
                merchantVol += amount;
            }
        });

        let todayRevenue = 0;
        todayCompletedOrders.forEach(order => {
            todayRevenue += Number(order.amount || 0);
        });

        return {
            totalTransactions,
            todayTransactions,
            platformRevenue: platformRev,
            merchantVolume: merchantVol,
            totalRevenue: platformRev + merchantVol,
            todayRevenue,
        };
    }

    @Get('merchant/:id')
    async getMerchantStats(@Param('id') id: string) {
        console.log(`[StatsController] Fetching stats for merchant ID: ${id}`);
        const [merchantOrders, totalOrders, failureCount] = await Promise.all([
            this.prisma.order.findMany({
                where: { merchantId: id, status: 'COMPLETED' },
                select: { amount: true, metadata: true }
            }),
            this.prisma.order.count({ where: { merchantId: id } }),
            this.prisma.order.count({ where: { merchantId: id, status: 'FAILED' } }),
        ]);
        console.log(`[StatsController] Found ${merchantOrders.length} completed, ${totalOrders} total, ${failureCount} failed`);

        let merchantVolume = 0;
        let platformRevenue = 0;

        merchantOrders.forEach(o => {
            const amount = Number(o.amount || 0);
            const isPlatform = (o.metadata as any)?.isPlatform === true;
            console.log(`[StatsController] Order amount: ${amount}, isPlatform: ${isPlatform}`);
            if (isPlatform) {
                platformRevenue += amount;
            } else {
                merchantVolume += amount;
            }
        });

        const completedOrders = merchantOrders.length;
        const totalRevenue = merchantVolume + platformRevenue;
        console.log(`[StatsController] Computed: merchantVolume=${merchantVolume}, platformRevenue=${platformRevenue}, total=${totalRevenue}`);
        
        const relevantTotal = completedOrders + failureCount;
        const successRate = relevantTotal > 0 ? ((completedOrders / relevantTotal) * 100).toFixed(1) + '%' : '0.0%';
        const avgOrderValue = completedOrders > 0 ? Number((totalRevenue / completedOrders).toFixed(2)) : 0;

        return {
            success: true,
            data: {
                totalOrders,
                totalRevenue,
                merchantVolume,
                platformRevenue,
                successRate,
                avgOrderValue,
                totalTransactions: totalOrders
            }
        };
    }

    @Get('monthly-volume')
    async getMonthlyVolume() {
        // Get last 7 months of transaction volume
        const now = new Date();
        const months = [];

        for (let i = 6; i >= 0; i--) {
            const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const endDate = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);

            const monthName = date.toLocaleString('default', { month: 'short' });

            const volume = await this.prisma.order.aggregate({
                _sum: { amount: true },
                where: {
                    status: 'COMPLETED',
                    createdAt: {
                        gte: date,
                        lte: endDate
                    }
                }
            });

            months.push({
                name: monthName,
                volume: Number(volume._sum.amount || 0)
            });
        }

        return { success: true, data: months };
    }

    @Get('hourly-trend')
    async getHourlyTrend(
        @Query('date') dateParam?: string,
    ) {
        const targetDate = dateParam ? new Date(dateParam) : new Date();
        targetDate.setHours(0, 0, 0, 0);
        
        const data = [];
        
        for (let i = 0; i < 24; i++) {
            const hourStart = new Date(targetDate);
            hourStart.setHours(i, 0, 0, 0);
            
            const hourEnd = new Date(targetDate);
            hourEnd.setHours(i, 59, 59, 999);
            
            const volume = await this.prisma.order.aggregate({
                _sum: { amount: true },
                where: {
                    status: 'COMPLETED',
                    createdAt: { gte: hourStart, lte: hourEnd }
                }
            });
            
            const ampm = i >= 12 ? 'PM' : 'AM';
            const hourLabel = i % 12 === 0 ? 12 : i % 12;
            
            data.push({
                name: `${hourLabel} ${ampm}`,
                volume: Number(volume._sum.amount || 0)
            });
        }
        
        return { success: true, data };
    }

    @Get('volume-trend')
    async getVolumeTrend(
        @Query('fromDate') fromDate?: string,
        @Query('toDate') toDate?: string,
    ) {
        const now = new Date();
        let start = new Date(now);
        start.setDate(now.getDate() - 9); // default last 10 days
        start.setHours(0, 0, 0, 0);
        let end = new Date();
        end.setHours(23, 59, 59, 999);

        if (fromDate) {
            start = new Date(fromDate);
            start.setHours(0, 0, 0, 0);
        }
        if (toDate) {
            end = new Date(toDate);
            end.setHours(23, 59, 59, 999);
        }

        const diffTime = Math.abs(end.getTime() - start.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        const data = [];
        
        if (diffDays <= 31) {
            // Group by day
            for (let i = 0; i < diffDays; i++) {
                const dayStart = new Date(start);
                dayStart.setDate(start.getDate() + i);
                const dayEnd = new Date(dayStart);
                dayEnd.setHours(23, 59, 59, 999);
                
                const volume = await this.prisma.order.aggregate({
                    _sum: { amount: true },
                    where: {
                        status: 'COMPLETED',
                        createdAt: { gte: dayStart, lte: dayEnd }
                    }
                });
                
                data.push({
                    name: dayStart.toLocaleDateString('default', { month: 'short', day: 'numeric' }),
                    volume: Number(volume._sum.amount || 0)
                });
            }
        } else {
            // Group by month
            const monthsDiff = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
            for (let i = 0; i < monthsDiff; i++) {
                const monthStart = new Date(start.getFullYear(), start.getMonth() + i, 1);
                const monthEnd = new Date(start.getFullYear(), start.getMonth() + i + 1, 0, 23, 59, 59);
                
                // Cap monthStart and monthEnd within start and end range
                const actualStart = monthStart < start ? start : monthStart;
                const actualEnd = monthEnd > end ? end : monthEnd;
                
                const volume = await this.prisma.order.aggregate({
                    _sum: { amount: true },
                    where: {
                        status: 'COMPLETED',
                        createdAt: { gte: actualStart, lte: actualEnd }
                    }
                });
                
                data.push({
                    name: monthStart.toLocaleDateString('default', { month: 'short', year: '2-digit' }),
                    volume: Number(volume._sum.amount || 0)
                });
            }
        }

        return { success: true, data };
    }

    /** Platform/super-admin: orders and success amount per organization */
    @Get('by-organization')
    async getByOrganization(
        @Query('fromDate') fromDate?: string,
        @Query('toDate') toDate?: string,
    ) {
        let dateFilter: any = undefined;
        if (fromDate || toDate) {
            dateFilter = {};
            if (fromDate) {
                const start = new Date(fromDate);
                start.setHours(0, 0, 0, 0);
                dateFilter.gte = start;
            }
            if (toDate) {
                const end = new Date(toDate);
                end.setHours(23, 59, 59, 999);
                dateFilter.lte = end;
            }
        }

        const orders = await this.prisma.order.findMany({
            where: fromDate || toDate ? { createdAt: dateFilter } : {},
            select: { organizationId: true, status: true, amount: true, metadata: true, customerName: true, createdAt: true },
        });
        const byOrg = new Map<string, { totalOrders: number; successAmount: number; todaySuccessAmount: number; platformRevenue: number; completedCount: number; failedCount: number; expiredCount: number }>();
        
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        for (const o of orders) {
            let orgId = o.organizationId || '_unknown_';
            const isPlatform = (o.metadata as any)?.isPlatform === true;

            // For platform orders (subscriptions), attribute revenue to the PAYER
            if (isPlatform && o.customerName?.startsWith('Org-')) {
                const payerId = o.customerName.replace('Org-', '');
                if (payerId && payerId.length > 20) { // Simple UUID check
                    orgId = payerId;
                }
            }

            if (!byOrg.has(orgId)) byOrg.set(orgId, { totalOrders: 0, successAmount: 0, todaySuccessAmount: 0, platformRevenue: 0, completedCount: 0, failedCount: 0, expiredCount: 0 });
            const row = byOrg.get(orgId)!;
            
            if (o.status === 'COMPLETED') {
                if (isPlatform) {
                    row.platformRevenue += Number(o.amount || 0);
                } else {
                    row.successAmount += Number(o.amount || 0);
                    if (o.createdAt >= todayStart) {
                        row.todaySuccessAmount += Number(o.amount || 0);
                    }
                }
                row.totalOrders += 1;
                row.completedCount += 1;
            } else if (o.status === 'FAILED') {
                row.totalOrders += 1;
                row.failedCount += 1;
            } else if (o.status === 'EXPIRED') {
                row.totalOrders += 1;
                row.expiredCount += 1;
            } else if (o.status !== 'CANCELLED') {
                row.totalOrders += 1;
            }
        }

        const data = Array.from(byOrg.entries())
            .filter(([id]) => id !== '_unknown_' && id !== 'platform-org-id')
            .map(([organizationId, v]) => {
                const totalRelevant = v.completedCount + v.failedCount + v.expiredCount;
                const successRatio = totalRelevant > 0 ? (v.completedCount / totalRelevant) * 100 : 0;
                return {
                    organizationId,
                    totalOrders: v.totalOrders,
                    successAmount: v.successAmount,
                    todaySuccessAmount: v.todaySuccessAmount,
                    platformRevenue: v.platformRevenue,
                    successRatio: Number(successRatio.toFixed(1))
                };
            });
            
        return { success: true, data };
    }

    @Get('organization/:id')
    async getOrganizationStats(
        @Param('id') id: string,
        @Query('fromDate') fromDate?: string,
        @Query('toDate') toDate?: string,
    ) {
        let dateFilter: any = undefined;
        if (fromDate || toDate) {
            dateFilter = {};
            if (fromDate) {
                const start = new Date(fromDate);
                start.setHours(0, 0, 0, 0);
                dateFilter.gte = start;
            }
            if (toDate) {
                const end = new Date(toDate);
                end.setHours(23, 59, 59, 999);
                dateFilter.lte = end;
            }
        }

        const baseWhere = {
            organizationId: id,
            ...(fromDate || toDate ? { createdAt: dateFilter } : {})
        };

        // 1. Merchant Volume (orders processed BY this organization)
        const merchantOrders = await this.prisma.order.findMany({
            where: { ...baseWhere, status: 'COMPLETED' },
            select: { amount: true }
        });

        // 2. Platform Revenue (subscription/unlock payments BY this organization)
        const allPlatformOrders = await this.prisma.order.findMany({
            where: { 
                status: 'COMPLETED',
                customerName: `Org-${id}`,
                ...(fromDate || toDate ? { createdAt: dateFilter } : {})
            },
            select: { amount: true, metadata: true }
        });
        const platformOrders = allPlatformOrders.filter(o => (o.metadata as any)?.isPlatform === true);

        const merchantVolume = merchantOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
        const platformRevenue = platformOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
        
        const totalOrders = await this.prisma.order.count({ where: baseWhere });
        const completedOrders = merchantOrders.length;
        const failureCount = await this.prisma.order.count({ where: { ...baseWhere, status: 'FAILED' } });
        const pendingCount = await this.prisma.order.count({ where: { ...baseWhere, status: 'PENDING' } });
        const expiredCount = await this.prisma.order.count({ where: { ...baseWhere, status: 'EXPIRED' } });

        const relevantTotal = completedOrders + failureCount + expiredCount;
        const successRate = relevantTotal > 0 ? ((completedOrders / relevantTotal) * 100).toFixed(1) + '%' : '0.0%';
        const avgOrderValue = completedOrders > 0 ? Number((merchantVolume / completedOrders).toFixed(2)) : 0;

        // Today's volume
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayCompleted = await this.prisma.order.findMany({
            where: { ...baseWhere, status: 'COMPLETED', createdAt: { gte: todayStart } },
            select: { amount: true }
        });
        const todayVolume = todayCompleted.reduce((sum, o) => sum + Number(o.amount || 0), 0);
        const todayOrders = await this.prisma.order.count({ where: { ...baseWhere, createdAt: { gte: todayStart } } });
        const todayCompleteCount = todayCompleted.length;

        const allOrdersInPeriod = await this.prisma.order.findMany({
            where: baseWhere,
            select: { status: true, amount: true }
        });

        const volumeByStatusMap = new Map<string, number>();
        const countByStatusMap = new Map<string, number>();
        allOrdersInPeriod.forEach(o => {
            const status = o.status || 'UNKNOWN';
            const amount = Number(o.amount || 0);
            volumeByStatusMap.set(status, (volumeByStatusMap.get(status) || 0) + amount);
            countByStatusMap.set(status, (countByStatusMap.get(status) || 0) + 1);
        });

        const volumeByStatus = Array.from(volumeByStatusMap.entries()).map(([name, value]) => ({ name, value }));
        const countByStatus = Array.from(countByStatusMap.entries()).map(([name, count]) => ({ name, count }));

        return {
            success: true,
            data: {
                totalOrders,
                completedOrders,
                failedOrders: failureCount,
                pendingOrders: pendingCount,
                expiredOrders: expiredCount,
                merchantVolume,
                platformRevenue,
                totalRevenue: merchantVolume,
                successRate,
                avgOrderValue,
                todayVolume,
                todayOrders,
                todayCompleteCount,
                volumeByStatus,
                countByStatus
            }
        };
    }
    @Get('organization/:id/merchants')
    async getOrganizationMerchantsStats(@Param('id') id: string) {
        const orders = await this.prisma.order.findMany({
            where: { organizationId: id },
            select: { merchantId: true, status: true, amount: true }
        });

        const byMerchant = new Map<string, { totalOrders: number; successVolume: number; completedCount: number; failedCount: number }>();

        for (const o of orders) {
            const mId = o.merchantId || 'unknown';
            if (!byMerchant.has(mId)) {
                byMerchant.set(mId, { totalOrders: 0, successVolume: 0, completedCount: 0, failedCount: 0 });
            }
            const row = byMerchant.get(mId)!;
            
            row.totalOrders += 1;
            if (o.status === 'COMPLETED') {
                row.completedCount += 1;
                row.successVolume += Number(o.amount || 0);
            } else if (o.status === 'FAILED') {
                row.failedCount += 1;
            }
        }

        const data = Array.from(byMerchant.entries()).map(([merchantId, v]) => {
            const totalRelevant = v.completedCount + v.failedCount;
            const successRatio = totalRelevant > 0 ? ((v.completedCount / totalRelevant) * 100).toFixed(1) + '%' : '0.0%';
            return {
                merchantId,
                totalOrders: v.totalOrders,
                successVolume: v.successVolume,
                successRatio
            };
        });

        return { success: true, data };
    }
}

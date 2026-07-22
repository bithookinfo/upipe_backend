import {
  Controller,
  Get,
  Put,
  Param,
  Query,
  Injectable,
  Headers,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { OrderStatus } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { InAppNotificationsService } from "../services/in-app-notifications.service";

/** Today = current calendar day in IST (UTC+5:30) for Indian users */
function getTodayISTRange(): { start: Date; end: Date } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const utcMs = Date.now();
  const istDate = new Date(utcMs + IST_OFFSET_MS);
  const y = istDate.getUTCFullYear();
  const m = istDate.getUTCMonth();
  const d = istDate.getUTCDate();
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - IST_OFFSET_MS - 1);
  return { start, end };
}

/** Current calendar month in IST (start of month 00:00 to end of month 23:59:59.999) */
function getCurrentMonthISTRange(): { start: Date; end: Date } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const utcMs = Date.now();
  const istDate = new Date(utcMs + IST_OFFSET_MS);
  const y = istDate.getUTCFullYear();
  const m = istDate.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS - 1);
  return { start, end };
}

/** Parse YYYY-MM-DD into start/end of that day in IST */
function parseISTDayToRange(dateStr: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0) - IST_OFFSET_MS - 1);
  return { start, end };
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inAppNotifications: InAppNotificationsService,
  ) {}

  private getEmptyDashboardStats() {
    return {
      overview: {
        totalOrders: 0,
        pendingOrders: 0,
        successOrders: 0,
        failedOrders: 0,
        cancelledOrders: 0,
        refundedOrders: 0,
        expiredOrders: 0,
        successRate: 0,
        revenueChange: 0,
        ordersChange: 0,
      },
      amounts: {
        totalAmount: 0,
        successAmount: 0,
        todayAmount: 0,
        todaySuccessAmount: 0,
        currentMonthSuccessAmount: 0,
      },
      today: { orders: 0, successOrders: 0, amount: 0, successAmount: 0 },
      currentMonth: { successAmount: 0, successOrders: 0, totalOrdersCreated: 0 },
      daily: {
        last10Days: [],
      },
      lastUpdated: new Date().toISOString(),
      recentTransactions: [],
    };
  }

  async getDashboardStats(
    timeRange: string = "7d",
    fromDate?: string,
    toDate?: string,
    organizationId?: string,
    chartFromDate?: string,
    chartToDate?: string,
  ) {
    try {
      // Require organization context for data isolation
      if (!organizationId || !organizationId.trim()) {
        return this.getEmptyDashboardStats();
      }

      const now = new Date();
      let startDate = new Date();
      let endDate = new Date();

      if (fromDate && toDate) {
        const fromRange = parseISTDayToRange(fromDate);
        const toRange = parseISTDayToRange(toDate);
        startDate = fromRange?.start ?? new Date(fromDate);
        endDate = toRange?.end ?? new Date(toDate);
      } else {
        endDate = now;
        switch (timeRange) {
          case "24h":
            startDate.setHours(now.getHours() - 24);
            break;
          case "7d":
            startDate.setDate(now.getDate() - 7);
            break;
          case "30d":
            startDate.setDate(now.getDate() - 30);
            break;
          case "90d":
            startDate.setDate(now.getDate() - 90);
            break;
          default:
            startDate.setDate(now.getDate() - 7);
        }
      }

      // Build where clause with organizationId filter
      const where: any = {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      };

      // CRITICAL: Filter by organizationId to ensure data isolation
      if (organizationId) {
        where.organizationId = organizationId;
      }

      where.NOT = [
        ...(where.NOT || []),
        {
          metadata: {
            path: '$.isPlatform',
            equals: true
          }
        }
      ];

      let previousStartDate = new Date(startDate);
      let previousEndDate = new Date(startDate);

      if (fromDate && toDate) {
        const rangeDays = Math.ceil(
          (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        previousStartDate = new Date(startDate);
        previousStartDate.setDate(previousStartDate.getDate() - rangeDays);
        previousEndDate = new Date(startDate);
        previousEndDate.setDate(previousEndDate.getDate() - 1);
      } else {
        switch (timeRange) {
          case "24h":
            previousStartDate.setHours(startDate.getHours() - 24);
            break;
          case "7d":
            previousStartDate.setDate(startDate.getDate() - 7);
            break;
          case "30d":
            previousStartDate.setDate(startDate.getDate() - 30);
            break;
          case "90d":
            previousStartDate.setDate(startDate.getDate() - 90);
            break;
        }
        previousEndDate = startDate;
      }

      const previousWhere: any = {
        createdAt: {
          gte: previousStartDate,
          lt: previousEndDate,
        },
        NOT: [
          {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        ]
      };
      if (organizationId) {
        previousWhere.organizationId = organizationId;
      }

      // Current month (IST) — full month, independent of selected range
      const { start: monthStartIST, end: monthEndIST } =
        getCurrentMonthISTRange();
      const currentMonthWhere: any = {
        createdAt: { gte: monthStartIST, lte: monthEndIST },
        NOT: [
          {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        ]
      };
      if (organizationId) {
        currentMonthWhere.organizationId = organizationId;
      }
      // Use database aggregations instead of loading entire ranges into memory.
      const [
        statusGroups,
        previousAgg,
        currentMonthTotalCreated,
        currentMonthCompletedAgg,
      ] = await Promise.all([
        // Per-status counts and amount sums for the selected range
        this.prisma.order.groupBy({
          by: ["status"],
          where,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        // Aggregate for previous period (for change percentages)
        this.prisma.order.aggregate({
          where: previousWhere,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        // Total orders created this month (any status) — for quota/usage display
        this.prisma.order.count({
          where: currentMonthWhere,
        }),
        // Completed orders this month (for success amount/count)
        this.prisma.order.aggregate({
          where: {
            ...currentMonthWhere,
            status: OrderStatus.COMPLETED,
          },
          _count: { _all: true },
          _sum: { amount: true },
        }),
      ]);

      let totalOrders = 0;
      let totalAmount = 0;
      let successOrders = 0;
      let successAmount = 0;
      let pendingOrders = 0;
      let failedOrders = 0;
      let cancelledOrders = 0;
      let refundedOrders = 0;
      let expiredOrders = 0;

      for (const row of statusGroups) {
        const count = row._count._all;
        const sumAmount = Number(row._sum.amount || 0);
        totalOrders += count;
        totalAmount += sumAmount;

        switch (row.status) {
          case OrderStatus.COMPLETED:
            successOrders = count;
            successAmount = sumAmount;
            break;
          case OrderStatus.PENDING:
            pendingOrders = count;
            break;
          case OrderStatus.FAILED:
            failedOrders = count;
            break;
          case OrderStatus.CANCELLED:
            cancelledOrders = count;
            break;
          case OrderStatus.REFUNDED:
            refundedOrders = count;
            break;
          case OrderStatus.EXPIRED:
            expiredOrders = count;
            break;
        }
      }

      const { start: todayStartIST, end: todayEndIST } = getTodayISTRange();

      const baseTodayWhere: any = {
        organizationId,
        createdAt: {
          gte: todayStartIST,
          lte: todayEndIST,
        },
        NOT: [
          {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        ]
      };

      const [todayAggAll, todayAggSuccess] = await Promise.all([
        this.prisma.order.aggregate({
          where: baseTodayWhere,
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.order.aggregate({
          where: {
            ...baseTodayWhere,
            status: OrderStatus.COMPLETED,
          },
          _count: { _all: true },
          _sum: { amount: true },
        }),
      ]);

      const todayAmount = Number(todayAggAll._sum.amount || 0);
      const todaySuccessAmount = Number(todayAggSuccess._sum.amount || 0);

      const previousTotalAmount = Number(previousAgg._sum.amount || 0);
      const previousTotalOrders = previousAgg._count._all;

      const revenueChange =
        previousTotalAmount > 0
          ? Math.round(
              ((totalAmount - previousTotalAmount) / previousTotalAmount) * 100,
            )
          : 0;

      const ordersChange =
        previousTotalOrders > 0
          ? Math.round(
              ((totalOrders - previousTotalOrders) / previousTotalOrders) * 100,
            )
          : 0;

      const successRate =
        totalOrders > 0 ? Math.round((successOrders / totalOrders) * 100) : 0;

      // Build calendar days for the bar chart.
      // - When chartFromDate/chartToDate are provided, use that entire window.
      // - Otherwise, default to the last 10 days relative to "today" in IST.
      let chartStart: Date;
      let chartEnd: Date;
      const MS_PER_DAY = 24 * 60 * 60 * 1000;

      if (chartFromDate && chartToDate) {
        const fromRange = parseISTDayToRange(chartFromDate);
        const toRange = parseISTDayToRange(chartToDate);
        chartStart = fromRange?.start ?? new Date(chartFromDate);
        chartEnd = toRange?.end ?? new Date(chartToDate);
      } else {
        const { start: todayStart } = getTodayISTRange();
        const todayAnchor = new Date(todayStart);
        chartEnd = new Date(todayAnchor);
        chartStart = new Date(todayAnchor);
        chartStart.setDate(chartEnd.getDate() - 9);
      }

      // Normalise to midnight in IST for bucket boundaries
      chartStart.setHours(0, 0, 0, 0);
      chartEnd.setHours(0, 0, 0, 0);

      const bucketCount = Math.max(
        1,
        Math.floor((chartEnd.getTime() - chartStart.getTime()) / MS_PER_DAY) + 1,
      );

      const last10DaysMap = new Map<
        string,
        {
          date: string;
          successAmount: number;
        }
      >();
      // Start from the end of the chart window and go backwards bucketCount days.
      for (let i = bucketCount - 1; i >= 0; i--) {
        const d = new Date(chartEnd);
        d.setDate(chartEnd.getDate() - i);
        const key = d.toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        });
        last10DaysMap.set(key, {
          date: key,
          successAmount: 0,
        });
      }

      const last10Start = new Date(chartEnd);
      last10Start.setDate(chartEnd.getDate() - (bucketCount - 1));
      const last10End = new Date(chartEnd);
      last10End.setDate(chartEnd.getDate() + 1);

      const last10Where: any = {
        createdAt: {
          gte: last10Start,
          lt: last10End,
        },
        NOT: [
          {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        ]
      };
      if (organizationId) {
        last10Where.organizationId = organizationId;
      }

      const last10Orders = await this.prisma.order.findMany({
        where: last10Where,
        select: {
          createdAt: true,
          amount: true,
          status: true,
        },
      });

      for (const o of last10Orders) {
        if (o.status !== OrderStatus.COMPLETED) continue;
        const key = new Date(o.createdAt).toLocaleDateString("en-CA", {
          timeZone: "Asia/Kolkata",
        });
        const bucket = last10DaysMap.get(key);
        if (bucket) {
          bucket.successAmount += Number(o.amount || 0);
        }
      }

      const last10Days = Array.from(last10DaysMap.values());

      const recentOrders = await this.prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      const recentTransactions = recentOrders.map((order) => ({
        id: order.id,
        txnId: order.externalOrderId,
        amount: Number(order.amount || 0),
        status: order.status.toLowerCase() as any,
        customer: order.customerName || "Unknown",
        time: order.createdAt,
        createdAt: order.createdAt,
      }));

      return {
        overview: {
          totalOrders,
          pendingOrders,
          successOrders,
          failedOrders,
          cancelledOrders,
          refundedOrders,
          expiredOrders,
          successRate,
          revenueChange,
          ordersChange,
        },
        amounts: {
          totalAmount,
          successAmount,
          todayAmount,
          todaySuccessAmount,
          currentMonthSuccessAmount: Number(
            currentMonthCompletedAgg._sum.amount || 0,
          ),
        },
        today: {
          orders: todayAggAll._count._all,
          successOrders: todayAggSuccess._count._all,
          amount: todayAmount,
          successAmount: todaySuccessAmount,
        },
        currentMonth: {
          successAmount: Number(
            currentMonthCompletedAgg._sum.amount || 0,
          ),
          successOrders: currentMonthCompletedAgg._count._all,
          totalOrdersCreated: currentMonthTotalCreated,
        },
        daily: {
          last10Days,
        },
        lastUpdated: new Date().toISOString(),
        recentTransactions,
      };
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      throw new Error("Failed to fetch dashboard statistics");
    }
  }

  async getMerchantPerformance(
    timeRange: string = "7d",
    fromDate?: string,
    toDate?: string,
    organizationId?: string,
    limit: number = 10,
  ) {
    try {
      if (!organizationId || !organizationId.trim()) {
        return {
          success: true,
          merchants: [],
          lastUpdated: new Date().toISOString(),
        };
      }

      const now = new Date();
      let startDate = new Date();
      let endDate = new Date();

      if (fromDate && toDate) {
        const fromRange = parseISTDayToRange(fromDate);
        const toRange = parseISTDayToRange(toDate);
        startDate = fromRange?.start ?? new Date(fromDate);
        endDate = toRange?.end ?? new Date(toDate);
      } else {
        endDate = now;
        switch (timeRange) {
          case "24h":
            startDate.setHours(now.getHours() - 24);
            break;
          case "7d":
            startDate.setDate(now.getDate() - 7);
            break;
          case "30d":
            startDate.setDate(now.getDate() - 30);
            break;
          case "90d":
            startDate.setDate(now.getDate() - 90);
            break;
          default:
            startDate.setDate(now.getDate() - 7);
        }
      }

      const where: any = {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
        organizationId,
        NOT: [
          {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        ]
      };

      // Aggregate per-merchant stats in the database instead of loading all orders.
      const perMerchantStatus = await this.prisma.order.groupBy({
        by: ["merchantId", "status"],
        where,
        _count: { _all: true },
        _sum: { amount: true },
      });

      if (!perMerchantStatus.length) {
        return {
          success: true,
          merchants: [],
          lastUpdated: new Date().toISOString(),
        };
      }

      const merchantMap = new Map<
        string,
        {
          merchantId: string;
          totalOrders: number;
          successOrders: number;
          failedOrders: number;
          pendingOrders: number;
          totalAmount: number;
          successAmount: number;
        }
      >();

      for (const row of perMerchantStatus) {
        if (!row.merchantId) continue;
        const key = row.merchantId;
        if (!merchantMap.has(key)) {
          merchantMap.set(key, {
            merchantId: key,
            totalOrders: 0,
            successOrders: 0,
            failedOrders: 0,
            pendingOrders: 0,
            totalAmount: 0,
            successAmount: 0,
          });
        }
        const agg = merchantMap.get(key)!;
        const count = row._count._all;
        const sumAmount = Number(row._sum.amount || 0);

        agg.totalOrders += count;
        agg.totalAmount += sumAmount;

        switch (row.status) {
          case OrderStatus.COMPLETED:
            agg.successOrders += count;
            agg.successAmount += sumAmount;
            break;
          case OrderStatus.FAILED:
            agg.failedOrders += count;
            break;
          case OrderStatus.PENDING:
            agg.pendingOrders += count;
            break;
        }
      }

      const merchantIds = Array.from(merchantMap.keys());
      const merchantDetails: Record<string, { name: string }> = {};
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;

      if (merchantServiceUrl && merchantIds.length > 0) {
        try {
          const axios = require("axios");
          await Promise.all(
            merchantIds.map(async (id) => {
              try {
                const response = await axios.get(
                  `${merchantServiceUrl}/merchant/${id}`,
                  { params: { includeDeleted: "true" }, headers: { "x-internal-token": process.env.INTERNAL_TOKEN } },
                );
                const merchant = response.data?.merchant || response.data;
                if (merchant) {
                  merchantDetails[id] = {
                    name:
                      merchant.businessName ||
                      merchant.name ||
                      `Merchant ${id.substring(0, 6)}`,
                  };
                }
              } catch (e) {
                if (!merchantDetails[id]) {
                  merchantDetails[id] = {
                    name: `Merchant ${id.substring(0, 6)}`,
                  };
                }
              }
            }),
          );
        } catch (e) {
          console.warn(
            "⚠️ Failed to fetch merchant details for performance dashboard:",
            e?.message || e,
          );
        }
      }

      const merchants = Array.from(merchantMap.values())
        .map((m) => {
          const successRate =
            m.totalOrders > 0
              ? Math.round((m.successOrders / m.totalOrders) * 100)
              : 0;
          return {
            merchantId: m.merchantId,
            name:
              merchantDetails[m.merchantId]?.name ||
              `Merchant ${m.merchantId.substring(0, 6)}`,
            totalOrders: m.totalOrders,
            successOrders: m.successOrders,
            failedOrders: m.failedOrders,
            pendingOrders: m.pendingOrders,
            successRate,
            totalAmount: m.totalAmount,
            successAmount: m.successAmount,
          };
        })
        .sort((a, b) => {
          if (b.totalOrders !== a.totalOrders) {
            return b.totalOrders - a.totalOrders;
          }
          return b.successRate - a.successRate;
        })
        .slice(0, limit);

      return {
        success: true,
        merchants,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Error fetching merchant performance stats:", error);
      throw new Error("Failed to fetch merchant performance statistics");
    }
  }

  async getDashboardTransactions(
    page: number = 1,
    limit: number = 50,
    merchantId?: string,
    organizationId?: string,
  ) {
    try {
      // Require organization context for data isolation
      if (!organizationId || !organizationId.trim()) {
        return {
          success: true,
          transactions: [],
          pagination: { page: 1, limit, total: 0, totalPages: 0 },
        };
      }

      const skip = (page - 1) * limit;

      const where: any = {};
      if (merchantId) {
        where.merchantId = merchantId;
      }
      if (organizationId) {
        where.organizationId = organizationId;
      }

      where.NOT = [
        ...(where.NOT || []),
        {
          metadata: {
            path: '$.isPlatform',
            equals: true
          }
        }
      ];

      // Get orders with related transactions from database
      const orders = await this.prisma.order.findMany({
        where,
        include: {
          transactions: {
            take: 1,
          }, // Only need the first related transaction
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      });

      // Get total count for pagination
      const total = await this.prisma.order.count({ where });

      const transactions = orders.map((order) => {
        const transaction = order.transactions?.[0]; // Get first transaction if exists
        return {
          id: order.id,
          merchantId: order.merchantId,
          amount: Number(order.amount || 0),
          currency: order.currency || "INR",
          status: order.status,
          customerName: order.customerName || "N/A",
          customerMobile: order.customerMobile || transaction?.utr || "N/A",
          transactionDate: order.createdAt,
          externalOrderId: order.externalOrderId,
          paymentMethod: order.paymentMethod || "UPI",
          utr: transaction?.utr || "N/A",
          providerResponse: transaction?.providerResponse || null,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        };
      });

      return {
        success: true,
        transactions,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      console.error("Error fetching dashboard transactions:", error);
      throw new Error("Failed to fetch dashboard transactions");
    }
  }

  async getTransactionStats(merchantId?: string, providerId?: string, organizationId?: string) {
    try {
      const where: any = {};
      if (merchantId) {
        where.merchantId = merchantId;
      }
      if (providerId) {
        where.providerId = providerId;
      }

      const orderWhere: any = {
        NOT: {
          metadata: {
            path: '$.isPlatform',
            equals: true
          }
        }
      };

      if (organizationId && organizationId !== "platform-org-id") {
        orderWhere.organizationId = organizationId;
      }
      where.order = orderWhere;

      const { start: todayStartIST, end: todayEndIST } = getTodayISTRange();

      // Get transaction counts and amounts from the TRANSACTION table (not orders)
      const [
        totalTransactions,
        totalAmount,
        successfulTransactions,
        failedTransactions,
        pendingTransactions,
        todayTransactions,
        todayAmount,
      ] = await Promise.all([
        // Total transactions
        this.prisma.transaction.count({ where }),

        // Total amount
        this.prisma.transaction.aggregate({
          where,
          _sum: { amount: true },
        }),

        // Successful transactions
        this.prisma.transaction.count({
          where: { ...where, status: "SUCCESS" },
        }),

        // Failed transactions
        this.prisma.transaction.count({
          where: { ...where, status: "FAILED" },
        }),

        // Pending transactions
        this.prisma.transaction.count({
          where: { ...where, status: "PENDING" },
        }),

        // Today's transactions
        this.prisma.transaction.count({
          where: {
            ...where,
            createdAt: {
              gte: todayStartIST,
              lte: todayEndIST,
            },
          },
        }),

        // Today's amount
        this.prisma.transaction.aggregate({
          where: {
            ...where,
            createdAt: {
              gte: todayStartIST,
              lte: todayEndIST,
            },
          },
          _sum: { amount: true },
        }),
      ]);

      return {
        success: true,
        stats: {
          totalTransactions,
          totalAmount: Number(totalAmount._sum.amount || 0),
          successfulTransactions,
          failedTransactions,
          pendingTransactions,
          todayTransactions,
          todayAmount: Number(todayAmount._sum.amount || 0),
        },
      };
    } catch (error) {
      console.error("Error fetching transaction stats:", error);
      throw new Error("Failed to fetch transaction stats");
    }
  }

  /**
   * Per-connector stats with order-based fallback.
   * Useful for connector cards where some historical transactions may not yet exist
   * in the unified Transaction table but orders are present.
   */
  async getConnectorStats(merchantId: string, providerId: string, organizationId?: string) {
    if (!merchantId || !providerId) {
      return {
        success: true,
        stats: {
          totalTransactions: 0,
          totalAmount: 0,
          successfulTransactions: 0,
          failedTransactions: 0,
          pendingTransactions: 0,
          todayTransactions: 0,
          todayAmount: 0,
        },
      };
    }

    const orderWhere: any = {
      NOT: {
        metadata: {
          path: '$.isPlatform',
          equals: true
        }
      }
    };
    if (organizationId && organizationId !== "platform-org-id") {
      orderWhere.organizationId = organizationId;
    }

    const whereTxn: any = {
      merchantId,
      providerId,
      order: orderWhere,
    };

    const { start: todayStartIST, end: todayEndIST } = getTodayISTRange();

    const [
      // Transaction-table stats
      totalTransactions,
      totalAmount,
      successfulTransactions,
      failedTransactions,
      pendingTransactions,
      todayTransactions,
      todayAmount,
      // Order-table fallback (completed orders for this connector)
      completedOrdersCount,
      completedOrdersAmount,
      todayCompletedOrdersCount,
      todayCompletedOrdersAmount,
    ] = await Promise.all([
      this.prisma.transaction.count({ where: whereTxn }),
      this.prisma.transaction.aggregate({
        where: whereTxn,
        _sum: { amount: true },
      }),
      this.prisma.transaction.count({
        where: { ...whereTxn, status: "SUCCESS" },
      }),
      this.prisma.transaction.count({
        where: { ...whereTxn, status: "FAILED" },
      }),
      this.prisma.transaction.count({
        where: { ...whereTxn, status: "PENDING" },
      }),
      this.prisma.transaction.count({
        where: {
          ...whereTxn,
          createdAt: {
            gte: todayStartIST,
            lte: todayEndIST,
          },
        },
      }),
      this.prisma.transaction.aggregate({
        where: {
          ...whereTxn,
          createdAt: {
            gte: todayStartIST,
            lte: todayEndIST,
          },
        },
        _sum: { amount: true },
      }),
      // Orders: completed only, scoped to this connector
      this.prisma.order.count({
        where: {
          merchantId,
          providerId,
          status: OrderStatus.COMPLETED,
          NOT: {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        },
      }),
      this.prisma.order.aggregate({
        where: {
          merchantId,
          providerId,
          status: OrderStatus.COMPLETED,
          NOT: {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          }
        },
        _sum: { amount: true },
      }),
      this.prisma.order.count({
        where: {
          merchantId,
          providerId,
          status: OrderStatus.COMPLETED,
          NOT: {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          },
          createdAt: {
            gte: todayStartIST,
            lte: todayEndIST,
          },
        },
      }),
      this.prisma.order.aggregate({
        where: {
          merchantId,
          providerId,
          status: OrderStatus.COMPLETED,
          NOT: {
            metadata: {
              path: '$.isPlatform',
              equals: true
            }
          },
          createdAt: {
            gte: todayStartIST,
            lte: todayEndIST,
          },
        },
        _sum: { amount: true },
      }),
    ]);

    const txTotalAmount = Number(totalAmount._sum.amount || 0);
    const orderTotalAmount = Number(completedOrdersAmount._sum.amount || 0);
    const txTodayAmount = Number(todayAmount._sum.amount || 0);
    const orderTodayAmount = Number(todayCompletedOrdersAmount._sum.amount || 0);

    return {
      success: true,
      stats: {
        totalTransactions: Math.max(totalTransactions, completedOrdersCount),
        totalAmount: Math.max(txTotalAmount, orderTotalAmount),
        successfulTransactions,
        failedTransactions,
        pendingTransactions,
        todayTransactions: Math.max(todayTransactions, todayCompletedOrdersCount),
        todayAmount: Math.max(txTodayAmount, orderTodayAmount),
      },
    };
  }

  async getNotifications(
    organizationId: string,
    userId: string | undefined,
    limit?: number,
  ) {
    const list = await this.inAppNotifications.list(
      organizationId,
      userId,
      limit,
    );
    return { notifications: list };
  }

  async markNotificationRead(notificationId: string, userId: string) {
    await this.inAppNotifications.markAsRead(notificationId, userId);
    return { success: true };
  }

  async markAllNotificationsRead(organizationId: string, userId: string) {
    const marked = await this.inAppNotifications.markAllAsRead(
      organizationId,
      userId,
    );
    return { success: true, marked };
  }
}

@ApiTags("Dashboard")
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("stats")
  @ApiOperation({ summary: "Get dashboard statistics" })
  @ApiResponse({
    status: 200,
    description: "Dashboard stats retrieved successfully",
  })
  async getStats(
    @Headers("x-organization-id") organizationId: string,
    @Query("timeRange") timeRange: string = "7d",
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("chartFromDate") chartFromDate?: string,
    @Query("chartToDate") chartToDate?: string,
  ) {
    return this.dashboardService.getDashboardStats(
      timeRange,
      fromDate,
      toDate,
      organizationId,
      chartFromDate,
      chartToDate,
    );
  }

  @Get("merchants/performance")
  @ApiOperation({
    summary:
      "Get merchant-wise performance for the selected date range (success ratio, counts, amounts)",
  })
  @ApiResponse({
    status: 200,
    description: "Merchant performance stats retrieved successfully",
  })
  async getMerchantPerformance(
    @Headers("x-organization-id") organizationId: string,
    @Query("timeRange") timeRange: string = "7d",
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("limit") limit: string = "20",
  ) {
    return this.dashboardService.getMerchantPerformance(
      timeRange,
      fromDate,
      toDate,
      organizationId,
      parseInt(limit, 10) || 20,
    );
  }

  @Get("transactions")
  @ApiOperation({ summary: "Get dashboard transactions" })
  @ApiResponse({
    status: 200,
    description: "Transactions retrieved successfully",
  })
  async getTransactions(
    @Headers("x-organization-id") organizationId: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "50",
    @Query("merchantId") merchantId?: string,
  ) {
    return this.dashboardService.getDashboardTransactions(
      parseInt(page, 10),
      parseInt(limit, 10),
      merchantId,
      organizationId,
    );
  }

  @Get("transactions/stats")
  @ApiOperation({ summary: "Get transaction statistics" })
  @ApiResponse({
    status: 200,
    description: "Transaction stats retrieved successfully",
  })
  async getTransactionStats(
    @Headers("x-organization-id") organizationId: string,
    @Query("merchantId") merchantId?: string,
    @Query("providerId") providerId?: string,
  ) {
    return this.dashboardService.getTransactionStats(merchantId, providerId, organizationId);
  }

  @Get("connectors/stats")
  @ApiOperation({ summary: "Get per-connector transaction statistics with order fallback" })
  @ApiResponse({
    status: 200,
    description: "Connector stats retrieved successfully",
  })
  async getConnectorStats(
    @Headers("x-organization-id") organizationId: string,
    @Query("merchantId") merchantId: string,
    @Query("providerId") providerId: string,
  ) {
    return this.dashboardService.getConnectorStats(merchantId, providerId, organizationId);
  }

  @Get("notifications")
  @ApiOperation({ summary: "List in-app notifications (bell) for the org" })
  @ApiResponse({
    status: 200,
    description: "Notifications with read status for current user",
  })
  async getNotifications(
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-id") userId: string | undefined,
    @Query("limit") limit?: string,
  ) {
    const actualOrgId = organizationId === "platform-org-id" ? "SUPERADMIN" : organizationId;
    return this.dashboardService.getNotifications(
      actualOrgId,
      userId,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Put("notifications/read-all")
  @ApiOperation({
    summary: "Mark all in-app notifications for the org as read",
  })
  @ApiResponse({ status: 200, description: "All marked as read" })
  async markAllNotificationsRead(
    @Headers("x-organization-id") organizationId: string,
    @Headers("x-user-id") userId: string,
  ) {
    const actualOrgId = organizationId === "platform-org-id" ? "SUPERADMIN" : organizationId;
    return this.dashboardService.markAllNotificationsRead(
      actualOrgId,
      userId,
    );
  }

  @Put("notifications/:id/read")
  @ApiOperation({ summary: "Mark an in-app notification as read" })
  @ApiResponse({ status: 200, description: "Marked as read" })
  async markNotificationRead(
    @Param("id") notificationId: string,
    @Headers("x-user-id") userId: string,
  ) {
    return this.dashboardService.markNotificationRead(notificationId, userId);
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  Injectable,
  Logger,
  Headers,
  HttpCode,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma.service";
import { QrcodeService } from "../services/qrcode.service";
import { HealthMonitorService } from "../services/health-monitor.service";
import { CallbackService } from "../services/callback.service";
import { OrderEventsService } from "../services/order-events.service";

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private qrcodeService: QrcodeService,
    private healthMonitor: HealthMonitorService,
    private configService: ConfigService,
    private callbackService: CallbackService,
    private orderEvents: OrderEventsService,
  ) { }

  /** Today = current calendar day in IST (UTC+5:30) for Indian users, regardless of server TZ */
  private getTodayISTRange(): { start: Date; end: Date } {
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

  /** Parse YYYY-MM-DD as a day in IST and return start/end of that day in UTC */
  private parseISTDayToRange(
    dateStr: string,
  ): { start: Date; end: Date } | null {
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

  async getQRUsage(organizationId: string, merchantId?: string) {
    try {
      const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;
      const axios = require("axios");

      const subResponse = await axios.get(
        `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );

      const subscription = subResponse.data?.subscription;
      if (!subscription || !["ACTIVE", "TRIAL"].includes(subscription.status)) {
        return {
          success: true,
          qrUsed: 0,
          qrLimit: 0,
          remaining: 0,
          message: "No active subscription"
        };
      }

      const qrLimit = subscription.limits?.maxTransactions || 0;
      const billingCycleStart = new Date(subscription.startDate);
      let billingCycleEnd = subscription.endDate ? new Date(subscription.endDate) : new Date();
      if (!subscription.endDate && subscription.nextBillingAt) {
        billingCycleEnd = new Date(subscription.nextBillingAt);
      }

      const whereClause: any = {
        organizationId,
        createdAt: {
          gte: billingCycleStart,
          lte: billingCycleEnd
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

      if (merchantId) {
        whereClause.merchantId = merchantId;
      }

      const [qrUsed, activeCount, expiredCount] = await Promise.all([
        this.prisma.order.count({ where: whereClause }),
        this.prisma.order.count({
          where: { ...whereClause, status: { in: ['PENDING', 'COMPLETED', 'PROCESSING'] } }
        }),
        this.prisma.order.count({
          where: { ...whereClause, status: 'EXPIRED' }
        }),
      ]);

      return {
        success: true,
        qrUsed,
        activeCount,
        expiredCount,
        qrLimit,
        remaining: Math.max(0, qrLimit - qrUsed)
      };

    } catch (error) {
      console.error("Error fetching QR usage:", error);
      return {
        success: false,
        message: "Failed to fetch QR usage"
      };
    }
  }

  async getOrders(
    page: number = 1,
    limit: number = 20,
    organizationId?: string,
    merchantId?: string,
    status?: string,
    search?: string,
    fromDate?: string,
    toDate?: string,
    excludeExpired?: boolean,
    includePlatform?: boolean,
    paymentApp?: string,
  ) {
    try {
      const skip = (page - 1) * limit;

      const baseWhere: any = {};
      if (organizationId) baseWhere.organizationId = organizationId;
      if (merchantId) baseWhere.merchantId = merchantId;

      if (!includePlatform && (!status || status !== "PLATFORM")) {
        baseWhere.NOT = [
          ...(baseWhere.NOT || []),
          {
            metadata: {
              path: "$.isPlatform",
              equals: true,
            },
          },
        ];
      }

      if (search && search.trim()) {
        const searchTerm = search.trim();
        const orConditions: any[] = [
          { externalOrderId: { contains: searchTerm } },
          { clientReferenceId: { contains: searchTerm } },
          { customerName: { contains: searchTerm } },
          { customerEmail: { contains: searchTerm } },
          { customerMobile: { contains: searchTerm } },
          { id: { contains: searchTerm } },
          { description: { contains: searchTerm } },
        ];
        const amountNum = parseFloat(searchTerm);
        if (!Number.isNaN(amountNum) && amountNum >= 0) {
          orConditions.push({ amount: amountNum });
        }
        baseWhere.OR = orConditions;
      }

      if (fromDate || toDate) {
        baseWhere.createdAt = baseWhere.createdAt || {};
        if (fromDate) {
          const range = this.parseISTDayToRange(fromDate);
          if (range) baseWhere.createdAt.gte = range.start;
        }
        if (toDate) {
          const range = this.parseISTDayToRange(toDate);
          if (range) baseWhere.createdAt.lte = range.end;
        }
      }

      if (paymentApp) {
        const lowerApp = paymentApp.toLowerCase();
        let appList = [paymentApp];
        if (lowerApp === "google pay" || lowerApp === "gpay") {
          appList = ["Google Pay", "GPay", "google pay", "gpay", "GOOGLE PAY", "GPAY"];
        } else if (lowerApp === "phonepe" || lowerApp === "phone pe") {
          appList = ["PhonePe", "Phonepe", "phonepe", "PHONEPE", "Phone Pe", "phone pe"];
        } else if (lowerApp === "paytm") {
          appList = ["Paytm", "paytm", "PAYTM"];
        } else if (lowerApp === "bhim") {
          appList = ["BHIM", "bhim", "Bhim", "BHIM UPI", "bhim upi"];
        } else if (lowerApp === "cred") {
          appList = ["Cred", "cred", "CRED"];
        } else if (lowerApp === "amazon pay" || lowerApp === "amazonpay") {
          appList = ["Amazon Pay", "AmazonPay", "amazon pay", "amazonpay", "AMAZON PAY"];
        } else if (lowerApp === "hdfc" || lowerApp === "pthdfc") {
          appList = ["pthdfc", "HDFC", "hdfc", "HDFC Bank", "HDFC BANK"];
        } else if (lowerApp === "sbi" || lowerApp === "ptsbi") {
          appList = ["ptsbi", "SBI", "sbi", "State Bank of India", "STATE BANK OF INDIA"];
        } else if (lowerApp === "axis" || lowerApp === "ptaxis") {
          appList = ["ptaxis", "AXIS", "axis", "Axis Bank", "Axis Bank"];
        } else if (lowerApp === "yes" || lowerApp === "ptyes") {
          appList = ["ptyes", "YES", "yes", "YES BANK", "Yes Bank"];
        }

        if (lowerApp === "upi") {
          baseWhere.OR = [
            {
              transactions: {
                some: {
                  OR: [
                    { paymentApp: { in: ["UPI", "upi", ""] } },
                    { paymentApp: null }
                  ]
                },
              },
            },
            {
              transactions: {
                none: {},
              },
            },
          ];
        } else {
          baseWhere.transactions = {
            some: {
              OR: [
                { paymentApp: { in: appList } },
                { paymentApp: { contains: paymentApp } }
              ]
            },
          };
        }
      }

      const where = { ...baseWhere };
      if (baseWhere.NOT) {
        where.NOT = [...baseWhere.NOT];
      }

      if (status) {
        const statusList = status.split(",").map((s) => s.trim().toUpperCase());
        if (statusList.length === 1 && statusList[0] === "EXPIRED") {
          if (where.OR) {
            where.AND = [
              ...(where.AND || []),
              { OR: where.OR },
              {
                OR: [
                  { status: "EXPIRED" },
                  { status: "PENDING", paymentLink: { expiresAt: { lt: new Date() } } },
                ],
              },
            ];
            delete where.OR;
          } else {
            where.OR = [
              { status: "EXPIRED" },
              { status: "PENDING", paymentLink: { expiresAt: { lt: new Date() } } },
            ];
          }
        } else if (statusList.length === 1 && statusList[0] === "PENDING") {
          where.status = "PENDING";
          if (where.OR) {
            where.AND = [
              ...(where.AND || []),
              { OR: where.OR },
              {
                OR: [
                  { paymentLink: { is: null } },
                  { paymentLink: { expiresAt: null } },
                  { paymentLink: { expiresAt: { gte: new Date() } } },
                ],
              },
            ];
            delete where.OR;
          } else {
            where.OR = [
              { paymentLink: { is: null } },
              { paymentLink: { expiresAt: null } },
              { paymentLink: { expiresAt: { gte: new Date() } } },
            ];
          }
        } else if (statusList.length > 1) {
          where.status = { in: statusList };
        } else {
          where.status = statusList[0];
        }
      } else if (excludeExpired) {
        where.NOT = [
          ...(where.NOT || []),
          { status: "EXPIRED" },
          { status: "PENDING", paymentLink: { expiresAt: { lt: new Date() } } },
        ];
      }

      // Build independent status queries for correct statistics counts
      const whereCompletedCount = { ...baseWhere, status: "COMPLETED" as const };
      const whereFailedCount = { ...baseWhere, status: "FAILED" as const };

      const wherePendingCount = { ...baseWhere, status: "PENDING" as const };
      if (wherePendingCount.OR) {
        wherePendingCount.AND = [
          ...(wherePendingCount.AND || []),
          { OR: wherePendingCount.OR },
          {
            OR: [
              { paymentLink: { is: null } },
              { paymentLink: { expiresAt: null } },
              { paymentLink: { expiresAt: { gte: new Date() } } },
            ],
          },
        ];
        delete wherePendingCount.OR;
      } else {
        wherePendingCount.OR = [
          { paymentLink: { is: null } },
          { paymentLink: { expiresAt: null } },
          { paymentLink: { expiresAt: { gte: new Date() } } },
        ];
      }

      const whereExpiredCount = { ...baseWhere };
      if (whereExpiredCount.OR) {
        whereExpiredCount.AND = [
          ...(whereExpiredCount.AND || []),
          { OR: whereExpiredCount.OR },
          {
            OR: [
              { status: "EXPIRED" as const },
              { status: "PENDING" as const, paymentLink: { expiresAt: { lt: new Date() } } },
            ],
          },
        ];
        delete whereExpiredCount.OR;
      } else {
        whereExpiredCount.OR = [
          { status: "EXPIRED" as const },
          { status: "PENDING" as const, paymentLink: { expiresAt: { lt: new Date() } } },
        ];
      }

      // "Today" = current day in IST (Indian users), regardless of server UTC
      const { start: startOfTodayIST, end: endOfTodayIST } =
        this.getTodayISTRange();
      const whereToday = {
        ...where,
        createdAt: { gte: startOfTodayIST, lte: endOfTodayIST },
      };

      const whereCompleted = whereCompletedCount;
      const whereTodayCompleted = {
        ...whereCompletedCount,
        createdAt: { gte: startOfTodayIST, lte: endOfTodayIST },
      };

      const [
        orders,
        total,
        successCount,
        pendingCount,
        failedCount,
        expiredCount,
        sumResult,
        todaySumResult,
        successSumResult,
        todaySuccessSumResult,
      ] = await Promise.all([
        this.prisma.order.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            paymentLink: true,
            transactions: {
              take: 1,
              orderBy: { createdAt: "desc" },
            },
          },
        }),
        this.prisma.order.count({ where }),
        this.prisma.order.count({ where: whereCompletedCount }),
        this.prisma.order.count({ where: wherePendingCount }),
        this.prisma.order.count({ where: whereFailedCount }),
        this.prisma.order.count({ where: whereExpiredCount }),
        this.prisma.order.aggregate({ where, _sum: { amount: true } }),
        this.prisma.order.aggregate({
          where: whereToday,
          _sum: { amount: true },
        }),
        this.prisma.order.aggregate({
          where: whereCompleted,
          _sum: { amount: true },
        }),
        this.prisma.order.aggregate({
          where: whereTodayCompleted,
          _sum: { amount: true },
        }),
      ]);

      const appStatsRaw = await this.prisma.transaction.groupBy({
        by: ['paymentApp', 'providerCode'],
        where: {
          order: whereCompletedCount,
          status: "SUCCESS"
        },
        _sum: { amount: true },
        _count: { _all: true },
      });

      let connectorMap: Map<string, any> = new Map();
      try {
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
        const axios = require("axios");
        const connectorsResponse = await axios.get(
          `${merchantServiceUrl}/merchant/connectors`,
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );
        if (connectorsResponse.data?.connectors) {
          for (const connector of connectorsResponse.data.connectors) {
            connectorMap.set(connector.id, connector);
          }
        }
      } catch (err) {
        console.warn(
          "Could not fetch connectors from merchant-service:",
          err.message,
        );
      }

      const enrichedOrders = orders.map((order) => {
        let connectorName = null;
        let providerType = null;
        let providerVpa = null;
        let providerLogo = null;
        let paidBy = order.customerName || null;

        if (order.providerId && connectorMap.has(order.providerId)) {
          const connector = connectorMap.get(order.providerId);
          connectorName = connector.displayName || connector.merchantName;
          providerType = connector.providerType;
          providerVpa = connector.upiId;
          providerLogo = connector.logo;
        }

        const latestTransaction = order.transactions?.[0];
        if (!providerType && latestTransaction?.providerCode) {
          providerType = latestTransaction.providerCode;
        }

        if (!providerVpa && order.paymentLink?.qrData) {
          const qrData = order.paymentLink.qrData;
          const paMatch = qrData.match(/pa=([^&]+)/);
          if (paMatch && paMatch[1]) {
            providerVpa = decodeURIComponent(paMatch[1]);
          }
        }

        const utr = latestTransaction?.utr || order.utr || (order.metadata as any)?.utr;

        // Derive paidBy similar to OrderDetails: prefer transaction customer name when available
        if (latestTransaction) {
          const raw = latestTransaction.providerResponse as any;
          const customerDetails = (raw && raw.customerDetails) || {};
          const additionalInfo = (raw && raw.additionalInfo) || {};
          const candidateName =
            customerDetails.userName ||
            additionalInfo.customerName ||
            (raw && (raw.payerName || raw.senderName)) ||
            paidBy;
          if (candidateName) {
            paidBy = candidateName;
          }
        }

        let status = order.status;
        if (status === "PENDING" && order.paymentLink?.expiresAt) {
          if (new Date(order.paymentLink.expiresAt) < new Date()) {
            status = "EXPIRED";
          }
        }

        return {
          ...order,
          status,
          connectorName,
          providerType,
          providerVpa,
          providerLogo,
          utr,
          paidBy,
          paymentApp: latestTransaction?.paymentApp || null,
        };
      });

      const totalAmount =
        sumResult._sum?.amount != null ? Number(sumResult._sum.amount) : 0;
      const todayTotalAmount =
        todaySumResult._sum?.amount != null
          ? Number(todaySumResult._sum.amount)
          : 0;
      const successAmount =
        successSumResult._sum?.amount != null
          ? Number(successSumResult._sum.amount)
          : 0;
      const todaySuccessAmount =
        todaySuccessSumResult._sum?.amount != null
          ? Number(todaySuccessSumResult._sum.amount)
          : 0;

      // Compute appBreakdown stats from appStatsRaw
      const appBreakdownStats: Record<string, { id: string, name: string, logo: string, amount: number, count: number }> = {};
      const defaultIds = ["gpay", "phonepe", "paytm", "bharatpe"];
      defaultIds.forEach((id) => {
        let name = "", logo = "";
        if (id === "gpay") { name = "Google Pay"; logo = "/gateways/gpay.png"; }
        if (id === "phonepe") { name = "PhonePe"; logo = "/gateways/PhonePe.png"; }
        if (id === "paytm") { name = "Paytm"; logo = "/gateways/paytm.png"; }
        if (id === "bharatpe") { name = "BharatPe"; logo = "/gateways/Bharatpe.svg"; }
        appBreakdownStats[id] = { id, name, logo, amount: 0, count: 0 };
      });

      appStatsRaw.forEach((row) => {
        const appRaw = (row.paymentApp || "").toLowerCase();
        const providerRaw = (row.providerCode || "").toLowerCase();
        const amt = Number(row._sum.amount || 0);
        const count = Number(row._count._all || 0);

        let app = appRaw || providerRaw;
        if (!app) return;

        if (app === "gpay" || app.includes("google") || app.includes("okicici") || app.includes("okaxis") || app.includes("oksbi") || app.includes("okhdfc")) {
          appBreakdownStats.gpay.amount += amt; appBreakdownStats.gpay.count += count;
        } else if (app.includes("phonepe") || app.includes("phone pe") || app.includes("ybl") || app.includes("ibl") || app.includes("axl")) {
          appBreakdownStats.phonepe.amount += amt; appBreakdownStats.phonepe.count += count;
        } else if (app.includes("paytm") || app.includes("ptsbi") || app.includes("pthdfc") || app.includes("ptaxis") || app.includes("ptyes")) {
          appBreakdownStats.paytm.amount += amt; appBreakdownStats.paytm.count += count;
        } else if (app.includes("bharatpe")) {
          appBreakdownStats.bharatpe.amount += amt; appBreakdownStats.bharatpe.count += count;
        } else if (app.includes("quintus")) {
          if (!appBreakdownStats.quintus) appBreakdownStats.quintus = { id: "quintus", name: "QuintusPay", logo: "/quintus/logo1.png", amount: 0, count: 0 };
          appBreakdownStats.quintus.amount += amt; appBreakdownStats.quintus.count += count;
        } else {
          // Identify junk or missing apps as Other UPI
          const isJunk = app.startsWith("upsa") || app.startsWith("frfz") || app === "order" || app.length > 20 || !app.trim();
          if (isJunk) {
            app = "other upi";
          }
          if (!appBreakdownStats[app]) {
            let name = app, logo = "/gateways/image.png";
            if (app.includes("amazon")) { name = "Amazon Pay"; logo = "/gateways/Amazonpay.svg"; }
            else if (app.includes("hdfc")) { name = "HDFC Bank"; logo = "/gateways/HDFC.svg"; }
            else if (app.includes("sbi")) { name = "SBI"; logo = "/gateways/SBI.png"; }
            else if (app.includes("axis")) { name = "Axis Bank"; logo = "/gateways/Axis.svg"; }
            else if (app.includes("yes")) { name = "YES Bank"; logo = "/gateways/YES.png"; }
            else if (app === "upi" || app === "other upi") { name = "Other UPI"; logo = "/UPI_Offical_Logo_result.webp"; }
            else { name = app.charAt(0).toUpperCase() + app.slice(1); }
            appBreakdownStats[app] = { id: app, name, logo, amount: 0, count: 0 };
          }
          appBreakdownStats[app].amount += amt;
          appBreakdownStats[app].count += count;
        }
      });

      const defaults = defaultIds.map(id => appBreakdownStats[id]);
      const others = Object.values(appBreakdownStats)
        .filter(s => !defaultIds.includes(s.id) && s.count > 0)
        .sort((a, b) => b.count - a.count);

      const appStatsArray = [...defaults, ...others];

      return {
        success: true,
        data: enrichedOrders,
        orders: enrichedOrders,
        successCount,
        pendingCount,
        failedCount,
        expiredCount,
        totalAmount,
        todayTotalAmount,
        successAmount,
        todaySuccessAmount,
        appStats: appStatsArray,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      console.error("Error fetching orders:", error);
      return {
        success: false,
        orders: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        error: "Failed to fetch orders",
      };
    }
  }

  async createOrder(orderData: any, headerOrgId?: string) {
    try {
      const parsedAmount = parseFloat(orderData.amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return {
          code: 4000,
          status: false,
          msg: "Invalid amount. Amount must be a positive number greater than 0.",
        };
      }

      if (orderData.key && !orderData.merchantId && !orderData.connectorId) {
        try {
          const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
          const axios = require("axios");

          console.log(
            `🔑 Resolving API key: ${orderData.key.substring(0, 15)}...`,
          );
          const keyResponse = await axios.post(
            `${orgServiceUrl}/organizations/validate-api-key`,
            { apiKey: orderData.key },
            { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
          );

          if (!keyResponse.data?.valid || !keyResponse.data?.organization) {
            return {
              code: 4000,
              status: false,
              msg: "Invalid API key. Please check your API key and try again.",
            };
          }

          const resolvedOrg = keyResponse.data.organization;
          console.log(
            `✅ API key resolved to organization: ${resolvedOrg.id} (${resolvedOrg.name})`,
          );

          orderData.organizationId = resolvedOrg.id;
          orderData._orgSlug = resolvedOrg.slug; // Store org slug for order ID prefix
          orderData._orgPrefix = resolvedOrg.order_prefix; // Unique org prefix for order IDs

          // Validate client_txn_id length (max 30 characters)
          if (orderData.client_txn_id && orderData.client_txn_id.length > 30) {
            return {
              code: 4000,
              status: false,
              msg: "client_txn_id must be at most 30 characters",
            };
          }

          // Store client_txn_id as clientReferenceId (NOT as externalOrderId)
          if (orderData.client_txn_id)
            orderData.clientReferenceId = orderData.client_txn_id;
          if (orderData.p_info) orderData.description = orderData.p_info;
          if (orderData.customer_name)
            orderData.customerName = orderData.customer_name;
          if (orderData.customer_email)
            orderData.customerEmail = orderData.customer_email;
          if (orderData.customer_mobile)
            orderData.customerMobile = orderData.customer_mobile;
          if (orderData.redirect_url)
            orderData.redirectUrl = orderData.redirect_url;
          if (orderData.callback_url)
            orderData.callbackUrl = orderData.callback_url;

          const userMetadata: Record<string, any> = {};
          if (orderData.udf1) userMetadata.udf1 = orderData.udf1;
          if (orderData.udf2) userMetadata.udf2 = orderData.udf2;
          if (orderData.udf3) userMetadata.udf3 = orderData.udf3;
          if (Object.keys(userMetadata).length > 0) {
            orderData._metadata = userMetadata;
          }

          if (!orderData.callbackUrl && resolvedOrg.webhook_url) {
            orderData.callbackUrl = resolvedOrg.webhook_url;
            console.log(
              `📡 Auto-populated webhook URL from organization: ${orderData.callbackUrl}`,
            );
          } else if (!orderData.callbackUrl) {
            console.warn(
              `⚠️ No webhook URL configured. Set it in Dashboard → API Keys & Webhooks, or pass callback_url in request.`,
            );
          }
        } catch (keyError: any) {
          console.error("❌ API key resolution failed:", keyError.message);
          return {
            code: 4000,
            status: false,
            msg: "Failed to validate API key. Please try again.",
          };
        }
      }

      let merchantId = orderData.merchantId;
      let organizationId = orderData.organizationId;

      if (!organizationId && headerOrgId) {
        organizationId = headerOrgId;
      }

      if (orderData.connectorId && !merchantId) {
        try {
          const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
          const axios = require("axios");

          const response = await axios.get(
            `${merchantServiceUrl}/merchant/list`,
            { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
          );
          const merchants = response.data.merchants || [];

          let foundMerchant = null;
          for (const merchant of merchants) {
            if (merchant.providers) {
              const provider = merchant.providers.find(
                (p) => p.id === orderData.connectorId,
              );
              if (provider) {
                foundMerchant = merchant;
                break;
              }
            }
          }

          if (!foundMerchant) {
            return {
              code: 4000,
              status: false,
              msg: "Provider (connector) not found. Please connect a payment provider first.",
            };
          }

          merchantId = foundMerchant.id;
          orderData._merchantName =
            foundMerchant.name || foundMerchant.businessName;
          organizationId = foundMerchant.organizationId || "default-org";
        } catch (err) {
          console.error("Failed to lookup connector:", err);
          return {
            code: 4000,
            status: false,
            msg: "Failed to lookup payment provider",
          };
        }
      }

      let smartRoutingError: string | null = null;
      let smartRoutingUsed = false;
      if (!merchantId && !orderData.connectorId) {
        const orgId = organizationId || headerOrgId;
        if (orgId) {
          try {
            const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
            const axios = require("axios");
            const amount = parseFloat(orderData.amount);

            if (amount > 0) {
              console.log(
                `🔄 Attempting Smart Routing for Org: ${orgId}, Amount: ${amount}`,
              );
              const routeResponse = await axios.post(
                `${merchantServiceUrl}/routing/route`,
                {
                  organizationId: orgId,
                  amount: amount,
                },
                { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
              );

              if (
                routeResponse.data?.success &&
                routeResponse.data?.merchantId
              ) {
                merchantId = routeResponse.data.merchantId;
                orderData._merchantName = routeResponse.data.merchantName;
                smartRoutingUsed = true;
                // If organizationId was missing in body, set it from context or the routing result (if available)
                if (!organizationId) organizationId = orgId;
                console.log(
                  `✅ Smart Routing selected merchant: ${merchantId} (${routeResponse.data.merchantName})`,
                );
              } else {
                smartRoutingError =
                  routeResponse.data?.message ||
                  "No suitable merchant found to process this transaction.";
                console.warn(`⚠️ Smart Routing failed: ${smartRoutingError}`);
              }
            }
          } catch (routeError) {
            smartRoutingError =
              routeError.message || "Smart routing service unavailable";
            console.error("Smart Routing error:", routeError.message);
          }
        }
      }

      if (!merchantId) {
        return {
          code: 4000,
          status: false,
          msg: smartRoutingError
            ? `No available merchant: ${smartRoutingError}`
            : "merchantId or connectorId is required",
        };
      }

      if (orderData.externalOrderId) {
        const existingOrder = await this.prisma.order.findFirst({
          where: {
            externalOrderId: orderData.externalOrderId,
            merchantId: merchantId,
          },
        });

        if (existingOrder) {
          console.log(
            `⚠️ Duplicate order detected: ${orderData.externalOrderId}`,
          );
          return {
            code: 4000,
            status: false,
            msg: `Order with ID '${orderData.externalOrderId}' already exists. Please use a unique order ID.`,
          };
        }
      }

      if (organizationId && !orderData.isPlatform) {
        try {
          const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;
          const axios = require("axios");

          console.log(
            `📋 Validating subscription for organization ${organizationId}`,
          );
          const subscriptionResponse = await axios.get(
            `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}`,
            { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
          );
          const subscriptionData = subscriptionResponse.data;
          const subscription =
            subscriptionData.subscription || subscriptionData;

          if (
            !subscription ||
            (subscription.status !== "ACTIVE" &&
              subscription.status !== "TRIAL")
          ) {
            console.log(
              `❌ Subscription not active for org ${organizationId} (status: ${subscription?.status})`,
            );
            return {
              code: 4000,
              status: false,
              msg: "Your subscription has expired or is inactive. Please renew your plan to continue creating orders.",
            };
          }

          if (subscription.endDate) {
            const expiryDate = new Date(subscription.endDate);
            if (expiryDate < new Date()) {
              console.log(
                `❌ Subscription expired on ${expiryDate.toISOString()}`,
              );
              return {
                code: 4000,
                status: false,
                msg: `Your plan expired on ${expiryDate.toLocaleDateString()}. Please renew to continue.`,
              };
            }
          }

          if (
            subscription.currentUsage &&
            subscription.limits?.maxTransactions
          ) {
            const current = subscription.currentUsage.transactionsCount || 0;
            const max = subscription.limits.maxTransactions;
            if (max > 0 && current >= max) {
              console.log(`❌ Transaction limit reached: ${current}/${max}`);
              return {
                code: 4000,
                status: false,
                msg: `Transaction limit reached (${current}/${max}). Please upgrade your plan to continue.`,
              };
            }
          }

          console.log(
            `✅ Subscription validation passed for org ${organizationId}`,
          );
        } catch (subError) {
          console.warn(
            "⚠️ Could not validate subscription, proceeding anyway:",
            subError.message,
          );
        }
      }

      if (!smartRoutingUsed) {
        try {
          const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
          const axios = require("axios");

          console.log(
            `🔍 Validating merchant ${merchantId} with connector ${orderData.connectorId}`,
          );
          const validationResponse = await axios.get(
            `${merchantServiceUrl}/merchant/${merchantId}/can-generate-qr`,
            {
              params: { bypass: orderData.isPlatform ? "true" : "false" },
              headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
            }
          );
          const validation = validationResponse.data;

          console.log(
            `📋 Validation result:`,
            JSON.stringify(validation, null, 2),
          );

          if (!validation.canGenerate) {
            console.log(`❌ Validation failed: ${validation.message}`);
            return {
              code: 4000,
              status: false,
              msg:
                validation.message ||
                "Merchant configuration incomplete. Please complete merchant setup before creating orders.",
            };
          }

          console.log(`✅ Validation passed, proceeding with order creation`);
        } catch (validationError) {
          console.error(
            "Error validating merchant for QR generation:",
            validationError,
          );
          return {
            code: 4000,
            status: false,
            msg: "Failed to validate merchant configuration. Please ensure merchant setup is complete.",
          };
        }
      } else {
        console.log(`✅ Skipping secondary merchant validation (Smart Routing already validated limits and hours)`);
      }

      try {
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
        const axios = require("axios");
        const amount = parseFloat(orderData.amount);

        console.log(
          `💰 Validating transaction amount: ₹${amount} for merchant ${merchantId}`,
        );
        const txnValidationResponse = await axios.post(
          `${merchantServiceUrl}/merchant/${merchantId}/validate-transaction`,
          { amount, bypass: orderData.isPlatform ? true : false },
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );
        const txnValidation = txnValidationResponse.data;

        if (!txnValidation.canProcess) {
          console.log(
            `❌ Transaction validation failed: ${txnValidation.message}`,
          );
          return {
            code: 4000,
            status: false,
            msg:
              txnValidation.message ||
              `Transaction amount ₹${amount} is not allowed.`,
          };
        }

        console.log(`✅ Transaction amount validated successfully`);
      } catch (txnValidationError) {
        console.error(
          "Error validating transaction amount:",
          txnValidationError?.response?.data || txnValidationError?.message,
        );
        // If it's a 4xx error, return the validation message
        if (
          txnValidationError?.response?.status >= 400 &&
          txnValidationError?.response?.status < 500
        ) {
          return {
            code: 4000,
            status: false,
            msg:
              txnValidationError?.response?.data?.message ||
              "Transaction amount validation failed.",
          };
        }
        console.warn(
          "⚠️ Could not validate transaction amount, proceeding anyway",
        );
      }

      if (!orderData.callbackUrl && (organizationId || headerOrgId)) {
        try {
          const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
          const axios = require("axios");
          const orgIdToQuery = organizationId || headerOrgId;
          const orgResponse = await axios.get(
            `${orgServiceUrl}/organizations/${orgIdToQuery}/webhook`,
            { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": orgIdToQuery } }
          );
          if (orgResponse.data?.success && orgResponse.data?.webhookUrl) {
            orderData.callbackUrl = orgResponse.data.webhookUrl;
            console.log(
              `📡 Auto-populated webhook URL from organization details: ${orderData.callbackUrl}`,
            );
          }
        } catch (orgError) {
          console.warn("⚠️ Failed to auto-populate webhook URL from organization:", orgError.message);
        }
      }

      const orgSlugPrefix = orderData._orgPrefix
        ? orderData._orgPrefix.toUpperCase()
        : (orderData._orgSlug || "UP")
          .substring(0, 6)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
      const merchantName = orderData._merchantName || "";
      const merchantCode = merchantName
        ? merchantName
          .split(/\s+/)
          .slice(0, 2)
          .map((w: string) => w.substring(0, 2))
          .join("")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
        : "";

      const crypto = require("crypto");
      const randomHex = crypto.randomBytes(6).toString("hex").toUpperCase();

      let generatedOrderId = merchantCode
        ? `${orgSlugPrefix}_${merchantCode}_${randomHex}`
        : `${orgSlugPrefix}_${randomHex}`;

      generatedOrderId = generatedOrderId.substring(0, 20).toUpperCase();

      if (generatedOrderId.endsWith("_")) {
        generatedOrderId = generatedOrderId.slice(0, -1);
      }

      const order = await (this.prisma.order as any).create({
        data: {
          externalOrderId: generatedOrderId,
          clientReferenceId: orderData.clientReferenceId || null,
          organizationId: organizationId,
          merchantId: merchantId,
          providerId: orderData.connectorId,
          amount: parseFloat(orderData.amount),
          currency: orderData.currency || "INR",
          customerName: orderData.customerName,
          customerMobile: orderData.customerMobile,
          customerEmail: orderData.customerEmail,
          description: orderData.description || "Payment order",
          callbackUrl: orderData.callbackUrl,
          redirectUrl: orderData.redirectUrl,
          status: "PENDING",
          metadata: {
            ...(orderData.metadata || {}),
            ...(orderData._metadata || {}),
            isPlatform: orderData.isPlatform === true || orderData.isPlatform === 'true'
          },
        },
      });

      const isPlatformOrder = orderData.isPlatform === true || orderData.isPlatform === 'true';
      if (organizationId && !isPlatformOrder) {
        try {
          const subscriptionServiceUrl = process.env.SUBSCRIPTION_SERVICE_URL;
          if (subscriptionServiceUrl) {
            const axios = require("axios");
            await axios.post(
              `${subscriptionServiceUrl}/real-subscriptions/organizations/${organizationId}/update-usage`,
              {
                action: "PROCESS_TRANSACTION",
                data: {
                  amount: parseFloat(orderData.amount) || 0,
                },
              },
              { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
            );
          } else {
            console.warn(
              "⚠️ SUBSCRIPTION_SERVICE_URL not set — plan quota (new orders created) will stay 0. Set it in payment-service .env (e.g. http://localhost:3104) so the dashboard shows correct usage.",
            );
          }
        } catch (usageError: any) {
          console.warn(
            "⚠️ Failed to update subscription usage for transaction:",
            usageError?.message || usageError,
          );
        }
      }

      const qrResult = await this.qrcodeService.createQrCode(order.id);

      const publicUrl = process.env.PUBLIC_API_URL;
      const paymentUrl = `${publicUrl}/payment/${qrResult.qrCode.paymentLink}`;

      const merchantVPA = qrResult.merchantVPA || "";
      const upiIdHash = merchantVPA
        ? crypto.createHash("sha256").update(merchantVPA).digest("hex")
        : null;

      const deepLinks = (qrResult.qrCode.deepLinks || {}) as {
        upi?: string;
        phonePe?: string;
        paytm?: string;
        gpay?: string;
      };

      return {
        code: 2000,
        status: true,
        msg: "Order Created",
        data: {
          session_id: qrResult.qrCode.paymentLink,
          is_utr_required: false,
          order_id: order.externalOrderId,
          client_txn_id: order.clientReferenceId || null,
          payment_url: paymentUrl,
          upi_id_hash: upiIdHash,
          upi_intent: {
            bhim_link: deepLinks.upi,
            phonepe_link: deepLinks.phonePe,
            paytm_link: deepLinks.paytm,
            gpay_link: deepLinks.gpay,
          },
        },
      };
    } catch (error) {
      console.error("Error creating order:", error);
      return {
        code: 4000,
        status: false,
        msg: "Failed to create order: " + (error.message || "Unknown error"),
      };
    }
  }

  async checkOrderStatus(body: {
    key: string;
    client_txn_id?: string;
    order_id?: string;
    txn_date?: string;
  }) {
    try {
      if (!body.key) {
        return {
          status: false,
          msg: "API key (key) is required",
          data: {},
        };
      }

      const lookupId = body.client_txn_id || body.order_id;
      if (!lookupId) {
        return {
          status: false,
          msg: "Either client_txn_id or order_id is required",
          data: {},
        };
      }

      // Validate API key
      let resolvedOrgId: string | null = null;
      try {
        const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
        const axios = require("axios");
        const keyResponse = await axios.post(
          `${orgServiceUrl}/organizations/validate-api-key`,
          { apiKey: body.key },
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );
        if (!keyResponse.data?.valid) {
          return {
            status: false,
            msg: "Invalid API key",
            data: {},
          };
        }
        resolvedOrgId = keyResponse.data.organizationId;
      } catch (keyError: any) {
        return {
          status: false,
          msg: "API key validation failed",
          data: {},
        };
      }

      // Search by clientReferenceId, externalOrderId, or UUID — scoped to the org
      const whereClause: any = {
        OR: [
          { clientReferenceId: lookupId },
          { externalOrderId: lookupId },
          { id: lookupId },
        ],
      };
      if (resolvedOrgId) {
        whereClause.organizationId = resolvedOrgId;
      }

      // Optional txn_date filter (DD-MM-YYYY) – narrows search by createdAt date
      let startOfDay: Date | null = null;
      let endOfDay: Date | null = null;
      if (body.txn_date) {
        const parts = body.txn_date.split("-");
        if (parts.length === 3) {
          const [dd, mm, yyyy] = parts;
          const day = parseInt(dd, 10);
          const month = parseInt(mm, 10) - 1; // JS months 0-11
          const year = parseInt(yyyy, 10);
          if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
            startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0));
            endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
          }
        }
      }

      if (startOfDay && endOfDay) {
        whereClause.createdAt = {
          gte: startOfDay,
          lte: endOfDay,
        };
      }

      const order = await (this.prisma.order as any).findFirst({
        where: whereClause,
        include: {
          paymentLink: true,
        },
      });

      if (!order) {
        return {
          status: false,
          msg: "Record not found",
          data: {},
        };
      }

      const transaction = await this.prisma.transaction.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: "desc" },
      });

      if (order.status === "PENDING" && order.merchantId) {
        const orderAgeMs = Date.now() - new Date(order.createdAt).getTime();
        const MAX_POLLING_AGE_MS = 15 * 60 * 1000; // 15 minutes

        if (orderAgeMs < MAX_POLLING_AGE_MS) {
          const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
          if (merchantServiceUrl) {
            this.logger.log(
              `🔄 [Immediate Watcher] Triggering sync for merchant ${order.merchantId} (Order: ${order.id})`,
            );
            const axios = require("axios");
            axios.get(`${merchantServiceUrl}/merchant/${order.merchantId}/transactions/sync`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } })
              .catch((err: any) => {
                this.logger.error(`Failed to trigger immediate sync: ${err.message}`);
              });
          }
        }
      }

      const metadata: any = order.metadata || {};

      const baseTimestamp: Date =
        (transaction?.completedAt as Date) ||
        (transaction?.createdAt as Date) ||
        (order.completedAt as Date) ||
        (order.createdAt as Date);
      const createdAtIso = baseTimestamp
        ? baseTimestamp.toISOString()
        : order.createdAt.toISOString();
      const txnDate = createdAtIso.slice(0, 10);

      let merchantUpiId = "";
      let merchantName = "Upipe Merchant";
      const qrData: string | null = (order as any).paymentLink?.qrData || null;
      if (qrData) {
        try {
          const url = new URL(qrData);
          const pa = url.searchParams.get("pa");
          const pn = url.searchParams.get("pn");
          if (pa) merchantUpiId = decodeURIComponent(pa);
          if (pn) merchantName = decodeURIComponent(pn);
        } catch {
          const paMatch = qrData.match(/pa=([^&]+)/);
          if (paMatch) {
            merchantUpiId = decodeURIComponent(paMatch[1]);
          }
          const pnMatch = qrData.match(/pn=([^&]+)/);
          if (pnMatch) {
            merchantName = decodeURIComponent(pnMatch[1]);
          }
        }
      }

      const statusString =
        order.status === "COMPLETED"
          ? "success"
          : order.status === "FAILED"
            ? "failure"
            : order.status.toLowerCase();

      return {
        status: true,
        msg: "Transaction found",
        data: {
          id: order.externalOrderId,
          amount: parseFloat(order.amount.toString()),
          client_txn_id: order.clientReferenceId || order.externalOrderId,
          customer_name: order.customerName,
          customer_email: order.customerEmail,
          customer_mobile: order.customerMobile,
          p_info: order.description || "",
          upi_txn_id:
            order.utr || transaction?.utr || transaction?.externalTransactionId || "",
          status: statusString,
          remark:
            metadata.remark ||
            (statusString === "success"
              ? "transaction successful"
              : `transaction ${statusString}`),
          udf1: metadata.udf1 || "",
          udf2: metadata.udf2 || "",
          udf3: metadata.udf3 || "",
          redirect_url: order.redirectUrl || "",
          txnAt: txnDate,
          createdAt: order.createdAt,
          Merchant: {
            name: merchantName,
            upi_id: merchantUpiId,
          },
        },
      };
    } catch (error) {
      console.error("Error checking order status:", error);
      return {
        status: false,
        msg: "Failed to check order status",
        data: {},
      };
    }
  }

  async getOrder(orderId: string, apiKey?: string) {
    try {
      if (apiKey) {
        try {
          const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
          const axios = require("axios");
          const keyResponse = await axios.post(
            `${orgServiceUrl}/organizations/validate-api-key`,
            { apiKey },
            { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
          );
          if (!keyResponse.data?.valid) {
            return { success: false, error: "Invalid API key" };
          }
        } catch (keyError: any) {
          return { success: false, error: "API key validation failed" };
        }
      }

      // Search by id, externalOrderId, or clientReferenceId
      const order = await this.prisma.order.findFirst({
        where: {
          OR: [
            { id: orderId },
            { externalOrderId: orderId },
            { clientReferenceId: orderId },
          ],
        },
        include: {
          paymentLink: true,
          transactions: {
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!order) {
        return {
          success: false,
          error: "Order not found",
        };
      }

      let qrCodeData = null;
      let intentUrl = null;
      let merchantVPA = null;
      let qrExpiresAt = null;
      let deepLinks = null;
      let webPaymentsApi = null;

      try {
        if (order.paymentLink && order.status === "PENDING") {
          const qrResult = await this.qrcodeService.getQrCode(
            order.paymentLink.linkToken,
          );
          if (qrResult.success) {
            qrCodeData = qrResult.qrCode.dataUrl || qrResult.qrCode.url;
            intentUrl = qrResult.qrCode.upiString;
            merchantVPA = qrResult.merchantVPA;
            qrExpiresAt = order.paymentLink.expiresAt;
            deepLinks = qrResult.qrCode.deepLinks;
            webPaymentsApi = qrResult.qrCode.webPaymentsApi;
          }
        }
      } catch (qrError) {
        console.error("Failed to generate QR code for order display:", qrError);
      }

      return {
        success: true,
        order: {
          ...order,
          ...(qrCodeData && { qrCode: qrCodeData }),
          ...(intentUrl && { intentUrl }),
          ...(merchantVPA && { merchantVPA }),
          ...(qrExpiresAt && { qrExpiresAt }),
          ...(deepLinks && { deepLinks }),
          ...(webPaymentsApi && { webPaymentsApi }),
        },
      };
    } catch (error) {
      console.error("Error fetching order:", error);
      return {
        success: false,
        error: "Failed to fetch order",
      };
    }
  }

  async updateOrderStatus(orderId: string, status: string, utr?: string, remark?: string) {
    try {
      // Accept either internal id (UUID) or externalOrderId (e.g. FNQY6_DAFO_345125A51)
      const order = await this.prisma.order.findFirst({
        where: {
          OR: [{ id: orderId }, { externalOrderId: orderId }],
        },
      });

      if (!order) {
        return {
          success: false,
          error: "Order not found",
        };
      }

      // Fetch the latest webhook URL from organization service
      let latestCallbackUrl: string | undefined = undefined;
      try {
        const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
        const axios = require("axios");
        const orgResponse = await axios.get(
          `${orgServiceUrl}/organizations/${order.organizationId}/webhook`,
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": order.organizationId } }
        );
        if (orgResponse.data?.success && orgResponse.data?.webhookUrl) {
          latestCallbackUrl = orgResponse.data.webhookUrl;
        }
      } catch (orgError) {
        this.logger.warn(`⚠️ Failed to fetch latest webhook URL for org ${order.organizationId}: ${orgError.message}`);
      }

      const isNewCompletion = status === "COMPLETED" && order.status !== "COMPLETED";
      const isNewFailure = status === "FAILED" && order.status !== "FAILED";

      const updatedOrder = await this.prisma.order.update({
        where: { id: order.id },
        data: {
          status: status as any,
          updatedAt: new Date(),
          ...(isNewCompletion ? { completedAt: new Date(), webhookSent: false, webhookFailed: false } : {}),
          ...(isNewFailure ? { failedAt: new Date(), webhookSent: false, webhookFailed: false } : {}),
          ...(utr !== undefined ? { utr: utr || null } : {}),
          ...(remark !== undefined ? { remark: remark || null } : {}),
          ...(latestCallbackUrl ? { callbackUrl: latestCallbackUrl } : {}),
        },
      });

      if (isNewCompletion) {
        await this.prisma.paymentLink.updateMany({
          where: { orderId: order.id, isActive: true },
          data: { state: "COMPLETED" },
        });

        try {
          await this.callbackService.triggerWebhookForOrder(order.id);
        } catch (error) {
          this.logger.warn(
            `Failed to trigger webhook for order ${order.externalOrderId}: ${error.message}`,
          );
        }
        this.orderEvents.broadcastOrderUpdated(order.id, order.organizationId, {
          externalOrderId: order.externalOrderId,
          isPlatform: (order.metadata as any)?.isPlatform,
        });
      }

      return {
        success: true,
        order: updatedOrder,
        message: "Order status updated successfully",
      };
    } catch (error) {
      console.error("Error updating order status:", error);
      return {
        success: false,
        error: "Failed to update order status: " + error.message,
      };
    }
  }

  async syncTransaction(syncData: any) {
    try {
      // Try to find existing order by multiple criteria
      // Priority 1: paytmMerchantTransId (Upipe's ORD_xxx format)
      // Priority 2: externalOrderId (provider's ID)
      let order = null;

      // First, try to match by merchantTransId (ORD_xxx from Upipe)
      if (syncData.paytmMerchantTransId) {
        order = await this.prisma.order.findFirst({
          where: {
            OR: [
              { externalOrderId: syncData.paytmMerchantTransId },
              { id: syncData.paytmMerchantTransId },
            ],
          },
        });
        if (order) {
          this.logger.log(
            `✅ Matched order by merchantTransId: ${syncData.paytmMerchantTransId}`,
          );
        }
      }

      // If not found, try by externalOrderId (bizOrderId)
      if (!order && syncData.externalOrderId) {
        order = await this.prisma.order.findFirst({
          where: { externalOrderId: syncData.externalOrderId },
        });
      }

      // IMPORTANT: Do NOT create new orders during sync!
      // If order doesn't exist, this is a "walk-in" transaction (paid directly on QR without Upipe order)
      // Just log and continue to create only a transaction without an order

      if (order && syncData.status === "COMPLETED") {
        // Verify amount before completing the order
        if (Math.abs(Number(order.amount) - Number(syncData.amount)) <= 0.01) {
          // Complete the order through updateOrderStatus which:
          //   - Sets status to COMPLETED + completedAt
          //   - Deactivates payment links
          //   - Triggers callbackService.triggerWebhookForOrder (merchant callback)
          //   - Broadcasts the order update event via SSE
          if (order.status !== "COMPLETED") {
            await this.updateOrderStatus(order.id, "COMPLETED");
          }
        } else {
          this.logger.error(`AMOUNT MISMATCH in syncTransaction: Order ${order.id} amount ${order.amount} != sync amount ${syncData.amount}. Cannot auto-complete order!`);
        }

        // Persist metadata and payment method separately
        // (updateOrderStatus doesn't touch these fields)
        const currentMetadata = (order.metadata as any) || {};
        const newMetadata = {
          ...currentMetadata,
          gatewayTxn:
            syncData.paytmData?.additionalInfo?.virtualPaymentAddr || null,
          paytmData: syncData.paytmData || currentMetadata.paytmData,
        };

        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentMethod:
              (syncData.paymentMethod as any) || order.paymentMethod || "UPI",
            metadata: newMetadata,
          },
        });

        // Update merchant usage is handled below after transaction processing
        // to prevent double counting (usage is updated when transaction status becomes SUCCESS)
      } else if (!order) {
        this.logger.log(
          `ℹ️ No matching Upipe order found for ${syncData.paytmMerchantTransId || syncData.externalOrderId}. This appears to be a walk-in transaction.`,
        );
      }

      const externalTxnId = syncData.externalOrderId + "_txn";

      let transaction = await this.prisma.transaction.findFirst({
        where: { externalTransactionId: externalTxnId },
      });

      const previousStatus = transaction?.status;

      if (!transaction) {
        transaction = await this.prisma.transaction.create({
          data: {
            orderId: order?.id || null,
            merchantId: syncData.merchantId,
            providerId: syncData.providerId,
            externalTransactionId: externalTxnId,
            amount: syncData.amount,
            netAmount: syncData.amount,
            currency: syncData.currency,
            status:
              syncData.status === "COMPLETED" || syncData.status === "SUCCESS"
                ? "SUCCESS"
                : "PENDING",
            paymentMethod: syncData.paymentMethod,
            providerCode: syncData.providerCode,
            providerResponse: syncData.providerResponse || syncData.paytmData || null,
            utr: syncData.utr || syncData.paytmData?.bankTxnId || syncData.paytmData?.merchantTransId || null,
            completedAt:
              syncData.status === "COMPLETED" || syncData.status === "SUCCESS"
                ? syncData.completedAt || new Date()
                : null,
            failedAt: syncData.status === "FAILED" ? new Date() : null,
          },
        });
      } else {
        transaction = await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            status:
              syncData.status === "COMPLETED" || syncData.status === "SUCCESS"
                ? "SUCCESS"
                : "PENDING",
            providerResponse:
              syncData.providerResponse || syncData.paytmData || transaction.providerResponse,
            utr:
              syncData.utr || syncData.paytmData?.bankTxnId || syncData.paytmData?.merchantTransId ||
              transaction.utr,
            completedAt:
              syncData.status === "COMPLETED" || syncData.status === "SUCCESS"
                ? syncData.completedAt || new Date()
                : transaction.completedAt,
            failedAt:
              syncData.status === "FAILED" ? new Date() : transaction.failedAt,
            updatedAt: new Date(),
          },
        });
      }

      // NOTE: Merchant usage is updated by order-status-cron.service.ts in merchant-service
      // after it calls this sync endpoint and completes the order flow

      return {
        success: true,
        order: order || null,
        transaction,
        message: order
          ? "Transaction synced successfully"
          : "Walk-in transaction recorded",
      };
    } catch (error) {
      console.error("Error syncing transaction:", error);
      return {
        success: false,
        error: "Failed to sync transaction: " + error.message,
      };
    }
  }
  async deleteOrder(orderId: string) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
      });

      if (!order) {
        return {
          success: false,
          error: "Order not found",
        };
      }

      if (order.status === "COMPLETED") {
        return {
          success: false,
          error:
            "Cannot delete completed orders. Completed orders must be retained for audit and compliance purposes.",
        };
      }

      await this.prisma.transaction.deleteMany({
        where: { orderId: orderId },
      });

      await this.prisma.order.delete({
        where: { id: orderId },
      });

      return {
        success: true,
        message: "Order deleted successfully",
      };
    } catch (error) {
      console.error("Error deleting order:", error);
      return {
        success: false,
        error: "Failed to delete order: " + error.message,
      };
    }
  }

  /**
   * Completed orders with a callback URL, plus callback attempt history for the Webhooks dashboard.
   */
  async getWebhookDeliveries(
    organizationId: string | undefined,
    page: number = 1,
    limit: number = 50,
    search?: string,
    fromDate?: string,
    toDate?: string,
    tab: "all" | "sent" | "failed" | "pending" | "expired" = "all",
  ) {
    if (!organizationId?.trim()) {
      return {
        success: false,
        error: "Organization context required (x-organization-id)",
        summary: {
          total: 0,
          sent: 0,
          failed: 0,
          pending: 0,
          deliveryRate: 0,
        },
        orders: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
      };
    }

    const clampedLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const skip = (safePage - 1) * clampedLimit;

    const buildSharedFilters = (): any[] => {
      const and: any[] = [
        { organizationId },
        { callbackUrl: { not: null } },
      ];
      if (search?.trim()) {
        const t = search.trim();
        const or: any[] = [
          { externalOrderId: { contains: t } },
          { clientReferenceId: { contains: t } },
          { id: { contains: t } },
          { description: { contains: t } },
        ];
        const n = parseFloat(t);
        if (!Number.isNaN(n) && n >= 0) {
          or.push({ amount: n });
        }
        or.push({
          transactions: { some: { utr: { contains: t } } },
        });
        or.push({
          transactions: {
            some: { externalTransactionId: { contains: t } },
          },
        });
        and.push({ OR: or });
      }
      if (fromDate || toDate) {
        const range: any = {};
        if (fromDate) {
          const r = this.parseISTDayToRange(fromDate);
          if (r) range.gte = r.start;
        }
        if (toDate) {
          const r = this.parseISTDayToRange(toDate);
          if (r) range.lte = r.end;
        }
        if (Object.keys(range).length) {
          and.push({ updatedAt: range });
        }
      }
      return and;
    };

    const summaryAnd = buildSharedFilters();
    // Exclude expired from summary unless we are calculating total including expired?
    // Let's keep summary for COMPLETED only.
    summaryAnd.push({ status: "COMPLETED" as const });

    const listAnd = buildSharedFilters();
    if (tab === "sent") {
      listAnd.push({ status: "COMPLETED" as const, webhookSent: true });
    } else if (tab === "failed") {
      listAnd.push({ status: "COMPLETED" as const, webhookFailed: true });
    } else if (tab === "pending") {
      listAnd.push({ status: "COMPLETED" as const, webhookSent: false, webhookFailed: false });
    } else if (tab === "expired") {
      listAnd.push({
        OR: [
          { status: "EXPIRED" },
          { status: "PENDING", paymentLink: { expiresAt: { lt: new Date() } } }
        ]
      });
    } else {
      listAnd.push({
        OR: [
          { status: "COMPLETED" as const },
          { status: "EXPIRED" as const },
          { status: "PENDING" as const, paymentLink: { expiresAt: { lt: new Date() } } }
        ]
      });
    }

    const whereSummary = { AND: summaryAnd };
    const whereList = { AND: listAnd };

    const [summaryGroups, rows, listTotal, expiredCount] = await Promise.all([
      this.prisma.order.groupBy({
        by: ["webhookSent", "webhookFailed"],
        where: whereSummary,
        _count: { _all: true },
      }),
      this.prisma.order.findMany({
        where: whereList,
        skip,
        take: clampedLimit,
        orderBy: { updatedAt: "desc" },
        include: {
          paymentLink: true,
          transactions: {
            take: 1,
            orderBy: { createdAt: "desc" },
          },
          callbackLogs: {
            orderBy: { createdAt: "asc" },
            take: 50,
          },
        },
      }),
      this.prisma.order.count({ where: whereList }),
      this.prisma.order.count({
        where: {
          organizationId,
          callbackUrl: { not: null },
          OR: [
            { status: "EXPIRED" },
            { status: "PENDING", paymentLink: { expiresAt: { lt: new Date() } } },
          ],
        },
      }),
    ]);

    let sentCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let totalAll = 0;
    for (const g of summaryGroups) {
      const n = g._count._all;
      totalAll += n;
      if (g.webhookSent) sentCount += n;
      else if (g.webhookFailed) failedCount += n;
      else pendingCount += n;
    }

    const deliveryRate =
      totalAll > 0 ? Math.round((sentCount / totalAll) * 1000) / 10 : 0;

    // Fetch the latest webhook URL from organization service for this organization
    let latestCallbackUrl: string | undefined = undefined;
    if (organizationId) {
      try {
        const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
        const axios = require("axios");
        const orgResponse = await axios.get(
          `${orgServiceUrl}/organizations/${organizationId}/webhook`,
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
        );
        if (orgResponse.data?.success && orgResponse.data?.webhookUrl) {
          latestCallbackUrl = orgResponse.data.webhookUrl;
        }
      } catch (orgError) {
        this.logger.warn(`⚠️ Failed to fetch latest webhook URL for org ${organizationId}: ${orgError.message}`);
      }
    }

    const orders = rows.map((o) => {
      let status = o.status;
      if (status === "PENDING" && o.paymentLink?.expiresAt) {
        if (new Date(o.paymentLink.expiresAt) < new Date()) {
          status = "EXPIRED";
        }
      }
      return {
        id: o.id,
        externalOrderId: o.externalOrderId,
        clientReferenceId: o.clientReferenceId,
        amount: parseFloat(o.amount.toString()),
        currency: o.currency,
        status,
        callbackUrl: latestCallbackUrl || o.callbackUrl,
        utr: o.utr,
        webhookSent: o.webhookSent,
        webhookFailed: o.webhookFailed,
        webhookFailureReason: o.webhookFailureReason,
        completedAt: o.completedAt,
        updatedAt: o.updatedAt,
        createdAt: o.createdAt,
        metadata: o.metadata,
        customerEmail: o.customerEmail,
        customerMobile: o.customerMobile,
        customerName: o.customerName,
        description: o.description,
        redirectUrl: o.redirectUrl,
        transactions: (o.transactions || []).map((tx) => ({
          id: tx.id,
          utr: tx.utr,
          externalTransactionId: tx.externalTransactionId,
          status: tx.status,
          completedAt: tx.completedAt,
          createdAt: tx.createdAt,
        })),
        callbackLogs: o.callbackLogs.map((log) => ({
          id: log.id,
          callbackUrl: log.callbackUrl,
          payload: log.payload,
          response: log.response,
          statusCode: log.statusCode,
          success: log.success,
          retryCount: log.retryCount,
          createdAt: log.createdAt,
        })),
      };
    });

    return {
      success: true,
      summary: {
        total: totalAll,
        sent: sentCount,
        failed: failedCount,
        pending: pendingCount,
        expired: expiredCount,
        deliveryRate,
      },
      orders,
      pagination: {
        page: safePage,
        limit: clampedLimit,
        total: listTotal,
        totalPages: Math.ceil(listTotal / clampedLimit) || 0,
      },
    };
  }

  async resendWebhook(orderId: string, organizationId?: string) {
    const where: any = {
      OR: [
        { id: orderId },
        { externalOrderId: orderId },
        { clientReferenceId: orderId },
      ],
      status: "COMPLETED",
    };
    if (organizationId) where.organizationId = organizationId;

    const order = await this.prisma.order.findFirst({ where });
    if (!order) {
      return {
        success: false,
        error: organizationId
          ? "Order not found or not completed (only COMPLETED orders can trigger webhook)"
          : "Order not found or not completed (only COMPLETED orders can trigger webhook)",
      };
    }

    // Fetch the latest webhook URL from organization service
    let latestCallbackUrl: string | undefined = undefined;
    try {
      const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
      const axios = require("axios");
      const orgResponse = await axios.get(
        `${orgServiceUrl}/organizations/${order.organizationId}/webhook`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": order.organizationId } }
      );
      if (orgResponse.data?.success && orgResponse.data?.webhookUrl) {
        latestCallbackUrl = orgResponse.data.webhookUrl;
      }
    } catch (orgError) {
      this.logger.warn(`⚠️ Failed to fetch latest webhook URL for org ${order.organizationId}: ${orgError.message}`);
    }

    let currentOrder = order;
    if (latestCallbackUrl && latestCallbackUrl !== order.callbackUrl) {
      currentOrder = await this.prisma.order.update({
        where: { id: order.id },
        data: { callbackUrl: latestCallbackUrl },
      });
      this.logger.log(`Updated callback URL for order ${order.externalOrderId} to ${latestCallbackUrl}`);
    }

    if (!currentOrder.callbackUrl) {
      return {
        success: false,
        error: "No callback URL configured for this order",
      };
    }
    try {
      await this.callbackService.resendWebhookNow(currentOrder.id);
      return { success: true, message: "Webhook sent" };
    } catch (err: any) {
      this.logger.warn(`Resend webhook failed: ${err?.message}`);
      return {
        success: false,
        error: err?.message || "Failed to send webhook",
      };
    }
  }

  async resendWebhooksBulk(organizationId: string, orderIds?: string[]) {
    if (!organizationId) {
      return { success: false, error: "Organization ID required" };
    }
    let orderIdList: string[];
    if (orderIds?.length) {
      const orders = await this.prisma.order.findMany({
        where: {
          organizationId,
          status: "COMPLETED",
          callbackUrl: { not: null },
          OR: [{ id: { in: orderIds } }, { externalOrderId: { in: orderIds } }],
        },
        select: { id: true },
      });
      orderIdList = orders.map((o) => o.id);
    } else {
      const orders = await this.prisma.order.findMany({
        where: {
          organizationId,
          status: "COMPLETED",
          callbackUrl: { not: null },
          OR: [{ webhookSent: false }, { webhookFailed: true }],
        },
        take: 5000,
        select: { id: true },
      });
      orderIdList = orders.map((o) => o.id);
    }

    // Fetch the latest webhook URL from organization service
    let latestCallbackUrl: string | undefined = undefined;
    try {
      const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
      const axios = require("axios");
      const orgResponse = await axios.get(
        `${orgServiceUrl}/organizations/${organizationId}/webhook`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } }
      );
      if (orgResponse.data?.success && orgResponse.data?.webhookUrl) {
        latestCallbackUrl = orgResponse.data.webhookUrl;
      }
    } catch (orgError) {
      this.logger.warn(`⚠️ Failed to fetch latest webhook URL for org ${organizationId}: ${orgError.message}`);
    }

    if (latestCallbackUrl && orderIdList.length > 0) {
      await this.prisma.order.updateMany({
        where: {
          id: { in: orderIdList },
        },
        data: {
          callbackUrl: latestCallbackUrl,
        },
      });
      this.logger.log(`Updated callback URL for ${orderIdList.length} orders of org ${organizationId} to ${latestCallbackUrl}`);
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const id of orderIdList) {
      try {
        await this.callbackService.resendWebhookNow(id);
        sent++;
      } catch (err: any) {
        failed++;
        errors.push(`${id}: ${err?.message || "Unknown error"}`);
      }
    }
    return {
      success: true,
      message: `Sent: ${sent}, Failed: ${failed}`,
      sent,
      failed,
      total: orderIdList.length,
      errors: errors.slice(0, 10),
    };
  }
}

@ApiTags("Orders")
@Controller("orders")
export class SimpleOrdersController {
  constructor(private readonly ordersService: OrdersService) { }

  @Get('qr-usage/:organizationId')
  @ApiOperation({ summary: 'Get QR usage for an organization or merchant' })
  @ApiResponse({ status: 200, description: 'QR usage stats' })
  async getQRUsage(
    @Param('organizationId') organizationId: string,
    @Query('merchantId') merchantId?: string,
  ) {
    return this.ordersService.getQRUsage(organizationId, merchantId);
  }


  private async resolveOrgId(
    headerOrgId: string,
    apiKey?: string,
  ): Promise<string | null> {
    if (apiKey) {
      try {
        const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
        const axios = require("axios");
        const keyResponse = await axios.post(
          `${orgServiceUrl}/organizations/validate-api-key`,
          { apiKey },
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );
        if (
          !keyResponse.data?.valid ||
          !keyResponse.data?.organization
        ) {
          return null;
        }
        const org = keyResponse.data.organization;
        return org.id || keyResponse.data.organizationId || null;
      } catch {
        return null;
      }
    }
    return headerOrgId || null;
  }

  @Get()
  @ApiOperation({ summary: "Get all orders with real data from database" })
  @ApiResponse({ status: 200, description: "Orders retrieved successfully" })
  async getOrders(
    @Headers("x-organization-id") headerOrgId: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "20",
    @Query("organizationId") organizationIdQuery?: string,
    @Query("merchantId") merchantId?: string,
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("excludeExpired") excludeExpiredQuery?: string,
    @Query("includePlatform") includePlatformQuery?: string,
    @Query("paymentApp") paymentApp?: string,
  ) {
    const organizationId =
      organizationIdQuery ||
      (headerOrgId === "platform-org-id" ? undefined : headerOrgId) ||
      undefined;

    // When a specific status is requested (COMPLETED, PENDING, FAILED, EXPIRED),
    // we always respect that and do NOT apply excludeExpired.
    // Only when no explicit status is given (status undefined) do we optionally
    // hide expired orders based on ?excludeExpired=true.
    let excludeExpired = false;
    if (!status) {
      excludeExpired =
        (excludeExpiredQuery || "").toLowerCase() === "true" ? true : false;
    }

    const includePlatform = includePlatformQuery !== undefined
      ? includePlatformQuery.toLowerCase() === "true"
      : (!headerOrgId || headerOrgId === "platform-org-id");

    return this.ordersService.getOrders(
      parseInt(page, 10),
      parseInt(limit, 10),
      organizationId,
      merchantId,
      status,
      search,
      fromDate,
      toDate,
      excludeExpired,
      includePlatform,
      paymentApp,
    );
  }

  @Get("webhook-deliveries")
  @ApiOperation({
    summary:
      "Webhook delivery overview: completed orders with callback URL and attempt logs",
  })
  @ApiResponse({ status: 200, description: "Webhook deliveries retrieved" })
  async getWebhookDeliveries(
    @Headers("x-organization-id") headerOrgId: string,
    @Query("organizationId") organizationIdQuery?: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "50",
    @Query("search") search?: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("tab") tab?: string,
  ) {
    const organizationId =
      organizationIdQuery ||
      (headerOrgId === "platform-org-id" ? undefined : headerOrgId) ||
      undefined;
    const t = (tab || "all").toLowerCase();
    const tabNorm =
      t === "sent" || t === "failed" || t === "pending" || t === "expired" ? t : "all";
    return this.ordersService.getWebhookDeliveries(
      organizationId,
      parseInt(page, 10) || 1,
      Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
      search,
      fromDate,
      toDate,
      tabNorm as "all" | "sent" | "failed" | "pending" | "expired",
    );
  }

  @Post("resend-webhook")
  @ApiOperation({ summary: "Resend webhook for one COMPLETED order (body: key + client_txn_id)" })
  @ApiResponse({ status: 200, description: "Webhook sent" })
  async resendWebhookSingle(
    @Headers("x-organization-id") headerOrgId: string,
    @Body() body: { key?: string; client_txn_id?: string },
  ) {
    const orderId = body?.client_txn_id;
    if (!orderId) {
      return {
        success: false,
        error: "client_txn_id is required in body (order ID or external order ID)",
      };
    }
    const organizationId = await this.resolveOrgId(headerOrgId, body?.key);
    if (!organizationId) {
      return {
        success: false,
        error:
          body?.key
            ? "Invalid API key"
            : "Provide API key in body (key) or x-organization-id header",
      };
    }
    return this.ordersService.resendWebhook(orderId, organizationId);
  }

  @Post("resend-webhooks-bulk")
  @ApiOperation({ summary: "Resend webhooks for completed orders (API key or x-organization-id)" })
  @ApiResponse({ status: 200, description: "Bulk resend completed" })
  async resendWebhooksBulk(
    @Headers("x-organization-id") headerOrgId: string,
    @Body() body: { key?: string; orderIds?: string[] },
  ) {
    const organizationId = await this.resolveOrgId(headerOrgId, body?.key);
    if (!organizationId) {
      return {
        success: false,
        error: "Provide API key in body (key) or x-organization-id header",
      };
    }
    return this.ordersService.resendWebhooksBulk(
      organizationId,
      body?.orderIds,
    );
  }

  @Delete(":orderId")
  @ApiOperation({ summary: "Delete an order" })
  @ApiResponse({ status: 200, description: "Order deleted successfully" })
  async deleteOrder(@Param("orderId") orderId: string) {
    return this.ordersService.deleteOrder(orderId);
  }

  @Get(":orderId")
  @ApiOperation({ summary: "Get order details" })
  @ApiResponse({
    status: 200,
    description: "Order details retrieved successfully",
  })
  async getOrder(@Param("orderId") orderId: string) {
    return this.ordersService.getOrder(orderId);
  }

  @Post()
  @ApiOperation({ summary: "Create a new order" })
  @ApiResponse({ status: 201, description: "Order created successfully" })
  async createOrder(
    @Body() createOrderDto: any,
    @Headers("x-organization-id") headerOrgId: string,
  ) {
    return this.ordersService.createOrder(createOrderDto, headerOrgId);
  }

  @Patch(":orderId/status")
  @ApiOperation({ summary: "Update order status" })
  @ApiResponse({
    status: 200,
    description: "Order status updated successfully",
  })
  async updateOrderStatus(
    @Param("orderId") orderId: string,
    @Body() body: { status: string; utr?: string; remark?: string },
  ) {
    return this.ordersService.updateOrderStatus(
      orderId,
      body.status,
      body.utr,
      body.remark,
    );
  }

  @Post("sync-transaction")
  @ApiOperation({ summary: "Sync transaction from external provider" })
  @ApiResponse({ status: 201, description: "Transaction synced successfully" })
  async syncTransaction(@Body() syncData: any) {
    return this.ordersService.syncTransaction(syncData);
  }

  @Post("check-status")
  @ApiOperation({
    summary:
      "Check order status by client_txn_id or order_id (API key required)",
  })
  @ApiResponse({ status: 200, description: "Order status retrieved" })
  @HttpCode(200)
  async checkOrderStatus(
    @Body()
    body: {
      key: string;
      client_txn_id?: string;
      order_id?: string;
      txn_date?: string;
    },
  ) {
    return this.ordersService.checkOrderStatus(body);
  }
}

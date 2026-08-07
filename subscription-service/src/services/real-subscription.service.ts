import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import axios from "axios";
import { Decimal } from "@prisma/client/runtime/library";
import { RedisService } from "./redis.service";

@Injectable()
export class RealSubscriptionService {
  private readonly logger = new Logger(RealSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService
  ) { }


  async getSubscriptionPlans() {
    try {
      const plans = await this.prisma.subscriptionPlan.findMany({
        where: { isActive: true, isPublic: true },
        include: { providerAccess: true },
        orderBy: { sortOrder: "asc" },
      });

      return {
        success: true,
        plans: plans.map((plan) => ({
          id: plan.id,
          name: plan.name,
          code: plan.code,
          description: plan.description,
          price: plan.price,
          currency: plan.currency,
          billingCycle: plan.billingCycle,
          trialDays: plan.trialDays,
          durationDays: plan.durationDays,
          maxUsers: plan.maxUsers,
          maxMerchants: plan.maxMerchants,
          maxTransactions: plan.maxTransactions,
          maxApiCalls: plan.maxApiCalls,
          features: plan.features,
          isFeatured: plan.isFeatured,
          isTrial: plan.isTrial,
          sortOrder: plan.sortOrder,
          providerAccess: plan.providerAccess.map((pa) => ({
            providerCode: pa.providerCode,
            isIncluded: pa.isIncluded,
            slotsCount: pa.slotsCount,
          })),
        })),
      };
    } catch (error) {
      this.logger.error("Failed to get subscription plans:", error);
      throw new BadRequestException("Failed to retrieve subscription plans");
    }
  }

  async getAssignableSubscriptions(organizationId: string) {
    try {
      const slots = await this.prisma.orgSubscription.findMany({
        where: { organizationId },
        include: {
          plan: {
            select: {
              id: true,
              name: true,
              code: true,
              maxTransactions: true,
              providerAccess: {
                select: {
                  providerCode: true,
                  slotsCount: true,
                  isIncluded: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      const now = new Date();

      const subscriptions = slots.map((slot) => {
        let assignable = true;
        let reasonCode: string | null = null;

        if (slot.status === "EXPIRED") {
          assignable = false;
          reasonCode = "SUBSCRIPTION_EXPIRED";
        } else if (slot.status === "CANCELLED") {
          assignable = false;
          reasonCode = "SUBSCRIPTION_CANCELLED";
        } else if (slot.status === "DELETION_PENDING") {
          assignable = false;
          reasonCode = "SUBSCRIPTION_DELETION_PENDING";
        } else if (slot.status !== "UNASSIGNED" && slot.status !== "ACTIVE") {
          assignable = false;
          reasonCode = "SUBSCRIPTION_STATUS_NOT_ASSIGNABLE";
        } else if (slot.startDate > now) {
          assignable = false;
          reasonCode = "SUBSCRIPTION_NOT_STARTED";
        } else if (slot.endDate && slot.endDate <= now) {
          assignable = false;
          reasonCode = "SUBSCRIPTION_EXPIRED";
        }

        return {
          id: slot.id,
          organizationId: slot.organizationId,
          status: slot.status,
          startDate: slot.startDate,
          endDate: slot.endDate,
          purchaseUnitIndex: slot.purchaseUnitIndex,
          assignable,
          reasonCode,
          plan: {
            id: slot.plan.id,
            name: slot.plan.name,
            code: slot.plan.code,
            maxTransactions: slot.plan.maxTransactions,
            providerAccess: slot.plan.providerAccess,
          },
        };
      });

      return {
        success: true,
        subscriptions,
      };
    } catch (error) {
      this.logger.error("Failed to get assignable subscriptions:", error);
      throw new BadRequestException("Failed to retrieve assignable subscriptions");
    }
  }

  async getOrganizationSubscription(organizationId: string, isSuperAdmin: boolean = false) {
    try {
      if (isSuperAdmin) {
        return {
          success: true,
          subscription: {
            id: 'platform-subscription-id',
            organizationId,
            plan: {
              name: 'Platform Master Plan',
              code: 'PLATFORM_MASTER',
              maxUsers: 999999,
              maxMerchants: 999999,
              maxTransactions: 999999,
              maxApiCalls: 999999,
              isTrial: false,
            },
            status: "ACTIVE",
            startDate: new Date('2020-01-01'),
            endDate: new Date('2100-01-01'),
            autoRenew: true,
            limits: {
              maxUsers: 999999,
              maxMerchants: 999999,
              maxTransactions: 999999,
              maxApiCalls: 999999,
            },
            currentUsage: {
              usersCreated: 0,
              merchantsCreated: 0,
              transactionsCount: 0,
              transactionVolume: 0,
              apiCallsCount: 0,
            },
            providerAccess: [], // Will be handled by checkProviderAccess bypass
          },
          slots: [],
          summary: {
            totalSlots: 999999,
            activeSlots: 0,
            unassignedSlots: 999999,
            expiredSlots: 0,
          },
        };
      }

      const slots = await this.prisma.orgSubscription.findMany({
        where: { organizationId },
        include: { plan: { include: { providerAccess: true } } },
        orderBy: { createdAt: "desc" },
      });

      if (slots.length === 0) {
        return {
          success: false,
          message: "No subscription found for this organization",
        };
      }

      const activeSlots = slots.filter((s) => s.status === "ACTIVE");
      const unassignedSlots = slots.filter((s) => s.status === "UNASSIGNED");
      const expiredSlots = slots.filter((s) => s.status === "EXPIRED");

      // Derive aggregated limits from all non-expired slots
      const nonExpiredSlots = slots.filter(s => s.status !== "EXPIRED");
      const currentSlot = nonExpiredSlots[0] || slots[0];
      const plan = currentSlot.plan;

      const aggregatedLimits = {
        maxUsers: 0,
        maxMerchants: 0,
        maxTransactions: 0,
        maxApiCalls: 0,
      };

      const providerAccessMap: Record<string, { providerCode: string; isIncluded: boolean }> = {};

      for (const slot of nonExpiredSlots) {
        aggregatedLimits.maxUsers += slot.plan.maxUsers || 0;
        aggregatedLimits.maxMerchants += slot.plan.maxMerchants || 0;
        aggregatedLimits.maxTransactions += slot.plan.maxTransactions || 0;
        aggregatedLimits.maxApiCalls += slot.plan.maxApiCalls || 0;

        for (const pa of slot.plan.providerAccess) {
          const code = pa.providerCode.toUpperCase();
          if (!providerAccessMap[code]) {
            providerAccessMap[code] = {
              providerCode: pa.providerCode,
              isIncluded: pa.isIncluded
            };
          } else {
            providerAccessMap[code].isIncluded = providerAccessMap[code].isIncluded || pa.isIncluded;
          }
        }
      }

      let actualMerchantsCount = 0;
      let allMerchants: any[] = [];
      try {
        const axios = require("axios");
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
        const mRes = await axios.get(`${merchantServiceUrl}/merchant/organization/${organizationId}`, {
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN },
          timeout: 3000
        });
        if (mRes.data?.success && Array.isArray(mRes.data.merchants)) {
          allMerchants = mRes.data.merchants;
          actualMerchantsCount = allMerchants.length;
        }
      } catch (e) {
        // Fallback: default to 0 if merchant-service call fails
      }

      const slotUsageMap: Record<string, number> = {};
      slots.forEach((s) => { slotUsageMap[s.id] = 0; });

      try {
        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL || "http://localhost:4003";
        const axios = require("axios");
        const tsRes = await axios.get(`${paymentServiceUrl}/orders/organization-timestamps/${organizationId}`, {
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN },
          timeout: 3000
        });

        if (tsRes.data?.success && Array.isArray(tsRes.data.timestamps)) {
          const timestamps = tsRes.data.timestamps;
          const sortedNonExpired = [...nonExpiredSlots].sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

          for (const ts of timestamps) {
            const orderDate = new Date(ts);
            const targetSlot = sortedNonExpired.find((s) => {
              const start = new Date(s.startDate);
              const end = s.endDate ? new Date(s.endDate) : new Date(8640000000000000);
              const cap = s.plan.maxTransactions || 0;
              const currentUsed = slotUsageMap[s.id] || 0;
              return orderDate >= start && orderDate <= end && currentUsed < cap;
            });

            if (targetSlot) {
              slotUsageMap[targetSlot.id] = (slotUsageMap[targetSlot.id] || 0) + 1;
            }
          }
        }
      } catch (e) {
        // Fallback: ignore error if payment service timestamp call fails
      }

      const overallStartDate = nonExpiredSlots.reduce((earliest, s) => {
        return s.startDate < earliest ? s.startDate : earliest;
      }, currentSlot.startDate);

      const overallEndDate = nonExpiredSlots.reduce((latest, s) => {
        if (!s.endDate) return latest;
        if (!latest) return s.endDate;
        return s.endDate > latest ? s.endDate : latest;
      }, currentSlot.endDate);

      // Auto-reconcile orphaned merchants (merchants whose orgSubscriptionId is missing or belongs to an old deleted slot)
      const validSlotIds = new Set(slots.map(s => s.id));
      const orphanedMerchants = allMerchants.filter(m => !m.deletedAt && (!m.orgSubscriptionId || !validSlotIds.has(m.orgSubscriptionId)));

      if (orphanedMerchants.length > 0 && slots.length > 0) {
        const axios = require("axios");
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;

        for (const m of orphanedMerchants) {
          const mProviders = m.providers && Array.isArray(m.providers) && m.providers.length > 0
            ? m.providers
            : (m.providerType ? [{ providerType: m.providerType }] : []);

          for (const p of mProviders) {
            const code = (p.providerType || '').toUpperCase();
            if (!code) continue;

            for (const s of slots) {
              const pa = s.plan.providerAccess?.find((access: any) => access.providerCode.toUpperCase() === code);
              if (pa && pa.isIncluded && pa.slotsCount > 0) {
                const assignedCount = allMerchants.filter(other => {
                  if (other.orgSubscriptionId !== s.id || other.deletedAt) return false;
                  const otherProviders = other.providers && Array.isArray(other.providers) && other.providers.length > 0
                    ? other.providers
                    : (other.providerType ? [{ providerType: other.providerType }] : []);
                  return otherProviders.some((op: any) => (op.providerType || '').toUpperCase() === code);
                }).length;
                if (assignedCount < pa.slotsCount) {
                  m.orgSubscriptionId = s.id; // Assign in memory immediately!
                  try {
                    axios.patch(
                      `${merchantServiceUrl}/internal/merchants/${m.id}/subscription-assignment`,
                      { orgSubscriptionId: s.id },
                      { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
                    ).catch(() => {});
                  } catch (err) {}
                  break;
                }
              }
            }
          }
        }
      }

      return {
        success: true,
        // Backward compat: expose a single "subscription" object for existing consumers
        subscription: {
          id: currentSlot.id,
          organizationId,
          plan,
          status: activeSlots.length > 0 || unassignedSlots.length > 0 ? "ACTIVE" : "EXPIRED",
          startDate: overallStartDate,
          endDate: overallEndDate,
          autoRenew: currentSlot.autoRenew,
          limits: aggregatedLimits,
          currentUsage: {
            usersCreated: 0,
            merchantsCreated: actualMerchantsCount,
            transactionsCount: 0,
            transactionVolume: 0,
            apiCallsCount: 0,
          },
          providerAccess: Object.values(providerAccessMap),
        },
        slots: slots.map((s) => {
          const connectedMerchants = allMerchants.filter(m => m.orgSubscriptionId === s.id && !m.deletedAt);

          // Re-calculate provider usage mapping to show used slots per provider
          const providerUsage: Record<string, number> = {};
          connectedMerchants.forEach(m => {
            if (m.providers && Array.isArray(m.providers)) {
              m.providers.forEach((p: any) => {
                const code = (p.providerType || '').toUpperCase();
                if (code) {
                  providerUsage[code] = (providerUsage[code] || 0) + 1;
                }
              });
            } else if (m.providerType) { // Fallback just in case
              const code = String(m.providerType).toUpperCase();
              providerUsage[code] = (providerUsage[code] || 0) + 1;
            }
          });

          return {
            id: s.id,
            merchantId: s.merchantId, // deprecated
            planId: s.planId,
            planName: s.plan.name,
            status: s.status,
            startDate: s.startDate,
            endDate: s.endDate,
            purchaseId: s.purchaseId,
            createdAt: s.createdAt,
            providerAccess: s.plan.providerAccess,
            usedTxn: slotUsageMap[s.id] || 0,
            connectedMerchants,
            providerUsage
          };
        }),
        summary: {
          totalSlots: slots.length,
          activeSlots: activeSlots.length,
          unassignedSlots: unassignedSlots.length,
          expiredSlots: expiredSlots.length,
        },
      };
    } catch (error) {
      this.logger.error("Failed to get organization subscription:", error);
      throw new BadRequestException("Failed to retrieve subscription details");
    }
  }

  async getProviderEntitlements(organizationId: string) {
    try {
      // 1. Get active subscriptions with their plans and provider access
      const activeSlots = await this.prisma.orgSubscription.findMany({
        where: {
          organizationId,
          status: { in: ['ACTIVE', 'UNASSIGNED'] },
          OR: [
            { endDate: null },
            { endDate: { gt: new Date() } }
          ]
        },
        include: {
          plan: {
            include: { providerAccess: true }
          }
        }
      });

      // 2. Sum allowed counts by provider
      const allowedCounts: Record<string, number> = {};
      for (const slot of activeSlots) {
        if (slot.plan?.providerAccess) {
          for (const pa of slot.plan.providerAccess) {
            if (pa.isIncluded) {
              const code = pa.providerCode.toUpperCase();
              allowedCounts[code] = (allowedCounts[code] || 0) + (pa.slotsCount || 0);
            }
          }
        }
      }

      // 3. Fetch used counts from merchant-service
      let usedCounts: Record<string, number> = {};
      try {
        const axios = require('axios');
        const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
        if (merchantServiceUrl) {
          const res = await axios.get(`${merchantServiceUrl}/merchant/organizations/${organizationId}/provider-counts`, {
            headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
          });
          if (res.data?.success) {
            usedCounts = res.data.data;
          }
        }
      } catch (err: any) {
        this.logger.error(`Failed to fetch used counts from merchant-service for org ${organizationId}: ${err.message}`);
      }

      // 4. Combine results
      const entitlements: Record<string, { allowed: number, used: number, remaining: number }> = {};
      // Include all providers that have an allowed limit
      for (const [code, allowed] of Object.entries(allowedCounts)) {
        const used = usedCounts[code] || 0;
        entitlements[code] = { allowed, used, remaining: Math.max(0, allowed - used) };
      }
      // Also include providers that have usage but no allowed limit
      for (const [code, used] of Object.entries(usedCounts)) {
        if (!entitlements[code]) {
          entitlements[code] = { allowed: 0, used, remaining: 0 };
        }
      }

      return {
        success: true,
        data: entitlements
      };
    } catch (error) {
      this.logger.error("Failed to get provider entitlements:", error);
      throw new BadRequestException("Failed to retrieve provider entitlements");
    }
  }

  // ─── RESERVATION ENGINE ───────────────────────────────────

  async reserveProviderSlot(organizationId: string, providerCode: string): Promise<{ reservationId: string }> {
    const lockKey = `reservation_lock:${organizationId}:${providerCode}`;
    const redis = this.redisService.getClient();

    // Wait up to 3 seconds for lock
    let lockAcquired = false;
    for (let i = 0; i < 30; i++) {
      const lock = await redis.set(lockKey, 'locked', 'EX', 5, 'NX');
      if (lock) {
        lockAcquired = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!lockAcquired) throw new BadRequestException('System busy, please try again');

    try {
      const entitlements = await this.getProviderEntitlements(organizationId);
      const data = entitlements.data[providerCode.toUpperCase()];
      if (!data) throw new BadRequestException(`No active entitlement for provider ${providerCode}`);

      const pCode = providerCode.toUpperCase();
      const resKey = `reservations:${organizationId}:${pCode}`;
      const activeReservationsStr = await redis.get(resKey);
      let activeReservations: Array<{ id: string, expiresAt: number }> = activeReservationsStr ? JSON.parse(activeReservationsStr) : [];

      const now = Date.now();
      activeReservations = activeReservations.filter(r => r.expiresAt > now);

      const availableSlots = data.allowed - data.used;
      if (availableSlots <= 0) {
        throw new BadRequestException(`No available slots for provider ${providerCode}`);
      }

      // If availableSlots > 0 (org has entitlement capacity), but previous uncommitted attempts
      // left reservations in Redis, clear them so the user is not blocked by abandoned attempts.
      if (activeReservations.length >= availableSlots) {
        activeReservations = [];
      }

      const reservationId = require('crypto').randomUUID();
      activeReservations.push({ id: reservationId, expiresAt: now + 2 * 60 * 1000 }); // 2 min TTL

      // Store reservations and set TTL for the key
      await redis.set(resKey, JSON.stringify(activeReservations), 'PX', 2 * 60 * 1000);

      return { reservationId };
    } finally {
      await redis.del(lockKey);
    }
  }

  async commitReservation(organizationId: string, providerCode: string, reservationId: string): Promise<{ success: true }> {
    const lockKey = `reservation_lock:${organizationId}:${providerCode}`;
    const redis = this.redisService.getClient();

    let lockAcquired = false;
    for (let i = 0; i < 30; i++) {
      const lock = await redis.set(lockKey, 'locked', 'EX', 5, 'NX');
      if (lock) {
        lockAcquired = true;
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!lockAcquired) throw new BadRequestException('System busy, please try again');

    try {
      const resKey = `reservations:${organizationId}:${providerCode}`;
      const activeReservationsStr = await redis.get(resKey);
      if (!activeReservationsStr) throw new BadRequestException('Reservation not found or expired');

      let activeReservations: Array<{ id: string, expiresAt: number }> = JSON.parse(activeReservationsStr);
      const now = Date.now();
      activeReservations = activeReservations.filter(r => r.expiresAt > now);

      const resIndex = activeReservations.findIndex(r => r.id === reservationId);
      if (resIndex === -1) throw new BadRequestException('Reservation not found or expired');

      activeReservations.splice(resIndex, 1);

      if (activeReservations.length > 0) {
        await redis.set(resKey, JSON.stringify(activeReservations), 'PX', 5 * 60 * 1000);
      } else {
        await redis.del(resKey);
      }

      return { success: true };
    } finally {
      await redis.del(lockKey);
    }
  }

  // ─── PURCHASE FLOW ──────────────────────────────────────────

  private computeEndDate(startDate: Date, billingCycle: string, durationDays?: number | null): Date {
    const ms = startDate.getTime();
    const DAY = 24 * 60 * 60 * 1000;
    let endDate: Date;

    if (durationDays && durationDays > 0) {
      endDate = new Date(ms + durationDays * DAY);
    } else {
      switch (billingCycle) {
        case "MONTHLY": endDate = new Date(ms + 28 * DAY); break;
        case "QUARTERLY": endDate = new Date(ms + 84 * DAY); break;
        case "HALF_YEARLY": endDate = new Date(ms + 180 * DAY); break;
        case "YEARLY": endDate = new Date(ms + 365 * DAY); break;
        case "LIFETIME": endDate = new Date(ms + 100 * 365 * DAY); break;
        default: endDate = new Date(ms + 28 * DAY); break;
      }
    }

    endDate.setHours(23, 59, 59, 999);
    return endDate;
  }

  async initiatePurchase(organizationId: string, planId: string, quantity: number) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) throw new NotFoundException("Plan not found or inactive");
    if (quantity < 1 || quantity > 100) throw new BadRequestException("Quantity must be 1-100");

    const totalAmount = Number(plan.price) * quantity;

    // Create purchase record
    const purchase = await this.prisma.subscriptionPurchase.create({
      data: {
        organizationId,
        planId,
        quantity,
        totalAmount,
        status: "PENDING",
      },
    });

    // Create order in payment-service using platform merchant
    let qrData: any = null;
    let orderResult: any = null;
    try {
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const platformConfig = await this.getPlatformConfig("subscription_payment_merchant");

      if (!platformConfig?.merchantId) {
        throw new BadRequestException({
          success: false,
          redirectUrl: '/customer-care', // Custom parameter handled by frontend
          message: "Platform payment merchant not configured. Redirecting to support..."
        });
      }

      const orderResponse = await axios.post(`${paymentServiceUrl}/orders`, {
        merchantId: platformConfig.merchantId,
        connectorId: platformConfig.connectorId || undefined,
        organizationId: platformConfig.organizationId || organizationId,
        amount: totalAmount.toString(),
        description: `Subscription: ${plan.name} x${quantity}`,
        customerName: `Org-${organizationId}`,
        callbackUrl: `${process.env.SUBSCRIPTION_SERVICE_URL}/real-subscriptions/payment-callback`,
        isPlatform: true,
      }, {
        headers: {
          'x-organization-id': platformConfig.organizationId || organizationId,
          "x-internal-token": process.env.INTERNAL_TOKEN
        }
      });

      orderResult = orderResponse.data;
      if (!orderResult.status && !orderResult.success) {
        throw new BadRequestException(orderResult.msg || "Failed to create payment order");
      }

      const orderId = orderResult.data?.id || orderResult.data?.session_id || orderResult.order?.id;
      const externalOrderId = orderResult.data?.order_id || orderResult.data?.externalOrderId || orderResult.order?.externalOrderId;

      // Update purchase with order info
      const updatedPurchase = await this.prisma.subscriptionPurchase.update({
        where: { id: purchase.id },
        data: { paymentOrderId: orderId, paymentExternalId: externalOrderId },
      });

      // The payment-service already generated the QR in the create response
      qrData = orderResult.data?.upi_intent || orderResult.data;

      return {
        success: true,
        purchase: {
          id: updatedPurchase.id,
          planName: plan.name,
          quantity,
          totalAmount,
          status: updatedPurchase.status,
          paymentExternalId: updatedPurchase.paymentExternalId,
          paymentOrderId: updatedPurchase.paymentOrderId,
        },
        qrCode: qrData?.qrCode || qrData?.bhim_link || null,
        paymentUrl: orderResult.data?.payment_url || null,
        order: qrData?.order || orderResult.data || null,
      };
    } catch (error) {
      this.logger.error("Failed to create payment order:", error?.response?.data || error.message);
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Failed to initiate payment. Please try again.");
    }
  }

  async handlePaymentCallback(body: any) {
    this.logger.log(`📥 Incoming payment callback: ${JSON.stringify(body)}`);
    const { externalOrderId, orderId, id, client_txn_id, status, utr } = body;
    const lookupId = id || client_txn_id || externalOrderId || orderId;

    if (!lookupId) {
      this.logger.warn("Payment callback missing order ID (checked id, client_txn_id, externalOrderId, orderId)");
      return { success: false, message: "Missing order identifier" };
    }

    const upperStatus = (status || "").toUpperCase();
    if (upperStatus !== "COMPLETED" && upperStatus !== "SUCCESS") {
      this.logger.log(`Payment callback for ${lookupId}: status=${status}, skipping slot creation`);
      if (upperStatus === "FAILED" || upperStatus === "EXPIRED") {
        await this.prisma.subscriptionPurchase.updateMany({
          where: { paymentExternalId: lookupId, status: "PENDING" },
          data: { status: upperStatus === "FAILED" ? "FAILED" : "EXPIRED" },
        });
      }
      return { success: true, message: `Status ${status} noted` };
    }

    // Find the purchase
    const purchase = await this.prisma.subscriptionPurchase.findFirst({
      where: {
        OR: [
          { paymentExternalId: lookupId },
          { paymentOrderId: lookupId },
        ],
      },
      include: { plan: true },
    });

    if (!purchase) {
      this.logger.warn(`No purchase found for order ${lookupId}`);
      return { success: false, message: "Purchase not found" };
    }

    // Idempotency: already completed
    if (purchase.status === "COMPLETED") {
      this.logger.log(`Purchase ${purchase.id} already completed, skipping`);
      return { success: true, message: "Already processed" };
    }

    // Check if it's a bulk renewal
    const metadata = purchase.metadata as any;
    const isBulkRenew = metadata?.type === 'BULK_RENEW';

    if (isBulkRenew && metadata.slotIds) {
      const slotIds = metadata.slotIds as string[];
      this.logger.log(`🔄 [Callback] Processing bulk renewal for ${slotIds.length} slots. Purchase: ${purchase.id}`);

      await this.prisma.$transaction(async (tx) => {
        for (const slotId of slotIds) {
          const slot = await tx.orgSubscription.findUnique({
            where: { id: slotId },
            include: { plan: true }
          });

          if (slot) {
            // Extend by plan duration
            const startDate = slot.endDate && slot.endDate > new Date() ? slot.endDate : new Date();
            const endDate = this.computeEndDate(startDate, slot.plan.billingCycle, slot.plan.durationDays);

            await tx.orgSubscription.update({
              where: { id: slotId },
              data: {
                status: slot.status === 'EXPIRED' ? 'ACTIVE' : slot.status,
                endDate,
                updatedAt: new Date()
              }
            });

            // Log to history
            await tx.subscriptionHistory.create({
              data: {
                organizationId: purchase.organizationId,
                planId: slot.planId,
                planName: slot.plan.name,
                planPrice: slot.plan.price,
                billingCycle: slot.plan.billingCycle,
                action: 'BULK_RENEWED',
                gatewayTransactionId: utr || null,
                quantity: 1,
                status: 'SUCCESS'
              }
            });
          }
        }

        // Update purchase and mark as invoiced
        await tx.subscriptionPurchase.update({
          where: { id: purchase.id },
          data: {
            status: "COMPLETED",
            paymentUtr: utr || null,
            completedAt: new Date(),
            metadata: {
              ...metadata,
              invoiceGenerated: true,
              invoiceDate: new Date().toISOString()
            }
          },
        });
      });

      this.logger.log(`✅ [Callback] Bulk renewal completed for ${purchase.id}`);
      return { success: true, message: `Bulk renewed ${slotIds.length} slots` };
    }

    // Create N slots (Original SINGLE PURCHASE LOGIC)
    this.logger.log(`🆕 [Callback] Creating ${purchase.quantity} new slots for plan ${purchase.plan.code}. Purchase: ${purchase.id}`);

    const startDate = new Date();
    const endDate = this.computeEndDate(startDate, purchase.plan.billingCycle, purchase.plan.durationDays);

    const slotData = Array.from({ length: purchase.quantity }, (_, i) => ({
      organizationId: purchase.organizationId,
      planId: purchase.planId,
      merchantId: null,
      status: "ACTIVE" as const, // Change to ACTIVE as it's an active plan unit
      startDate,
      endDate,
      purchaseId: purchase.id,
      purchaseUnitIndex: i,
    }));

    // Use createMany to support idempotency if needed, or loop with upsert
    // But since purchase.status = COMPLETED check at the top handles idempotency for the purchase itself,
    // createMany is fine.
    await this.prisma.$transaction([
      this.prisma.orgSubscription.createMany({ data: slotData, skipDuplicates: true }),
      this.prisma.subscriptionPurchase.update({
        where: { id: purchase.id },
        data: {
          status: "COMPLETED",
          paymentUtr: utr || null,
          completedAt: new Date(),
          metadata: {
            ...metadata,
            invoiceGenerated: true,
            invoiceDate: new Date().toISOString()
          }
        },
      }),
      this.prisma.subscriptionHistory.create({
        data: {
          organizationId: purchase.organizationId,
          planId: purchase.planId,
          planName: purchase.plan.name,
          planPrice: purchase.plan.price,
          billingCycle: purchase.plan.billingCycle,
          action: "PURCHASED",
          quantity: purchase.quantity,
          gatewayTransactionId: utr || null,
          status: "SUCCESS",
        },
      }),
    ]);

    this.logger.log(`✅ [Callback] Created ${purchase.quantity} slots for org ${purchase.organizationId} (purchase ${purchase.id})`);

    return { success: true, message: `Created ${purchase.quantity} subscription slots` };
  }


  async deleteSlot(slotId: string, organizationId: string, forceDeleteMerchant = false) {
    try {
      // 1. Fetch the slot to verify it exists and belongs to this org
      const slot = await this.prisma.orgSubscription.findUnique({
        where: { id: slotId },
      });

      if (!slot) {
        throw new BadRequestException("Slot not found");
      }

      // 2. Check merchant-service for active merchants on this org
      //    (slot.merchantId is not used — merchants are linked to orgs, not slots directly)
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
      let activeMerchants: Array<{ id: string; name: string }> = [];
      try {
        const mRes = await axios.get(`${merchantServiceUrl}/merchant/organization/${organizationId}`, {
          headers: {
            "x-internal-token": process.env.INTERNAL_TOKEN,
            "x-organization-id": organizationId,
          },
          timeout: 4000,
        });
        const rawList = mRes.data?.merchants || mRes.data?.data || [];
        // Only active, non-deleted merchants connected to this specific slot
        activeMerchants = rawList
          .filter((m: any) => m.isActive && !m.deletedAt && m.orgSubscriptionId === slotId)
          .map((m: any) => ({ id: m.id, name: m.name || m.businessName || m.id }));
      } catch (e) {
        this.logger.warn(`Could not fetch merchants for org ${organizationId}: ${e.message}`);
      }

      if (activeMerchants.length > 0) {
        if (!forceDeleteMerchant) {
          const primary = activeMerchants[0];
          throw new BadRequestException({
            code: "MERCHANT_CONNECTED",
            message: `This slot is being used by ${activeMerchants.length} merchant(s). Deleting it will remove their access.`,
            merchantId: primary.id,
            merchantName: primary.name,
            allMerchants: activeMerchants,
          });
        }

        // Force delete: soft-delete all active merchants first
        for (const merchant of activeMerchants) {
          this.logger.log(`🗑️ Force-deleting merchant ${merchant.id} (${merchant.name}) as part of slot ${slotId} deletion`);
          try {
            await axios.delete(`${merchantServiceUrl}/merchant/${merchant.id}`, {
              headers: {
                "x-internal-token": process.env.INTERNAL_TOKEN,
                "x-organization-id": organizationId,
                "x-user-type": "SUPER_ADMIN",
              },
              timeout: 5000,
            });
            this.logger.log(`✅ Merchant ${merchant.id} soft-deleted`);
          } catch (merchantErr) {
            this.logger.error(`❌ Failed to soft-delete merchant ${merchant.id}:`, merchantErr?.response?.data || merchantErr.message);
            throw new BadRequestException(
              `Failed to delete merchant "${merchant.name}". Please remove it manually and try again.`
            );
          }
        }
      }

      // 3. Delete the slot
      await this.prisma.orgSubscription.delete({
        where: { id: slotId },
      });
      this.logger.log(`🗑️ Deleted slot ${slotId}`);
      return { success: true, message: "Slot deleted successfully" };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error(`Failed to delete slot ${slotId}:`, error);
      throw new BadRequestException("Failed to delete slot. It may not exist.");
    }
  }

  // ─── PURCHASE HISTORY ───────────────────────────────────────

  async initiateBulkRenew(organizationId: string, slotIds: string[]) {
    try {
      // 1. Get all slots
      const slots = await this.prisma.orgSubscription.findMany({
        where: { id: { in: slotIds }, organizationId },
        include: { plan: true }
      });

      if (slots.length !== slotIds.length) {
        throw new BadRequestException("Some slots not found or don't belong to your organization");
      }

      // 2. Calculate total amount
      const totalAmount = slots.reduce((acc, slot) => acc.plus(slot.plan.price), new Decimal(0));

      // 3. Create one purchase record to track this bulk attempt
      // Use the first slot's planId for the relation (required by schema)
      const purchase = await this.prisma.subscriptionPurchase.create({
        data: {
          organizationId,
          planId: slots[0].planId,
          quantity: slots.length,
          totalAmount,
          status: 'PENDING',
          metadata: {
            type: 'BULK_RENEW',
            slotIds,
            breakdown: slots.map(s => ({ slotId: s.id, planId: s.planId, price: s.plan.price, planName: s.plan.name }))
          }
        }
      });

      // 4. Create payment order in payment-service using platform merchant
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const platformConfig = await this.getPlatformConfig("subscription_payment_merchant");

      if (!platformConfig?.merchantId) {
        throw new BadRequestException("Platform payment merchant not configured. Contact admin.");
      }

      const orderPayload = {
        merchantId: platformConfig.merchantId,
        connectorId: platformConfig.connectorId || undefined,
        organizationId: platformConfig.organizationId || organizationId,
        amount: totalAmount.toString(),
        currency: 'INR',
        description: `Bulk Renewal: ${slots.length} plans`,
        customerName: `Org-${organizationId.substring(0, 8)}`,
        callbackUrl: `${process.env.PUBLIC_API_URL}/real-subscriptions/payment-callback`,
        isPlatform: true,
        metadata: {
          purchaseId: purchase.id,
          type: 'BULK_RENEW'
        }
      };

      const orderResponse = await axios.post(`${paymentServiceUrl}/orders`, orderPayload, {
        headers: {
          'x-organization-id': platformConfig.organizationId || organizationId,
          'x-internal-token': process.env.INTERNAL_TOKEN
        }
      });

      const orderResult = orderResponse.data;
      if (!orderResult.status && !orderResult.success) {
        throw new BadRequestException(orderResult.msg || "Failed to create payment order");
      }

      const orderId = orderResult.data?.id || orderResult.data?.session_id || orderResult.order?.id;
      const externalOrderId = orderResult.data?.order_id || orderResult.data?.externalOrderId || orderResult.order?.externalOrderId;

      // 5. Update purchase with order info
      const updatedPurchase = await this.prisma.subscriptionPurchase.update({
        where: { id: purchase.id },
        data: {
          paymentOrderId: orderId,
          paymentExternalId: externalOrderId,
        },
        include: { plan: true }
      });

      return {
        success: true,
        purchase: updatedPurchase,
        order: orderResult.data || orderResult.order
      };
    } catch (error) {
      this.logger.error("Failed to initiate bulk renewal:", error);
      throw new BadRequestException(error.response?.data?.message || "Failed to initiate bulk renewal");
    }
  }

  async getPurchaseHistory(organizationId: string) {
    const purchases = await this.prisma.subscriptionPurchase.findMany({
      where: { organizationId },
      include: { plan: { select: { name: true, billingCycle: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return {
      success: true,
      purchases: purchases.map((p) => ({
        id: p.id,
        planName: p.plan.name,
        billingCycle: p.plan.billingCycle,
        quantity: p.quantity,
        totalAmount: p.totalAmount,
        status: p.status,
        paymentUtr: p.paymentUtr,
        paymentExternalId: p.paymentExternalId,
        completedAt: p.completedAt,
        createdAt: p.createdAt,
      })),
    };
  }

  async getSubscriptionHistory(organizationId: string) {
    try {
      const [history, unlocks] = await Promise.all([
        this.prisma.subscriptionHistory.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        this.prisma.merchantUnlockPurchase.findMany({
          where: { organizationId, status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);

      const historyRows = history.map((h) => ({
        id: h.id,
        planName: h.planName,
        planPrice: h.planPrice,
        billingCycle: h.billingCycle,
        action: h.action,
        previousPlanName: h.previousPlanName,
        gatewayTransactionId: h.gatewayTransactionId,
        quantity: h.quantity,
        status: h.status,
        date: h.createdAt,
      }));

      const unlockRows = unlocks.map((u) => ({
        id: u.id,
        planName: u.merchantType,
        planPrice: u.totalAmount,
        billingCycle: "ONETIME",
        action: "UNLOCK",
        previousPlanName: null,
        gatewayTransactionId: u.paymentExternalId || u.id,
        quantity: 1,
        status: "SUCCESS",
        date: u.createdAt,
      }));

      const combined = [...historyRows, ...unlockRows].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      return {
        success: true,
        history: combined.slice(0, 50),
      };
    } catch (error) {
      this.logger.error("Failed to get subscription history:", error);
      throw new BadRequestException("Failed to retrieve subscription history");
    }
  }

  async checkProviderAccess(organizationId: string, providerCode: string, isSuperAdmin: boolean = false) {
    try {
      // Platform bypass
      if (isSuperAdmin) {
        return { allowed: true };
      }

      const activeSlots = await this.prisma.orgSubscription.findMany({
        where: { organizationId, status: { in: ["ACTIVE", "UNASSIGNED"] } },
        include: { plan: { include: { providerAccess: true } } },
      });

      if (activeSlots.length === 0) {
        return { allowed: false, reason: "No active subscription found" };
      }

      let allowed = false;

      const pCode = providerCode.toUpperCase();

      for (const slot of activeSlots) {
        const providerAccess = slot.plan.providerAccess.find(
          (pa) => pa.providerCode.toUpperCase() === pCode
        );

        if (providerAccess && providerAccess.isIncluded) {
          allowed = true;
        }
      }

      if (!allowed) {
        return { allowed: false, reason: `Provider ${providerCode} not included in any of your active subscription plans` };
      }

      return { allowed: true };
    } catch (error) {
      this.logger.error("Failed to check provider access:", error);
      return { allowed: false, reason: "Failed to verify provider access" };
    }
  }

  async assignTrialSubscription(organizationId: string) {
    try {
      this.logger.log(`Assigning trial subscription to organization: ${organizationId}`);

      const existingSub = await this.prisma.orgSubscription.findFirst({
        where: { organizationId },
      });

      if (existingSub) {
        this.logger.warn(`Organization ${organizationId} already has a subscription, skipping trial assignment`);
        return { success: false, message: "Organization already has a subscription" };
      }

      // 2. Find the trial plan
      const trialPlan = await this.prisma.subscriptionPlan.findFirst({
        where: { isTrial: true, isActive: true },
      });

      if (!trialPlan) {
        this.logger.error("No active trial plan found in the system");
        throw new NotFoundException("Trial plan not configured");
      }

      // 3. Create the trial slot
      const duration = trialPlan.durationDays || trialPlan.trialDays || 7;
      const startDate = new Date();
      const endDate = this.computeEndDate(startDate, trialPlan.billingCycle, trialPlan.durationDays);

      const subscription = await this.prisma.orgSubscription.create({
        data: {
          organizationId,
          planId: trialPlan.id,
          status: "ACTIVE", // Start trial active immediately
          startDate,
          endDate,
          autoRenew: false,
          purchaseUnitIndex: 0,
        },
      });

      // 4. Record in history
      await this.prisma.subscriptionHistory.create({
        data: {
          organizationId,
          planId: trialPlan.id,
          planName: trialPlan.name,
          planPrice: trialPlan.price,
          billingCycle: trialPlan.billingCycle,
          action: "SUBSCRIBED",
          status: "SUCCESS",
          quantity: 1,
        },
      });

      this.logger.log(`✅ Trial assigned: ${subscription.id} for Org: ${organizationId} (Expires: ${endDate.toISOString()})`);

      return {
        success: true,
        message: "Trial subscription assigned successfully",
        subscription,
      };
    } catch (error) {
      this.logger.error("Failed to assign trial subscription:", error);
      throw error;
    }
  }

  async getPlatformConfig(key: string): Promise<any> {
    const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;

    const isMerchantActiveAndValid = async (merchantId: string): Promise<boolean> => {
      if (!merchantId || !merchantServiceUrl) return false;
      try {
        const res = await axios.get(`${merchantServiceUrl}/merchant/${merchantId}?includeDeleted=false`, {
          timeout: 4000,
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        });
        const m = res.data?.merchant || res.data;
        if (!m || m.deletedAt || m.isDeleted || m.isActive === false || m.status === "DEACTIVATED") {
          return false;
        }
        return true;
      } catch (err: any) {
        this.logger.warn(`⚠️ Platform merchant validation failed for ${merchantId}: ${err?.message}`);
        return false;
      }
    };

    // 1. Try explicit DB config first
    const config = await this.prisma.platformConfig.findUnique({ where: { key } });
    if (config?.value && (config.value as any)?.merchantId) {
      const dbMerchantId = (config.value as any).merchantId;
      const isValid = await isMerchantActiveAndValid(dbMerchantId);
      if (isValid) {
        return config.value;
      }
      this.logger.warn(`⚠️ DB platform merchant ${dbMerchantId} is inactive or deleted. Falling back to auto-discovery.`);
    }

    // 2. Auto-discover: query merchant-service for any active, non-deleted merchant with isPlatform: true
    try {
      this.logger.log("🔍 Platform merchant auto-discovering active merchants...");
      if (!merchantServiceUrl) {
        this.logger.error("❌ MERCHANT_SERVICE_URL not set in env");
        return null;
      }

      const response = await axios.get(`${merchantServiceUrl}/merchants/users`, {
        params: { limit: 50 },
        timeout: 5000,
        headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-user-type": "SUPER_ADMIN" }
      });

      const merchants = response.data?.data || response.data?.merchants || [];
      const platformMerchant = merchants.find(
        (m: any) => (m.isPlatform || m.isSuperAdmin) && m.isActive && !m.deletedAt && !m.isDeleted && m.status !== "DEACTIVATED"
      ) || merchants.find(
        (m: any) => m.isActive && !m.deletedAt && !m.isDeleted && m.status !== "DEACTIVATED"
      );

      if (platformMerchant) {
        this.logger.log(`✅ Auto-discovered active platform merchant: ${platformMerchant.id} (${platformMerchant.name})`);
        return {
          merchantId: platformMerchant.id,
          organizationId: platformMerchant.organizationId,
        };
      }
    } catch (error: any) {
      this.logger.error("❌ Auto-discovery failed:", error.message);
    }

    return null;
  }

  async setPlatformConfig(key: string, value: any) {
    await this.prisma.platformConfig.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return { success: true };
  }


  async directAssignSlots(organizationId: string, planId: string, quantity: number) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException("Plan not found");
    if (quantity < 1 || quantity > 100) throw new BadRequestException("Quantity must be 1-100");

    const startDate = new Date();
    const endDate = this.computeEndDate(startDate, plan.billingCycle, plan.durationDays);

    const purchaseId = require("crypto").randomUUID();

    const slotData = Array.from({ length: quantity }, (_, i) => ({
      organizationId,
      planId,
      merchantId: null,
      status: "ACTIVE" as const,
      startDate,
      endDate,
      purchaseId,
      purchaseUnitIndex: i,
    }));

    const slots = await this.prisma.$transaction([
      this.prisma.orgSubscription.createMany({ data: slotData, skipDuplicates: true }),
    ]);

    await this.prisma.subscriptionHistory.create({
      data: {
        organizationId,
        planId,
        planName: plan.name,
        planPrice: plan.price,
        billingCycle: plan.billingCycle,
        action: "ASSIGNED_BY_ADMIN",
        quantity,
        status: "SUCCESS",
      },
    });

    this.logger.log(`✅ Super-admin assigned ${quantity} slots to org ${organizationId}`);
    return { success: true, slotsCreated: slots.length, purchaseId };
  }

  async updateSlotDates(slotId: string, startDate?: string, endDate?: string, planId?: string, status?: string, autoRenew?: boolean) {
    const data: any = {};
    if (startDate) data.startDate = new Date(startDate);
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      data.endDate = ed;
    }
    if (planId) data.planId = planId;
    if (status) data.status = status;
    if (autoRenew !== undefined) data.autoRenew = autoRenew;

    if (Object.keys(data).length === 0) {
      return { success: false, message: 'No update data provided' };
    }

    const slot = await this.prisma.orgSubscription.update({
      where: { id: slotId },
      data
    });

    // Check if status needs to be updated based on new endDate
    const now = new Date();
    if (data.endDate && !status) {
      if (data.endDate < now && slot.status !== 'EXPIRED') {
        await this.prisma.orgSubscription.update({
          where: { id: slotId },
          data: { status: 'EXPIRED' }
        });
      } else if (data.endDate > now && slot.status === 'EXPIRED') {
        await this.prisma.orgSubscription.update({
          where: { id: slotId },
          data: { status: slot.merchantId ? 'ACTIVE' : 'UNASSIGNED' }
        });
      }
    }

    this.logger.log(`✅ Super-admin updated dates for slot ${slotId}`);
    return { success: true, message: 'Slot dates updated successfully', slot };
  }

  async getAllPurchases(status?: string) {
    const where: any = {};
    if (status) where.status = status;

    const purchases = await this.prisma.subscriptionPurchase.findMany({
      where,
      include: { plan: { select: { name: true, billingCycle: true, durationDays: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return {
      success: true,
      purchases: purchases.map((p) => ({
        id: p.id,
        organizationId: p.organizationId,
        planName: p.plan.name,
        quantity: p.quantity,
        totalAmount: p.totalAmount,
        status: p.status,
        paymentUtr: p.paymentUtr,
        paymentExternalId: p.paymentExternalId,
        completedAt: p.completedAt,
        createdAt: p.createdAt,
      })),
    };
  }


  @Cron("*/30 * * * * *")
  async reconcilePendingPurchases() {
    try {
      // Find purchases that are PENDING and have a payment reference
      const pendingPurchases = await this.prisma.subscriptionPurchase.findMany({
        where: {
          status: "PENDING",
          paymentExternalId: { not: null },
          // Only check recent ones (last 30 minutes) to avoid thrashing
          createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      });

      // Also check pending merchant unlock purchases
      const pendingUnlocks = await this.prisma.merchantUnlockPurchase.findMany({
        where: {
          status: "PENDING",
          paymentExternalId: { not: null },
          createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        },
        take: 10,
        orderBy: { createdAt: "desc" },
      });

      const allPending = [
        ...pendingPurchases.map(p => ({ id: p.id, paymentExternalId: p.paymentExternalId, type: 'subscription' as const })),
        ...pendingUnlocks.map(p => ({ id: p.id, paymentExternalId: p.paymentExternalId, type: 'unlock' as const })),
      ];

      if (allPending.length === 0) return;

      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      if (!paymentServiceUrl) return;

      for (const pending of allPending) {
        try {
          const orderRes = await axios.get(
            `${paymentServiceUrl}/orders/${pending.paymentExternalId}`,
            { timeout: 5000, headers: { "x-internal-token": process.env.INTERNAL_TOKEN } },
          );

          const order = orderRes.data?.order || orderRes.data;
          const orderStatus = (order?.status || "").toUpperCase();

          if (orderStatus === "COMPLETED" || orderStatus === "SUCCESS") {
            this.logger.log(
              `🔄 Reconciliation: purchase ${pending.id} payment is COMPLETED, triggering callback...`,
            );

            const utr = order?.utr || order?.transactions?.[0]?.utr || null;

            await this.handlePaymentCallback({
              externalOrderId: pending.paymentExternalId,
              status: "COMPLETED",
              utr,
            });

            this.logger.log(
              `✅ Reconciliation: purchase ${pending.id} activated successfully`,
            );
          }
        } catch (err: any) {
          // Don't log for expected errors (order not found, etc.)
          if (err?.response?.status !== 404) {
            this.logger.debug(
              `Reconciliation check failed for purchase ${pending.id}: ${err?.message}`,
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Reconciliation cron failed: ${err?.message}`);
    }
  }
  @Cron("*/5 * * * *")
  async expireSlots() {
    try {
      const now = new Date();
      const result = await this.prisma.orgSubscription.deleteMany({
        where: {
          status: { in: ["ACTIVE", "UNASSIGNED", "EXPIRED"] },
          endDate: { lt: now, not: null },
        },
      });

      if (result.count > 0) {
        this.logger.log(`⏰ Automatically deleted ${result.count} expired subscription slot(s)`);
      }
    } catch (error) {
      this.logger.error("Failed to delete expired slots:", error);
    }
  }

  // ─── SUBSCRIPTION EXPIRY NOTIFICATIONS ─────────────────────

  /** In-memory dedup map: "orgId:slotId:milestone" → timestamp */
  private expiryAlertsSent = new Map<string, number>();

  /** Clean stale entries older than 25 hours */
  private cleanExpiryAlertCache() {
    const cutoff = Date.now() - 25 * 60 * 60 * 1000;
    for (const [key, ts] of this.expiryAlertsSent.entries()) {
      if (ts < cutoff) this.expiryAlertsSent.delete(key);
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkExpiringSubscriptions() {
    try {
      this.cleanExpiryAlertCache();
      const now = new Date();

      // Find slots expiring in the next 24 hours
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const in6h = new Date(now.getTime() + 6 * 60 * 60 * 1000);

      const expiringSlots = await this.prisma.orgSubscription.findMany({
        where: {
          status: { in: ['ACTIVE', 'UNASSIGNED'] },
          endDate: { lte: in24h, gt: now },
        },
        include: { plan: true },
      });

      if (expiringSlots.length === 0) return;

      // Group by organization
      const orgSlots = new Map<string, typeof expiringSlots>();
      for (const slot of expiringSlots) {
        const existing = orgSlots.get(slot.organizationId) || [];
        existing.push(slot);
        orgSlots.set(slot.organizationId, existing);
      }

      const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL;
      const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
      const identityServiceUrl = process.env.IDENTITY_SERVICE_URL;
      const frontendUrl = process.env.FRONTEND_URL;
      const supportEmail = process.env.SUPPORT_EMAIL;
      const supportPhone = process.env.SUPPORT_PHONE;

      // Fetch dynamic BCC email from identity-service (primary superadmin)
      let bccEmail: string | undefined = undefined;
      try {
        const identityResponse = await axios.get(`${identityServiceUrl}/internal/super-admin/primary`, {
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        });
        bccEmail = identityResponse.data?.email;
      } catch (err: any) {
        this.logger.warn(`Failed to fetch primary super admin email for BCC: ${err.message}`);
      }

      for (const [organizationId, slots] of orgSlots.entries()) {
        try {
          // Determine the most urgent slot
          const earliestSlot = slots.reduce((a, b) =>
            new Date(a.endDate!).getTime() < new Date(b.endDate!).getTime() ? a : b
          );

          const hoursRemaining = (new Date(earliestSlot.endDate!).getTime() - now.getTime()) / (60 * 60 * 1000);
          const milestone = hoursRemaining <= 6 ? 6 : 24;
          const dedupKey = `${organizationId}:${earliestSlot.id}:${milestone}`;

          if (this.expiryAlertsSent.has(dedupKey)) {
            continue; // Already sent for this milestone
          }

          // Fetch owner email
          const orgResponse = await axios.get(`${orgServiceUrl}/organizations/${organizationId}`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } });
          const adminEmail = orgResponse.data?.ownerEmail || orgResponse.data?.email;
          const orgName = orgResponse.data?.name || 'Your Organization';

          if (!adminEmail) {
            this.logger.warn(`No admin email found for org ${organizationId}, skipping expiry alert`);
            continue;
          }

          // Send email
          await axios.post(`${notificationServiceUrl}/internal/send/email`, {
            to: adminEmail,
            bcc: bccEmail,
            type: 'subscription_expiry',
            data: {
              appName: 'Upipe',
              orgName,
              frontendUrl,
              planName: earliestSlot.plan.name,
              expiryDate: earliestSlot.endDate!.toISOString(),
              hoursRemaining: Math.round(hoursRemaining),
              supportEmail,
              supportPhone,
            },
          }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });

          this.expiryAlertsSent.set(dedupKey, Date.now());
          this.logger.log(`📧 Sent ${milestone}h expiry alert for org ${organizationId} (slot ${earliestSlot.id}, plan ${earliestSlot.plan.name})`);
        } catch (err: any) {
          this.logger.error(`Failed to send expiry alert for org ${organizationId}: ${err.message}`);
        }
      }
    } catch (error: any) {
      this.logger.error(`Expiry notification cron failed: ${error.message}`);
    }
  }


  async simulateNotification(organizationId: string, type: 'expiry' | 'renewal', slotId?: string) {
    try {
      const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
      const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL;
      const frontendUrl = process.env.FRONTEND_URL;
      const supportEmail = process.env.SUPPORT_EMAIL;
      const supportPhone = process.env.SUPPORT_PHONE;
      const identityServiceUrl = process.env.IDENTITY_SERVICE_URL;

      // Fetch dynamic BCC email from identity-service (primary superadmin)
      let bccEmail: string | undefined = undefined;
      try {
        const identityResponse = await axios.get(`${identityServiceUrl}/internal/super-admin/primary`, {
          headers: { "x-internal-token": process.env.INTERNAL_TOKEN }
        });
        bccEmail = identityResponse.data?.email;
      } catch (err: any) {
        this.logger.warn(`Failed to fetch primary super admin email for BCC: ${err.message}`);
      }

      const orgResponse = await axios.get(`${orgServiceUrl}/organizations/${organizationId}`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } });
      const orgData = orgResponse.data?.data?.organization || orgResponse.data?.organization || orgResponse.data;
      const adminEmail = orgData?.ownerEmail || orgData?.email;
      const orgName = orgData?.name;

      if (!adminEmail) {
        throw new BadRequestException("Organization has no admin email");
      }

      let planName = 'Premium Plan';
      let endDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      let hoursRemaining = 24;

      if (slotId) {
        const slot = await this.prisma.orgSubscription.findUnique({ where: { id: slotId }, include: { plan: true } });
        if (slot) {
          planName = slot.plan.name;
          endDate = slot.endDate || endDate;
          hoursRemaining = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);
        }
      }

      if (type.toLowerCase() === 'expiry') {
        await axios.post(`${notificationServiceUrl}/internal/send/email`, {
          to: adminEmail,
          bcc: bccEmail,
          type: 'subscription_expiry',
          data: {
            appName: 'Upipe',
            orgName,
            frontendUrl,
            planName,
            expiryDate: endDate.toISOString(),
            hoursRemaining: Math.round(hoursRemaining),
            supportEmail,
            supportPhone,
          },
        }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
      } else if (type.toLowerCase() === 'renewal') {
        await axios.post(`${notificationServiceUrl}/internal/send/email`, {
          to: adminEmail,
          bcc: bccEmail,
          type: 'subscription_renewal',
          data: {
            appName: 'Upipe',
            orgName,
            frontendUrl,
            planName,
            renewalDate: new Date().toISOString(),
            expiryDate: endDate.toISOString(),
            supportEmail,
            supportPhone,
          },
        }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
      }

      return { success: true, message: `Simulated ${type} notification sent to ${adminEmail}` };
    } catch (err: any) {
      this.logger.error(`Failed to simulate notification: ${err.message}`);
      throw new BadRequestException(err.message || "Failed to simulate notification");
    }
  }

  async getExpiringSlots(organizationId: string) {
    try {
      const now = new Date();
      const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);

      const slots = await this.prisma.orgSubscription.findMany({
        where: {
          organizationId,
          status: { in: ['ACTIVE', 'UNASSIGNED'] },
          endDate: { lte: in48h, gt: now },
        },
        include: { plan: true },
        orderBy: { endDate: 'asc' },
      });

      return {
        success: true,
        expiringSlots: slots.map((s) => {
          const hoursRemaining = (new Date(s.endDate!).getTime() - now.getTime()) / (60 * 60 * 1000);
          return {
            id: s.id,
            planName: s.plan.name,
            merchantId: s.merchantId,
            endDate: s.endDate,
            hoursRemaining: Math.round(hoursRemaining * 10) / 10,
          };
        }),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get expiring slots: ${error.message}`);
      return { success: true, expiringSlots: [] };
    }
  }

  async seedSubscriptionPlans() {
    try {
      const existingPlans = await this.prisma.subscriptionPlan.count();
      if (existingPlans > 0) {
        this.logger.log("Subscription plans already exist, skipping seed");
        return;
      }

      this.logger.log("Seeding initial subscription plans...");

      const FEATURES = [
        '0 Transaction Fee *',
        'Realtime Transaction',
        'No Amount Limit',
        'Zero Setup Charge',
        'Migration Assistance',
        '24*7 Whatsapp Support',
        'Remove Branding',
        'Direct Intent *',
        'Incognito Payment URL',
        'Allow connecting multiple merchants',
        'Support Special & Star Merchant *',
      ];

      const plansData = [
        // ── Trial Plan ──
        {
          name: 'Free Trial', code: 'TRIAL', description: 'Explore all features for 7 days',
          price: 0, currency: 'INR', billingCycle: 'MONTHLY', trialDays: 7,
          maxUsers: 2, maxMerchants: 1, maxTransactions: 100, maxApiCalls: 1000,
          features: ['All Features Enabled', 'Limited Quotas', '7 Day Duration'],
          isActive: true, isPublic: true, isFeatured: false, isTrial: true, sortOrder: 0,
        },
        // ── Monthly Plans ──
        {
          name: 'Starter', code: 'STARTER', description: 'Starter monthly plan',
          price: 1299, currency: 'INR', billingCycle: 'MONTHLY', trialDays: 0,
          maxUsers: 5, maxMerchants: 3, maxTransactions: 1000, maxApiCalls: 10000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 10,
        },
        {
          name: 'Startup', code: 'STARTUP', description: 'Startup monthly plan',
          price: 1999, currency: 'INR', billingCycle: 'MONTHLY', trialDays: 0,
          maxUsers: 15, maxMerchants: 10, maxTransactions: 5000, maxApiCalls: 50000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 20,
        },
        {
          name: 'Business', code: 'BUSINESS', description: 'Business monthly plan',
          price: 2499, currency: 'INR', billingCycle: 'MONTHLY', trialDays: 0,
          maxUsers: 50, maxMerchants: 25, maxTransactions: 25000, maxApiCalls: 250000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: true, sortOrder: 30,
        },
        {
          name: 'Business +', code: 'BUSINESS_PLUS', description: 'Business+ monthly plan',
          price: 4999, currency: 'INR', billingCycle: 'MONTHLY', trialDays: 0,
          maxUsers: 100, maxMerchants: 50, maxTransactions: 50000, maxApiCalls: 500000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 40,
        },
        // ── Quarterly Plans ──
        {
          name: 'Starter', code: 'STARTER_QTR', description: 'Starter quarterly plan (10% more requests)',
          price: 3899, currency: 'INR', billingCycle: 'QUARTERLY', trialDays: 0,
          maxUsers: 5, maxMerchants: 3, maxTransactions: 1000, maxApiCalls: 10000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 50,
        },
        {
          name: 'Startup', code: 'STARTUP_QTR', description: 'Startup quarterly plan (10% more requests)',
          price: 5999, currency: 'INR', billingCycle: 'QUARTERLY', trialDays: 0,
          maxUsers: 15, maxMerchants: 10, maxTransactions: 5000, maxApiCalls: 50000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 60,
        },
        {
          name: 'Business', code: 'BUSINESS_QTR', description: 'Business quarterly plan (10% more requests)',
          price: 7499, currency: 'INR', billingCycle: 'QUARTERLY', trialDays: 0,
          maxUsers: 50, maxMerchants: 25, maxTransactions: 25000, maxApiCalls: 250000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: true, sortOrder: 70,
        },
        {
          name: 'Business +', code: 'BUSINESS_PLUS_QTR', description: 'Business+ quarterly plan (10% more requests)',
          price: 14999, currency: 'INR', billingCycle: 'QUARTERLY', trialDays: 0,
          maxUsers: 100, maxMerchants: 50, maxTransactions: 50000, maxApiCalls: 500000,
          features: [...FEATURES],
          isActive: true, isPublic: true, isFeatured: false, sortOrder: 80,
        },
      ];

      for (const data of plansData) {
        const plan = await this.prisma.subscriptionPlan.create({ data: data as any });

        const providers = ['PHONEPE', 'PAYTM', 'GPAY', 'BHARATPE', 'QUINTUS', 'QUINTUSPAY'];
        const providerAccessData = providers.map(pCode => {
          let included = false;

          if (data.code === 'TRIAL' || data.code.startsWith('STARTER')) {
            included = pCode !== 'BHARATPE';
          } else if (data.code.startsWith('STARTUP')) {
            included = true;
          } else if (data.code.startsWith('BUSINESS')) {
            included = true;
          }

          return {
            planId: plan.id,
            providerCode: pCode,
            isIncluded: included,
          };
        });

        await this.prisma.subscriptionProviderAccess.createMany({ data: providerAccessData });
      }

      this.logger.log("✅ Subscription plans seeded successfully");
    } catch (error) {
      this.logger.error("Failed to seed subscription plans:", error);
      throw error;
    }
  }

  async getPurchaseDetails(
    purchaseId: string,
    force: boolean = false,
    reqOrgId?: string,
    isSuperAdmin: boolean = false
  ) {
    let purchase: any = await this.prisma.subscriptionPurchase.findUnique({
      where: { id: purchaseId },
      include: { plan: true },
    });

    let isUnlock = false;
    if (!purchase) {
      purchase = await this.prisma.merchantUnlockPurchase.findUnique({
        where: { id: purchaseId },
      });
      isUnlock = true;
    }

    if (!purchase) {
      throw new BadRequestException("Purchase record not found");
    }

    if (!isSuperAdmin && reqOrgId && purchase.organizationId !== reqOrgId) {
      throw new ForbiddenException("Access denied: You do not have permission to view this purchase");
    }

    if (purchase.status === 'EXPIRED') {
      await this.prisma.subscriptionPurchase.update({
        where: { id: purchaseId },
        data: { status: 'PENDING' }
      });
      (purchase as any).status = 'PENDING';
    }

    // Get order info from payment-service if possible
    let paymentData: any = null;
    try {
      const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
      const orderResponse = await axios.get(
        `${paymentServiceUrl}/orders/${purchase.paymentExternalId}`,
        { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
      );
      paymentData = orderResponse.data?.order || orderResponse.data;
    } catch (e) {
      this.logger.warn(`Could not fetch payment status for ${purchase.paymentExternalId}`);
    }

    // Self-healing: if payment is COMPLETED but purchase is still PENDING, trigger callback now
    if (
      purchase.status === "PENDING" &&
      paymentData &&
      (paymentData.status === "COMPLETED" || paymentData.status === "SUCCESS")
    ) {
      this.logger.log(
        `🔄 Self-heal: purchase ${purchase.id} is PENDING but order is COMPLETED. Triggering callback inline...`,
      );
      try {
        const utr = paymentData.utr || paymentData.transactions?.[0]?.utr || null;
        await this.handlePaymentCallback({
          externalOrderId: purchase.paymentExternalId,
          status: "COMPLETED",
          utr,
        });
        // Re-fetch the updated purchase to return correct status
        const refreshed = await this.prisma.subscriptionPurchase.findUnique({
          where: { id: purchaseId },
          include: { plan: true },
        });
        if (refreshed) {
          purchase = refreshed;
        }
        this.logger.log(`✅ Self-heal: purchase ${purchase.id} activated successfully`);
      } catch (healErr: any) {
        this.logger.warn(`Self-heal failed for ${purchase.id}: ${healErr?.message}`);
      }
    }

    // Get QR data from payment-service if we have an external ID
    let qrData: any = null;
    if (purchase.paymentExternalId) {
      try {
        const paymentServiceUrl = process.env.PAYMENT_SERVICE_URL;
        const qrResponse = await axios.post(
          `${paymentServiceUrl}/payments/generate-qr/${purchase.paymentExternalId}${force ? '?force=true' : ''}`,
          {},
          { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
        );
        qrData = qrResponse.data;
      } catch (e) {
        this.logger.warn(`Could not generate QR for ${purchase.paymentExternalId}: ${e.message}`);
      }
    } else {
      this.logger.warn(`Skipping QR generation for purchase ${purchase.id} - paymentExternalId is missing`);
    }

    // Fallback QR/Payment URL from order data if not explicitly provided
    const orderData = paymentData?.data || paymentData;
    const finalQrCode = qrData?.qrCode || orderData?.qrCode || orderData?.upi_intent?.qr_code || null;
    const finalPaymentUrl = paymentData?.payment_url || orderData?.payment_url || orderData?.upi_intent?.payment_url || qrData?.qrCode?.paymentUrl || null;

    return {
      success: true,
      purchase: {
        id: purchase.id,
        planName: isUnlock ? purchase.merchantType : purchase.plan?.name,
        quantity: isUnlock ? 1 : purchase.quantity,
        totalAmount: purchase.totalAmount,
        status: purchase.status,
        paymentExternalId: purchase.paymentExternalId,
        createdAt: purchase.createdAt,
        metadata: isUnlock ? {
          type: 'MERCHANT_UNLOCK',
          displayName: purchase.merchantType === 'PREMIUM_GATEWAY_ACCESS' ? 'Premium Gateway Access' : purchase.merchantType,
        } : { type: 'PLAN_PURCHASE' }
      },
      qrCode: finalQrCode,
      paymentUrl: finalPaymentUrl,
      order: paymentData || null,
    };
  }

  // ─── EVENT-DRIVEN USAGE ALERTS ────────────────────────────

  async processTransactionEvent(organizationId: string) {
    try {
      const now = new Date();
      const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      // 1. Increment MonthlyUsage
      const monthlyUsage = await this.prisma.monthlyUsage.upsert({
        where: {
          orgId_billingMonth: { orgId: organizationId, billingMonth },
        },
        create: { orgId: organizationId, billingMonth, orderCount: 1 },
        update: { orderCount: { increment: 1 } },
      });

      // 2. Fetch Subscription Data to get limits
      const subData = await this.getOrganizationSubscription(organizationId);
      if (!subData.success) return;

      const limit = subData.subscription.limits?.maxTransactions || 1000;
      if (limit <= 0) return;

      const usagePct = (monthlyUsage.orderCount / limit) * 100;

      const milestones = [100, 90, 80, 70];
      let crossedMilestone: number | null = null;
      for (const m of milestones) {
        if (usagePct >= m) {
          crossedMilestone = m;
          break;
        }
      }

      if (crossedMilestone) {
        // Attempt to create UsageAlert lock
        try {
          await this.prisma.usageAlert.create({
            data: {
              orgId: organizationId,
              billingMonth,
              milestone: crossedMilestone
            }
          });

          // Successfully obtained lock -> Fire Email
          this.logger.log(`Firing ${crossedMilestone}% usage alert for org ${organizationId}`);

          // Call notification service
          const notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL as string;
          const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL as string;

          try {
            const orgResponse = await axios.get(`${orgServiceUrl}/organizations/${organizationId}`, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-organization-id": organizationId } });
            const orgData = orgResponse.data?.data?.organization || orgResponse.data?.organization || orgResponse.data?.data || orgResponse.data;
            const adminEmail = orgData?.ownerEmail || orgData?.email;
            const orgName = orgData?.name;

            if (adminEmail) {
              await axios.post(`${notificationServiceUrl}/internal/send/email`, {
                to: adminEmail,
                type: 'usage_alert',
                data: {
                  milestone: crossedMilestone,
                  appName: 'Upipe',
                  orgName: orgName,
                  usagePct: Math.floor(usagePct)
                }
              }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });
            }
          } catch (err: any) {
            this.logger.error(`Failed to fetch org details or send email for org ${organizationId}: ${err.message}`);
          }
        } catch (err: any) {
          // If Prisma unique constraint fails, it means alert already sent
          if (err.code !== 'P2002') {
            this.logger.error(`Error creating usage alert record: ${err.message}`);
          }
        }
      }

    } catch (error: any) {
      this.logger.error(`Failed to process transaction event: ${error.message}`);
    }
  }
}


import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import axios from "axios";
import { Decimal } from "@prisma/client/runtime/library";

@Injectable()
export class RealSubscriptionService {
  private readonly logger = new Logger(RealSubscriptionService.name);

  constructor(private readonly prisma: PrismaService) { }


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
          })),
        })),
      };
    } catch (error) {
      this.logger.error("Failed to get subscription plans:", error);
      throw new BadRequestException("Failed to retrieve subscription plans");
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

      return {
        success: true,
        // Backward compat: expose a single "subscription" object for existing consumers
        subscription: {
          id: currentSlot.id,
          organizationId,
          plan,
          status: activeSlots.length > 0 || unassignedSlots.length > 0 ? "ACTIVE" : "EXPIRED",
          startDate: currentSlot.startDate,
          endDate: currentSlot.endDate,
          autoRenew: currentSlot.autoRenew,
          limits: aggregatedLimits,
          currentUsage: {
            usersCreated: 0,
            merchantsCreated: activeSlots.length,
            transactionsCount: 0,
            transactionVolume: 0,
            apiCallsCount: 0,
          },
          providerAccess: Object.values(providerAccessMap),
        },
        // New slot-based response
        slots: slots.map((s) => ({
          id: s.id,
          merchantId: s.merchantId,
          planId: s.planId,
          planName: s.plan.name,
          status: s.status,
          startDate: s.startDate,
          endDate: s.endDate,
          purchaseId: s.purchaseId,
          createdAt: s.createdAt,
        })),
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

  // ─── PURCHASE FLOW ──────────────────────────────────────────

  private computeEndDate(startDate: Date, billingCycle: string, durationDays?: number | null): Date {
    const ms = startDate.getTime();
    const DAY = 24 * 60 * 60 * 1000;

    if (durationDays && durationDays > 0) {
      return new Date(ms + durationDays * DAY);
    }

    switch (billingCycle) {
      case "MONTHLY": return new Date(ms + 28 * DAY);
      case "QUARTERLY": return new Date(ms + 84 * DAY);
      case "HALF_YEARLY": return new Date(ms + 180 * DAY);
      case "YEARLY": return new Date(ms + 365 * DAY);
      case "LIFETIME": return new Date(ms + 100 * 365 * DAY);
      default: return new Date(ms + 28 * DAY);
    }
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

    const slotData = Array.from({ length: purchase.quantity }, () => ({
      organizationId: purchase.organizationId,
      planId: purchase.planId,
      merchantId: null,
      status: "UNASSIGNED" as const,
      startDate,
      endDate,
      purchaseId: purchase.id,
    }));

    await this.prisma.$transaction([
      ...slotData.map((data) => this.prisma.orgSubscription.create({ data })),
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

    this.autoAssignFloatingMerchants(purchase.organizationId).catch(err => {
      this.logger.warn(`Failed to auto-assign merchants for org ${purchase.organizationId}: ${err.message}`);
    });

    return { success: true, message: `Created ${purchase.quantity} subscription slots` };
  }

  async autoAssignFloatingMerchants(organizationId: string) {
    try {
      this.logger.log(`🔄 Auto-assigning floating merchants for org ${organizationId}`);

      const axios = require("axios");
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
      const response = await axios.get(`${merchantServiceUrl}/merchant/list`, {
        headers: { 'x-organization-id': organizationId, 'x-internal-token': process.env.INTERNAL_TOKEN }
      });

      if (!response.data?.success) return;
      const allMerchants = response.data.merchants || [];

      // 2. Find currently assigned merchants and identify their plan types
      const activeSlots = await this.prisma.orgSubscription.findMany({
        where: { organizationId, merchantId: { not: null }, status: "ACTIVE" },
        include: { plan: true },
      });

      const assignedMerchantIds = new Set(activeSlots.map(s => s.merchantId));

      // Identify merchants who have a paid slot
      const paidMerchantIds = new Set(
        activeSlots.filter(s => !s.plan.isTrial).map(s => s.merchantId)
      );

      // 3. Find merchants eligible for auto-assignment:
      //    a) Floating merchants (no slot at all)
      //    b) Trial merchants who DON'T have a paid slot yet
      const eligibleMerchants = allMerchants.filter(m => {
        const hasAnySlot = assignedMerchantIds.has(m.id);
        const hasPaidSlot = paidMerchantIds.has(m.id);

        // Eligible if they have NO slot OR if they ONLY have a trial slot (and no paid slot yet)
        return !hasAnySlot || (hasAnySlot && !hasPaidSlot);
      });

      if (eligibleMerchants.length === 0) {
        this.logger.log(`✅ No eligible merchants for auto-assignment in org ${organizationId}`);
        return;
      }

      this.logger.log(`Found ${eligibleMerchants.length} merchants eligible for auto-assignment for org ${organizationId}`);

      // 4. Try to assign each eligible merchant to a NEW slot
      for (const merchant of eligibleMerchants) {
        try {
          // Double check they didn't get a paid slot in this same loop (though unlikely here)
          await this.assignSlotToMerchant(organizationId, merchant.id);
          this.logger.log(`✅ Auto-linked merchant ${merchant.id} to a new slot`);
        } catch (assignError) {
          this.logger.debug(`Could not auto-assign merchant ${merchant.id}: ${assignError.message}`);
          break; // No more slots available
        }
      }
    } catch (error) {
      this.logger.error(`Failed during auto-assignment: ${error.message}`);
    }
  }

  async checkCanConnectMerchant(organizationId: string) {
    const unassignedCount = await this.prisma.orgSubscription.count({
      where: { organizationId, status: "UNASSIGNED" },
    });

    return {
      success: true,
      allowed: unassignedCount > 0,
      unassignedCount,
      message: unassignedCount > 0
        ? `${unassignedCount} slot(s) available`
        : "No available slots. Please purchase a plan to connect more merchants.",
    };
  }

  async assignSlotToMerchant(organizationId: string, merchantId: string, slotId?: string) {
    let slot;
    if (slotId) {
      slot = await this.prisma.orgSubscription.findFirst({
        where: { id: slotId, organizationId, status: "UNASSIGNED", merchantId: null },
      });
      if (!slot) {
        throw new BadRequestException("Subscription slot not found or already assigned.");
      }
    } else {
      slot = await this.prisma.orgSubscription.findFirst({
        where: { organizationId, status: "UNASSIGNED", merchantId: null },
        orderBy: { createdAt: "asc" },
      });
      if (!slot) {
        throw new BadRequestException("No available subscription slots. Please purchase a plan.");
      }
    }

    const unassignedSlot = slot;

    // Atomic update: only update if still UNASSIGNED (race condition guard)
    const result = await this.prisma.orgSubscription.updateMany({
      where: { id: unassignedSlot.id, status: "UNASSIGNED", merchantId: null },
      data: { merchantId, status: "ACTIVE" },
    });

    if (result.count === 0) {
      throw new BadRequestException("Slot was already assigned. Please try again.");
    }

    this.logger.log(`✅ Assigned slot ${unassignedSlot.id} to merchant ${merchantId}`);
    return { success: true, slotId: unassignedSlot.id, message: "Slot assigned successfully" };
  }

  async unassignSlot(merchantId: string) {
    const result = await this.prisma.orgSubscription.updateMany({
      where: { merchantId, status: "ACTIVE" },
      data: { merchantId: null, status: "UNASSIGNED" },
    });

    if (result.count > 0) {
      this.logger.log(`♻️ Freed ${result.count} slot(s) from merchant ${merchantId}`);
    }

    return { success: true, freedCount: result.count };
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
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + duration);

      const subscription = await this.prisma.orgSubscription.create({
        data: {
          organizationId,
          planId: trialPlan.id,
          status: "UNASSIGNED",
          startDate,
          endDate,
          autoRenew: false,
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
    // 1. Try explicit DB config first
    const config = await this.prisma.platformConfig.findUnique({ where: { key } });
    if (config?.value && (config.value as any)?.merchantId) {
      return config.value;
    }

    // 2. Auto-discover: query merchant-service for any merchant with isPlatform: true
    try {
      this.logger.log("🔍 Platform merchant not in DB config. Auto-discovering...");
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
      if (!merchantServiceUrl) {
        this.logger.error("❌ MERCHANT_SERVICE_URL not set in env");
        return null;
      }

      const response = await axios.get(`${merchantServiceUrl}/merchants/users`, {
        params: { limit: 1 },
        timeout: 5000,
        headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "x-user-type": "SUPER_ADMIN" }
      });

      const merchants = response.data?.data || response.data?.merchants || [];
      const platformMerchant = merchants.find((m: any) => m.isActive) || merchants[0];

      if (platformMerchant) {
        this.logger.log(`✅ Auto-discovered platform merchant: ${platformMerchant.id} (${platformMerchant.name})`);
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

  // ─── SUPER-ADMIN: DIRECT ASSIGN ────────────────────────────

  async directAssignSlots(organizationId: string, planId: string, quantity: number) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException("Plan not found");
    if (quantity < 1 || quantity > 100) throw new BadRequestException("Quantity must be 1-100");

    const startDate = new Date();
    const endDate = this.computeEndDate(startDate, plan.billingCycle, plan.durationDays);

    const purchaseId = require("crypto").randomUUID();

    const slots = await this.prisma.$transaction(
      Array.from({ length: quantity }, () =>
        this.prisma.orgSubscription.create({
          data: {
            organizationId,
            planId,
            merchantId: null,
            status: "UNASSIGNED",
            startDate,
            endDate,
            purchaseId,
          },
        })
      )
    );

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

  async updateSlotDates(slotId: string, startDate?: string, endDate?: string) {
    const data: any = {};
    if (startDate) data.startDate = new Date(startDate);
    if (endDate) data.endDate = new Date(endDate);

    if (Object.keys(data).length === 0) {
      return { success: false, message: 'No dates provided' };
    }

    const slot = await this.prisma.orgSubscription.update({
      where: { id: slotId },
      data
    });

    // Check if status needs to be updated based on new endDate
    const now = new Date();
    if (data.endDate) {
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
      const result = await this.prisma.orgSubscription.updateMany({
        where: {
          status: { in: ["ACTIVE", "UNASSIGNED"] },
          endDate: { lt: now, not: null },
        },
        data: { status: "EXPIRED" },
      });

      if (result.count > 0) {
        this.logger.log(`⏰ Expired ${result.count} subscription slot(s)`);
      }
    } catch (error) {
      this.logger.error("Failed to expire slots:", error);
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
      const identityServiceUrl = process.env.IDENTITY_SERVICE_URL || 'http://127.0.0.1:4001';
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
      const supportEmail = process.env.SUPPORT_EMAIL || 'support@upipe.in';
      const supportPhone = process.env.SUPPORT_PHONE || '+91-XXXXXXXXXX';
      const identityServiceUrl = process.env.IDENTITY_SERVICE_URL || 'http://127.0.0.1:4001';

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
      const adminEmail = orgResponse.data?.ownerEmail || orgResponse.data?.email;
      const orgName = orgResponse.data?.name || 'Your Organization';

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

      if (type === 'expiry') {
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
      } else if (type === 'renewal') {
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

  async getPurchaseDetails(purchaseId: string, force: boolean = false) {
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


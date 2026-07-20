import { Controller, Post, Body, Get, Query, Logger, Headers, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { PrismaClient, TransactionStatus, PaymentMethod } from "@prisma/client";
import { OrdersService } from "./simple-orders.controller";
import axios from "axios";
import { InternalAuthGuard } from "../guards/internal-auth.guard";
import { IsArray, ArrayMaxSize, IsString, IsNotEmpty } from "class-validator";

export class BulkCheckDto {
  @IsArray()
  @ArrayMaxSize(1000, { message: "Maximum of 1000 transactions can be checked at once to prevent database overload." })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  externalTransactionIds: string[];
}

@ApiTags("Transactions")
@Controller("transactions")
export class TransactionsController {
  private readonly logger = new Logger(TransactionsController.name);
  private prisma = new PrismaClient();

  constructor(private readonly ordersService: OrdersService) {}

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

  @Post("bulk-check")
  @UseGuards(InternalAuthGuard)
  @ApiOperation({ summary: "Bulk check if transactions exist" })
  @ApiResponse({ status: 200, description: "Transactions matched successfully" })
  async bulkCheckTransactions(@Body() body: BulkCheckDto) {
    try {
      if (!body.externalTransactionIds || !Array.isArray(body.externalTransactionIds)) {
        return { success: false, transactions: [] };
      }
      
      const externalIds = body.externalTransactionIds.filter(id => id && typeof id === 'string');
      if (externalIds.length === 0) return { success: true, transactions: [] };

      const existingTxns = await this.prisma.transaction.findMany({
        where: { externalTransactionId: { in: externalIds } },
        select: { externalTransactionId: true, orderId: true }
      });
      return { success: true, transactions: existingTxns };
    } catch (e) {
      this.logger.error("Bulk check failed", e);
      return { success: false, transactions: [] };
    }
  }

  @Post("sync")
  @ApiOperation({ summary: "Sync transaction from provider" })
  @ApiResponse({ status: 200, description: "Transaction synced successfully" })
  async syncTransaction(@Body() syncData: any) {
    try {
      this.logger.log(`Syncing transaction: ${syncData.externalTransactionId}`);

      const orderIdStr =
        syncData.orderId ||
        syncData.paytmMerchantTransId ||
        syncData.merchantTransactionId;
      let trueMerchantId = syncData.merchantId;

      if (orderIdStr) {
        let order = await this.prisma.order.findFirst({
          where: {
            OR: [{ id: orderIdStr }, { externalOrderId: orderIdStr }],
          },
        });
        // Providers often send ID without underscores (e.g. FNQY6SU56090D2F3E0) while we store with underscores (FNQY6_SU_56090D2F3E0)
        if (!order && typeof orderIdStr === "string") {
          const normalized = orderIdStr.replace(/_/g, "");
          const rows = await this.prisma.$queryRawUnsafe<
            Array<{ id: string; merchantId: string }>
          >(
            `SELECT id, merchant_id as "merchantId" FROM orders WHERE REPLACE(external_order_id, '_', '') = ? LIMIT 1`,
            normalized,
          );
          if (rows?.[0]) {
            order = rows[0] as any;
            this.logger.log(
              `Matched order by normalized externalOrderId: ${orderIdStr} -> ${order.id}`,
            );
          }
        }
        if (order) {
          trueMerchantId = order.merchantId;
          syncData.orderId = order.id;
        }
      }

      // Phase 3: If no order from merchantTransactionId/externalOrderId, resolve by UTR so full transaction response can still match our orders
      if (!syncData.orderId && syncData.utr) {
        const txnByUtr = await this.prisma.transaction.findFirst({
          where: { utr: syncData.utr },
          select: { orderId: true, merchantId: true },
        });
        if (txnByUtr?.orderId) {
          syncData.orderId = txnByUtr.orderId;
          trueMerchantId = txnByUtr.merchantId;
          this.logger.log(
            `Matched order by UTR (existing transaction): ${syncData.utr} -> orderId ${txnByUtr.orderId}`,
          );
        } else {
          const orderByUtr = await this.prisma.order.findFirst({
            where: { utr: syncData.utr },
            select: { id: true, merchantId: true },
          });
          if (orderByUtr) {
            syncData.orderId = orderByUtr.id;
            trueMerchantId = orderByUtr.merchantId;
            this.logger.log(
              `Matched order by Order.utr: ${syncData.utr} -> orderId ${orderByUtr.id}`,
            );
          }
        }
      }

      let transaction = await this.prisma.transaction.findFirst({
        where: {
          externalTransactionId: syncData.externalTransactionId,
        },
      });

      if (!transaction && syncData.orderId) {
        transaction = await this.prisma.transaction.findFirst({
          where: {
            orderId: syncData.orderId,
          },
        });

        if (transaction) {
          this.logger.log(
            `Found existing transaction by Order ID: ${syncData.orderId}. Merging...`,
          );
        }
      }

      // If we still have no order but found existing transaction, use its orderId so we link correctly
      if (!syncData.orderId && transaction?.orderId) {
        syncData.orderId = transaction.orderId;
        trueMerchantId = transaction.merchantId;
        this.logger.log(
          `Resolved order from existing transaction: orderId ${transaction.orderId}`,
        );
      }

      if (!transaction) {
        transaction = await this.prisma.transaction.create({
          data: {
            orderId: syncData.orderId,
            merchantId: trueMerchantId,
            providerId: syncData.providerId,
            externalTransactionId: syncData.externalTransactionId,
            amount: syncData.amount,
            netAmount: syncData.amount,
            currency: syncData.currency || "INR",
            status: syncData.status as TransactionStatus,
            paymentMethod: syncData.paymentMethod as PaymentMethod,
            providerCode: syncData.providerCode,
            providerResponse: syncData.providerResponse,
            customerName: syncData.customerName,
            customerContact: syncData.customerContact,
            paymentApp: syncData.paymentApp,
            utr: syncData.utr,
            createdAt: syncData.createdAt || new Date(),
            completedAt:
              syncData.status === "SUCCESS"
                ? syncData.completedAt || new Date()
                : null,
            failedAt: syncData.status === "FAILED" ? new Date() : null,
          },
        });

        this.logger.log(
          `✅ Created new transaction: ${transaction.id} for merchant ${trueMerchantId}`,
        );
      } else {
        const terminalStates = ["SUCCESS", "FAILED", "COMPLETED"];
        if (
          terminalStates.includes(transaction.status) &&
          transaction.status === syncData.status
        ) {
          return {
            success: true,
            transaction,
            message: "Transaction already finalized, skipped update",
            skipped: true,
          };
        }

        const updateData: any = {
          externalTransactionId: syncData.externalTransactionId,
          status: syncData.status as TransactionStatus,
          amount: syncData.amount,
          netAmount: syncData.amount,
          currency: syncData.currency,
          providerCode: syncData.providerCode,
          providerResponse:
            syncData.providerResponse || transaction.providerResponse,
          customerName: syncData.customerName || transaction.customerName,
          customerContact:
            syncData.customerContact || transaction.customerContact,
          paymentApp: syncData.paymentApp || transaction.paymentApp,
          utr: syncData.utr || transaction.utr,
          createdAt: syncData.createdAt || transaction.createdAt,
          completedAt:
            syncData.status === "SUCCESS"
              ? syncData.completedAt || transaction.completedAt
              : transaction.completedAt,
          failedAt:
            syncData.status === "FAILED" ? new Date() : transaction.failedAt,
          updatedAt: new Date(),
        };

        if (transaction.merchantId !== trueMerchantId) {
          this.logger.warn(
            `⚠️ Transaction ${transaction.id} merchantId mismatch. Reassigning from ${transaction.merchantId} to ${trueMerchantId}`,
          );
          updateData.merchantId = trueMerchantId;
        }

        transaction = await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: updateData,
        });

        this.logger.log(`✅ Updated existing transaction: ${transaction.id}`);
      }

      if (syncData.status === "SUCCESS" && syncData.orderId) {
        // Complete the order when we have a SUCCESS sync — including when the order
        // was previously marked EXPIRED (link expired before we synced the payment).
        // This fixes "Paid Successfully" on UPI but "Expired" in our list.
        const order = await this.prisma.order.findUnique({
          where: { id: syncData.orderId },
          select: { id: true, status: true, organizationId: true, amount: true, externalOrderId: true },
        });
        if (order && order.status !== "COMPLETED") {
          if (Math.abs(Number(order.amount) - Number(syncData.amount)) > 0.01) {
            this.logger.error(
              `🚨 AMOUNT MISMATCH for ${order.externalOrderId}: Requested ₹${order.amount}, Paid ₹${syncData.amount}. Preventing auto-complete!`
            );
          } else {
            await this.ordersService.updateOrderStatus(order.id, "COMPLETED", syncData.utr);
            this.logger.log(
              `Order ${order.id} (${order.status} → COMPLETED) completed from synced transaction ${syncData.externalTransactionId}`,
            );
            try {
              const subscriptionServiceUrl =
                process.env.SUBSCRIPTION_SERVICE_URL;
              if (subscriptionServiceUrl) {
                await axios.post(
                  `${subscriptionServiceUrl}/real-subscriptions/organizations/${order.organizationId}/update-usage`,
                  {
                    action: "PROCESS_TRANSACTION",
                    data: { amount: Number(order.amount) },
                  },
                  { timeout: 5000,
                      headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
                },
                );
                this.logger.log(
                  `Updated subscription usage for org ${order.organizationId}`,
                );
              }
            } catch (err: any) {
              this.logger.warn(
                `Failed to update subscription usage: ${err?.message || err}`,
              );
            }
          }
        }
      }

      // Phase 3: Persist UTR on order so full transaction response can match our order by UTR (e.g. after deletion / export)
      if (syncData.orderId && syncData.utr) {
        try {
          await this.prisma.order.update({
            where: { id: syncData.orderId },
            data: { utr: syncData.utr },
          });
        } catch (err: any) {
          this.logger.warn(
            `Could not persist Order.utr for ${syncData.orderId}: ${err?.message || err}`,
          );
        }
      }

      return {
        success: true,
        transaction,
        message: "Transaction synced successfully",
      };
    } catch (error) {
      this.logger.error("Error syncing transaction:", error);
      return {
        success: false,
        error: "Failed to sync transaction: " + error.message,
      };
    }
  }

  @Get()
  @ApiOperation({ summary: "Get transactions" })
  @ApiResponse({
    status: 200,
    description: "Transactions retrieved successfully",
  })
  async getTransactions(
    @Headers("x-organization-id") organizationId: string,
    @Query("page") page: string = "1",
    @Query("limit") limit: string = "50",
    @Query("merchantId") merchantId?: string,
    @Query("providerCode") providerCode?: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("status") status?: string,
    @Query("externalTransactionId") externalTransactionId?: string,
  ) {
    try {
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);
      const skip = (pageNum - 1) * limitNum;

      const where: any = {};
      if (organizationId && organizationId !== "platform-org-id") {
        where.order = { organizationId };
      }

      this.logger.log(
        `Debugging getTransactions - Params: merchantId=${merchantId}, providerCode=${providerCode}, status=${status}, externalTransactionId=${externalTransactionId}`,
      );

      if (merchantId) {
        where.merchantId = merchantId;
      }
      if (providerCode) {
        where.providerCode = providerCode;
      }
      if (status) {
        where.status = status;
      }
      if (externalTransactionId) {
        where.externalTransactionId = externalTransactionId;
      }

      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) {
          const range = this.parseISTDayToRange(fromDate);
          where.createdAt.gte = range ? range.start : new Date(fromDate);
        }
        if (toDate) {
          const range = this.parseISTDayToRange(toDate);
          where.createdAt.lte = range ? range.end : new Date(toDate);
        }
      }

      this.logger.log(`Prisma Where Clause: ${JSON.stringify(where)}`);

      const [transactions, total] = await Promise.all([
        this.prisma.transaction.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip,
          take: limitNum,
          include: {
            order: {
              select: { externalOrderId: true, clientReferenceId: true },
            },
          },
        }),
        this.prisma.transaction.count({ where }),
      ]);

      this.logger.log(
        `Found ${transactions.length} transactions. Total: ${total}`,
      );

      return {
        success: true,
        transactions: transactions.map((txn) => ({
          id: txn.id,
          orderId: txn.orderId,
          transactionId: txn.externalTransactionId,
          merchantTransactionId: txn.externalTransactionId,
          merchantId: txn.merchantId,
          amount: Number(txn.amount),
          currency: txn.currency,
          status: txn.status,
          paymentMethod: txn.paymentMethod,
          providerCode: txn.providerCode,
          utr: txn.utr || "N/A",
          createdAt: txn.createdAt,
          externalOrderId:
            (txn as any).order?.externalOrderId || txn.externalTransactionId,
          clientReferenceId: (txn as any).order?.clientReferenceId || null,
          transactionDate: txn.createdAt,
          completedAt: txn.completedAt,

          customerName:
            txn.customerName ||
            (txn.providerResponse as any)?.additionalInfo?.customerName ||
            "N/A",
          customerVpa:
            txn.customerContact ||
            (txn.providerResponse as any)?.additionalInfo?.virtualPaymentAddr ||
            txn.utr ||
            "N/A",
          customerMobile: txn.customerContact || "N/A",
          paymentApp:
            txn.paymentApp ||
            (txn.providerResponse as any)?.additionalInfo?.payerPSP ||
            "UPI",
          settlementStatus: txn.status === "SUCCESS" ? "SETTLED" : "PENDING",
          settlementAmount:
            txn.status === "SUCCESS" ? Number(txn.amount) : null,
          rawResponse: JSON.stringify(txn.providerResponse || {}),
        })),
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      };
    } catch (error) {
      this.logger.error("Error fetching transactions:", error);
      throw new Error("Failed to fetch transactions");
    }
  }
}

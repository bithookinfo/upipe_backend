import {
  Injectable,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { GpayParsedTransaction } from './gpay-rpc-parser.service';
import { PaymentServiceClient } from '../../clients/payment-service.client';
import { MerchantServiceClient } from '../../clients/merchant-service.client';
import { GpaySessionService } from './gpay-session.service';

/**
 * Converts any decimal string or number representation to integer minor units (paise/cents)
 * without using floating point arithmetic.
 */
export function toMinorUnits(amount: string | number): number {
  const str = String(amount).trim();
  const parts = str.split('.');
  const whole = parseInt(parts[0] || '0', 10);
  const fracStr = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  const frac = parseInt(fracStr || '0', 10);
  return whole * 100 + frac;
}

export interface ReconciliationResult {
  success: boolean;
  status?: string;
  reason?: string;
  orderId?: string;
  transactionId?: string;
}

@Injectable()
export class GpayReconciliationService {
  private readonly logger = new Logger(GpayReconciliationService.name);

  constructor(
    private readonly merchantClient: MerchantServiceClient,
    private readonly paymentClient: PaymentServiceClient,
    @Optional()
    @Inject(forwardRef(() => GpaySessionService))
    private readonly sessionService?: GpaySessionService,
  ) {}

  private async checkLeaseBeforeWrite(providerId: string): Promise<void> {
    if (this.sessionService) {
      if (this.sessionService.isLeaseLost(providerId)) {
        throw new Error(
          `Reconciliation write blocked: provider ${providerId} lease was lost`,
        );
      }
      const isOwner = await this.sessionService.verifyLeaseOwner(providerId);
      if (!isOwner) {
        throw new Error(
          `Reconciliation write blocked: current instance no longer owns provider ${providerId} lease`,
        );
      }
    }
  }

  /**
   * Reconciles a single GPay transaction against payment-service orders.
   * Performs exact decimal-string minor unit matching and 2-step idempotent write.
   */
  async reconcileTransaction(
    providerId: string,
    merchantId: string,
    txn: GpayParsedTransaction,
  ): Promise<ReconciliationResult> {
    try {
      // 1. Check if Transaction already exists in payment-service
      const existingTxn = await this.findExistingTransaction(txn.txnId);

      // 2. Query PENDING GPay orders for this merchant
      const pendingOrders = await this.getPendingOrders(merchantId, providerId);
      const matchedOrder = this.matchOrder(pendingOrders, txn);

      if (existingTxn) {
        if (
          existingTxn.status === 'SUCCESS' ||
          (existingTxn as any).order?.status === 'COMPLETED' ||
          (existingTxn as any).order?.status === 'SUCCESS'
        ) {
          return {
            success: true,
            status: 'ALREADY_COMPLETED',
            transactionId: existingTxn.id,
            orderId: (existingTxn as any).orderId,
          };
        }

        // Existing transaction + PENDING order: retry only order completion
        if ((existingTxn as any).orderId) {
          await this.checkLeaseBeforeWrite(providerId);
          await this.completeOrder((existingTxn as any).orderId);
          return {
            success: true,
            status: 'SUCCESS',
            transactionId: existingTxn.id,
            orderId: (existingTxn as any).orderId,
          };
        }

        if (matchedOrder) {
          await this.checkLeaseBeforeWrite(providerId);
          await this.completeOrder((matchedOrder as any).id);
          return {
            success: true,
            status: 'SUCCESS',
            transactionId: existingTxn.id,
            orderId: (matchedOrder as any).id,
          };
        }

        return {
          success: true,
          status: 'TXN_EXISTS_UNMATCHED',
          transactionId: existingTxn.id,
        };
      }

      // No existing transaction: always sync to payment-service
      await this.checkLeaseBeforeWrite(providerId);
      const createdTxnId = await this.syncTransaction(
        providerId,
        merchantId,
        matchedOrder,
        txn,
      );

      // Step B: Complete order if matched
      if (matchedOrder) {
        await this.checkLeaseBeforeWrite(providerId);
        await this.completeOrder((matchedOrder as any).id);
        this.logger.log(
          `[2-Step Write] Reconciled order ${
            (matchedOrder as any).id
          } with GPay txn ${txn.txnId} (amountMinor: ${toMinorUnits(
            txn.amount,
          )})`,
        );
      } else {
        this.logger.log(
          `[2-Step Write] Synced unmatched GPay txn ${txn.txnId} (amountMinor: ${toMinorUnits(
            txn.amount,
          )})`,
        );
      }

      return {
        success: true,
        status: 'SUCCESS',
        orderId: matchedOrder ? (matchedOrder as any).id : undefined,
        transactionId: createdTxnId,
      };
    } catch (error: any) {
      this.logger.error(
        `Reconciliation failed for txn ${txn.txnId} (provider: ${providerId}): ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // Backward compatibility alias for existing spec
  async reconcileTransactions(
    providerOrId: any,
    merchantIdOrTxns: any,
    maybeTxns?: GpayParsedTransaction[],
  ) {
    const providerId = typeof providerOrId === 'string' ? providerOrId : providerOrId?.id || '';
    const merchantId = typeof providerOrId === 'string' ? merchantIdOrTxns : providerOrId?.merchantId || '';
    const transactions: GpayParsedTransaction[] = Array.isArray(merchantIdOrTxns)
      ? merchantIdOrTxns
      : (maybeTxns || []);

    let saved = 0;
    let duplicates = 0;
    let errors = 0;
    const results: any[] = [];
    for (const txn of transactions) {
      const res = await this.reconcileTransaction(providerId, merchantId, txn);
      results.push(res);
      if (res.success && res.status === 'SUCCESS') saved++;
      else if (res.status === 'ALREADY_COMPLETED' || res.status === 'TXN_EXISTS_UNMATCHED') duplicates++;
      else errors++;
    }
    return { saved, duplicates, errors, results };
  }

  private matchOrder(orders: any[], txn: GpayParsedTransaction): any | null {
    const txnAmountMinor = toMinorUnits(txn.amount);

    // Filter orders by exact minor-unit amount
    const amountMatched = orders.filter(
      (o) => toMinorUnits(o.amount) === txnAmountMinor,
    );

    if (amountMatched.length === 0) return null;
    if (amountMatched.length === 1) return amountMatched[0];

    // Note matching: check if note contains order ID or externalOrderId
    const noteString = (txn.note || '').toLowerCase();
    const noteMatched = amountMatched.find(
      (o) =>
        (o.id && noteString.includes(o.id.toLowerCase())) ||
        (o.externalOrderId &&
          noteString.includes(o.externalOrderId.toLowerCase())),
    );

    if (noteMatched) return noteMatched;

    // Time window fallback: pick the earliest order created before txn timestamp
    return amountMatched.reduce((prev, curr) => {
      const prevTime = new Date(prev.createdAt).getTime();
      const currTime = new Date(curr.createdAt).getTime();
      return prevTime <= currTime ? prev : curr;
    });
  }

  private async findExistingTransaction(
    externalTxnId: string,
  ): Promise<any | null> {
    try {
      const txns =
        await this.paymentClient.findTransactionByExternalId(externalTxnId);
      return txns && txns.length > 0 ? txns[0] : null;
    } catch {
      return null;
    }
  }

  private async getPendingOrders(
    merchantId: string,
    providerId: string,
  ): Promise<any[]> {
    try {
      const orders = await this.paymentClient.fetchPendingOrders(merchantId);
      return orders || [];
    } catch (e: any) {
      this.logger.warn(
        `Failed to fetch pending orders for merchant ${merchantId}: ${e.message}`,
      );
      return [];
    }
  }

  private async syncTransaction(
    providerId: string,
    merchantId: string,
    order: any,
    txn: GpayParsedTransaction,
  ): Promise<string> {
    const created = await this.paymentClient.syncTransaction({
      orderId: order ? order.id : undefined,
      merchantId,
      providerId,
      providerCode: 'GPAY',
      connectorId: providerId,
      amount: txn.amount,
      externalTransactionId: txn.txnId,
      utr: txn.utr,
      status: 'SUCCESS',
      paymentMethod: 'UPI',
      customerName: txn.customerName,
      payerVpa: txn.customerVpa,
      metadata: {
        vpa: txn.customerVpa,
        note: txn.note,
        customerName: txn.customerName,
        syncedBy: 'gpay-service',
      },
    } as any);

    return created?.id || (created as any)?.transaction?.id || '';
  }

  private async completeOrder(orderId: string): Promise<void> {
    await this.paymentClient.completeOrder(orderId);
  }
}

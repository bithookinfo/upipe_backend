import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GpayReconciliationService } from '../gpay-reconciliation.service';
import { GpayPaymentEventPayload } from './gpay-payment-event.producer';
import { GpayParsedTransaction } from '../gpay-rpc-parser.service';

@Processor('gpay-payment-events', {
  concurrency: 5,
})
export class GpayReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(GpayReconciliationProcessor.name);

  constructor(private readonly reconciliationService: GpayReconciliationService) {
    super();
  }

  async process(job: Job<GpayPaymentEventPayload>): Promise<any> {
    const { providerId, merchantId, transaction } = job.data;
    this.logger.debug(
      `[Worker] Processing reconciliation job ${job.id} for provider ${providerId} (txn: ${transaction.txnId})`,
    );

    try {
      const parsedTxn: GpayParsedTransaction = {
        txnId: transaction.txnId,
        utr: transaction.utr,
        timestamp: new Date(transaction.timestamp),
        amount: transaction.amount,
        customerName: transaction.customerName,
        customerVpa: transaction.vpa,
        status: transaction.status,
        note: transaction.note,
      };

      const result = await this.reconciliationService.reconcileTransaction(
        providerId,
        merchantId,
        parsedTxn,
      );

      if (result.success) {
        this.logger.log(
          `[Worker] Reconciled job ${job.id} (txn: ${transaction.txnId}) -> status: ${result.status || 'SUCCESS'}`,
        );
      } else {
        this.logger.warn(
          `[Worker] Unmatched txn ${transaction.txnId} for provider ${providerId}: ${result.reason}`,
        );
      }

      return result;
    } catch (error: any) {
      this.logger.error(
        `[Worker] Error reconciling job ${job.id} (txn: ${transaction.txnId}): ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

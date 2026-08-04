import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import {
  GPAY_PAYMENT_EVENTS_QUEUE,
  GPAY_RECONCILIATION_JOB,
} from './gpay-queue.constants';

export interface GpayPaymentEventPayload {
  providerId: string;
  merchantId: string;
  transaction: {
    txnId: string;
    utr: string | null;
    timestamp: string;
    amount: number;
    customerName: string | null;
    vpa: string | null;
    status: 'COMPLETED' | 'PENDING' | 'FAILED';
    note: string | null;
  };
  source: 'RPtkab' | 'yuZqtb' | 'push';
}

@Injectable()
export class GpayPaymentEventProducer {
  private readonly logger = new Logger(GpayPaymentEventProducer.name);

  constructor(
    @InjectQueue(GPAY_PAYMENT_EVENTS_QUEUE)
    private readonly paymentEventsQueue: Queue<GpayPaymentEventPayload>,
  ) {}

  /**
   * Enqueues a GPay transaction event for reconciliation.
   * Generates a SHA-256 job ID to avoid BullMQ colon restrictions while maintaining idempotency.
   */
  async producePaymentEvent(payload: GpayPaymentEventPayload): Promise<string> {
    const rawId = `${payload.providerId}|${payload.transaction.txnId}`;
    const sha256Id = `gpay-${crypto
      .createHash('sha256')
      .update(rawId)
      .digest('hex')}`;

    const job = await this.paymentEventsQueue.add(
      GPAY_RECONCILIATION_JOB,
      payload,
      {
        jobId: sha256Id,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    this.logger.debug(
      `Enqueued GPay payment event job ${job.id} for txn ${payload.transaction.txnId} (provider: ${payload.providerId})`,
    );

    return job.id || sha256Id;
  }
}

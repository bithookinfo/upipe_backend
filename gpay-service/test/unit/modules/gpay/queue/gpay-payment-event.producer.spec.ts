import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { GpayPaymentEventProducer } from '../../../../../src/modules/gpay/queue/gpay-payment-event.producer';
import {
  GPAY_PAYMENT_EVENTS_QUEUE,
  GPAY_RECONCILIATION_JOB,
} from '../../../../../src/modules/gpay/queue/gpay-queue.constants';

describe('GpayPaymentEventProducer', () => {
  let producer: GpayPaymentEventProducer;
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_123' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GpayPaymentEventProducer,
        {
          provide: getQueueToken(GPAY_PAYMENT_EVENTS_QUEUE),
          useValue: mockQueue,
        },
      ],
    }).compile();

    producer = module.get<GpayPaymentEventProducer>(GpayPaymentEventProducer);
  });

  it('should be defined', () => {
    expect(producer).toBeDefined();
  });

  it('should enqueue a payment event with a deterministic job ID', async () => {
    const payload = {
      providerId: 'prov_1',
      merchantId: 'merch_1',
      transaction: {
        txnId: 'txn_001',
        utr: null,
        amount: 100,
        status: 'COMPLETED' as const,
        timestamp: new Date().toISOString(),
        customerName: null,
        vpa: null,
        note: null,
      },
      source: 'RPtkab' as const,
    };

    await producer.producePaymentEvent(payload);

    expect(mockQueue.add).toHaveBeenCalledWith(
      GPAY_RECONCILIATION_JOB,
      payload,
      expect.objectContaining({
        jobId: expect.stringMatching(/^gpay-[a-f0-9]{64}$/),
        attempts: 3,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      }),
    );
  });
});

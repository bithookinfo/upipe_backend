import { Test, TestingModule } from '@nestjs/testing';
import { GpayReconciliationProcessor } from '../../../../../src/modules/gpay/queue/gpay-reconciliation.processor';
import { GpayReconciliationService } from '../../../../../src/modules/gpay/gpay-reconciliation.service';
import { Job } from 'bullmq';

describe('GpayReconciliationProcessor', () => {
  let processor: GpayReconciliationProcessor;
  let mockReconciliationService: { reconcileTransaction: jest.Mock };

  beforeEach(async () => {
    mockReconciliationService = {
      reconcileTransaction: jest
        .fn()
        .mockResolvedValue({ success: true, status: 'SUCCESS' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GpayReconciliationProcessor,
        {
          provide: GpayReconciliationService,
          useValue: mockReconciliationService,
        },
      ],
    }).compile();

    processor = module.get<GpayReconciliationProcessor>(
      GpayReconciliationProcessor,
    );
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  it('should process a job successfully', async () => {
    const job = {
      id: 'job_1',
      data: {
        providerId: 'prov_1',
        merchantId: 'merch_1',
        transaction: {
          txnId: 'txn_001',
          amount: 100,
          status: 'COMPLETED',
          timestamp: new Date().toISOString(),
        },
        source: 'RPtkab',
      },
    } as unknown as Job;

    const result = await processor.process(job);

    const expectedTxn = {
      txnId: 'txn_001',
      utr: undefined,
      timestamp: new Date(job.data.transaction.timestamp),
      amount: 100,
      customerName: undefined,
      customerVpa: undefined,
      status: 'COMPLETED',
      note: undefined,
    };

    expect(mockReconciliationService.reconcileTransaction).toHaveBeenCalledWith(
      'prov_1',
      'merch_1',
      expectedTxn,
    );
    expect(result).toEqual({ success: true, status: 'SUCCESS' });
  });

  it('should throw an error if reconciliation fails', async () => {
    mockReconciliationService.reconcileTransaction.mockRejectedValue(
      new Error('Test error'),
    );

    const job = {
      id: 'job_1',
      data: {
        providerId: 'prov_1',
        merchantId: 'merch_1',
        transaction: {
          txnId: 'txn_001',
          amount: 100,
        },
      },
    } as unknown as Job;

    await expect(processor.process(job)).rejects.toThrow('Test error');
  });
});

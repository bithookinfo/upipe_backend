import { Test, TestingModule } from '@nestjs/testing';
import { GpayReconciliationService } from '../../../src/modules/gpay/gpay-reconciliation.service';
import { MerchantServiceClient } from '../../../src/clients/merchant-service.client';
import { PaymentServiceClient } from '../../../src/clients/payment-service.client';
import { GpaySessionService } from '../../../src/modules/gpay/gpay-session.service';
import { ConfigModule } from '@nestjs/config';
import { Logger } from '@nestjs/common';

describe('Partial-Write Recovery Integration', () => {
  let reconciliationService: GpayReconciliationService;
  let paymentClientMock: jest.Mocked<PaymentServiceClient>;
  let merchantClientMock: jest.Mocked<MerchantServiceClient>;
  let sessionServiceMock: jest.Mocked<GpaySessionService>;

  beforeAll(async () => {
    paymentClientMock = {
      findTransactionByExternalId: jest.fn(),
      completeOrder: jest.fn(),
      syncTransaction: jest.fn(),
      fetchPendingOrders: jest.fn(),
    } as any;

    merchantClientMock = {} as any;
    sessionServiceMock = {
      isLeaseLost: jest.fn().mockReturnValue(false),
      verifyLeaseOwner: jest.fn().mockResolvedValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GpayReconciliationService,
        { provide: PaymentServiceClient, useValue: paymentClientMock },
        { provide: MerchantServiceClient, useValue: merchantClientMock },
        { provide: GpaySessionService, useValue: sessionServiceMock },
      ],
    }).compile();

    reconciliationService = module.get<GpayReconciliationService>(
      GpayReconciliationService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should trigger order completion if transaction exists but order is PENDING (Partial-Write scenario)', async () => {
    // 1. Transaction already synced in DB
    paymentClientMock.findTransactionByExternalId.mockResolvedValue([
      {
        id: 'db_txn_123',
        orderId: 'db_order_123',
        externalTransactionId: 'gpay_txn_789',
        amount: 500,
        status: 'PENDING',
        providerCode: 'GPAY',
        order: { status: 'PENDING' },
      } as any,
    ]);

    // 2. We mock completeOrder to succeed
    paymentClientMock.completeOrder.mockResolvedValue({ success: true });

    // The GPay payload we received from BullMQ
    const incomingTxn = {
      txnId: 'gpay_txn_789',
      amount: 500,
      timestamp: new Date(),
      status: 'COMPLETED' as const,
      utr: null,
      customerName: null,
      customerVpa: null,
      note: null,
    };

    const result = await reconciliationService.reconcileTransaction(
      'prov_1',
      'merch_1',
      incomingTxn,
    );

    // Should recognize it as SUCCESS since we successfully completed the order now
    expect(result.status).toBe('SUCCESS');
    expect(result.success).toBe(true);

    // Verify it called completeOrder
    expect(paymentClientMock.completeOrder).toHaveBeenCalledWith(
      'db_order_123',
    );

    // And did NOT try to sync transaction again
    expect(paymentClientMock.syncTransaction).not.toHaveBeenCalled();
  });
});

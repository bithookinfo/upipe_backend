import { GpayReconciliationService } from '../../../../src/modules/gpay/gpay-reconciliation.service';
import { PaymentServiceClient } from '../../../../src/clients/payment-service.client';
import { MerchantServiceClient } from '../../../../src/clients/merchant-service.client';

describe('GpayReconciliationService', () => {
  let service: GpayReconciliationService;
  let paymentClient: jest.Mocked<PaymentServiceClient>;
  let merchantClient: jest.Mocked<MerchantServiceClient>;

  const sampleProvider = {
    id: 'prov_1',
    merchantId: 'merch_1',
    organizationId: 'org_1',
    provider: 'GPAY',
    isActive: true,
    metadata: { gpayRuntime: 'NEW' },
  };

  beforeEach(() => {
    paymentClient = {
      syncTransaction: jest.fn(),
      completeOrder: jest.fn(),
      fetchPendingOrders: jest.fn(),
      findTransactionByExternalId: jest.fn(),
    } as unknown as jest.Mocked<PaymentServiceClient>;

    merchantClient = {
      getActiveProviders: jest.fn(),
      updateStatus: jest.fn(),
    } as unknown as jest.Mocked<MerchantServiceClient>;

    service = new GpayReconciliationService(merchantClient, paymentClient);
    jest.clearAllMocks();
  });

  describe('reconcileTransactions', () => {
    it('should match and sync transaction when new transaction is found', async () => {
      const gpayTxn = {
        txnId: 'txn_001',
        amount: 100,
        timestamp: new Date(),
        status: 'COMPLETED' as const,
        utr: 'UTR100',
        customerName: 'Test User',
        customerVpa: 'user@okhdfcbank',
        note: null,
      };

      paymentClient.findTransactionByExternalId.mockResolvedValue([]);
      paymentClient.syncTransaction.mockResolvedValue({
        id: '1',
        orderId: 'order_123',
        externalTransactionId: 'txn_001',
        amount: 100,
        status: 'SUCCESS',
        providerCode: 'GPAY',
      });

      const res = await service.reconcileTransactions(sampleProvider, [
        gpayTxn,
      ]);

      expect(res.saved).toBe(1);
      expect(paymentClient.syncTransaction).toHaveBeenCalledTimes(1);
      expect(paymentClient.syncTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantId: 'merch_1',
          providerId: 'prov_1',
          externalTransactionId: 'txn_001',
          utr: 'UTR100',
          amount: 100,
          status: 'SUCCESS',
          customerName: 'Test User',
          payerVpa: 'user@okhdfcbank',
        }),
      );
    });

    it('should not sync duplicate transactions already marked SUCCESS', async () => {
      const gpayTxn = {
        txnId: 'txn_seen_before',
        amount: 200,
        timestamp: new Date(),
        status: 'COMPLETED' as const,
        utr: 'UTR200',
        customerName: null,
        customerVpa: null,
        note: null,
      };

      paymentClient.findTransactionByExternalId.mockResolvedValue([
        {
          id: '1',
          orderId: 'order_1',
          externalTransactionId: 'txn_seen_before',
          amount: 200,
          status: 'SUCCESS',
          providerCode: 'GPAY',
          order: { status: 'COMPLETED' },
        } as any,
      ]);

      const res = await service.reconcileTransactions(sampleProvider, [
        gpayTxn,
      ]);
      expect(res.saved).toBe(0);
      expect(paymentClient.syncTransaction).not.toHaveBeenCalled();
    });

    it('should block reconciliation write when provider lease is lost or not owned', async () => {
      const mockSessionService = {
        isLeaseLost: jest.fn().mockReturnValue(true),
        verifyLeaseOwner: jest.fn().mockResolvedValue(false),
      };
      const serviceWithSession = new GpayReconciliationService(
        merchantClient,
        paymentClient,
        mockSessionService as any,
      );

      const gpayTxn = {
        txnId: 'txn_lease_lost',
        amount: 100,
        timestamp: new Date(),
        status: 'COMPLETED' as const,
        utr: 'UTR100',
        customerName: 'Test User',
        customerVpa: 'user@okhdfcbank',
        note: null,
      };

      paymentClient.findTransactionByExternalId.mockResolvedValue([]);

      await expect(
        serviceWithSession.reconcileTransaction('prov_1', 'merch_1', gpayTxn),
      ).rejects.toThrow(
        /Reconciliation write blocked: provider prov_1 lease was lost/,
      );
    });

    it('should return status SUCCESS when retrying order completion for existing transaction', async () => {
      const gpayTxn = {
        txnId: 'txn_retry',
        amount: 100,
        timestamp: new Date(),
        status: 'COMPLETED' as const,
        utr: 'UTR100',
        customerName: 'Test User',
        customerVpa: 'user@okhdfcbank',
        note: null,
      };

      paymentClient.findTransactionByExternalId.mockResolvedValue([
        {
          id: '1',
          orderId: 'order_retry',
          externalTransactionId: 'txn_retry',
          amount: 100,
          status: 'PENDING',
          providerCode: 'GPAY',
        },
      ]);
      paymentClient.completeOrder = jest.fn().mockResolvedValue({});

      const res = await service.reconcileTransaction(
        'prov_1',
        'merch_1',
        gpayTxn,
      );
      expect(res.status).toBe('SUCCESS');
      expect(paymentClient.completeOrder).toHaveBeenCalledWith('order_retry');
    });
  });
});

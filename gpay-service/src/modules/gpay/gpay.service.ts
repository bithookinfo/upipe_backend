import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  MerchantServiceClient,
  GpayProviderData,
} from '../../clients/merchant-service.client';
import { PaymentServiceClient } from '../../clients/payment-service.client';
import { PlaywrightSessionManager } from './playwright-session-manager.service';
import { GpayReconciliationService } from './gpay-reconciliation.service';
import {
  GpayRpcParserService,
  GpayParsedTransaction,
} from './gpay-rpc-parser.service';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';

@Injectable()
export class GpayService {
  private readonly logger = new Logger(GpayService.name);
  private readonly loginSessions = new Map<string, any>();

  public getLoginSessions() {
    return this.loginSessions;
  }

  constructor(
    private readonly merchantClient: MerchantServiceClient,
    private readonly paymentClient: PaymentServiceClient,
    private readonly sessionManager: PlaywrightSessionManager,
    private readonly reconciliationService: GpayReconciliationService,
    private readonly rpcParser: GpayRpcParserService,
    private readonly encryptionService: GpayEncryptionService,
  ) {}

  /**
   * Connect GPay: initiate login / challenge flow for a merchant
   */
  async connectGPay(
    merchantId: string,
    data: {
      email: string;
      password?: string;
      organizationId?: string;
      sessionId?: string;
      businessId?: string;
      upiId?: string;
      recoveryPhoneNumber?: string;
      googleVerificationCode?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    this.logger.log(`🔗 [GPay Service] Connect Request for: ${data.email}`);

    if (!data.organizationId) {
      throw new BadRequestException('Organization ID is required');
    }

    const existingProvider =
      await this.merchantClient.getProviderByMerchant(merchantId);

    if (
      existingProvider &&
      (existingProvider.metadata as any)?.gpayRuntime === 'LEGACY'
    ) {
      throw new BadRequestException(
        'This GPay provider is managed by the LEGACY runtime in merchant-service.',
      );
    }

    // Check if session is already active in memory
    if (
      existingProvider &&
      this.sessionManager.getActiveSession(existingProvider.id)
    ) {
      this.logger.log(
        `✅ Reusing active in-memory GPay session for ${data.email}`,
      );
      return {
        success: true,
        message: 'Google Pay connected (session reused)',
        status: 'CONNECTED',
        providerId: existingProvider.id,
      };
    }

    let storageStateJson: Record<string, any> | undefined;
    if (
      existingProvider &&
      (existingProvider.credentials as any)?.sessionStateEncrypted
    ) {
      try {
        storageStateJson = this.encryptionService.decryptSessionState(
          (existingProvider.credentials as any).sessionStateEncrypted,
        );
      } catch (e: any) {
        this.logger.warn(
          `Failed to decrypt sessionState for ${existingProvider.id}: ${e.message}`,
        );
      }
    } else if (
      existingProvider &&
      (existingProvider.credentials as any)?.sessionState
    ) {
      storageStateJson = (existingProvider.credentials as any).sessionState;
    }

    const mockProviderData: GpayProviderData = existingProvider || {
      id: `temp_gpay_${Date.now()}`,
      merchantId,
      provider: 'GPAY',
      status: 'PENDING',
      credentials: { email: data.email, businessId: data.businessId },
      metadata: {
        gpayRuntime: 'NEW',
        browserSessionType: 'IN_MEMORY_PERSISTENT',
      },
    };

    const session = await this.sessionManager.launchSession(
      mockProviderData,
      storageStateJson,
    );

    // Navigate to GPay for business
    try {
      await session.page.goto('https://pay.google.com/g4b', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
    } catch (e: any) {
      this.logger.warn(`Navigation to GPay for business failed: ${e.message}`);
    }

    // Return challenge/status
    const sessionId = data.sessionId || `gpay_login_${Date.now()}`;
    this.loginSessions.set(sessionId, {
      merchantId,
      email: data.email,
      providerId: mockProviderData.id,
      createdAt: Date.now(),
    });

    return {
      success: true,
      message: 'Google Pay connection initiated in gpay-service',
      sessionId,
      status: 'AWAITING_VERIFICATION',
    };
  }

  /**
   * Finalize GPay connection after login / OTP verification
   */
  async finalizeGPayConnection(
    merchantId: string,
    data: {
      email: string;
      businessId: string;
      businessName?: string;
      organizationId: string;
      upiId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    this.logger.log(
      `🎯 [GPay Service] Finalizing GPay connection for ${data.email} (${merchantId})`,
    );

    const provider = await this.merchantClient.finalizeConnection({
      merchantId,
      email: data.email,
      businessId: data.businessId,
      businessName: data.businessName,
      organizationId: data.organizationId,
      upiId: data.upiId,
      isSuperAdmin: data.isSuperAdmin,
      gpayRuntime: 'LEGACY', // We must pass LEGACY to prevent merchant-service from forwarding it back to gpay-service
    });

    // Update session state in DB
    await this.sessionManager.snapshotSessionState(provider.id);

    return {
      success: true,
      message: 'Google Pay connected successfully via gpay-service',
      providerId: provider.id,
      businessId: data.businessId,
    };
  }

  /**
   * Update GPay UPI ID
   */
  async updateGpayUpi(providerId: string, upiId: string, merchantId?: string) {
    this.logger.log(
      `📝 Updating GPay UPI via gpay-service for provider: ${providerId}, upiId: ${upiId}`,
    );
    return this.merchantClient.updateUpi(providerId, upiId);
  }

  /**
   * Sync transactions for a merchant within a date range
   */
  async syncTransactions(
    merchantId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<{
    success: boolean;
    fetched: number;
    saved: number;
    message: string;
  }> {
    const provider =
      await this.merchantClient.getProviderByMerchant(merchantId);
    if (!provider) {
      throw new NotFoundException(
        `No Google Pay provider found for merchant ${merchantId}`,
      );
    }

    if ((provider.metadata as any)?.gpayRuntime === 'LEGACY') {
      throw new BadRequestException(
        'This GPay provider is managed by the LEGACY runtime in merchant-service.',
      );
    }

    const session = this.sessionManager.getActiveSession(provider.id);
    if (!session) {
      throw new BadRequestException(
        `No active in-memory browser session for provider ${provider.id}. Please connect Google Pay first.`,
      );
    }

    // Auto-heal url if needed
    await this.sessionManager.autoHealInvalidTransactionsUrl(
      provider.id,
      session,
      (provider.credentials as any)?.businessId,
    );

    // Refresh page to trigger batchexecute load
    try {
      await session.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await new Promise((resolve) => setTimeout(resolve, 3000)); // wait for RPC responses
    } catch (e: any) {
      this.logger.warn(`Reload failed during syncTransactions: ${e.message}`);
    }

    return {
      success: true,
      fetched: 0, // Handled asynchronously by real-time listener
      saved: 0,
      message: 'Sync triggered in gpay-service browser session',
    };
  }

  /**
   * Non-blocking order activation from payment-service
   */
  async handleOrderActivation(
    orderId: string,
    data: {
      amount?: number;
      utr?: string;
      vpa?: string;
    },
  ): Promise<{ success: boolean; activated: boolean; message: string }> {
    this.logger.log(`⚡ Checking instant activation for order ${orderId}...`);

    if (!data.amount && !data.utr && !data.vpa) {
      return {
        success: true,
        activated: false,
        message: 'No amount/utr/vpa provided for activation check',
      };
    }

    // Look up transaction by UTR or order in payment-service
    try {
      if (data.utr) {
        const existingTxns =
          await this.paymentClient.findTransactionByExternalId(data.utr);
        if (existingTxns && existingTxns.length > 0) {
          const matched = existingTxns.find(
            (t) =>
              t.status === 'SUCCESS' ||
              t.status === 'COMPLETED' ||
              Number(t.amount) === Number(data.amount),
          );
          if (matched) {
            await this.paymentClient.completeOrder(orderId);
            this.logger.log(`🎉 Order ${orderId} activated via instant match!`);
            return {
              success: true,
              activated: true,
              message: 'Order activated instantly',
            };
          }
        }
      }
    } catch (e: any) {
      this.logger.warn(`Error during order activation lookup: ${e.message}`);
    }

    return {
      success: true,
      activated: false,
      message: 'No matching completed transaction found in real-time window',
    };
  }
}

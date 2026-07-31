import { GpayRecoveryCron } from './gpay-recovery.cron';
import { ConfigService } from '@nestjs/config';
import { MerchantServiceClient } from '../../clients/merchant-service.client';
import { PlaywrightSessionManager } from './playwright-session-manager.service';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';

describe('GpayRecoveryCron', () => {
  let cron: GpayRecoveryCron;
  let configService: jest.Mocked<ConfigService>;
  let merchantClient: jest.Mocked<MerchantServiceClient>;
  let sessionManager: jest.Mocked<PlaywrightSessionManager>;
  let encryptionService: jest.Mocked<GpayEncryptionService>;

  const sampleProvider = {
    id: 'prov_1',
    merchantId: 'merch_1',
    organizationId: 'org_1',
    provider: 'GPAY',
    isActive: true,
    metadata: { gpayRuntime: 'NEW' },
    credentials: { businessId: 'biz_123' },
    sessionState: 'encrypted_session_state',
  };

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue('true'),
    } as unknown as jest.Mocked<ConfigService>;

    merchantClient = {
      getActiveProviders: jest.fn().mockResolvedValue([sampleProvider]),
    } as unknown as jest.Mocked<MerchantServiceClient>;

    sessionManager = {
      getActiveSession: jest.fn(),
      closeSession: jest.fn().mockResolvedValue(undefined),
      launchSession: jest.fn(),
      autoHealInvalidTransactionsUrl: jest.fn(),
    } as unknown as jest.Mocked<PlaywrightSessionManager>;

    encryptionService = {
      decryptSessionState: jest.fn().mockReturnValue({ cookies: [] }),
    } as unknown as jest.Mocked<GpayEncryptionService>;

    cron = new GpayRecoveryCron(
      configService,
      merchantClient,
      sessionManager,
      encryptionService,
    );
    jest.clearAllMocks();
  });

  it('should skip recovery when NEW_GPAY_WORKERS_ENABLED is false', async () => {
    configService.get.mockReturnValue('false');
    await cron.recoverSessions();
    expect(merchantClient.getActiveProviders).not.toHaveBeenCalled();
  });

  it('should not recover if active session exists and page is not closed', async () => {
    sessionManager.getActiveSession.mockReturnValue({
      providerId: 'prov_1',
      page: { isClosed: () => false } as any,
    } as any);

    await cron.recoverSessions();
    expect(sessionManager.launchSession).not.toHaveBeenCalled();
  });

  it('should recover session when page is missing or closed', async () => {
    sessionManager.getActiveSession.mockReturnValue(undefined);

    const mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
    };
    sessionManager.launchSession.mockResolvedValue({
      page: mockPage,
    } as any);

    await cron.recoverSessions();

    expect(sessionManager.closeSession).toHaveBeenCalledWith('prov_1');
    expect(encryptionService.decryptSessionState).toHaveBeenCalledWith(
      'encrypted_session_state',
    );
    expect(sessionManager.launchSession).toHaveBeenCalledWith(
      sampleProvider,
      { cookies: [] },
    );
    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://pay.google.com/g4b/transactions/biz_123',
      expect.any(Object),
    );
  });
});

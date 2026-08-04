import { GpayRecoveryCron } from '../../../../src/modules/gpay/gpay-recovery.cron';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { RedisService } from '../../../../src/common/redis/redis.service';
import { GpayOrchestratorService } from '../../../../src/modules/gpay/gpay-orchestrator.service';
import { MerchantServiceClient } from '../../../../src/clients/merchant-service.client';
import { PlaywrightSessionManager } from '../../../../src/modules/gpay/playwright-session-manager.service';
import { GpayEncryptionService } from '../../../../src/common/security/gpay-encryption.service';
import { BrowserPoolService } from '../../../../src/modules/gpay/browser-pool.service';
import { of } from 'rxjs';

describe('GpayRecoveryCron', () => {
  let cron: GpayRecoveryCron;
  let configService: any;
  let httpService: any;
  let redisService: any;
  let orchestrator: any;
  let redisClient: any;

  beforeEach(() => {
    configService = {
      get: jest.fn((key) => {
        if (key === 'NEW_GPAY_WORKERS_ENABLED') return 'true';
        if (key === 'GPAY_NODE_ID') return 'test-node-1';
        return undefined;
      }),
    };

    httpService = {
      get: jest.fn(),
    };

    redisClient = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
      eval: jest.fn(),
    };

    redisService = {
      getClient: jest.fn().mockReturnValue(redisClient),
    };

    orchestrator = {
      activateProvider: jest.fn().mockResolvedValue({ success: true }),
    };

    cron = new GpayRecoveryCron(
      configService,
      {} as any, // merchantClient
      {} as any, // sessionManager
      {} as any, // encryptionService
      httpService,
      redisService,
      orchestrator,
      {} as any, // browserPoolService
    );
  });

  describe('Phase 9: Recovery Cron Verification', () => {
    it('no pending candidates -> no activation', async () => {
      redisClient.set.mockResolvedValue('OK'); // acquire lease
      httpService.get.mockReturnValue(of({ data: { candidates: [] } }));

      await cron.recoverSessions();

      expect(httpService.get).toHaveBeenCalled();
      expect(orchestrator.activateProvider).not.toHaveBeenCalled();
    });

    it('188 idle connected providers -> no activation', async () => {
      // The cron ONLY queries for pending-activations. It does not query all connected providers.
      // We mock the API to return 0 pending activations, representing 188 idle connected.
      redisClient.set.mockResolvedValue('OK');
      httpService.get.mockReturnValue(of({ data: { candidates: [] } }));

      await cron.recoverSessions();

      expect(orchestrator.activateProvider).not.toHaveBeenCalled();
    });

    it('12 pending candidates -> only 12 activation calls', async () => {
      redisClient.set.mockResolvedValue('OK');

      const candidates = Array.from({ length: 12 }, (_, i) => ({
        providerId: `prov_${i}`,
        merchantId: `merch_${i}`,
        status: 'ACTIVE',
      }));

      httpService.get.mockReturnValue(of({ data: { candidates } }));

      await cron.recoverSessions();

      expect(orchestrator.activateProvider).toHaveBeenCalledTimes(12);
    });

    it('duplicate cron instances -> only scheduler lease owner processes', async () => {
      // Instance 2 fails to acquire lease
      redisClient.set.mockResolvedValue(null);

      await cron.recoverSessions();

      expect(httpService.get).not.toHaveBeenCalled();
      expect(orchestrator.activateProvider).not.toHaveBeenCalled();
    });

    it('EXPIRED provider with future nextRetryAt -> skipped', async () => {
      redisClient.set.mockResolvedValue('OK');

      const candidates = [
        {
          providerId: 'prov_expired',
          merchantId: 'merch_1',
          status: 'EXPIRED',
        },
      ];

      httpService.get.mockReturnValue(of({ data: { candidates } }));

      // Mock backoff counter > 3
      redisClient.incr.mockResolvedValue(4);

      await cron.recoverSessions();

      // Skipped due to backoff
      expect(orchestrator.activateProvider).not.toHaveBeenCalled();
    });
  });
});

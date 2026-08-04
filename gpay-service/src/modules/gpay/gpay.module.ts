import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import {
  GpayGatewayController,
  GpayController,
  InternalGpayController,
} from './gpay.controller';
import { GpayService } from './gpay.service';
import { PlaywrightSessionManager } from './playwright-session-manager.service';
import { GpayReconciliationService } from './gpay-reconciliation.service';
import { GpayRpcParserService } from './gpay-rpc-parser.service';
import { GpayRecoveryCron } from './gpay-recovery.cron';
import { GpayEncryptionService } from '../../common/security/gpay-encryption.service';
import { MerchantServiceClient } from '../../clients/merchant-service.client';
import { PaymentServiceClient } from '../../clients/payment-service.client';
import { BrowserPoolService } from './browser-pool.service';
import { GpayAuthService } from './gpay-auth.service';
import { GpaySessionService } from './gpay-session.service';
import { GpayRpcListenerService } from './gpay-rpc-listener.service';
import { GpayOrchestratorService } from './gpay-orchestrator.service';
import { GpayOnboardingService } from './gpay-onboarding.service';
import { GpayQueueModule } from './queue/gpay-queue.module';
import { GpayReconciliationProcessor } from './queue/gpay-reconciliation.processor';
import { RedisModule } from '../../common/redis/redis.module';

@Module({
  imports: [HttpModule, RedisModule, GpayQueueModule],
  controllers: [GpayGatewayController, GpayController, InternalGpayController],
  providers: [
    GpayService,
    PlaywrightSessionManager,
    GpayReconciliationService,
    GpayRpcParserService,
    GpayRecoveryCron,
    GpayEncryptionService,
    MerchantServiceClient,
    PaymentServiceClient,
    BrowserPoolService,
    GpayAuthService,
    GpaySessionService,
    GpayRpcListenerService,
    GpayOrchestratorService,
    GpayOnboardingService,
    GpayReconciliationProcessor,
  ],
  exports: [GpayService, GpayOrchestratorService],
})
export class GpayModule {}

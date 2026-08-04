import {
  Controller,
  Post,
  Patch,
  Get,
  Param,
  Body,
  Req,
  BadRequestException,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { GpayService } from './gpay.service';
import { GpayOrchestratorService } from './gpay-orchestrator.service';
import { BrowserPoolService } from './browser-pool.service';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GPAY_PAYMENT_EVENTS_QUEUE } from './queue/gpay-queue.constants';

import { GpayOnboardingService } from './gpay-onboarding.service';

@Controller('gateway')
export class GpayGatewayController {
  private readonly logger = new Logger(GpayGatewayController.name);

  constructor(
    private readonly gpayService: GpayService,
    private readonly gpayOnboardingService: GpayOnboardingService,
  ) {}

  @Post(':providerId/connect-gpay')
  async connectGPay(
    @Param('providerId') providerId: string,
    @Body()
    body: {
      username?: string;
      email?: string;
      password?: string;
      displayName?: string;
      organizationId?: string;
      merchantId?: string;
      sessionId?: string;
      businessId?: string;
      upiId?: string;
      recoveryPhoneNumber?: string;
      googleVerificationCode?: string;
      isSuperAdmin?: boolean;
    },
    @Req() req: any,
  ) {
    if (providerId.toLowerCase() !== 'gpay') {
      throw new BadRequestException(
        'connect-gpay is only supported for GPay provider',
      );
    }

    const email = body.username || body.email;
    if (!email) {
      throw new BadRequestException('username or email is required');
    }
    if (!body.organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    const userType = req.headers?.['x-user-type'] as string | undefined;
    const isSuperAdmin =
      body.isSuperAdmin === true ||
      (userType &&
        (userType.toUpperCase() === 'SUPER_ADMIN' ||
          userType.toUpperCase() === 'SUPERADMIN'));

    const merchantId = body.merchantId || `temp-${Date.now()}`;

    return this.gpayOnboardingService.connectGPay(merchantId, {
      email,
      password: body.password,
      organizationId: body.organizationId,
      sessionId: body.sessionId,
      businessId: body.businessId,
      upiId: body.upiId,
      recoveryPhoneNumber: body.recoveryPhoneNumber,
      googleVerificationCode: body.googleVerificationCode,
      isSuperAdmin: Boolean(isSuperAdmin),
    });
  }

  @Post(':providerId/finalize-connection')
  async finalizeConnection(
    @Param('providerId') providerId: string,
    @Body()
    body: {
      merchantId: string;
      email: string;
      businessId: string;
      businessName?: string;
      organizationId: string;
      upiId?: string;
      isSuperAdmin?: boolean;
    },
  ) {
    return this.gpayService.finalizeGPayConnection(body.merchantId, body);
  }

  @Post(':providerId/update-gpay-upi')
  async updateUpi(
    @Param('providerId') providerId: string,
    @Body() body: { upiId: string; merchantId?: string },
  ) {
    return this.gpayService.updateGpayUpi(
      providerId,
      body.upiId,
      body.merchantId,
    );
  }
}

@Controller('gpay')
export class GpayController {
  private readonly logger = new Logger(GpayController.name);

  constructor(private readonly gpayService: GpayService) {}

  @Post('sync')
  async syncTransactions(
    @Body()
    body: {
      merchantId: string;
      fromDate?: string;
      toDate?: string;
    },
  ) {
    const from = body.fromDate
      ? new Date(body.fromDate)
      : new Date(Date.now() - 86400000);
    const to = body.toDate ? new Date(body.toDate) : new Date();
    return this.gpayService.syncTransactions(body.merchantId, from, to);
  }

  @Post('orders/:orderId/activate')
  async activateOrder(
    @Param('orderId') orderId: string,
    @Body()
    body: {
      amount?: number;
      utr?: string;
      vpa?: string;
    },
  ) {
    return this.gpayService.handleOrderActivation(orderId, body);
  }

  @Get('metrics')
  @UseGuards(InternalAuthGuard)
  async getMetrics() {
    return {
      status: 'ok',
      service: 'gpay-service',
      runtime: 'NEW',
    };
  }
}

@Controller('internal/gpay')
@UseGuards(InternalAuthGuard)
export class InternalGpayController {
  private readonly logger = new Logger(InternalGpayController.name);

  constructor(
    private readonly orchestrator: GpayOrchestratorService,
    private readonly browserPoolService: BrowserPoolService,
    @InjectQueue(GPAY_PAYMENT_EVENTS_QUEUE)
    private readonly paymentEventsQueue: Queue,
  ) {}

  @Get('queue-metrics')
  async getQueueMetrics() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.paymentEventsQueue.getWaitingCount(),
      this.paymentEventsQueue.getActiveCount(),
      this.paymentEventsQueue.getCompletedCount(),
      this.paymentEventsQueue.getFailedCount(),
      this.paymentEventsQueue.getDelayedCount(),
    ]);
    return {
      queue: GPAY_PAYMENT_EVENTS_QUEUE,
      waiting,
      active,
      completed,
      failed,
      delayed,
    };
  }

  @Get('metrics')
  getOperationalMetrics() {
    const browsers: any[] =
      (this.browserPoolService as any).sharedBrowsers || [];
    const contexts: Map<string, any> =
      (this.browserPoolService as any).activeContexts || new Map();
    const memory = process.memoryUsage();

    let activeSharedContexts = 0;
    let activePersistentContexts = 0;

    contexts.forEach((ctx: any) => {
      if (ctx.isPersistent) {
        activePersistentContexts++;
      } else {
        activeSharedContexts++;
      }
    });

    const maxSharedBrowsers =
      Number((this.browserPoolService as any).maxBrowsersPerInstance) || 3;
    const maxContextsPerBrowser =
      Number((this.browserPoolService as any).maxContextsPerBrowser) || 5;
    const maxPersistentProfiles =
      Number(
        (this.browserPoolService as any).maxPersistentProfilesPerInstance,
      ) || 3;

    return {
      activeSharedBrowsers: browsers.length,
      activeSharedContexts,
      activePages: contexts.size,
      activePersistentContexts,
      activeProviderSessions: contexts.size,
      browserRecycleCount:
        (this.browserPoolService as any).browserRecycleCount || 0,
      capacityRejectionCount:
        (this.browserPoolService as any).capacityRejectionCount || 0,
      capacity: {
        maxSharedBrowsers,
        maxContextsPerBrowser,
        maxPersistentProfiles,
      },
      memory: {
        rssMB: Math.round(memory.rss / 1024 / 1024),
        heapTotalMB: Math.round(memory.heapTotal / 1024 / 1024),
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
      },
    };
  }

  @Post('providers/:providerId/activate')
  async activateProvider(
    @Param('providerId') providerId: string,
    @Body() body: { merchantId: string; force?: boolean },
  ) {
    this.logger.log(
      `Internal activate request for provider ${providerId} (merchant: ${body?.merchantId})`,
    );
    return this.orchestrator.activateProvider(
      providerId,
      body?.merchantId || '',
      { force: Boolean(body?.force) },
    );
  }

  @Post('providers/:providerId/deactivate')
  async deactivateProvider(
    @Param('providerId') providerId: string,
    @Body() body: { merchantId: string },
  ) {
    await this.orchestrator.deactivateProvider(
      providerId,
      body?.merchantId || '',
    );
    return { success: true };
  }
}

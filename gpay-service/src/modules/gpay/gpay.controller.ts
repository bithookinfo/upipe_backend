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
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';

@Controller('gateway')
export class GpayGatewayController {
  private readonly logger = new Logger(GpayGatewayController.name);

  constructor(private readonly gpayService: GpayService) {}

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

    return this.gpayService.connectGPay(merchantId, {
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

  @Patch(':providerId/update-gpay-upi')
  async updateUpi(
    @Param('providerId') providerId: string,
    @Body() body: { upiId: string; merchantId?: string },
  ) {
    return { success: true, message: 'UPI ID updated via gpay-service' };
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

  constructor(private readonly orchestrator: GpayOrchestratorService) {}

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

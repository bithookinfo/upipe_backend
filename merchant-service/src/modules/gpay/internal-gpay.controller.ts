import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InternalAuthGuard } from '../../guards/internal-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { GpayService } from './gpay.service';
import { ProviderType, MerchantProviderStatus } from '@prisma/client';

@Controller('internal/gpay')
@UseGuards(InternalAuthGuard)
export class InternalGpayController {
  private readonly logger = new Logger(InternalGpayController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gpayService: GpayService,
  ) {}

  @Get('providers')
  async getActiveProviders() {
    const providers = await this.prisma.merchantProvider.findMany({
      where: {
        providerType: ProviderType.GPAY,
        status: MerchantProviderStatus.ACTIVE,
        merchant: {
          deletedAt: null,
        },
      },
    });

    return providers.filter((p) => (p.metadata as any)?.gpayRuntime === 'NEW');
  }

  @Get('providers/:id')
  async getProvider(@Param('id') id: string) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: {
        id,
        providerType: ProviderType.GPAY,
      },
    });

    if (!provider) {
      throw new NotFoundException(`GPay provider ${id} not found`);
    }

    return provider;
  }

  @Patch('providers/:id/session')
  async updateSessionState(
    @Param('id') id: string,
    @Body()
    body: {
      sessionStateEncrypted?: string;
      sessionState?: string;
      sessionSavedAt?: string;
    },
  ) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: { id, providerType: ProviderType.GPAY },
    });
    if (!provider) {
      throw new NotFoundException(`GPay provider ${id} not found`);
    }

    const credentials = (provider.credentials as Record<string, any>) || {};
    const metadata = (provider.metadata as Record<string, any>) || {};

    const nextCredentials = {
      ...credentials,
      ...(body.sessionStateEncrypted
        ? { sessionStateEncrypted: body.sessionStateEncrypted }
        : {}),
      ...(body.sessionState ? { sessionState: body.sessionState } : {}),
    };

    const nextMetadata = {
      ...metadata,
      ...(body.sessionSavedAt ? { sessionSavedAt: body.sessionSavedAt } : {}),
      lastSync: new Date().toISOString(),
    };

    const updated = await this.prisma.merchantProvider.update({
      where: { id },
      data: {
        credentials: nextCredentials,
        metadata: nextMetadata,
      },
    });

    this.logger.log(`Updated session state for GPay provider ${id}`);
    return updated;
  }

  @Patch('providers/:id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body()
    body: {
      status?: MerchantProviderStatus;
      verified?: boolean;
      lastConnectedAt?: string;
      metadata?: Record<string, any>;
    },
  ) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: { id, providerType: ProviderType.GPAY },
    });
    if (!provider) {
      throw new NotFoundException(`GPay provider ${id} not found`);
    }

    const existingMetadata = (provider.metadata as Record<string, any>) || {};
    const nextMetadata = {
      ...existingMetadata,
      ...(body.metadata || {}),
      ...(body.lastConnectedAt ? { lastConnectedAt: body.lastConnectedAt } : {}),
      lastSync: new Date().toISOString(),
    };

    const updated = await this.prisma.merchantProvider.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        metadata: nextMetadata,
      },
    });

    if (body.verified !== undefined) {
      await this.prisma.merchant.update({
        where: { id: provider.merchantId },
        data: { verified: body.verified },
      });
    }

    this.logger.log(
      `Updated status for GPay provider ${id}: status=${body.status}, verified=${body.verified}`,
    );
    return updated;
  }

  @Patch('providers/:id/upi')
  async updateUpi(
    @Param('id') id: string,
    @Body() body: { upiId: string },
  ) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: { id, providerType: ProviderType.GPAY },
    });
    if (!provider) {
      throw new NotFoundException(`GPay provider ${id} not found`);
    }

    const credentials = (provider.credentials as Record<string, any>) || {};
    const updated = await this.prisma.merchantProvider.update({
      where: { id },
      data: {
        accountIdentifier: body.upiId,
        credentials: {
          ...credentials,
          upiId: body.upiId,
        },
      },
    });

    this.logger.log(`Updated UPI ID for GPay provider ${id} to ${body.upiId}`);
    return updated;
  }

  @Post('finalize-connection')
  async finalizeConnection(
    @Body()
    body: {
      merchantId: string;
      email: string;
      businessId: string;
      businessName?: string;
      organizationId: string;
      upiId?: string;
      isSuperAdmin?: boolean;
      gpayRuntime?: 'LEGACY' | 'NEW';
    },
  ) {
    return this.gpayService.finalizeGPayConnection(body.merchantId, {
      email: body.email,
      businessId: body.businessId,
      businessName: body.businessName,
      organizationId: body.organizationId,
      upiId: body.upiId,
      isSuperAdmin: body.isSuperAdmin,
      gpayRuntime: body.gpayRuntime || 'NEW',
    });
  }

  @Get('merchants/:merchantId/provider')
  async getMerchantProvider(@Param('merchantId') merchantId: string) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: {
        merchantId,
        providerType: ProviderType.GPAY,
        status: {
          in: [
            MerchantProviderStatus.ACTIVE,
            MerchantProviderStatus.EXPIRED,
          ],
        },
        merchant: {
          deletedAt: null,
        },
      },
    });

    if (!provider) {
      throw new NotFoundException(
        `Active/Expired GPay provider for merchant ${merchantId} not found`,
      );
    }

    return provider;
  }

  @Get('merchants/:merchantId/providers/by-type/GPAY')
  async getProviderByType(@Param('merchantId') merchantId: string) {
    const provider = await this.prisma.merchantProvider.findFirst({
      where: {
        merchantId,
        providerType: ProviderType.GPAY,
      },
    });

    if (!provider) {
      throw new NotFoundException(
        `GPay provider for merchant ${merchantId} not found`,
      );
    }

    return provider;
  }
}

import { Controller, Get, Query, UseGuards, Logger } from '@nestjs/common';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { PrismaService } from '../prisma.service';
import axios from 'axios';

@Controller('internal/gpay')
@UseGuards(InternalAuthGuard)
export class InternalGpayController {
  private readonly logger = new Logger(InternalGpayController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('pending-activations')
  async getPendingActivations(@Query('maxAgeMs') maxAgeMsParam?: string) {
    const maxAgeMs = maxAgeMsParam ? parseInt(maxAgeMsParam, 10) : 15 * 60 * 1000;
    const cutoff = new Date(Date.now() - (isNaN(maxAgeMs) ? 900000 : maxAgeMs));

    const orders = await this.prisma.order.findMany({
      where: {
        status: 'PENDING',
        createdAt: { gte: cutoff },
      },
      select: {
        merchantId: true,
        providerId: true,
        metadata: true,
      },
    });

    const gpayOrders = orders.filter((o) => {
      const meta = (o.metadata as any) || {};
      const providerStr = String(o.providerId || '').toLowerCase();
      return (
        meta.providerType === 'GPAY' ||
        meta.provider === 'GPAY' ||
        providerStr.includes('gpay') ||
        meta.connector === 'gpay'
      );
    });

    const merchantIds = Array.from(
      new Set(gpayOrders.map((o) => o.merchantId).filter(Boolean)),
    );

    const merchantServiceUrl =
      process.env.MERCHANT_SERVICE_URL || 'http://localhost:4002';
    const internalToken =
      process.env.INTERNAL_TOKEN || 'default-internal-token';

    const candidates: Array<{ merchantId: string; providerId: string }> = [];

    for (const merchantId of merchantIds) {
      try {
        const res = await axios.get(
          `${merchantServiceUrl}/internal/gpay/merchants/${merchantId}/provider`,
          {
            headers: { 'x-internal-token': internalToken },
            timeout: 3000,
          },
        );
        if (res.data && res.data.id) {
          candidates.push({
            merchantId,
            providerId: res.data.id,
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to resolve GPay provider for merchant ${merchantId}: ${err.message}`,
        );
      }
    }

    return { candidates };
  }
}

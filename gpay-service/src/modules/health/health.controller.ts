import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { InternalAuthGuard } from '../../common/guards/internal-auth.guard';

@Controller()
export class HealthController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('health/live')
  getLiveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/ready')
  getReadiness() {
    const readiness = this.metricsService.getReadinessStatus();
    if (readiness.status !== 'ready') {
      throw new HttpException(readiness, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return readiness;
  }

  @Get('internal/metrics/gpay')
  @UseGuards(InternalAuthGuard)
  getGpayMetrics() {
    return {
      status: 'ok',
      metrics: this.metricsService.getMetrics(),
    };
  }
}

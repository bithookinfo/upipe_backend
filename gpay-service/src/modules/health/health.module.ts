import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [HealthController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class HealthModule {}

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  private isInitialized = false;

  onModuleInit() {
    this.isInitialized = true;
    this.logger.log('MetricsService initialized (Foundation readiness mode)');
  }

  onModuleDestroy() {
    this.logger.log('MetricsService destroying');
  }

  getReadinessStatus(): {
    status: 'ready' | 'not_ready';
    checks: {
      configValid: boolean;
      appInitialized: boolean;
      noFatalCondition: boolean;
    };
    uptimeSeconds: number;
  } {
    const configValid = Boolean(process.env.INTERNAL_TOKEN);
    const isReady = this.isInitialized && configValid;

    return {
      status: isReady ? 'ready' : 'not_ready',
      checks: {
        configValid,
        appInitialized: this.isInitialized,
        noFatalCondition: true,
      },
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  getMetrics(): Record<string, unknown> {
    const memoryUsage = process.memoryUsage();
    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round((memoryUsage.rss / 1024 / 1024) * 100) / 100,
        heapUsedMb:
          Math.round((memoryUsage.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotalMb:
          Math.round((memoryUsage.heapTotal / 1024 / 1024) * 100) / 100,
      },
      status: this.isInitialized ? 'ready' : 'not_ready',
    };
  }
}

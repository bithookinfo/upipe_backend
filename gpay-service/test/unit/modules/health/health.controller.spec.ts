import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from '../../../../src/modules/health/health.controller';
import { MetricsService } from '../../../../src/modules/health/metrics.service';
import { InternalAuthGuard } from '../../../../src/common/guards/internal-auth.guard';

describe('HealthController', () => {
  let controller: HealthController;
  let metricsService: MetricsService;

  beforeEach(async () => {
    process.env.INTERNAL_TOKEN = 'secret-token';

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        MetricsService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('secret-token'),
          },
        },
        InternalAuthGuard,
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    metricsService = module.get<MetricsService>(MetricsService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_TOKEN;
  });

  it('should return liveness status via getLiveness()', () => {
    const res = controller.getLiveness();
    expect(res.status).toBe('ok');
    expect(res.timestamp).toBeDefined();
  });

  it('should return readiness status when initialized and config valid', () => {
    metricsService.onModuleInit();
    const res = controller.getReadiness();
    expect(res.status).toBe('ready');
    expect(res.checks.configValid).toBe(true);
    expect(res.checks.appInitialized).toBe(true);
    expect(res.checks.noFatalCondition).toBe(true);
  });

  it('should throw SERVICE_UNAVAILABLE when foundation readiness is not met', () => {
    delete process.env.INTERNAL_TOKEN;
    expect(() => controller.getReadiness()).toThrow(HttpException);
    try {
      controller.getReadiness();
    } catch (err) {
      expect((err as HttpException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  });

  it('should return metrics via getGpayMetrics()', () => {
    metricsService.onModuleInit();
    const res = controller.getGpayMetrics();
    expect(res.status).toBe('ok');
    expect(res.metrics).toBeDefined();
    expect(res.metrics.status).toBe('ready');
  });
});

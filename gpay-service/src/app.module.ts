import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './common/config/configuration';
import { validate } from './common/config/environment.validation';
import { HealthModule } from './modules/health/health.module';
import { GpayModule } from './modules/gpay/gpay.module';
import { MerchantServiceClient } from './clients/merchant-service.client';
import { PaymentServiceClient } from './clients/payment-service.client';
import { InternalAuthGuard } from './common/guards/internal-auth.guard';
import { RedisModule } from './common/redis/redis.module';
import { SecurityModule } from './common/security/security.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    SecurityModule,
    HealthModule,
    GpayModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    MerchantServiceClient,
    PaymentServiceClient,
    InternalAuthGuard,
  ],
  exports: [
    MerchantServiceClient,
    PaymentServiceClient,
    InternalAuthGuard,
    RedisModule,
    SecurityModule,
  ],
})
export class AppModule {}

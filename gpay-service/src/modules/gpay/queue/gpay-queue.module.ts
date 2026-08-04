import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { GpayPaymentEventProducer } from './gpay-payment-event.producer';

import { GPAY_PAYMENT_EVENTS_QUEUE } from './gpay-queue.constants';

@Module({
  imports: [
    HttpModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl =
          configService.get<string>('REDIS_URL') ||
          `redis://${configService.get('REDIS_HOST') || 'localhost'}:${
            configService.get('REDIS_PORT') || 6379
          }`;
        const url = new URL(redisUrl);
        return {
          connection: {
            host: url.hostname || 'localhost',
            port: Number(url.port) || 6379,
            password: url.password || undefined,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: GPAY_PAYMENT_EVENTS_QUEUE,
    }),
  ],
  providers: [GpayPaymentEventProducer],
  exports: [GpayPaymentEventProducer, BullModule],
})
export class GpayQueueModule {}

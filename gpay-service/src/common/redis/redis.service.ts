import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') ||
      `redis://${this.configService.get('REDIS_HOST') || 'localhost'}:${
        this.configService.get('REDIS_PORT') || 6379
      }`;

    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    this.client
      .connect()
      .then(() => this.logger.log('Connected to Redis server'))
      .catch((err) =>
        this.logger.warn(`Redis connect warning: ${err.message}`),
      );
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => {});
    }
  }

  getClient(): Redis {
    return this.client;
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class PlatformConfigService {
  private readonly logger = new Logger(PlatformConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getConfigs(group?: string) {
    return this.prisma.platformConfig.findMany({
      where: group ? { group } : undefined,
    });
  }

  async getConfig(key: string) {
    const config = await this.prisma.platformConfig.findUnique({
      where: { key },
    });
    if (!config) throw new NotFoundException(`Config with key ${key} not found`);
    return config;
  }

  async upsertConfig(key: string, value: string, group?: string) {
    return this.prisma.platformConfig.upsert({
      where: { key },
      update: { value, group },
      create: { key, value, group },
    });
  }

  async bulkUpdate(configs: { key: string; value: string; group?: string }[]) {
    const results = [];
    for (const config of configs) {
      results.push(await this.upsertConfig(config.key, config.value, config.group));
    }
    return results;
  }
}

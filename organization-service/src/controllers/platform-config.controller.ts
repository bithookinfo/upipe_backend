import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  Headers,
  ForbiddenException
} from '@nestjs/common';
import { PlatformConfigService } from '../services/platform-config.service';

@Controller('platform-configs')
export class PlatformConfigController {
  constructor(private readonly configService: PlatformConfigService) {}

  private validateSuperAdmin(isSuperAdmin?: string, userType?: string) {
    if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
    throw new ForbiddenException("Super admin access required");
  }

  @Get()
  async getConfigs(
    @Query('group') group?: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const configs = await this.configService.getConfigs(group);
    const configMap = configs.reduce((acc, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {} as Record<string, string>);
    
    return { success: true, data: configMap };
  }

  @Get(':key')
  async getConfig(
    @Param('key') key: string,
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const config = await this.configService.getConfig(key);
    return { success: true, data: config };
  }

  @Post()
  async upsertConfig(
    @Body() body: { key: string; value: string; group?: string },
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const config = await this.configService.upsertConfig(
      body.key,
      body.value,
      body.group,
    );
    return { success: true, data: config };
  }

  @Put('bulk')
  async bulkUpdate(
    @Body() body: { configs: { key: string; value: string; group?: string }[] },
    @Headers('x-user-type') userType?: string,
    @Headers('x-is-super-admin') isSuperAdmin?: string
  ) {
    this.validateSuperAdmin(isSuperAdmin, userType);
    const results = await this.configService.bulkUpdate(body.configs);
    return { success: true, data: results };
  }
}

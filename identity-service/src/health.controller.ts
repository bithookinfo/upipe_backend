import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  getHealth() {
    return { 
      status: 'healthy', 
      service: 'identity-service', 
      timestamp: new Date(), 
      version: '1.0.0',
      uptime: process.uptime()
    };
  }
}

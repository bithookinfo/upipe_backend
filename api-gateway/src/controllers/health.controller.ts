import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import axios from 'axios';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private configService: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Health check for API Gateway' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  getHealth() {
    return {
      status: 'healthy',
      service: 'api-gateway',
      timestamp: new Date(),
      version: '1.0.0',
      uptime: process.uptime()
    };
  }

  @Get('services')
  @ApiOperation({ summary: 'Health check for all microservices' })
  @ApiResponse({ status: 200, description: 'Services status' })
  async getServicesHealth() {
    const services = {
      identity: this.configService.get('IDENTITY_SERVICE_URL'),
      merchant: this.configService.get('MERCHANT_SERVICE_URL'),
      payment: this.configService.get('PAYMENT_SERVICE_URL'),
      subscription: this.configService.get('SUBSCRIPTION_SERVICE_URL'),
      organization: this.configService.get('ORGANIZATION_SERVICE_URL'),
    };

    const results: Record<string, string> = {};
    
    // Check each service health
    for (const [name, url] of Object.entries(services)) {
      try {
        const response = await axios.get(`${url}/health`, { timeout: 3000 });
        results[name] = response.data?.status || 'healthy';
      } catch (error) {
        results[name] = 'unhealthy';
      }
    }

    return {
      gateway: 'healthy',
      services: results,
      timestamp: new Date()
    };
  }
}

import { Controller, Post, Body, Headers, Logger, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WebhookService } from '../services/webhook.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  @Post('paytm')
  @ApiOperation({ summary: 'Handle Paytm webhook notifications' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async handlePaytmWebhook(
    @Body() payload: any,
    @Headers() headers: any,
    @Req() req: any,
  ) {
    this.logger.log('📨 Received Paytm webhook');
    this.logger.debug('Paytm webhook payload:', payload);
    
    try {
      await this.webhookService.handlePaytmWebhook(payload, headers);
      return { success: true, message: 'Paytm webhook processed' };
    } catch (error) {
      this.logger.error('Paytm webhook processing failed:', error);
      return { success: false, error: error.message };
    }
  }

  @Post('phonepe')
  @ApiOperation({ summary: 'Handle PhonePe webhook notifications' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async handlePhonePeWebhook(
    @Body() payload: any,
    @Headers() headers: any,
  ) {
    this.logger.log('📨 Received PhonePe webhook');
    this.logger.debug('PhonePe webhook payload:', payload);
    
    try {
      await this.webhookService.handlePhonePeWebhook(payload, headers);
      return { success: true, message: 'PhonePe webhook processed' };
    } catch (error) {
      this.logger.error('PhonePe webhook processing failed:', error);
      return { success: false, error: error.message };
    }
  }

  @Post('bharatpe')
  @ApiOperation({ summary: 'Handle BharatPe webhook notifications' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async handleBharatPeWebhook(
    @Body() payload: any,
    @Headers() headers: any,
  ) {
    this.logger.log('📨 Received BharatPe webhook');
    this.logger.debug('BharatPe webhook payload:', payload);
    
    try {
      await this.webhookService.handleBharatPeWebhook(payload, headers);
      return { success: true, message: 'BharatPe webhook processed' };
    } catch (error) {
      this.logger.error('BharatPe webhook processing failed:', error);
      return { success: false, error: error.message };
    }
  }

  @Post('test')
  @ApiOperation({ summary: 'Test webhook endpoint for development' })
  @ApiResponse({ status: 200, description: 'Test webhook received' })
  async handleTestWebhook(@Body() payload: any) {
    this.logger.log('🧪 Received test webhook');
    this.logger.log('Test payload:', JSON.stringify(payload, null, 2));
    
    return { 
      success: true, 
      message: 'Test webhook received',
      receivedAt: new Date().toISOString(),
      payload 
    };
  }
}

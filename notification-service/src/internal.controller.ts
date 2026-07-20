import { Body, Controller, Post, Logger, UseGuards } from '@nestjs/common';
import { EmailService, SendEmailPayload } from './email/email.service';
import { PushService, PushPayload } from './push/push.service';
import { addSubscription } from './push/push-subscription.store';
import { InternalAuthGuard } from './guards/internal-auth.guard';

@UseGuards(InternalAuthGuard)
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly pushService: PushService,
  ) {}

  @Post('send/email')
  async sendEmail(@Body() body: SendEmailPayload) {
    if (!body?.to || !body?.type) {
      return { success: false, error: 'Missing to or type' };
    }
    const result = await this.emailService.send({
      to: body.to,
      type: body.type as any,
      data: body.data || {},
      bcc: (body as any).bcc,
    });
    return result;
  }

  @Post('push/subscribe')
  async pushSubscribe(
    @Body()
    body: {
      userId: string;
      organizationId: string;
      subscription: {
        endpoint: string;
        keys: { p256dh: string; auth: string };
        expirationTime?: number | null;
      };
    },
  ) {
    if (!body?.userId || !body?.organizationId || !body?.subscription?.endpoint || !body?.subscription?.keys) {
      return { success: false, error: 'Missing userId, organizationId, or subscription' };
    }
    try {
      const record = addSubscription(body.userId, body.organizationId, {
        endpoint: body.subscription.endpoint,
        keys: body.subscription.keys,
        expirationTime: body.subscription.expirationTime ?? null,
      });
      return { success: true, id: record.id };
    } catch (e: any) {
      this.logger.warn(`Push subscribe failed: ${e?.message || e}`);
      return { success: false, error: e?.message || 'Subscribe failed' };
    }
  }

  @Post('push/send')
  async pushSend(
    @Body()
    body: {
      organizationId: string;
      payload: PushPayload;
    },
  ) {
    if (!body?.organizationId || !body?.payload?.title) {
      return { success: false, error: 'Missing organizationId or payload.title' };
    }
    const { sent, failed } = await this.pushService.sendToOrganization(
      body.organizationId,
      body.payload,
    );
    return { success: true, sent, failed };
  }

  @Post('health')
  health() {
    return { status: 'ok', service: 'notification-service' };
  }
}

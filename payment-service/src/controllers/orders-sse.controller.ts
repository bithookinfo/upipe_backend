import { Controller, Get, Query, Res, Logger,Headers } from '@nestjs/common';
import { Response } from 'express';
import { OrderEventsService, SseClient } from '../services/order-events.service';

@Controller('sse')
export class OrdersSseController {
  private readonly logger = new Logger(OrdersSseController.name);

  constructor(private readonly orderEvents: OrderEventsService) {}

  @Get('orders')
  streamOrderEvents(
    @Res() res: Response,
    @Headers('x-organization-id') headerOrgId?: string,
    @Query('organizationId') queryOrgId?: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-user-type') headerUserType?: string,
    @Query('userId') queryUserId?: string,
    @Query('userType') queryUserType?: string,
  ): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable buffering
    res.flushHeaders();

    const userId = headerUserId || queryUserId;
    const userType = headerUserType || queryUserType;

    const userTypeStr = (userType || '').toUpperCase();
    const resolvedOrgId = (headerOrgId && headerOrgId !== 'platform-org-id') ? headerOrgId : queryOrgId;

    const client: SseClient = {
      res,
      organizationId: resolvedOrgId || undefined,
      userId: userId || undefined,
      isSuperAdmin: userTypeStr === 'SUPERADMIN' || userTypeStr === 'SUPER_ADMIN',
    };
    this.orderEvents.addClient(client);

    // Send initial comment so client sees connection is alive
    res.write(': connected\n\n');

    res.on('close', () => {
      this.orderEvents.removeClient(client);
    });
  }
}

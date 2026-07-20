import { Injectable, Logger } from '@nestjs/common';
import { InAppNotificationsService } from './in-app-notifications.service';

export interface SseClient {
  res: any;
  organizationId?: string;
  userId?: string;
  isSuperAdmin?: boolean;
}

@Injectable()
export class OrderEventsService {
  private readonly logger = new Logger(OrderEventsService.name);
  private readonly clients = new Set<SseClient>();

  constructor(private readonly inAppNotifications: InAppNotificationsService) {}

  addClient(client: SseClient): void {
    this.clients.add(client);
    this.logger.debug(`SSE client connected. Total: ${this.clients.size}`);
  }

  removeClient(client: SseClient): void {
    this.clients.delete(client);
    this.logger.debug(`SSE client disconnected. Total: ${this.clients.size}`);
  }

  broadcastOrderUpdated(
    orderId: string,
    organizationId?: string,
    meta?: { externalOrderId?: string, isPlatform?: boolean },
  ): void {
    const payload = JSON.stringify({ orderId, organizationId, event: 'order.updated' });
    const data = `event: order.updated\ndata: ${payload}\n\n`;

    const isPlatform = meta?.isPlatform || false;

    const notificationPayload = JSON.stringify({
      type: isPlatform ? 'subscription_activated' : 'order_completed',
      orderId,
      externalOrderId: meta?.externalOrderId,
      title: isPlatform ? 'Subscription Activated' : 'Order completed',
      message: isPlatform 
        ? 'You paid for the plan, so it\'s active.'
        : (meta?.externalOrderId
          ? `Order ${meta.externalOrderId} completed successfully.`
          : 'An order was completed.'),
    });
    const notificationData = `event: notification\ndata: ${notificationPayload}\n\n`;

    let sent = 0;
    this.clients.forEach((client) => {
      if (organizationId != null && client.organizationId != null && client.organizationId !== organizationId) {
        return;
      }
      try {
        if (client.res && !client.res.writableEnded) {
          client.res.write(data);
          if (meta?.externalOrderId) client.res.write(notificationData);
          sent++;
        }
      } catch (err) {
        this.logger.warn('SSE write error, removing client', err);
        this.clients.delete(client);
      }
    });
    if (sent > 0) {
      this.logger.debug(`Broadcast order.updated orderId=${orderId} to ${sent} client(s)`);
    }

    // Persist for DB-backed notification list (cross-device, survive refresh)
    if (organizationId && meta?.externalOrderId) {
        this.inAppNotifications.create({
          organizationId,
          orderId,
          externalOrderId: meta.externalOrderId,
          type: isPlatform ? 'subscription_activated' : 'order_completed',
          title: isPlatform ? 'Subscription Activated' : 'Order completed',
          message: isPlatform 
            ? 'You paid for the plan, so it\'s active.'
            : `Order ${meta.externalOrderId} completed successfully.`,
        }).catch(() => {});
    }
  }

  async broadcastNotification(params: {
    type: string;
    title: string;
    message: string;
    organizationId?: string;
    userId?: string;
    orderId?: string;
    externalOrderId?: string;
    forSuperAdmins?: boolean;
  }): Promise<void> {
    const notificationPayload = JSON.stringify({
      type: params.type,
      title: params.title,
      message: params.message,
      orderId: params.orderId,
      externalOrderId: params.externalOrderId,
    });
    const notificationData = `event: notification\ndata: ${notificationPayload}\n\n`;

    let sent = 0;
    this.clients.forEach((client) => {
      let shouldSend = false;

      if (params.forSuperAdmins && client.isSuperAdmin) {
        shouldSend = true;
      } else if (params.userId && client.userId === params.userId) {
        shouldSend = true;
      } else if (!params.forSuperAdmins && params.organizationId && client.organizationId === params.organizationId) {
        // Broadcast to org if userId not specified
        if (!params.userId) {
          shouldSend = true;
        }
      }

      if (shouldSend) {
        try {
          if (client.res && !client.res.writableEnded) {
            client.res.write(notificationData);
            sent++;
          }
        } catch (err) {
          this.logger.warn('SSE write error, removing client', err);
          this.clients.delete(client);
        }
      }
    });

    if (sent > 0) {
      this.logger.debug(`Broadcast notification '${params.type}' to ${sent} client(s)`);
    }

    // Always persist
    await this.inAppNotifications.create({
      organizationId: params.forSuperAdmins ? 'SUPERADMIN' : (params.organizationId || 'SUPERADMIN'),
      orderId: params.orderId,
      externalOrderId: params.externalOrderId,
      type: params.type,
      title: params.title,
      message: params.message,
    });
  }
}

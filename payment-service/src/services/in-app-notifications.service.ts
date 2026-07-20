import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

const DEFAULT_LIMIT = 50;
const TTL_DAYS = 14;

@Injectable()
export class InAppNotificationsService {
  private readonly logger = new Logger(InAppNotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Persist a notification (e.g. when order completes and we broadcast via SSE).
   * Dedupe: we do not enforce unique (orderId) so multiple events per order are allowed;
   * client can dedupe by id when merging with SSE stream.
   */
  async create(params: {
    organizationId: string;
    orderId?: string;
    externalOrderId?: string;
    type?: string;
    title: string;
    message: string;
  }): Promise<void> {
    try {
      await this.prisma.inAppNotification.create({
        data: {
          organizationId: params.organizationId,
          orderId: params.orderId ?? null,
          externalOrderId: params.externalOrderId ?? null,
          type: params.type ?? 'order_completed',
          title: params.title,
          message: params.message,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to persist in-app notification: ${err?.message || err}`);
    }
  }

  /**
   * List notifications for org, with read status for the given user.
   * Returns last N, optionally excluding older than TTL.
   */
  async list(
    organizationId: string,
    userId: string | undefined,
    limit: number = DEFAULT_LIMIT,
  ): Promise<{
    id: string;
    type: string;
    title: string;
    message: string;
    orderId: string | null;
    externalOrderId: string | null;
    createdAt: Date;
    read: boolean;
  }[]> {
    const since = new Date();
    since.setDate(since.getDate() - TTL_DAYS);

    const notifications = await this.prisma.inAppNotification.findMany({
      where: {
        organizationId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        reads: userId ? { where: { userId }, take: 1 } : false,
      },
    });

    return notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      orderId: n.orderId,
      externalOrderId: n.externalOrderId,
      createdAt: n.createdAt,
      read: userId ? (n.reads && Array.isArray(n.reads) ? n.reads.length > 0 : false) : false,
    }));
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    await this.prisma.notificationRead.upsert({
      where: {
        notificationId_userId: { notificationId, userId },
      },
      create: { notificationId, userId },
      update: {},
    });
  }

  /**
   * Mark all notifications for the org as read for the given user (single DB round-trip).
   */
  async markAllAsRead(organizationId: string, userId: string): Promise<number> {
    const since = new Date();
    since.setDate(since.getDate() - TTL_DAYS);
    const notifications = await this.prisma.inAppNotification.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: { id: true },
    });
    if (notifications.length === 0) return 0;
    const existing = await this.prisma.notificationRead.findMany({
      where: { userId, notificationId: { in: notifications.map((n) => n.id) } },
      select: { notificationId: true },
    });
    const existingIds = new Set(existing.map((r) => r.notificationId));
    const toInsert = notifications.filter((n) => !existingIds.has(n.id)).map((n) => ({ notificationId: n.id, userId }));
    if (toInsert.length === 0) return 0;
    await this.prisma.notificationRead.createMany({
      data: toInsert,
      skipDuplicates: true,
    });
    return toInsert.length;
  }

  /**
   * Optional: cleanup old notifications (e.g. cron). Call from a cron job if desired.
   */
  async deleteOlderThan(days: number = TTL_DAYS): Promise<number> {
    const before = new Date();
    before.setDate(before.getDate() - days);
    const result = await this.prisma.inAppNotification.deleteMany({
      where: { createdAt: { lt: before } },
    });
    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} in-app notifications older than ${days} days`);
    }
    return result.count;
  }
}

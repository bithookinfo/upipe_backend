import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as webpush from "web-push";
import {
  getSubscriptionsByOrganization,
  StoredPushSubscription,
} from "./push-subscription.store";

export interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  [key: string]: unknown;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private vapidConfigured = false;

  constructor(private readonly config: ConfigService) {
    const publicKey = this.config.get<string>("VAPID_PUBLIC_KEY");
    const privateKey = this.config.get<string>("VAPID_PRIVATE_KEY");
    if (publicKey && privateKey) {
      webpush.setVapidDetails(
        `mailto:${process.env.SUPPORT_EMAIL}`,
        publicKey,
        privateKey,
      );
      this.vapidConfigured = true;
      this.logger.log("VAPID keys configured for push notifications");
    } else {
      this.logger.warn(
        "VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not set; push notifications disabled",
      );
    }
  }

  async sendToOrganization(
    organizationId: string,
    payload: PushPayload,
  ): Promise<{ sent: number; failed: number }> {
    if (!this.vapidConfigured) return { sent: 0, failed: 0 };

    const subscriptions = getSubscriptionsByOrganization(organizationId);
    if (subscriptions.length === 0) {
      this.logger.debug(`No push subscriptions for org ${organizationId}`);
      return { sent: 0, failed: 0 };
    }

    const payloadStr = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (sub: StoredPushSubscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.subscription.endpoint,
              keys: sub.subscription.keys,
              expirationTime: sub.subscription.expirationTime ?? undefined,
            },
            payloadStr,
            { TTL: 86400 },
          );
          sent++;
        } catch (err: any) {
          failed++;
          this.logger.warn(
            `Push failed for ${sub.subscription.endpoint?.slice(0, 50)}...: ${err?.message || err}`,
          );
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            const { removeByEndpoint } =
              await import("./push-subscription.store");
            removeByEndpoint(sub.subscription.endpoint);
          }
        }
      }),
    );

    if (sent > 0 || failed > 0) {
      this.logger.log(
        `Push to org ${organizationId}: ${sent} sent, ${failed} failed`,
      );
    }
    return { sent, failed };
  }
}

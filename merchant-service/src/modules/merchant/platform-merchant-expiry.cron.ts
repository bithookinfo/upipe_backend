import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import axios from "axios";

@Injectable()
export class PlatformMerchantExpiryCron {
  private readonly logger = new Logger(PlatformMerchantExpiryCron.name);

  // In-memory cache to avoid sending duplicate alerts for the same provider
  private readonly alertedProviders = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  // Run every 10 minutes
  @Cron("*/10 * * * *", { name: "platform-merchant-expiry-alert" })
  async checkPlatformMerchantExpiry() {
    try {
      // Find all expired platform merchant providers
      const expiredProviders = await this.prisma.merchantProvider.findMany({
        where: {
          status: "EXPIRED",
          merchant: {
            isPlatform: true
          }
        },
        include: {
          merchant: true
        }
      });

      if (expiredProviders.length === 0) return;

      const notifUrl = process.env.NOTIFICATION_SERVICE_URL;

      let superAdminEmails: string[] = [];
      try {
        const identityUrl = process.env.IDENTITY_SERVICE_URL;
        if (identityUrl) {
          const adminsRes = await axios.get(`${identityUrl}/super-admins`, {
            headers: { 
                "x-internal-token": process.env.INTERNAL_TOKEN,
                "x-user-type": "SUPER_ADMIN",
                "x-is-super-admin": "true"
            }
          }).catch((err) => {
             this.logger.error("Failed to fetch super admins from identity service: " + err.message);
             return null;
          });

          if (adminsRes?.data && Array.isArray(adminsRes.data)) {
            superAdminEmails = adminsRes.data.map((admin: any) => admin.email).filter(Boolean);
          }
        }
      } catch (err) {
        this.logger.error("Failed to fetch super admins");
      }

      if (superAdminEmails.length === 0) {
        this.logger.warn("No super admin emails found for platform merchant alerts.");
        return;
      }

      for (const provider of expiredProviders) {
        if (this.alertedProviders.has(provider.id)) {
          continue; // already alerted
        }

        try {
          this.logger.log(`🚨 Sending expiration alert for platform merchant provider ${provider.id} to ${superAdminEmails.join(', ')}`);
          
          await axios.post(`${notifUrl}/internal/send/email`, {
            to: superAdminEmails.join(","),
            type: "security_alert", // use security_alert or create a new one, security_alert works for admin notifications
            data: {
              organizationName: "SuperAdmin Platform",
              message: `Platform Merchant Gateway Expired: ${provider.providerType} (${provider.accountIdentifier || provider.id}) for Platform Merchant '${provider.merchant.name}'. Please reconnect the provider from SuperAdmin Dashboard immediately to restore platform payment processing.`
            }
          }, { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } });

          this.alertedProviders.add(provider.id);
        } catch (e: any) {
          this.logger.error(`Failed to send platform merchant expiry alert: ${e.message}`);
        }
      }
      
      if (this.alertedProviders.size > 1000) {
        this.alertedProviders.clear();
      }

    } catch (e: any) {
      this.logger.error(`Error in platform merchant expiry cron: ${e.message}`);
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import {
  getVerifyEmailHtml,
  getResetPasswordHtml,
  getOrderCompletionHtml,
  getSecurityAlertHtml,
} from "./templates";
import {
  TemplateStoreService,
  type TemplateKey,
} from "../templates/template-store.service";

export type EmailType =
  | "verify_email"
  | "reset_password"
  | "order_completion"
  | "security_alert"
  | "change_email"
  | "usage_alert"
  | "subscription_expiry"
  | "subscription_renewal";

export interface SendEmailPayload {
  to: string;
  type: EmailType;
  data: Record<string, string | number | undefined>;
  bcc?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const AUTH_EMAIL_TYPES: EmailType[] = [
  "verify_email",
  "reset_password",
  "security_alert",
  "change_email",
];

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporterAuth: Transporter | null = null;
  private transporterAlerts: Transporter | null = null;
  private fromAuth: string;
  private fromAlerts: string;
  private appName: string;
  private frontendUrl: string;

  constructor(
    private config: ConfigService,
    private templateStore: TemplateStoreService,
  ) {
    const fallback =
      this.config.get<string>("SMTP_USER") || "noreply@example.com";
    this.fromAuth =
      this.config.get<string>("FROM_EMAIL_AUTH") ||
      this.config.get<string>("FROM_EMAIL") ||
      fallback;
    this.fromAlerts =
      this.config.get<string>("FROM_EMAIL_ALERTS") ||
      this.config.get<string>("FROM_EMAIL") ||
      fallback;
    this.appName = this.config.get<string>("APP_NAME") || "Upipe";
    this.frontendUrl =
      this.config.get<string>("FRONTEND_URL") || "https://upipe.tech";
    this.initTransporters();
  }

  private initTransporters(): void {
    const host = this.config.get<string>("SMTP_HOST");
    const port = this.config.get<number>("SMTP_PORT") ?? 587;
    const user = this.config.get<string>("SMTP_USER");
    const pass = this.config.get<string>("SMTP_PASS");
    const userAlerts = this.config.get<string>("SMTP_USER_ALERTS");
    const passAlerts = this.config.get<string>("SMTP_PASS_ALERTS");

    if (!host || !user || !pass) {
      this.logger.warn(
        "SMTP not configured (SMTP_HOST, SMTP_USER, SMTP_PASS). Email sending disabled.",
      );
      return;
    }

    try {
      this.transporterAuth = nodemailer.createTransport({
        host,
        port: Number(port),
        secure: port === 465,
        auth: { user, pass },
        tls: { rejectUnauthorized: false }
      });
      this.logger.log("SMTP transporter (auth/noreply) initialized");

      if (userAlerts && passAlerts) {
        this.transporterAlerts = nodemailer.createTransport({
          host,
          port: Number(port),
          secure: port === 465,
          auth: { user: userAlerts, pass: passAlerts },
          tls: { rejectUnauthorized: false }
        });
        this.logger.log("SMTP transporter (alerts) initialized");
      } else {
        this.transporterAlerts = this.transporterAuth;
      }
    } catch (err: any) {
      this.logger.error(
        "Failed to create SMTP transporter",
        err?.message || err,
      );
    }
  }

  private getTransporter(type: EmailType): Transporter | null {
    return AUTH_EMAIL_TYPES.includes(type)
      ? this.transporterAuth
      : (this.transporterAlerts ?? this.transporterAuth);
  }

  async send(
    payload: SendEmailPayload,
  ): Promise<{ success: boolean; error?: string }> {
    const { to, type, data } = payload;
    const transporter = this.getTransporter(type);
    if (!transporter) {
      this.logger.warn("Cannot send email: SMTP not configured");
      return { success: false, error: "Email service not configured" };
    }

    const { subject, html } = this.buildMessage(type, data);

    if (!subject || !html) {
      this.logger.warn(`Unknown or invalid email type: ${type}`);
      return { success: false, error: `Invalid type: ${type}` };
    }

    const fromAddress = AUTH_EMAIL_TYPES.includes(type)
      ? this.fromAuth
      : this.fromAlerts;
    const fromHeader = `"${this.appName}" <${fromAddress}>`;
    const replyTo = this.config.get<string>("REPLY_TO_EMAIL") || undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await transporter.sendMail({
          from: fromHeader,
          ...(replyTo && AUTH_EMAIL_TYPES.includes(type) ? { replyTo } : {}),
          to,
          ...(payload.bcc ? { bcc: payload.bcc } : {}),
          subject,
          html,
          text: html.replace(/<[^>]*>/g, ""), // fallback plain text
        });
        const toStr = Array.isArray(to) ? to.join(",") : String(to || "");
        this.logger.log(
          `Email sent: ${type} to ${toStr.replace(/(.{2}).*(@.*)/, "$1***$2")}`,
        );
        return { success: true };
      } catch (err: any) {
        const msg = err?.message || String(err);
        this.logger.error(
          `Send attempt ${attempt}/${MAX_RETRIES} failed for ${type}: ${msg}`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          return { success: false, error: msg };
        }
      }
    }

    return { success: false, error: "Max retries exceeded" };
  }

  private buildMessage(
    type: EmailType,
    data: Record<string, string | number | undefined>,
  ): { subject: string; html: string } {
    const base = {
      appName: this.appName,
      frontendUrl: this.frontendUrl,
      ...data,
    };

    if (this.templateStore.isCustomized(type as TemplateKey)) {
      const custom = this.templateStore.getRendered(type as TemplateKey, base);
      if (custom?.subject && custom?.html) {
        return { subject: custom.subject, html: custom.html };
      }
    }

    switch (type) {
      case "verify_email":
        return {
          subject: `Verify your email - ${this.appName}`,
          html: getVerifyEmailHtml(base as any),
        };
      case "reset_password":
        return {
          subject: `Reset your password - ${this.appName}`,
          html: getResetPasswordHtml(base as any),
        };
      case "order_completion":
        return {
          subject: `Order completed - ${data.orderId || "Order"} - ${this.appName}`,
          html: getOrderCompletionHtml(base as any),
        };
      case "security_alert":
        return {
          subject: `Security alert - ${this.appName}`,
          html: getSecurityAlertHtml(base as any),
        };
      case "usage_alert":
        const { getUsageAlertHtml } = require("./templates/usage-alert.template");
        return {
          subject: `QR Usage Alert: ${(base as any).milestone}% Reached - ${this.appName}`,
          html: getUsageAlertHtml(base as any),
        };
      case "subscription_expiry":
        const { getSubscriptionExpiryHtml } = require("./templates/subscription-expiry.template");
        const isUrgent = ((base as any).hoursRemaining || 24) <= 6;
        return {
          subject: `${isUrgent ? '⚠️ URGENT: ' : ''}Subscription Expiring ${isUrgent ? 'Soon' : 'Tomorrow'} - ${this.appName}`,
          html: getSubscriptionExpiryHtml(base as any),
        };
      case "subscription_renewal":
        const { getSubscriptionRenewalHtml } = require("./templates/subscription-renewal.template");
        return {
          subject: `🎉 Subscription Renewed Successfully! - ${this.appName}`,
          html: getSubscriptionRenewalHtml(base as any),
        };
      default:
        return { subject: "", html: "" };
    }
  }
}

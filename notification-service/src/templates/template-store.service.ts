import { Injectable, Logger } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";

export const TEMPLATE_KEYS = [
  "verify_email",
  "reset_password",
  "order_completion",
  "security_alert",
  "usage_alert",
  "subscription_expiry",
  "subscription_renewal",
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface EmailTemplate {
  key: TemplateKey;
  name: string;
  description: string;
  subject: string;
  htmlBody: string;
  variables: string[];
  isCustomized: boolean;
}

export const DEFAULT_TEMPLATES: Record<
  TemplateKey,
  Omit<EmailTemplate, "key" | "isCustomized">
> = {
  verify_email: {
    name: "Verify Email",
    description: "Sent when a user signs up to verify their email address.",
    subject: "Verify your email - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Verify your email</h2>
  <p>Thanks for signing up for {{appName}}. Please verify your email by clicking the button below.</p>
  <p><a href="{{verifyUrl}}" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600;">Verify email</a></p>
  <p style="font-size:14px;color:#6b7280;">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "verifyUrl", "userName"],
  },
  reset_password: {
    name: "Reset Password",
    description: "Sent when a user requests a password reset.",
    subject: "Reset your password - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Reset your password</h2>
  <p>We received a request to reset your password. Click the button below to set a new password.</p>
  <p><a href="{{resetUrl}}" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset password</a></p>
  <p style="font-size:14px;color:#6b7280;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "resetUrl", "userName"],
  },
  order_completion: {
    name: "Order Completion",
    description:
      "Sent to the organization when an order is completed (if enabled in settings).",
    subject: "Order completed - {{orderId}} - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Order completed</h2>
  <p>An order on your {{appName}} account has been completed.</p>
  <p><strong>Order ID:</strong> {{orderId}}</p>
  <p><strong>Amount:</strong> ₹{{amount}}</p>
  <p><strong>Customer:</strong> {{customerName}}</p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Order notification.</footer>
</body>
</html>`,
    variables: ["appName", "orderId", "amount", "customerName"],
  },
  security_alert: {
    name: "Security Alert",
    description:
      "Sent for security-related events (e.g. password change, login from new device).",
    subject: "Security alert - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Security alert</h2>
  <p>{{message}}</p>
  <p>If this wasn't you, please change your password and contact support.</p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "message"],
  },
  usage_alert: {
    name: "Usage Alert",
    description: "Sent when an organization reaches a specific usage milestone.",
    subject: "QR Usage Alert: {{milestone}}% Reached - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Usage Milestone Reached</h2>
  <p>Your organization <strong>{{orgName}}</strong> has reached <strong>{{milestone}}%</strong> of its usage limit.</p>
  <p>Please log in to your dashboard to view your current usage and consider upgrading your plan if necessary.</p>
  <p><a href="{{frontendUrl}}/admin/dashboard" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600;">View Dashboard</a></p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "orgName", "frontendUrl", "milestone", "usagePct"],
  },
  subscription_expiry: {
    name: "Subscription Expiry",
    description: "Sent when an organization's subscription is about to expire.",
    subject: "Subscription Expiring Soon - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Subscription Expiring Soon</h2>
  <p>Your subscription plan <strong>{{planName}}</strong> for organization <strong>{{orgName}}</strong> is expiring soon (around {{expiryDate}}).</p>
  <p>Please renew your subscription to ensure uninterrupted service.</p>
  <p><a href="{{frontendUrl}}/admin/subscription/buy-plan" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600;">Renew Subscription</a></p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "orgName", "frontendUrl", "planName", "expiryDate", "hoursRemaining"],
  },
  subscription_renewal: {
    name: "Subscription Renewal",
    description: "Sent when an organization's subscription is successfully renewed.",
    subject: "Subscription Renewed Successfully - {{appName}}",
    htmlBody: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 24px;">
  <h2 style="margin:0 0 16px 0;">Subscription Renewed</h2>
  <p>Your subscription plan <strong>{{planName}}</strong> for organization <strong>{{orgName}}</strong> has been successfully renewed!</p>
  <p>Your new expiry date is <strong>{{expiryDate}}</strong>.</p>
  <p><a href="{{frontendUrl}}/admin/dashboard" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600;">View Dashboard</a></p>
  <footer style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280;">{{appName}} – Please do not reply.</footer>
</body>
</html>`,
    variables: ["appName", "orgName", "frontendUrl", "planName", "expiryDate"],
  },
};

function getDataPath(): string {
  const dir =
    process.env.TEMPLATES_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "email-templates.json");
}

function substituteVars(
  html: string,
  data: Record<string, string | number | undefined>,
): string {
  let out = html;
  for (const [k, v] of Object.entries(data)) {
    const val = v === undefined || v === null ? "" : String(v);
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), val);
  }
  return out;
}

type CacheShape = Partial<
  Record<TemplateKey, { subject: string; htmlBody: string }>
>;

@Injectable()
export class TemplateStoreService {
  private readonly logger = new Logger(TemplateStoreService.name);
  private cache: CacheShape = {};
  private readonly dataPath: string = getDataPath();

  constructor() {
    this.loadFromFile();
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private loadFromFile(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;

      const raw = fs.readFileSync(this.dataPath, "utf-8");
      const parsed = JSON.parse(raw);

      // Validate: only accept keys we know about
      const safe: CacheShape = {};
      for (const key of TEMPLATE_KEYS) {
        if (parsed[key] && typeof parsed[key] === "object") {
          safe[key] = {
            subject: String(parsed[key].subject ?? ""),
            htmlBody: String(parsed[key].htmlBody ?? ""),
          };
        }
      }

      this.cache = safe;
      this.logger.log(
        `Loaded ${Object.keys(safe).length} customized template(s) from disk`,
      );
    } catch (e: any) {
      this.logger.warn(
        `Could not load template file — using defaults. Reason: ${e?.message ?? e}`,
      );
      this.cache = {};
    }
  }

  private saveToFile(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.dataPath,
        JSON.stringify(this.cache, null, 2),
        "utf-8",
      );
    } catch (e: any) {
      this.logger.error(
        `Could not save template file. Reason: ${e?.message ?? e}`,
      );
    }
  }

  private buildTemplate(key: TemplateKey): EmailTemplate {
    const def = DEFAULT_TEMPLATES[key];
    const custom = this.cache[key];
    return {
      key,
      name: def.name,
      description: def.description,
      subject: custom?.subject ?? def.subject,
      htmlBody: custom?.htmlBody ?? def.htmlBody,
      variables: def.variables,
      isCustomized: !!custom,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Return all templates with isCustomized flag included. */
  getAll(): EmailTemplate[] {
    return TEMPLATE_KEYS.map((key) => this.buildTemplate(key));
  }

  /** Return a single template, or null if the key is unknown. */
  get(key: TemplateKey): EmailTemplate | null {
    if (!TEMPLATE_KEYS.includes(key)) return null;
    return this.buildTemplate(key);
  }

  /** Return the unmodified system default for a key. */
  getDefault(key: TemplateKey): EmailTemplate | null {
    if (!TEMPLATE_KEYS.includes(key)) return null;
    const def = DEFAULT_TEMPLATES[key];
    return { key, ...def, isCustomized: false };
  }

  /**
   * Save custom subject/htmlBody for a template.
   * Only the fields you pass are updated; omitted fields keep their current value.
   */
  update(
    key: TemplateKey,
    updates: { subject?: string; htmlBody?: string },
  ): EmailTemplate | null {
    if (!TEMPLATE_KEYS.includes(key)) return null;

    const def = DEFAULT_TEMPLATES[key];
    const current = this.cache[key];

    this.cache[key] = {
      subject:
        updates.subject !== undefined
          ? updates.subject
          : (current?.subject ?? def.subject),
      htmlBody:
        updates.htmlBody !== undefined
          ? updates.htmlBody
          : (current?.htmlBody ?? def.htmlBody),
    };

    this.saveToFile();
    this.logger.log(`Template "${key}" updated`);

    return this.buildTemplate(key);
  }

  /** Remove the custom override for a template, restoring the system default. */
  reset(key: TemplateKey): EmailTemplate | null {
    if (!TEMPLATE_KEYS.includes(key)) return null;

    delete this.cache[key];
    this.saveToFile();
    this.logger.log(`Template "${key}" reset to default`);

    return this.buildTemplate(key);
  }

  /** Returns true when the template has an active custom override. */
  isCustomized(key: TemplateKey): boolean {
    return !!this.cache[key];
  }

  /**
   * Return the rendered subject + HTML for a template with all
   * {{variable}} placeholders substituted.
   */
  getRendered(
    key: TemplateKey,
    data: Record<string, string | number | undefined>,
  ): { subject: string; html: string } | null {
    const t = this.get(key);
    if (!t) return null;

    return {
      subject: substituteVars(t.subject, data),
      html: substituteVars(t.htmlBody, data),
    };
  }
}

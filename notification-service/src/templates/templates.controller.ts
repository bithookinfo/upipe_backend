import { Body, Controller, Get, Param, Post, Put } from "@nestjs/common";
import {
  TemplateStoreService,
  TemplateKey,
  TEMPLATE_KEYS,
} from "./template-store.service";
import { EmailService } from "../email/email.service";

/** Sample variables used for preview and test emails */
const SAMPLE_DATA: Record<string, string> = {
  appName: "Upipe",
  frontendUrl: process.env.FRONTEND_URL as string,
  verifyUrl: `${process.env.FRONTEND_URL}/verify-email?token=sample-token`,
  resetUrl: `${process.env.FRONTEND_URL}/reset-password?token=sample-token`,
  userName: "John Doe",
  orderId: "ORD-12345",
  amount: "1,299.00",
  customerName: "Jane Smith",
  message:
    "Your password was changed from a new device. If this wasn't you, please contact support immediately.",
};

@Controller("notifications/templates")
export class TemplatesController {
  constructor(
    private readonly store: TemplateStoreService,
    private readonly emailService: EmailService,
  ) {}

  @Get()
  getAll() {
    const templates = this.store.getAll().map((t) => ({
      ...t,
      isCustomized: this.store.isCustomized(t.key as TemplateKey),
    }));
    return { success: true, templates };
  }

  @Get(":key")
  getOne(@Param("key") key: string) {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
      return { success: false, error: "Invalid template key" };
    }
    const t = this.store.get(key as TemplateKey);
    if (!t) return { success: false, error: "Not found" };
    return {
      success: true,
      template: {
        ...t,
        isCustomized: this.store.isCustomized(key as TemplateKey),
        defaultTemplate: this.store.getDefault(key as TemplateKey),
      },
    };
  }

  @Put(":key")
  update(
    @Param("key") key: string,
    @Body() body: { subject?: string; htmlBody?: string },
  ) {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
      return { success: false, error: "Invalid template key" };
    }
    const updated = this.store.update(key as TemplateKey, {
      subject: body.subject,
      htmlBody: body.htmlBody,
    });
    return updated
      ? { success: true, template: { ...updated, isCustomized: true } }
      : { success: false, error: "Update failed" };
  }

  @Post(":key/reset")
  reset(@Param("key") key: string) {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
      return { success: false, error: "Invalid template key" };
    }
    const resetTemplate = this.store.reset(key as TemplateKey);
    return resetTemplate
      ? { success: true, template: { ...resetTemplate, isCustomized: false } }
      : { success: false, error: "Reset failed" };
  }

  @Post(":key/preview")
  preview(
    @Param("key") key: string,
    @Body() body: { data?: Record<string, string> },
  ) {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
      return { success: false, error: "Invalid template key" };
    }
    const merged = { ...SAMPLE_DATA, ...(body.data || {}) };
    const result = this.store.getRendered(key as TemplateKey, merged);
    return result
      ? { success: true, subject: result.subject, html: result.html }
      : { success: false, error: "Preview failed" };
  }

  @Post(":key/send-test")
  async sendTest(@Param("key") key: string, @Body() body: { email: string }) {
    if (!TEMPLATE_KEYS.includes(key as TemplateKey)) {
      return { success: false, error: "Invalid template key" };
    }
    if (!body.email || !body.email.includes("@")) {
      return { success: false, error: "Valid email is required" };
    }
    const result = await this.emailService.send({
      to: body.email,
      type: key as any,
      data: SAMPLE_DATA,
    });
    return result;
  }
}

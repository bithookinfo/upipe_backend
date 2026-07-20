import {
  Controller,
  Get,
  Post,
  Param,
  Res,
  Req,
  NotFoundException,
  BadRequestException,
  Logger,
  Query,
} from "@nestjs/common";
import { Response, Request } from "express";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { PaymentLinkService } from "../services/payment-link.service";
import { QrcodeService } from "../services/qrcode.service";
import { PHONEPE_LOGO, GPAY_LOGO, PAYTM_LOGO, UPIPE_LOGO, OTHER_UPI_LOGO } from "./logos";

@ApiTags("Payment Pages")
@Controller("")
export class PaymentPageController {
  private readonly logger = new Logger(PaymentPageController.name);

  constructor(
    private readonly paymentLinkService: PaymentLinkService,
    private readonly qrcodeService: QrcodeService,
  ) {}

  @Get("payment/:linkToken")
  @ApiOperation({
    summary: "Modern payment page",
    description: "Beautiful, modern payment page with improved UX",
  })
  async getPaymentPage(
    @Param("linkToken") linkToken: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    try {
      const response = await this.paymentLinkService.getPaymentLink(linkToken);

      if (!response || !response.paymentLink) {
        throw new NotFoundException("Payment link not found or expired");
      }

      const paymentLink = response.paymentLink;

      const scanData = {
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers["user-agent"] as string,
        deviceType: this.detectDeviceType(req.headers["user-agent"] as string),
      };

      const qrCodeData = await this.qrcodeService.getQrCode(
        linkToken,
        scanData,
      );

      const html = this.generatePaymentPageHTML(paymentLink, qrCodeData);

      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch (error) {
      this.logger.error(
        `Failed to serve payment page for token ${linkToken}:`,
        error,
      );

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        res
          .status(404)
          .send(
            this.generateErrorPageHTML(
              "Payment Link Expired",
              "This payment link has expired or is no longer valid. Please request a new payment link from the merchant.",
            ),
          );
      } else {
        res
          .status(500)
          .send(
            this.generateErrorPageHTML(
              "Payment Error",
              "Something went wrong. Please try again later.",
            ),
          );
      }
    }
  }

  @Post("payments/generate-qr/:orderId")
  @ApiOperation({
    summary: "Generate QR Code API",
    description: "Generates a QR code and payment link for an order (JSON API)",
  })
  async generateQr(
    @Param("orderId") orderId: string,
    @Query("force") force?: string,
  ) {
    return this.qrcodeService.createQrCode(orderId, 5, force === "true");
  }

  @Post("payments/upi/qr")
  @ApiOperation({
    summary: "Generate UPI QR Code",
    description:
      "Generates a UPI QR code from payment details without requiring an order",
  })
  async generateUpiQr(@Req() req: Request) {
    const { amount, payeeVpa, payeeName, transactionId, transactionNote } =
      req.body;

    if (!amount || !payeeVpa || !payeeName) {
      throw new BadRequestException(
        "Missing required fields: amount, payeeVpa, payeeName",
      );
    }

    const sanitizedNote = (transactionNote || `PaymentTo${payeeName}`).replace(
      /[^a-zA-Z0-9]/g,
      "",
    );
    const upiString = `upi://pay?pa=${encodeURIComponent(payeeVpa)}&pn=${encodeURIComponent(payeeName)}&am=${amount}&tr=${transactionId || `QR${Date.now()}`}&tn=${sanitizedNote}`;

    const QRCode = require("qrcode");
    const qrCodeDataUrl = await QRCode.toDataURL(upiString, {
      errorCorrectionLevel: "H",
      type: "image/png",
      width: 300,
      margin: 1,
    });

    return {
      success: true,
      qrCode: qrCodeDataUrl,
      upiString,
      deepLinks: {
        upi: upiString,
        phonepe: `phonepe://pay?${upiString.split("?")[1]}`,
        gpay: `tez://upi/pay?${upiString.split("?")[1]}`,
        paytm: `paytmmp://pay?${upiString.split("?")[1]}`,
      },
      paymentDetails: {
        amount,
        payeeVpa,
        payeeName,
        transactionId: transactionId || `QR_${Date.now()}`,
        transactionNote: transactionNote || `Payment to ${payeeName}`,
      },
    };
  }

  @Get("payments/status/:orderId")
  @ApiOperation({
    summary: "Check Order Payment Status",
    description: "Check status of an order payment",
  })
  async checkPaymentStatus(@Param("orderId") orderId: string) {
    try {
      return this.paymentLinkService.checkOrderStatus(orderId);
    } catch (e) {
      throw new NotFoundException("Order not found");
    }
  }

  private generatePaymentPageHTML(paymentLink: any, qrCodeData: any): string {
    const order = paymentLink.order;
    const isExpired = paymentLink.expiresAt
      ? new Date(paymentLink.expiresAt) < new Date()
      : false;
    const timeLeftSeconds = paymentLink.expiresAt
      ? Math.max(
          0,
          Math.floor(
            (new Date(paymentLink.expiresAt).getTime() - new Date().getTime()) /
              1000,
          ),
        )
      : 0;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay ₹${order.amount} · Upipe</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #F7F6F3;
      --surface: #FFFFFF;
      --surface-2: #F2F1EE;
      --surface-3: #E9E8E4;
      --text-primary: #111110;
      --text-secondary: #6F6E69;
      --text-tertiary: #A8A7A2;
      --accent: #0A6E5A;
      --accent-light: #E6F5F1;
      --accent-text: #0A4A3C;
      --border: rgba(0,0,0,0.08);
      --border-strong: rgba(0,0,0,0.14);
      --timer-bg: #FFF8EE;
      --timer-border: #F5C87A;
      --timer-text: #7A4A00;
      --success: #1A7A4A;
      --success-bg: #EDFAF3;
      --danger: #C0392B;
      --danger-bg: #FDF0EE;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 18px;
      --radius-xl: 24px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
      --shadow-md: 0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04);
      --shadow-lg: 0 12px 40px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05);
    }

    body {
      font-family: 'DM Sans', sans-serif;
      background: var(--bg);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }

    /* ─── Logo ─── */
    .logo-row {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 4px;
    }
    .logo-row img {
      height: 28px;
      object-fit: contain;
    }

    /* ─── Card & Columns ─── */
    .card {
      background: transparent;
      width: 100%;
      max-width: 420px;
      overflow: hidden;
      margin: 0 auto;
    }
    .card-body-wrapper {
      display: flex;
      flex-direction: column;
    }
    .card-left-column {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    /* ─── Amount header ─── */
    .card-header {
      padding: 4px 16px 4px;
      background: transparent;
      border-bottom: none;
    }
    .amount-wrap {
      display: flex;
      flex-direction: column;
    }
    .scan-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.5px;
      margin-bottom: 6px;
    }
    .amount-subtitle {
      font-size: 14px;
      font-weight: 400;
      color: var(--text-secondary);
    }
    .amount-subtitle strong {
      font-weight: 600;
      color: var(--text-primary);
    }

    /* ─── Timer pill ─── */
    .timer-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--timer-bg);
      border: 1px solid var(--timer-border);
      border-radius: 100px;
      padding: 4px 10px;
      margin-top: 12px;
    }
    .timer-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--timer-text);
      opacity: 0.7;
      animation: blink 1.4s ease-in-out infinite;
    }
    @keyframes blink { 0%,100%{opacity:0.7} 50%{opacity:0.2} }
    .timer-text {
      font-size: 11px;
      font-weight: 500;
      color: var(--timer-text);
      font-family: 'DM Mono', monospace;
    }

    /* ─── Order meta ─── */
    .meta-grid {
      padding: 12px 20px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      border-bottom: 1px solid var(--border);
    }
    .meta-key {
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: var(--text-tertiary);
      margin-bottom: 2px;
    }
    .meta-val {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      font-family: 'DM Mono', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta-val.plain {
      font-family: 'DM Sans', sans-serif;
    }

    /* ─── QR section ─── */
    .qr-section {
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
    }
    .qr-wrap {
      position: relative;
      width: 180px;
      height: 180px;
      border-radius: var(--radius-md);
      overflow: hidden;
      border: 1px solid var(--border-strong);
      background: #fff;
    }
    .qr-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .qr-corner {
      position: absolute;
      width: 14px;
      height: 14px;
      border-color: var(--accent);
      border-style: solid;
    }
    .qr-corner.tl { top: 6px; left: 6px; border-width: 2px 0 0 2px; border-radius: 3px 0 0 0; }
    .qr-corner.tr { top: 6px; right: 6px; border-width: 2px 2px 0 0; border-radius: 0 3px 0 0; }
    .qr-corner.bl { bottom: 6px; left: 6px; border-width: 0 0 2px 2px; border-radius: 0 0 0 3px; }
    .qr-corner.br { bottom: 6px; right: 6px; border-width: 0 2px 2px 0; border-radius: 0 0 3px 0; }

    .qr-hint {
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-tertiary);
      text-align: center;
    }
    .qr-hint strong {
      color: var(--text-secondary);
      font-weight: 500;
    }

    /* UPI logo strip */
    .upi-logos {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
    }
    .upi-logo-badge {
      height: 20px;
      padding: 0 6px;
      border-radius: 4px;
      background: var(--surface);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 600;
      color: var(--text-secondary);
    }
    .upi-badge-label {
      font-size: 11px;
      color: var(--text-tertiary);
    }

    /* ─── Pay buttons ─── */
    .pay-section {
      padding: 20px 24px;
    }
    .pay-section-label {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--text-tertiary);
      margin-bottom: 12px;
    }
    .pay-btns {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pay-btn {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 9px 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-strong);
      background: var(--surface);
      cursor: pointer;
      text-align: left;
      transition: background 0.15s, border-color 0.15s, transform 0.1s;
      text-decoration: none;
    }
    .pay-btn:hover {
      background: var(--surface-2);
      border-color: rgba(0,0,0,0.18);
    }
    .pay-btn:active { transform: scale(0.99); }

    .pay-btn-icon {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background: var(--surface-2);
      border: 1px solid var(--border);
      overflow: hidden;
      transition: background-color 0.15s, border-color 0.15s;
    }
    .pay-btn-icon img { width: 35px; height: 35px; object-fit: contain; }
    .pay-btn-icon svg { width: 24px; height: 24px; }

    /* Brand-specific icon and button styling */
    .btn-phonepe .pay-btn-icon {
      background: #F5EEFD; /* PhonePe soft purple */
      border-color: #E2D1F9;
    }
    .btn-phonepe:hover {
      background: #FAF6FE !important;
      border-color: #5f259f !important;
    }
    .btn-phonepe:hover .pay-btn-arrow {
      color: #5f259f !important;
    }

    .btn-gpay .pay-btn-icon {
      background: #EAF2FE; /* Google Pay soft blue */
      border-color: #CADAFA;
    }
    .btn-gpay:hover {
      background: #F5F9FF !important;
      border-color: #1a73e8 !important;
    }
    .btn-gpay:hover .pay-btn-arrow {
      color: #1a73e8 !important;
    }

    .btn-paytm .pay-btn-icon {
      background: #E6F3FC; /* Paytm soft light blue */
      border-color: #C6E3F7;
    }
    .btn-paytm:hover {
      background: #F1F9FF !important;
      border-color: #00baf2 !important;
    }
    .btn-paytm:hover .pay-btn-arrow {
      color: #00baf2 !important;
    }

    .btn-other-upi .pay-btn-icon {
      background: #F5F3FF; /* Violet soft */
      border-color: #EDE9FE;
    }
    .btn-other-upi:hover {
      background: #FAFAF9 !important;
      border-color: #8b5cf6 !important;
    }

    .pay-btn-label {
      flex: 1;
    }
    .pay-btn-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      display: block;
    }
    .pay-btn-sub {
      font-size: 11px;
      color: var(--text-tertiary);
      display: block;
      margin-top: 1px;
    }
    .pay-btn-arrow {
      color: var(--text-tertiary);
      font-size: 13px;
      flex-shrink: 0;
      transition: color 0.15s;
    }

    /* Primary CTA button (UPI generic) */
    .pay-btn.primary {
      background: var(--text-primary);
      border-color: var(--text-primary);
    }
    .pay-btn.primary .pay-btn-title { color: #fff; }
    .pay-btn.primary .pay-btn-sub { color: rgba(255,255,255,0.55); }
    .pay-btn.primary .pay-btn-arrow { color: rgba(255,255,255,0.4); }
    .pay-btn.primary .pay-btn-icon { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.15); }
    .pay-btn.primary:hover { background: #222; border-color: #222; }

    /* ─── Divider ─── */
    .divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 2px 0;
    }
    .divider-line { flex: 1; height: 1px; background: var(--border); }
    .divider-text { font-size: 10px; color: var(--text-tertiary); font-weight: 500; letter-spacing: 0.3px; }

    /* ─── Secure badge ─── */
    .secure-badge {
      text-align: center;
      padding: 12px 28px 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--text-tertiary);
      font-size: 11px;
      border-top: 1px solid var(--border);
    }
    .secure-badge svg { width: 12px; height: 12px; opacity: 0.5; }

    /* ─── Status overlay ─── */
    #status-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: var(--bg);
      z-index: 100;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    #status-overlay.visible { display: flex; }
    .status-card {
      background: var(--surface);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-lg);
      border: 1px solid var(--border);
      width: 100%;
      max-width: 400px;
      padding: 40px 32px;
      text-align: center;
      transform: scale(0.9);
      opacity: 0;
      transition: transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.45s ease-out;
    }
    #status-overlay.visible .status-card {
      transform: scale(1);
      opacity: 1;
    }
    .status-icon-wrap {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
      position: relative;
    }
    .status-icon-wrap.success { background: var(--success-bg); }
    .status-icon-wrap svg { width: 28px; height: 28px; }

    /* Premium SVG Checkmark Draw Animation */
    .checkmark-svg {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      display: block;
      stroke-width: 4;
      stroke: #1A7A4A;
      stroke-miterlimit: 10;
      box-shadow: inset 0px 0px 0px #1A7A4A;
      animation: fillCheckmark .4s ease-in-out .4s forwards, scaleCheckmark .3s ease-in-out .9s both;
    }
    .checkmark-circle {
      stroke-dasharray: 166;
      stroke-dashoffset: 166;
      stroke-width: 4;
      stroke-miterlimit: 10;
      stroke: #1A7A4A;
      fill: none;
      animation: strokeCheckmark 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
    }
    .checkmark-check {
      transform-origin: 50% 50%;
      stroke-dasharray: 48;
      stroke-dashoffset: 48;
      animation: strokeCheckmark 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards;
    }

    @keyframes strokeCheckmark {
      100% {
        stroke-dashoffset: 0;
      }
    }
    @keyframes scaleCheckmark {
      0%, 100% {
        transform: none;
      }
      50% {
        transform: scale3d(1.1, 1.1, 1);
      }
    }
    @keyframes fillCheckmark {
      100% {
        box-shadow: inset 0px 0px 0px 32px #EDFAF3;
      }
    }

    /* Confetti Particle Animation */
    .confetti-particle {
      position: absolute;
      border-radius: 50%;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(1);
      animation: burstConfetti 1.2s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
      pointer-events: none;
      z-index: 10;
    }
    @keyframes burstConfetti {
      0% {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
      }
      100% {
        transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0);
        opacity: 0;
      }
    }

    .status-title {
      font-size: 22px;
      font-weight: 500;
      letter-spacing: -0.5px;
      color: var(--text-primary);
      margin-bottom: 8px;
    }
    .status-desc { font-size: 14px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px; }
    .status-meta {
      background: var(--surface-2);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      text-align: left;
      margin-bottom: 24px;
    }
    .status-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      padding: 3px 0;
    }
    .status-meta-key { color: var(--text-tertiary); }
    .status-meta-val { font-weight: 500; font-family: 'DM Mono', monospace; font-size: 12px; }
    .status-redirect {
      font-size: 12px;
      color: var(--text-tertiary);
      background: var(--surface-2);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      margin-bottom: 20px;
    }
    .btn-close {
      width: 100%;
      padding: 13px;
      border-radius: var(--radius-md);
      background: var(--text-primary);
      color: #fff;
      border: none;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      transition: background 0.15s;
    }
    .btn-close:hover { background: #222; }

    /* ─── Expired state ─── */
    .expired-card {
      background: var(--surface);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-lg);
      border: 1px solid var(--border);
      width: 100%;
      max-width: 400px;
      padding: 48px 32px;
      text-align: center;
    }
    .expired-icon {
      width: 56px;
      height: 56px;
      background: var(--danger-bg);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .expired-icon svg { width: 24px; height: 24px; color: var(--danger); }
    .expired-title { font-size: 20px; font-weight: 500; letter-spacing: -0.4px; margin-bottom: 10px; }
    .expired-desc { font-size: 14px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 28px; }

    /* ─── Responsive & Viewport Adjustments ─── */
    .desktop-only { display: flex; }
    .mobile-only { display: none; }
    
    @media (max-width: 720px) {
      body { padding: 12px; }
      .card { max-width: 100%; border: none; box-shadow: none; background: transparent; }
      
      .card-body-wrapper {
        display: flex;
        flex-direction: column;
      }
      
      .card-header { padding: 10px 0 20px; text-align: center; justify-content: center; border-bottom: none; }
      .amount-wrap { align-items: center; }
      .amount-label { font-size: 20px; font-weight: 700; color: var(--text-main); text-transform: none; }
      .amount-value { font-size: 16px; font-weight: 500; color: var(--text-secondary); margin-top: 4px; }
      .amount-value::before { content: "Amount to pay: "; font-weight: 400; font-size: 14px; }
      
      .meta-grid { display: none; }
      
      .qr-section {
        padding: 20px;
        display: flex;
      }
      .qr-section .qr-wrap {
        width: 200px;
        height: 200px;
      }
      
      /* Move timer below QR */
      .timer-mobile-wrap { display: flex; justify-content: space-between; padding: 12px 16px; border: 1px dashed var(--border-strong); border-radius: 24px; margin-bottom: 24px; font-size: 13px; color: var(--text-secondary); }
      .card-header .timer { display: none; }
      
      .pay-section { padding: 24px 16px; background: #fdfdfd; border: 1px solid #eef2f6; border-radius: 16px; }
      .pay-section-label { display: none; }
      .pay-section::before { content: "PAY WITH DIRECT UPI APPS"; display: block; font-size: 12px; font-weight: 700; color: #1e3a8a; margin-bottom: 16px; letter-spacing: 0.5px; }
      
      .pay-btns {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      .pay-btn#pay-upi-btn { order: 4; }
      .pay-btn.btn-gpay { order: 1; }
      .pay-btn.btn-paytm { order: 2; }
      .pay-btn.btn-phonepe { order: 3; }
      
      .divider { display: none; }
      
      .pay-btn {
        flex-direction: row;
        justify-content: center;
        padding: 12px 8px;
        gap: 8px;
        background: #fff !important;
        border: 1px solid #eef2f6 !important;
        border-radius: 12px;
        color: var(--text-main) !important;
        box-shadow: 0 2px 4px rgba(0,0,0,0.02);
      }
      .pay-btn .pay-btn-arrow { display: none; }
      .pay-btn .pay-btn-sub { display: none; }
      .pay-btn .pay-btn-icon { width: 24px; height: 24px; background: transparent; border-radius: 0; }
      .pay-btn .pay-btn-title { font-size: 14px; font-weight: 600; }

      /* Special styling for Open UPI App button on mobile to match grid */
      .pay-btn#pay-upi-btn .pay-btn-icon svg { color: #10b981; }

    }


    .timer-mobile-wrap { 
      display: flex; 
      justify-content: space-between; 
      padding: 8px 16px; 
      border: 1.5px dashed rgba(0,0,0,0.12); 
      border-radius: 16px; 
      margin: 0 16px 8px; 
      font-size: 13px; 
      color: var(--text-secondary); 
    }
    
    .pay-section { 
      padding: 12px 16px; 
      background: var(--surface); 
      border: 1px solid rgba(0,0,0,0.06); 
      border-radius: 20px; 
      margin: 0 16px 8px;
    }
    .pay-section::before { content: "PAY WITH DIRECT UPI APPS"; display: block; font-size: 12px; font-weight: 700; color: #1e3a8a; margin-bottom: 16px; letter-spacing: 0.5px; }
    .pay-section-label { display: none; }
    .divider { display: none; }
    
    .pay-btns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .pay-btn#pay-upi-btn { order: 4; }
    .pay-btn.btn-gpay { order: 1; }
    .pay-btn.btn-paytm { order: 2; }
    .pay-btn.btn-phonepe { order: 3; }

    .pay-btn {
      flex-direction: row;
      justify-content: center;
      padding: 12px 8px;
      gap: 8px;
      background: #fff !important;
      border: 1px solid #eef2f6 !important;
      border-radius: 12px;
      color: var(--text-main) !important;
      box-shadow: 0 2px 4px rgba(0,0,0,0.02);
      width: 100%;
    }
    .pay-btn .pay-btn-arrow { display: none; }
    .pay-btn .pay-btn-sub { display: none; }
    .pay-btn .pay-btn-icon { width: 24px; height: 24px; background: transparent; border-radius: 0; display: flex; align-items: center; justify-content: center; }
    .pay-btn .pay-btn-title { font-size: 14px; font-weight: 600; }
    .pay-btn#pay-upi-btn .pay-btn-icon svg { color: #10b981; }

    @media (max-width: 720px) {
      .qr-section { margin: 16px 0; }
      .timer-mobile-wrap { margin: 0 0 24px 0; }
      .pay-section { padding: 24px 16px; border: 1px solid #eef2f6; border-radius: 16px; }
    }
    /* ─── Enter animation ─── */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes slideDown {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .card, .logo-row {
      animation: fadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    .logo-row { animation-delay: 0.05s; }
  </style>
</head>
<body>

  <!-- Status overlay (hidden, shown on success) -->
  <div id="status-overlay">
    <div class="status-card" id="status-card-content"></div>
  </div>

  <!-- Logo -->
  <div class="logo-row">
    <img src="${UPIPE_LOGO}" alt="Upipe">
  </div>

  ${isExpired ? `
  <!-- Expired -->
  <div class="expired-card">
    <div class="expired-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>
    <div class="expired-title">Link expired</div>
    <div class="expired-desc">This payment link is no longer valid. Please request a new one from the merchant.</div>
    <button class="btn-close" onclick="window.close()">Close window</button>
  </div>
  ` : `
  <div class="card">
      <div class="card-left-column">
        <div class="card-header">
          <div class="amount-wrap">
            <div class="scan-title">Scan QR to Pay</div>
            <div class="amount-subtitle">Amount to pay: <strong>₹${Number(order.amount).toLocaleString()}</strong></div>
          </div>
        </div>

        <div class="qr-section" id="qr-section">
          <div class="qr-wrap">
            <img src="${qrCodeData.qrCode.dataUrl || qrCodeData.qrCode.url}" alt="UPI QR code">
            <div class="qr-corner tl"></div>
            <div class="qr-corner tr"></div>
            <div class="qr-corner bl"></div>
            <div class="qr-corner br"></div>
          </div>
          <img src="${qrCodeData.qrCode.dataUrl || qrCodeData.qrCode.url}" 
               alt="Payment QR Code" 
               class="qr_code_img" 
               style="max-width: 240px; width: 100%;" hidden>
          <!-- QR scan status indicator -->
          <div id="qr-status" class="hidden mt-3 p-2 bg-white rounded-lg shadow-sm" style="display: none;">
            <p id="qr-state-text" class="text-xs font-medium"></p>
          </div>
          <p class="qr-hint desktop-only">Scan with any UPI app to pay</p>
          <p class="qr-hint mobile-only">Or scan QR with another device</p>
          <div class="upi-logos">
            <span class="upi-badge-label">Works with</span>
            <div class="upi-logo-badge">GPay</div>
            <div class="upi-logo-badge">PhonePe</div>
            <div class="upi-logo-badge">Paytm</div>
            <div class="upi-logo-badge">BHIM</div>
          </div>
        </div>



        <div class="timer-mobile-wrap">
          <span>QR expires in</span>
          <strong style="color: #059669;" id="time-left-mobile">05:00</strong>
        </div>

        <div class="pay-section">
          <div class="pay-section-label">Pay directly</div>
          <div class="pay-btns">

            <!-- Other UPI Apps -->
            <button class="pay-btn btn-other-upi" id="pay-other-upi-btn" type="button">
              <div class="pay-btn-icon">
                <img src="${OTHER_UPI_LOGO}" alt="Other UPI">
              </div>
              <div class="pay-btn-label">
                <span class="pay-btn-title">Other UPI Apps</span>
              </div>
            </button>

            <!-- UPI generic / Download -->
            <button class="pay-btn primary" id="pay-upi-btn" type="button">
              <div class="pay-btn-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </div>
              <div class="pay-btn-label">
                <span class="pay-btn-title" style="color: #10b981;">Download</span>
              </div>
            </button>

            <!-- PhonePe -->
            <button class="pay-btn btn-phonepe" id="pay-phonepe-btn" type="button">
              <div class="pay-btn-icon">
                <img src="${PHONEPE_LOGO}" alt="PhonePe">
              </div>
              <div class="pay-btn-label">
                <span class="pay-btn-title">PhonePe</span>
              </div>
            </button>

            <!-- Google Pay -->
            <button class="pay-btn btn-gpay" id="pay-gpay-btn" type="button">
              <div class="pay-btn-icon">
                <img src="${GPAY_LOGO}" alt="Google Pay">
              </div>
              <div class="pay-btn-label">
                <span class="pay-btn-title">G Pay</span>
              </div>
            </button>

            <!-- Paytm -->
            <button class="pay-btn btn-paytm" id="pay-paytm-btn" type="button">
              <div class="pay-btn-icon">
                <img src="${PAYTM_LOGO}" alt="Paytm">
              </div>
              <div class="pay-btn-label">
                <span class="pay-btn-title">Paytm</span>
              </div>
            </button>

          </div>
        </div>
      </div>
  </div>
  `}

  <script>
  ${!isExpired ? `
    let timeLeftSeconds = ${timeLeftSeconds};

    function triggerConfetti() {
      const wrap = document.querySelector('.status-icon-wrap');
      if (!wrap) return;
      const colors = ['#1A7A4A', '#00baf2', '#5f259f', '#ffc107', '#e81123'];
      for (let i = 0; i < 35; i++) {
        const p = document.createElement('div');
        p.className = 'confetti-particle';
        const color = colors[Math.floor(Math.random() * colors.length)];
        const angle = Math.random() * Math.PI * 2;
        const velocity = 40 + Math.random() * 70;
        const tx = Math.cos(angle) * velocity;
        const ty = Math.sin(angle) * velocity;
        
        p.style.backgroundColor = color;
        p.style.setProperty('--tx', \`\${tx}px\`);
        p.style.setProperty('--ty', \`\${ty}px\`);
        p.style.width = \`\${4 + Math.random() * 5}px\`;
        p.style.height = \`\${4 + Math.random() * 5}px\`;
        
        wrap.appendChild(p);
        setTimeout(() => p.remove(), 1200);
      }
    }

    function updateTimer() {
      const mins = String(Math.floor(timeLeftSeconds / 60)).padStart(2, '0');
      const secs = String(timeLeftSeconds % 60).padStart(2, '0');
      const el = document.getElementById('time-left');
      if (el) el.textContent = mins + ':' + secs;
      const mobileTimer = document.getElementById('time-left-mobile');
      if (mobileTimer) mobileTimer.textContent = mins + ':' + secs;
    }
    updateTimer();
    const countdownInterval = setInterval(() => {
      timeLeftSeconds--;
      if (timeLeftSeconds <= 0) { clearInterval(countdownInterval); location.reload(); }
      updateTimer();
    }, 1000);

    const upiUrl      = '${qrCodeData.qrCode.upiString}';
    const gpayUrl     = '${qrCodeData.qrCode.deepLinks.gpay}';
    const paytmUrl    = '${qrCodeData.qrCode.deepLinks.paytm}';
    const phonepeUrl  = '${qrCodeData.qrCode.deepLinks.phonePe}';

    document.getElementById('pay-upi-btn').addEventListener('click', () => { 
      if (window.innerWidth <= 720) {
        // Trigger download of QR code on mobile
        const link = document.createElement('a');
        link.href = "${qrCodeData.qrCode.dataUrl || qrCodeData.qrCode.url}";
        link.download = "payment-qr.png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        window.location.href = upiUrl; 
      }
    });
    document.getElementById('pay-other-upi-btn').addEventListener('click', () => { window.location.href = upiUrl; });
    document.getElementById('pay-gpay-btn').addEventListener('click', () => { window.location.href = gpayUrl; });
    document.getElementById('pay-paytm-btn').addEventListener('click', () => { window.location.href = paytmUrl; });
    document.getElementById('pay-phonepe-btn').addEventListener('click', () => { window.location.href = phonepeUrl; });

    const orderId = '${order.id}';
    const pollInterval = setInterval(async () => {
      try {
        const baseUrl = '${process.env.PUBLIC_API_URL || ""}';
        const statusUrl = baseUrl ? \`\${baseUrl}/payments/status/\${orderId}\` : \`/payments/status/\${orderId}\`;
        const response = await fetch(statusUrl);
        const data = await response.json();
        const status = (data.status || '').toUpperCase();

        if (status === 'COMPLETED' || status === 'SUCCESS') {
          clearInterval(pollInterval);
          clearInterval(countdownInterval);
          const redirectUrl = '${order.redirectUrl || ""}';
          const overlay = document.getElementById('status-overlay');
          const card = document.getElementById('status-card-content');

          if (redirectUrl) {
            card.innerHTML = \`
              <div class="status-icon-wrap success">
                <svg class="checkmark-svg" viewBox="0 0 52 52">
                  <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
                  <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
              </div>
              <div class="status-title">Payment successful</div>
              <div class="status-desc">₹${Number(order.amount).toLocaleString()} received. Redirecting you back to the merchant…</div>
              <div class="status-redirect" id="redirect-count">Redirecting in 3 seconds</div>
            \`;
            overlay.classList.add('visible');
            setTimeout(triggerConfetti, 100);
            let c = 3;
            const ri = setInterval(() => {
              c--;
              const el = document.getElementById('redirect-count');
              if (el) el.textContent = 'Redirecting in ' + c + ' second' + (c !== 1 ? 's' : '');
              if (c <= 0) {
                clearInterval(ri);
                const sep = redirectUrl.includes('?') ? '&' : '?';
                window.location.href = redirectUrl + sep + 'orderId=${order.externalOrderId}&status=success&amount=${order.amount}';
              }
            }, 1000);
          } else {
            const utrRow = data.utr ? \`
                <div class="status-meta-row">
                  <span class="status-meta-key">UTR / Ref No</span>
                  <span class="status-meta-val">\${data.utr}</span>
                </div>
            \` : \`
                <div class="status-meta-row">
                  <span class="status-meta-key">Transaction ID</span>
                  <span class="status-meta-val">\${data.orderId || orderId}</span>
                </div>
            \`;
            card.innerHTML = \`
              <div class="status-icon-wrap success">
                <svg class="checkmark-svg" viewBox="0 0 52 52">
                  <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
                  <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
              </div>
              <div class="status-title">Payment successful</div>
              <div class="status-desc">Your payment of ₹${Number(order.amount).toLocaleString()} was received.</div>
              <div class="status-meta">
                \${utrRow}
                <div class="status-meta-row">
                  <span class="status-meta-key">Method</span>
                  <span class="status-meta-val">UPI</span>
                </div>
              </div>
              <button class="btn-close" onclick="window.close()">Close window</button>
            \`;
            overlay.classList.add('visible');
            setTimeout(triggerConfetti, 100);
          }
        }
      } catch (err) {
        console.error('Status check error:', err);
      }
    }, 3000);
  ` : ''}
  </script>
</body>
</html>`;
  }

  private generateErrorPageHTML(title: string, message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Upipe</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', sans-serif;
      background: #F7F6F3;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: #fff;
      border-radius: 24px;
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 12px 40px rgba(0,0,0,0.1);
      width: 100%;
      max-width: 380px;
      padding: 48px 32px;
      text-align: center;
    }
    .icon-wrap {
      width: 56px;
      height: 56px;
      background: #FDF0EE;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon-wrap svg { width: 24px; height: 24px; color: #C0392B; }
    h1 { font-size: 20px; font-weight: 500; letter-spacing: -0.4px; color: #111110; margin-bottom: 10px; }
    p { font-size: 14px; color: #6F6E69; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-wrap">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
  }

  private detectDeviceType(userAgent?: string): string {
    if (!userAgent) return "unknown";
    const ua = userAgent.toLowerCase();
    if (ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")) return "mobile";
    else if (ua.includes("tablet") || ua.includes("ipad")) return "tablet";
    else return "desktop";
  }
}
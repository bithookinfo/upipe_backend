export interface SubscriptionRenewalData {
  appName: string;
  orgName: string;
  frontendUrl: string;
  planName: string;
  expiryDate: string;
  supportEmail?: string;
  supportPhone?: string;
}

export function getSubscriptionRenewalHtml(data: SubscriptionRenewalData): string {
  const {
    appName,
    orgName,
    frontendUrl,
    planName,
    expiryDate,
    supportEmail = process.env.SUPPORT_EMAIL as string,
    supportPhone = '+91-XXXXXXXXXX',
  } = data;

  const headerColor = '#059669'; // Emerald green
  const headerText = '🎉 Subscription Renewed Successfully!';

  const expiryFormatted = new Date(expiryDate).toLocaleString('en-IN', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });

  const bodyMessage = `Great news! Your subscription plan <strong>${planName}</strong> for organization <strong>${orgName}</strong> has been successfully renewed. Your service will continue without any interruption.`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${headerText}</title>
      <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; color: #18181b; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background: linear-gradient(135deg, ${headerColor}, #047857); padding: 32px 24px; text-align: center; }
        .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
        .header p { margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px; }
        .content { padding: 32px 24px; }
        .content p { margin: 0 0 16px; line-height: 1.7; color: #3f3f46; font-size: 15px; }
        .info-box { background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin: 20px 0; }
        .info-box .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #065f46; margin: 0 0 4px; font-weight: 600; }
        .info-box .value { font-size: 16px; font-weight: 700; color: #064e3b; margin: 0; }
        .button-container { text-align: center; margin: 28px 0 20px; }
        .button { display: inline-block; background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; }
        .divider { height: 1px; background-color: #e4e4e7; margin: 24px 0; }
        .support-box { background-color: #f4f4f5; border-radius: 8px; padding: 20px; margin: 20px 0; }
        .support-box h3 { margin: 0 0 12px; font-size: 15px; font-weight: 700; color: #18181b; }
        .support-box p { margin: 0 0 6px; font-size: 14px; color: #52525b; line-height: 1.6; }
        .support-box a { color: #059669; text-decoration: none; font-weight: 600; }
        .footer { background-color: #f4f4f5; padding: 20px 24px; text-align: center; font-size: 13px; color: #71717a; border-top: 1px solid #e4e4e7; }
        .footer p { margin: 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${headerText}</h1>
          <p>${planName} Plan • ${orgName}</p>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>${bodyMessage}</p>

          <div class="info-box">
            <p class="label">Plan</p>
            <p class="value">${planName}</p>
            <br>
            <p class="label">New Expiry Date</p>
            <p class="value">${expiryFormatted} IST</p>
          </div>

          <div class="button-container">
            <a href="${frontendUrl}/dashboard" class="button">Go to Dashboard →</a>
          </div>

          <div class="divider"></div>

          <div class="support-box">
            <h3>Need Help? Contact Support</h3>
            <p>📧 Email: <a href="mailto:${supportEmail}">${supportEmail}</a></p>
            <p>📞 Phone: <a href="tel:${supportPhone.replace(/[^+\d]/g, '')}">${supportPhone}</a></p>
            <p>🌐 Support: <a href="${frontendUrl}/support">${frontendUrl}/support</a></p>
          </div>

          <p style="font-size: 13px; color: #a1a1aa;">Thank you for your continued partnership with us!</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

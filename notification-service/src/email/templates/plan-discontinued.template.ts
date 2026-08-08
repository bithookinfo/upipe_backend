export interface PlanDiscontinuedData {
  appName: string;
  orgName: string;
  frontendUrl: string;
  planName: string;
  supportEmail?: string;
  supportPhone?: string;
}

export function getPlanDiscontinuedHtml(data: PlanDiscontinuedData): string {
  const {
    appName,
    orgName,
    frontendUrl,
    planName,
    supportEmail = process.env.SUPPORT_EMAIL as string,
    supportPhone = process.env.SUPPORT_PHONE as string || '+91 8055558292',
  } = data;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Important Update Regarding Your Subscription Plan</title>
      <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; color: #18181b; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background: linear-gradient(135deg, #4f46e5, #3730a3); padding: 32px 24px; text-align: center; }
        .header h1 { margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.3px; }
        .header p { margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px; }
        .content { padding: 32px 24px; }
        .content p { margin: 0 0 16px; line-height: 1.7; color: #3f3f46; font-size: 15px; }
        .info-box { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0; }
        .info-box .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #71717a; margin: 0 0 4px; font-weight: 600; }
        .info-box .value { font-size: 18px; font-weight: 700; color: #0f172a; margin: 0; }
        .btn { display: inline-block; background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 16px; transition: background-color 0.2s; }
        .btn:hover { background-color: #4338ca; }
        .footer { background-color: #fafafa; padding: 24px; text-align: center; border-top: 1px solid #e4e4e7; }
        .footer p { margin: 0 0 8px; font-size: 13px; color: #71717a; }
        .footer a { color: #4f46e5; text-decoration: none; }
        .footer a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Plan Discontinued Notice</h1>
          <p>Important update for ${orgName}</p>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>We are writing to inform you that your current subscription plan, <strong>${planName}</strong>, has been discontinued and is no longer available for renewal on <strong>${appName}</strong>.</p>
          
          <div class="info-box">
            <p class="label">What this means for you:</p>
            <p class="value" style="font-size: 15px; font-weight: normal; margin-top: 8px;">
              Your current active subscription will remain valid until its expiration date. However, once it expires, you will not be able to renew this specific plan.
            </p>
          </div>

          <p>To ensure uninterrupted service for your payment collections, please login to your dashboard and upgrade to one of our new, improved plans before your current subscription expires.</p>
          
          <div style="text-align: center;">
            <a href="${frontendUrl}/dashboard" class="btn" style="color: #ffffff; background-color: #4f46e5; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">View Available Plans</a>
          </div>

          <p style="margin-top: 32px; font-size: 14px;">If you have any questions or need assistance choosing a new plan, our support team is ready to help at <a href="mailto:${supportEmail}" style="color: #4f46e5; text-decoration: none;">${supportEmail}</a> or ${supportPhone}.</p>
          
          <p>Best regards,<br>The ${appName} Team</p>
        </div>
        <div class="footer">
          <p>This is an automated message, please do not reply directly to this email.</p>
          <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

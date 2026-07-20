export interface UsageAlertData {
  milestone: number;
  appName: string;
  orgName: string;
  frontendUrl: string;
  usagePct?: number;
}

export function getUsageAlertHtml(data: UsageAlertData): string {
  const { milestone, appName, orgName, frontendUrl, usagePct } = data;
  const percentage = usagePct || milestone;
  
  const isExhausted = percentage >= 100;
  
  const title = isExhausted 
    ? "Subscription Limit Reached" 
    : `Approaching Subscription Limit (${percentage}%)`;
    
  const bodyMessage = isExhausted
    ? `Your organization <strong>${orgName}</strong> has reached <strong>${percentage}%</strong> of its monthly transaction limit. Further transactions may be blocked until you upgrade your plan or the next billing cycle begins.`
    : `Your organization <strong>${orgName}</strong> has reached <strong>${percentage}%</strong> of its monthly transaction limit. Please consider upgrading your plan to ensure uninterrupted service.`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; color: #18181b; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
        .header { background-color: ${isExhausted ? '#ef4444' : '#f59e0b'}; padding: 24px; text-align: center; }
        .header h1 { margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; }
        .content { padding: 32px 24px; }
        .content p { margin: 0 0 16px; line-height: 1.6; color: #3f3f46; font-size: 16px; }
        .button-container { text-align: center; margin: 32px 0 16px; }
        .button { display: inline-block; background-color: #18181b; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 500; font-size: 16px; }
        .footer { background-color: #f4f4f5; padding: 24px; text-align: center; font-size: 14px; color: #71717a; border-top: 1px solid #e4e4e7; }
        .footer p { margin: 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${title}</h1>
        </div>
        <div class="content">
          <p>Hello,</p>
          <p>${bodyMessage}</p>
          <div class="button-container">
            <a href="${frontendUrl}/admin/dashboard" class="button">View Dashboard</a>
          </div>
          <p>If you need assistance, please contact our support team.</p>
          <p>Thanks,<br>The ${appName} Team</p>
        </div>
        <div class="footer">
          <p>&copy; ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}

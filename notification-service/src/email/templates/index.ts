export interface TemplateContext {
  appName?: string;
  frontendUrl?: string;
  verifyUrl?: string;
  resetUrl?: string;
  userName?: string;
  organizationName?: string;
  roleName?: string;
  orderId?: string;
  amount?: string | number;
  customerName?: string;
  message?: string;
}

function getBaseTemplate(contentParams: {
  appName: string;
  previewText?: string;
  headerTitle: string;
  bodyContent: string;
  buttonHtml?: string;
  footerMessage?: string;
}): string {
  const {
    appName,
    previewText,
    headerTitle,
    bodyContent,
    buttonHtml,
    footerMessage,
  } = contentParams;

  // Safe fallback if previewText isn't explicitly provided
  const hiddenPreviewText = previewText
    ? `<div style="display: none; max-height: 0px; overflow: hidden;">${previewText}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${headerTitle}</title>
    <!--[if mso]>
    <style type="text/css">
      table {border-collapse: collapse;}
      td {font-family: Arial, sans-serif;}
    </style>
    <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1f2937;">
    ${hiddenPreviewText}
    <div style="background-color: #f3f4f6; padding: 40px 20px; text-align: center;">
        <!-- Logo / Header Area -->
        <div style="max-width: 600px; margin: 0 auto; padding-bottom: 24px;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #111827; letter-spacing: -0.5px;">
                ${appName}
            </h1>
        </div>

        <!-- Main Content Card -->
        <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #ffffff; border-radius: 12px; max-width: 600px; width: 100%; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
            <tr>
                <td style="padding: 40px; text-align: left;">
                    <h2 style="margin: 0 0 24px 0; font-size: 20px; font-weight: 600; color: #111827; letter-spacing: -0.3px;">
                        ${headerTitle}
                    </h2>
                    
                    <div style="font-size: 16px; line-height: 26px; color: #4b5563;">
                        ${bodyContent}
                    </div>

                    ${
                      buttonHtml
                        ? `
                    <div style="margin-top: 32px; margin-bottom: 16px;">
                        ${buttonHtml}
                    </div>
                    `
                        : ""
                    }
                    
                    ${
                      footerMessage
                        ? `
                    <div style="margin-top: 32px; border-top: 1px solid #f3f4f6; padding-top: 24px;">
                        <p style="margin: 0; font-size: 14px; line-height: 22px; color: #6b7280;">
                            ${footerMessage}
                        </p>
                    </div>
                    `
                        : ""
                    }
                </td>
            </tr>
        </table>

        <!-- Global Footer -->
        <div style="max-width: 600px; margin: 0 auto; padding-top: 32px; text-align: center;">
            <p style="margin: 0 0 8px 0; font-size: 13px; color: #9ca3af;">
                &copy; ${new Date().getFullYear()} ${appName}. All rights reserved.
            </p>
            <p style="margin: 0; font-size: 12px; color: #9ca3af;">
                This is an automated message. Please do not reply directly to this email.
            </p>
        </div>
    </div>
</body>
</html>`;
}

// Reusable standard button generator
function getButton(
  href: string,
  text: string,
  type: "primary" | "danger" = "primary",
): string {
  const bgColor = type === "danger" ? "#ef4444" : "#4f46e5";
  return `<a href="${href}" style="display: inline-block; padding: 14px 28px; background-color: ${bgColor}; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; text-align: center;">${text}</a>`;
}

export function getVerifyEmailHtml(ctx: TemplateContext): string {
  const { appName = "Upipe", verifyUrl = "#", userName, organizationName, roleName } = ctx;
  const greeting = userName ? `Hi ${userName},` : "Hello,";
  
  let customMessage = `Welcome to <strong>${appName}</strong>! We're thrilled to have you on board.`;
  if (organizationName && roleName) {
    customMessage = `You have been invited to join <strong>${organizationName}</strong> as a <strong>${roleName}</strong> on ${appName}.`;
  } else if (organizationName) {
    customMessage = `You have been invited to join <strong>${organizationName}</strong> on ${appName}.`;
  }

  return getBaseTemplate({
    appName,
    previewText: "Verify your email address to get started.",
    headerTitle: "Verify your email address",
    bodyContent: `
        <p style="margin: 0 0 16px 0;">${greeting}</p>
        <p style="margin: 0 0 16px 0;">${customMessage} To complete your registration and secure your account, please verify your email address by clicking the button below.</p>
      `,
    buttonHtml: getButton(verifyUrl, "Verify Email Address"),
    footerMessage: `If the button above doesn't work, you can securely paste the following link into your browser:<br><br><a href="${verifyUrl}" style="color: #4f46e5; word-break: break-all;">${verifyUrl}</a><br><br>This link will expire in 24 hours.`,
  });
}

export function getResetPasswordHtml(ctx: TemplateContext): string {
  const { appName = "Upipe", resetUrl = "#", userName } = ctx;
  const greeting = userName ? `Hi ${userName},` : "Hello,";

  return getBaseTemplate({
    appName,
    previewText: "Action required: Rest your password.",
    headerTitle: "Reset your password",
    bodyContent: `
        <p style="margin: 0 0 16px 0;">${greeting}</p>
        <p style="margin: 0 0 16px 0;">We received a request to reset the password associated with your <strong>${appName}</strong> account. You can securely set a new password by clicking the button below.</p>
      `,
    buttonHtml: getButton(resetUrl, "Reset Password"),
    footerMessage: `If you did not request a password reset, no further action is required and you can safely ignore this email.<br><br>If the button above doesn't work, copy and paste the following link:<br><br><a href="${resetUrl}" style="color: #4f46e5; word-break: break-all;">${resetUrl}</a><br><br>This password reset link will expire in 1 hour.`,
  });
}

export function getOrderCompletionHtml(ctx: TemplateContext): string {
  const {
    appName = "Upipe",
    orderId = "",
    amount = "",
    customerName = "",
  } = ctx;
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";

  return getBaseTemplate({
    appName,
    previewText: `Your order ${orderId} has been successfully completed.`,
    headerTitle: "Order Successfully Completed",
    bodyContent: `
        <p style="margin: 0 0 16px 0;">${greeting}</p>
        <p style="margin: 0 0 24px 0;">Great news! An order placed on your <strong>${appName}</strong> account has been successfully processed and marked as complete.</p>
        
        <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px; margin-bottom: 16px;">
            <p style="margin: 0 0 12px 0; font-size: 14px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Order Summary</p>
            <table width="100%" border="0" cellpadding="0" cellspacing="0" style="font-size: 15px;">
                <tr>
                    <td style="padding: 8px 0; color: #4b5563;">Order ID</td>
                    <td align="right" style="padding: 8px 0; font-weight: 600; color: #111827;">${orderId}</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; color: #4b5563; border-top: 1px solid #e5e7eb;">Total Amount</td>
                    <td align="right" style="padding: 8px 0; font-weight: 700; color: #111827; font-size: 18px; border-top: 1px solid #e5e7eb;">₹${amount}</td>
                </tr>
            </table>
        </div>
      `,
    footerMessage: `Keep this email for your records. If you have any questions regarding this order, please contact our support team.`,
  });
}

export function getSecurityAlertHtml(ctx: TemplateContext): string {
  const {
    appName = "Upipe",
    message = "A security-related action was performed on your account.",
  } = ctx;

  return getBaseTemplate({
    appName,
    previewText:
      "Security Alert: Important security information regarding your account.",
    headerTitle: "Security Alert",
    bodyContent: `
        <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin-bottom: 24px; border-radius: 0 8px 8px 0;">
            <p style="margin: 0; color: #991b1b; font-weight: 500;">Action Required</p>
        </div>
        <p style="margin: 0 0 16px 0;">We detected a recent security event related to your <strong>${appName}</strong> account. Please review the details below:</p>
        <p style="margin: 0 0 16px 0; padding: 16px; background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; font-weight: 500; color: #111827;">
            "${message}"
        </p>
      `,
    footerMessage: `If you initiated this action, you can safely disregard this email. However, if you do not recognize this activity, please secure your account immediately by changing your password and contacting our support team.`,
  });
}

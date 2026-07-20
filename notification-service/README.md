# Notification Service (Upipe)

Handles email delivery via SMTP (e.g. aaPanel self-hosted mail) and optional in-app notification events.

## Setup

1. Install: `npm install`
2. Copy `.env.example` to `.env` and set:
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (e.g. from aaPanel Mail Server)
   - **From addresses (recommended):**
     - `FROM_EMAIL_AUTH=noreply@yourdomain.com` — auth emails (verify, reset password, security); no reply expected.
     - `FROM_EMAIL_ALERTS=alerts@yourdomain.com` — alert/order emails. If unset, `FROM_EMAIL` or `SMTP_USER` is used.
   - Optional: `REPLY_TO_EMAIL=alerts@yourdomain.com` so Reply on auth emails goes to alerts.
   - `APP_NAME`, `FRONTEND_URL` for links in emails
   - `PORT` (default 3006)
3. Run: `npm run start:dev`

## Internal API

- `POST /internal/send/email` – send an email (called by identity-service, payment-service).
  - Body: `{ to, type, data }`
  - `type`: `verify_email` | `reset_password` | `order_completion` | `security_alert`
  - `data`: template variables (e.g. `verifyUrl`, `resetUrl`, `orderId`, `amount`)

## Template management (Super Admin)

- `GET /notifications/templates` – list all email templates (subject, htmlBody, variables).
- `GET /notifications/templates/:key` – get one template.
- `PUT /notifications/templates/:key` – update template; body `{ subject?, htmlBody? }`.

Templates are stored in `data/email-templates.json` (created on first save). Use placeholders like `{{appName}}`, `{{verifyUrl}}`, `{{orderId}}` in subject and HTML; they are replaced when sending. Set `TEMPLATES_DATA_DIR` to use a different directory.

## Usage from other services

- **Identity-service**: set `NOTIFICATION_SERVICE_URL=http://localhost:3006` and call `POST {NOTIFICATION_SERVICE_URL}/internal/send/email` for verification and password reset emails.
- **Payment-service**: set `NOTIFICATION_SERVICE_URL` and `ORGANIZATION_SERVICE_URL`; order completion emails are sent when webhook is sent and org has `notifications.orderCompletionEmail` enabled.

## Templates

HTML templates live in `src/email/templates/index.ts`. They are mobile-friendly and use inline styles. You can replace with Handlebars/React Email later if needed.

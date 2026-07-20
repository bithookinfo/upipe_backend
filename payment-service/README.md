# Payment Service – Setup Guide

Handles **payments, orders, webhooks, QR generation, and payment statistics**.

Built with NestJS + Prisma.

---

## 1. Environment variables

Configuration is read from `.env` in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3103`
- **DATABASE_URL** – MySQL URL for payment data, e.g.  
  `mysql://user:pass@localhost:3306/greenpay_payment`
- **MERCHANT_SERVICE_URL** – e.g. `http://localhost:3102`
- **IDENTITY_SERVICE_URL** – e.g. `http://localhost:3105`
- **ORGANIZATION_SERVICE_URL** – e.g. `http://localhost:3106`
- **SUBSCRIPTION_SERVICE_URL** – e.g. `http://localhost:3104`
- **JWT_SECRET** – same as `identity-service`
- **WEBHOOK_SECRET** – secret used for signing/verifying webhooks
- **API_GATEWAY_URL** – internal URL of the API gateway, e.g. `http://localhost:3100/api/v1`
- **PUBLIC_API_URL** – base URL merchants use to call payment APIs, e.g.  
  `http://localhost:3103/api/v1` or your public API domain
- **ALLOWED_ORIGINS** – e.g. `http://localhost:5173,http://localhost:5174`

> Do not commit `.env`; only `.env.example` is versioned.

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Database & Prisma

Ensure the database exists, then run:

```bash
npx prisma migrate deploy
```

Optional:

- `npm run prisma:generate` – regenerate Prisma client
- Seed scripts (if any) for initial test data

---

## 4. Run in development

```bash
npm run start:dev
```

Service runs on `http://localhost:3103` by default.

---

## 5. Build & production

```bash
npm run build
npm run start:prod
```

Or with `pm2`:

```bash
pm2 start dist/main.js --name payment-service
```

---

## 6. Role in the system

The Payment Service:

- Creates and manages payment orders
- Sends and receives webhooks from external payment providers
- Sends order completion notifications (via `notification-service`)

It works together with `merchant-service`, `identity-service`, and `organization-service`
to support the full payment flow.


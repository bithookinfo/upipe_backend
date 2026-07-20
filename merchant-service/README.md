# Merchant Service – Setup Guide

Handles **merchant accounts, routing to payment providers, transaction sync, and related business logic**.

Built with NestJS + Prisma, uses MySQL and Redis.

---

## 1. Environment variables

Config is loaded from `.env` in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3102`
- **DATABASE_URL** – MySQL URL for merchant data, e.g.  
  `mysql://user:pass@localhost:3306/greenpay_merchant`
- **IDENTITY_SERVICE_URL** – e.g. `http://localhost:3105`
- **ORGANIZATION_SERVICE_URL** – e.g. `http://localhost:3106`
- **PAYMENT_SERVICE_URL** – e.g. `http://localhost:3103`
- **SUBSCRIPTION_SERVICE_URL** – e.g. `http://localhost:3104`
- **MERCHANT_SERVICE_URL** – usually `http://localhost:3102`
- **JWT_SECRET** – must match `identity-service`
- **PHONEPE_CHECKSUM_ENDPOINT** – your checksum endpoint URL (if using PhonePe simple flow)
- **REDIS_HOST / REDIS_PORT** – Redis connection (default: `localhost` / `6379`)
- **PHONEPE_USE_WEB_FLOW** – `true` / `false` depending on integration
- **ALLOWED_ORIGINS** – e.g. `http://localhost:5173,http://localhost:5174`

> Never commit `.env` to Git.

---

## 2. Install dependencies

```bash
npm install
```

Make sure Redis is running if you use features that depend on it.

---

## 3. Database & Prisma

Create the database defined in `DATABASE_URL`, then run:

```bash
npx prisma migrate deploy
```

Optional:

- `npm run prisma:generate` – regenerate Prisma client
- Seed scripts (if any) for initial merchant data

---

## 4. Run in development

```bash
npm run start:dev
```

Service listens on `http://localhost:3102` by default.

---

## 5. Build & production

```bash
npm run build
npm run start:prod
```

Or with `pm2`:

```bash
pm2 start dist/main.js --name merchant-service
```

---

## 6. Role in the system

The Merchant Service is responsible for:

- Managing merchants and their configuration
- Routing payment requests to providers (e.g. PhonePe)
- Coordinating with `payment-service` for transaction status

Ensure this service is running along with `identity-service`, `organization-service`,
`payment-service`, and `subscription-service` before using merchant flows in the frontends.


# Subscription Service – Setup Guide

Manages **plans, subscriptions, and assignments of plans to organizations/merchants**.

Built with NestJS + Prisma.

---

## 1. Environment variables

This service reads configuration from `.env` in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3104`
- **DATABASE_URL** – MySQL URL for subscription data, e.g.  
  `mysql://user:pass@localhost:3306/greenpay_subscription`
- **ORGANIZATION_SERVICE_URL** – e.g. `http://localhost:3106`
- **JWT_SECRET** – must match `identity-service`
- **ALLOWED_ORIGINS** – e.g. `http://localhost:5173,http://localhost:5174`

> Do not commit `.env`; only `.env.example` is versioned.

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Database & Prisma

Ensure the DB in `DATABASE_URL` exists, then run:

```bash
npx prisma migrate deploy
```

Optional:

- `npm run prisma:generate` – regenerate Prisma client

---

## 4. Run in development

```bash
npm run start:dev
```

Service runs on `http://localhost:3104` by default.

---

## 5. Build & production

```bash
npm run build
npm run start:prod
```

Or with `pm2`:

```bash
pm2 start dist/main.js --name subscription-service
```

---

## 6. Role in the system

The Subscription Service is used to:

- Define subscription plans
- Assign plans to organizations/merchants
- Coordinate with `organization-service` for access/limits

Make sure this service is running when working with subscription features in the dashboards.


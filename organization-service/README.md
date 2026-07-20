# Organization Service – Setup Guide

Manages **organizations, roles, permissions, and org-level settings** for Upipe.

Built with NestJS + Prisma.

---

## 1. Environment variables

This service reads config from `.env` in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3106`
- **DATABASE_URL** – MySQL URL for the organization DB, e.g.  
  `mysql://user:pass@localhost:3306/greenpay_organization?connection_limit=5`
- **IDENTITY_SERVICE_URL** – URL of the identity service, e.g. `http://localhost:3105`
- **JWT_SECRET** – same secret as used by `identity-service`
- **ALLOWED_ORIGINS** – e.g. `http://localhost:5173,http://localhost:5174`

> Do **not** commit `.env`; only `.env.example` is in Git.

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Database & Prisma

Ensure the database from `DATABASE_URL` exists.

Run migrations:

```bash
npx prisma migrate deploy
```

Optional:

- `npm run prisma:generate` – regenerate Prisma client
- `npm run seed` – seed initial org/role data (if implemented)

---

## 4. Run in development

```bash
npm run start:dev
```

Service runs on `http://localhost:3106` by default.

---

## 5. Build & production

```bash
npm run build
npm run start:prod
```

Or with `pm2`:

```bash
pm2 start dist/main.js --name organization-service
```

---

## 6. Role in the system

The Organization Service is used by:

- Backends and frontends to fetch organization details
- Permission and role checks
- Subscription assignments (together with `subscription-service`)

Start this after `identity-service` so JWT validation works correctly.


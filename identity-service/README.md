# Identity Service – Setup Guide

Handles **authentication, users, login/signup, JWT tokens, MFA** for Upipe.

Built with NestJS + Prisma.

---

## 1. Environment variables

This service reads config from a `.env` file in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3105`
- **DATABASE_URL** – MySQL URL for the identity database, e.g.  
  `mysql://user:pass@localhost:3306/greenpay_identity`
- **JWT_SECRET / JwtSecret** – long random string; **must match** other backend services
- **ALLOWED_ORIGINS** – list of allowed frontends, e.g.  
  `http://localhost:5173,http://localhost:5174`
- **NOTIFICATION_SERVICE_URL** – URL of `notification-service`, e.g. `http://localhost:3006`
- **FRONTEND_URL** – base URL of the client app (used in email links)
- Optional SMTP / SMS values for OTP and security emails (see `.env.example`).

> Do **not** commit `.env` to Git; only `.env.example` should be versioned.

---

## 2. Install dependencies

From this folder:

```bash
npm install
```

---

## 3. Database & Prisma

Make sure the database in `DATABASE_URL` exists.

Then run migrations:

```bash
npx prisma migrate deploy
```

Optional:

- `npm run prisma:generate` – regenerate Prisma client
- `npm run seed` – seed initial data (if implemented)

---

## 4. Run in development

```bash
npm run start:dev
```

The service will start on `http://localhost:3105` (or the `PORT` you set).

---

## 5. Build & run in production

```bash
npm run build
npm run start:prod
```

In production you typically:

- Keep `.env` on the server (aaPanel / VPS)
- Run `npm run build` once
- Use a process manager like `pm2`:

```bash
pm2 start dist/main.js --name identity-service
```

---

## 6. Role in the system

Other services rely on the Identity Service for:

- Creating and authenticating users
- Issuing and validating JWT tokens
- Email verification and password reset (via `notification-service`)

Make sure this service is running before logging into the frontends.


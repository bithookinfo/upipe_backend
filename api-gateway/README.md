# API Gateway – Setup Guide

The **single HTTP entrypoint** for Upipe.

Frontends (`client-admin`, `super-admin`) talk only to this service. It then routes
requests to the underlying microservices (identity, merchant, payment, etc.).

Built with NestJS.

---

## 1. Environment variables

Configuration is taken from `.env` in this folder.

1. Copy the example:

```bash
cp .env.example .env
```

2. Open `.env` and set:

- **PORT** – default: `3100`
- **IDENTITY_SERVICE_URL** – e.g. `http://localhost:3105`
- **MERCHANT_SERVICE_URL** – e.g. `http://localhost:3102`
- **PAYMENT_SERVICE_URL** – e.g. `http://localhost:3103`
- **SUBSCRIPTION_SERVICE_URL** – e.g. `http://localhost:3104`
- **ORGANIZATION_SERVICE_URL** – e.g. `http://localhost:3106`
- **NOTIFICATION_SERVICE_URL** – e.g. `http://localhost:3006`
- **ALLOWED_ORIGINS** – comma-separated frontend URLs, e.g.  
  `http://localhost:5173,http://localhost:5174`

> `.env` is private; do not commit it.

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Run in development

```bash
npm run start:dev
```

The gateway will run on `http://localhost:3100`, and the API base URL is:

```text
http://localhost:3100/api/v1
```

Point your frontends to this URL via:

- `VITE_API_BASE_URL` in `frontends/client-admin/.env`
- `VITE_API_URL` in `frontends/super-admin/.env`

---

## 4. Build & production

```bash
npm run build
npm run start:prod
```

Or via `pm2`:

```bash
pm2 start dist/main.js --name api-gateway
```

In production you usually put Nginx (or aaPanel) in front of the gateway and expose
it at a domain like `https://api.yourdomain.com`.

---

## 5. Role in the system

The API Gateway:

- Validates and forwards requests to backend services
- Central place for CORS, auth, and routing
- Simplifies frontend configuration (frontends only need one URL)

Start this after the underlying services so routes can forward correctly.


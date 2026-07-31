# UPipe Shared Backend Infrastructure Facts (`SHARED_BACKEND_FACTS.md`)

## 1. Purpose & Scope
This document serves as the single source of truth for shared backend infrastructure facts across all UPipe microservices and payment provider integrations. To prevent duplication and inconsistencies across individual provider documentation (`PHONEPE.md`, `PAYTM.md`, `BHARATPE.md`, `QUINTUS.md`, `HDFC_VYAPAR.md`), all provider integration references must cite this document for shared service ports, database ownership boundaries, inter-service HTTP authentication, and database status enum conventions.

Every fact documented below has been verified directly against the active application code and Prisma schemas in `upipe_backend`.

---

## 2. Verified Service Application Port Mapping

The UPipe backend consists of seven NestJS microservices and an API Gateway. Each microservice binds to an HTTP port defined in its respective `src/main.ts` entrypoint file via `process.env.PORT || <fallback>`.

| Service Name | Verified Fallback Expression (`main.ts`) | Default Application Port | Primary Responsibility |
| :--- | :--- | :--- | :--- |
| **`api-gateway`** | `process.env.PORT` (`api-gateway/src/main.ts`, L59) | `3100` *(via `.env` / default)* | Single public ingress, reverse proxy, CORS, Swagger documentation aggregation, and route forwarding. |
| **`identity-service`** | `process.env.PORT \|\| 3101` (`identity-service/src/main.ts`, L53) | `3101` | Authentication, user registration, JWT lifecycle, OTP verification, and RBAC roles. |
| **`merchant-service`** | `process.env.PORT \|\| 3102` (`merchant-service/src/main.ts`, L43) | `3102` | Merchant accounts, provider connection onboarding (`MerchantProvider`), keep-alive crons, and transaction polling. |
| **`payment-service`** | `process.env.PORT \|\| 3103` (`payment-service/src/main.ts`, L32) | `3103` | Order lifecycle (`Order`), transaction ledger (`Transaction`), payment links (`PaymentLink`), and webhook callback processing. |
| **`subscription-service`** | `process.env.PORT \|\| 3105` (`subscription-service/src/main.ts`, L32) | `3105` | SaaS subscription billing, organization quotas, and merchant provider unlock entitlements (`SubscriptionProviderAccess`). |
| **`organization-service`** | `process.env.PORT \|\| 3106` (`organization-service/src/main.ts`, L56) | `3106` | Tenant organization lifecycle, multi-tenant user memberships, CMS pages, and platform configurations. |
| **`notification-service`** | `process.env.PORT \|\| 3006` (`notification-service/src/main.ts`, L24) | `3006` | Email delivery (SMTP/Nodemailer/SendGrid) and web push notifications (`web-push`). |

### Notes on Service Ports
- **`subscription-service` Port Truth:** While older diagrams occasionally cited `3004`, `subscription-service/src/main.ts` line 32 explicitly defines `const port = process.env.PORT || 3105;`. The verified application port is **`3105`**.
- **`api-gateway` Port Truth:** `api-gateway/src/main.ts` line 59 reads `const port = process.env.PORT;` without an inline code fallback, but its default environment configuration in `.env.example` and `README.md` is **`3100`**.

---

## 3. Verified Database Ownership Rules

All UPipe backend microservices use **MySQL** as their relational database engine (`provider = "mysql"` in all `prisma/schema.prisma` files). There is zero PostgreSQL usage in the UPipe backend.

To preserve strict microservice isolation, each database table is owned and migrated by exactly one service schema:

### 1. `merchant-service` Database Ownership (`merchant-service/prisma/schema.prisma`)
- **`Merchant`**: Core merchant account record.
- **`MerchantProvider`**: Stores provider integrations connected by each merchant (e.g., `PHONEPE`, `PAYTM`, `BHARATPE`, `QUINTUS`, `HDFC_VYAPAR`).
  - Contains encrypted or raw session credentials in the JSON `credentials` column.
  - Contains status flags (`status: MerchantProviderStatus`, `isActive: Boolean @default(true)`), timestamps (`lastSyncedAt`, `lastUsedAt`), and metadata (`metadata: Json?`).
- **`MerchantConfig`**, **`BusinessCategory`**, **`ConfigTemplate`**: Merchant configurations and category templates.

### 2. `payment-service` Database Ownership (`payment-service/prisma/schema.prisma`)
- **`Order`**: Represents a payment order created by a merchant (`externalOrderId`, `amount`, `status`, `payerName`, `utr`, etc.).
- **`Transaction`**: Immutable ledger of payment attempts and reconciled transactions matching an order.
- **`PaymentLink`**: Shareable payment links and dynamic UPI intent URLs.
- **`CallbackLog`**: Audit record of incoming webhook callback payloads and verification outcomes.

### 3. `subscription-service` Database Ownership (`subscription-service/prisma/schema.prisma`)
- **`SubscriptionPlan`**, **`OrgSubscription`**, **`SubscriptionPurchase`**: Plans and tenant subscriptions.
- **`SubscriptionProviderAccess`**: Mappings defining which payment providers (`PHONEPE`, `PAYTM`, `GPAY`, `BHARATPE`, `QUINTUS`, `QUINTUSPAY`, `HDFC`, `SBI`) are entitled for a given subscription plan.
- **`MerchantUnlock`**, **`MerchantUnlockProduct`**: Slot-based merchant unlock allotments.

### Cross-Service Database Isolation
Microservices **never** query another service's MySQL database tables directly. When `merchant-service` (port `3102`) performs background transaction polling or order reconciliation, it interacts with `payment-service` (port `3103`) exclusively over internal HTTP REST endpoints:
- `GET /orders/pending` — Fetch pending orders for reconciliation.
- `GET /orders/:id` — Retrieve specific order details by ID.
- `POST /transactions/sync` — Submit a reconciled transaction and trigger order completion.

---

## 4. Internal HTTP Authentication Mechanism (`x-internal-token`)

For direct inter-service HTTP communication (e.g., `merchant-service` calling `payment-service` over `PAYMENT_SERVICE_URL`), calls bypass external JWT user authentication and instead use an internal secret token header:

```http
x-internal-token: <INTERNAL_SECRET_TOKEN>
```

### Verification in Code (`payment-service/src/guards/internal-auth.guard.ts`)
When `payment-service` receives an internal request, `InternalAuthGuard` inspects the request headers:
1. It reads `req.headers['x-internal-token']`.
2. It validates the value against:
   ```typescript
   const expectedToken = process.env.INTERNAL_SECRET_TOKEN || process.env.INTERNAL_TOKEN || 'upipe_internal_secret_token_2026';
   ```
3. If the token matches, the request is permitted; otherwise, it returns `401 Unauthorized`.

---

## 5. Verified Status Enum Conventions

To prevent confusion between order status values and transaction status values, provider documentation must adhere to the exact GraphQL/Prisma enum literals defined in `payment-service/prisma/schema.prisma` and `merchant-service/prisma/schema.prisma`:

### 1. `OrderStatus` Enum (`payment-service/prisma/schema.prisma`, L175)
```prisma
enum OrderStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
  REFUNDED
  EXPIRED
}
```
- **Key Convention:** A successfully paid order transitions to **`OrderStatus.COMPLETED`**.
- There is **no** `SUCCESS` or `PAID` value in `OrderStatus`. Any documentation stating `Order.status = "SUCCESS"` or `Order.status = "PAID"` is incorrect.

### 2. `TransactionStatus` Enum (`payment-service/prisma/schema.prisma`, L192)
```prisma
enum TransactionStatus {
  PENDING
  SUCCESS
  FAILED
  REFUNDED
}
```
- **Key Convention:** A successful payment attempt or reconciled gateway transaction is recorded with **`TransactionStatus.SUCCESS`**.
- During order reconciliation (`syncTransactionAndCompleteOrder`), the service creates a `Transaction` row with `status = "SUCCESS"` and updates the corresponding `Order` row to `status = "COMPLETED"`.

### 3. `MerchantProviderStatus` Enum (`merchant-service/prisma/schema.prisma`, L180)
```prisma
enum MerchantProviderStatus {
  ACTIVE
  INACTIVE
  EXPIRED
  PENDING
  SUSPENDED
}
```
- **Key Convention:**
  - Active provider connections have `status: "ACTIVE"` and `isActive: true`.
  - When session tokens expire permanently or fail keep-alive circuit breakers (e.g., Paytm after 3 consecutive failures, HDFC after 6 consecutive failures), the provider is marked `status: "EXPIRED"`.
  - For BharatPe, HTTP 401 session expiration sets `metadata.authError = "UNAUTHORIZED"` without changing `status` from `"ACTIVE"` to `"EXPIRED"`.

---

## 6. Webhook Routing Convention (Gateway Proxy vs. Direct Service Route)

For providers that implement webhook notifications (`PHONEPE`, `PAYTM`, `BHARATPE`), incoming HTTP webhooks can be delivered via two valid paths:

1. **API Gateway Proxied Route (Port `3100`):**
   - **URL:** `http://localhost:3100/api/v1/webhooks/<provider>`
   - **Behavior:** `api-gateway` strips the `/api/v1` prefix and proxies the request to `PAYMENT_SERVICE_URL/webhooks/<provider>`.
2. **Direct Payment-Service Route (Port `3103`):**
   - **URL:** `http://localhost:3103/webhooks/<provider>`
   - **Behavior:** `WebhookController` (`@Controller('webhooks')` in `payment-service/src/controllers/webhook.controller.ts`) directly handles `@Post('phonepe')`, `@Post('paytm')`, and `@Post('bharatpe')`.

**Important Note:** Providers without webhook controllers (`QUINTUS`, `HDFC_VYAPAR`) operate exclusively via automated background polling crons in `merchant-service`.

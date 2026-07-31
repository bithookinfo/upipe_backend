# Paytm Provider Integration — UPipe Backend Technical Reference

**Document Version:** 1.1.0  
**Status:** Verified against source code (Audit completed; Internal Consistency Cleaned)  
**Verification Scope:** `api-gateway`, `merchant-service`, `payment-service`

---

## 1. Executive Summary

The **Paytm** integration in the UPipe platform provides Unified Payments Interface (UPI) payment collection, dynamic QR code generation, order synchronization, and automated transaction reconciliation for merchants. Unlike traditional payment gateway integrations that rely solely on server-to-server API credentials (such as API keys or merchant IDs issued via email), UPipe's Paytm integration combines **Puppeteer-based automated browser session onboarding** via the Paytm Business Dashboard (`dashboard.paytm.com`) with **server-to-server webhook verification** and **scheduled polling**.

This document serves as the authoritative, code-verified reference for the Paytm provider implementation across the UPipe backend microservices. Every architectural statement, route, database model, cryptographic method, and cron schedule documented below is derived directly from the active codebase.

```
+---------------------------------------------------------------------------------------------------+
|                                      UPipe Client / Frontend                                      |
+---------------------------------------------------------------------------------------------------+
                                                  |
                         (HTTP / REST via Authorization Bearer JWT)
                                                  v
+---------------------------------------------------------------------------------------------------+
|                                      api-gateway (Port 3100)                                      |
|    - Route Translation: /api/v1/gateway/* -> http://localhost:3102/gateway/*                     |
|    - Webhook Proxy Route: POST /api/v1/webhooks/paytm -> http://localhost:3103/webhooks/paytm     |
|    - Strips client-provided x-organization-id; injects JWT claims & x-internal-token              |
+---------------------------------------------------------------------------------------------------+
                   |                                                              |
    (HTTP / REST / Provider Connect)                              (Webhook Callbacks & Polling)
                   v                                                              v
+--------------------------------------------------+   +--------------------------------------------+
|         merchant-service (Port 3102)             |   |         payment-service (Port 3103)        |
| - ProviderConnectionService                      |   | - WebhookService (POST /webhooks/paytm)    |
| - PaytmSimpleService (Puppeteer Auth/Sessions)   |   | - OrderService (Transaction creation)      |
| - OrderStatusCronService (15-sec Polling)        |   | - PaytmChecksum (AES-128-CBC + SHA-256)    |
| - MySQL Table: merchant_providers (credentials)  |   | - MySQL Tables: orders, transactions       |
+--------------------------------------------------+   +--------------------------------------------+
                   |                                                              |
                   |      (Internal REST over HTTP with x-internal-token)         |
                   +------------------------------------------------------------->|
                   |   - GET /orders?status=PENDING,EXPIRED&limit=500             |
                   |   - GET /orders/:id                                          |
                   |   - POST /transactions/sync                                  |
                   |   - PATCH /orders/:id/status                                 |
                   |                                                              |
                   v                                                              v
+---------------------------------------------------------------------------------------------------+
|                                  Paytm Business Dashboard / API                                   |
|    - Login URL: https://dashboard.paytm.com/login/?referrer=Business (Fallback: /login/)          |
|    - Profile API: https://dashboard.paytm.com/api/v1/merchant/profile                             |
|    - QR Product API: https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all           |
|    - QR Data API: https://dashboard.paytm.com/api/v1/merchant/user/qr-data                        |
|    - Order List API: https://dashboard.paytm.com/api/v3/order/list                                |
+---------------------------------------------------------------------------------------------------+
```

---

## 2. Architecture & Service Boundaries

The Paytm provider workflow spans three core NestJS microservices. Each service runs on an independent application port and communicates over internal HTTP endpoints secured by shared JWT secrets and internal service tokens (`x-internal-token`).

### Verified Service Port Table (Reference: [`SHARED_BACKEND_FACTS.md`](file:///upipe_backend/docs/providers/SHARED_BACKEND_FACTS.md))

The following table lists the application fallback ports explicitly defined in each service's `src/main.ts` file (`process.env.PORT || XXXX`), along with the verified local development URLs referenced in `.env.example`.

> **Note on Container Host Mappings:** The repository contains no `Dockerfile` or `docker-compose.yml` manifests. Therefore, container host-to-port mappings do not exist in the codebase and are not presented here.

| Microservice | Application Fallback Port (`src/main.ts`) | Default Local Dev URL (`.env.example`) | Primary Paytm Responsibility |
| :--- | :--- | :--- | :--- |
| **`api-gateway`** | `3100` (`process.env.PORT`, `.env.example`) | `http://localhost:3100` | External routing, authentication, and HTTP header sanitization |
| **`identity-service`** | `3101` (`process.env.PORT || 3101`) | `http://localhost:3101` | User JWT authentication and permissions |
| **`merchant-service`** | `3102` (`process.env.PORT || 3102`) | `http://localhost:3102` | Provider connection, Puppeteer OTP onboarding, QR data, and 15-sec order cron |
| **`payment-service`** | `3103` (`process.env.PORT || 3103`) | `http://localhost:3103` | Order creation, QR generation, signature verification, and webhook callbacks |
| **`subscription-service`** | `3105` (`process.env.PORT || 3105`) | `http://localhost:3105` | Merchant connection limit and subscription quota enforcement |
| **`organization-service`** | `3106` (`process.env.PORT || 3106`) | `http://localhost:3106` | Organization and role management |
| **`notification-service`** | `3006` (`process.env.PORT || 3006`) | `http://localhost:3006` | Notification dispatch for payment and subscription events |

---

### Microservice Responsibilities

#### 1. `api-gateway` (`api-gateway/src/controllers/gateway.controller.ts`)
* **Route Translation:** Intercepts client HTTP requests sent to `/api/v1/gateway/*`.
* **Service Mapping:** Matches the first segment (`gateway`) to `MERCHANT_SERVICE_URL` (`http://localhost:3102`) via `getServiceUrl(path)`.
* **Webhook Proxying:** Proxies incoming requests from `/api/v1/webhooks/paytm` directly to `http://localhost:3103/webhooks/paytm` (`PAYMENT_SERVICE_URL`).
* **Path Prefix Stripping:** Strips `/api/v1` and proxies requests to downstream service URLs.
* **Header Sanitization:** Strips any client-provided `x-organization-id`, `x-user-id`, `x-user-type`, and `x-user-role` headers to prevent cross-tenant data spoofing.
* **Header Injection:** Verifies the Bearer JWT using `JWT_SECRET`, extracts token claims, and injects validated headers (`x-user-id`, `x-organization-id`, `x-user-role`, `x-user-permissions`) along with `x-internal-token`.

#### 2. `merchant-service` (`merchant-service/src/modules/provider/`)
* **Onboarding & Authentication:** Implements `GatewayController` (`/gateway/:providerId/*`) and `ProviderConnectionService`.
* **Puppeteer Automation:** `PaytmSimpleService` launches headless Chromium instances (`puppeteer.use(StealthPlugin())`) to automate login at `https://dashboard.paytm.com/login/?referrer=Business` (with fallback to `https://dashboard.paytm.com/login/`).
* **Session & Cookie Persistence:** Stores active browser sessions in an in-memory map (`browserSessions`) with a 10-minute expiration TTL. Captures session cookies (`merchant_session_id`, `merchant_csrftoken`) upon OTP verification.
* **Account Identification:** Resolves merchant VPA/UPI ID and MID from dashboard HTML/API responses and stores them in MySQL (`merchant_providers`).
* **Background Reconciliation:** Runs `OrderStatusCronService` every 15 seconds (`5,20,35,50 * * * * *`) to poll `https://dashboard.paytm.com/api/v3/order/list` for pending orders.

#### 3. `payment-service` (`payment-service/src/`)
* **Order & Transaction Management:** Manages payment orders (`OrderService`) and transaction records (`TransactionService`) in MySQL.
* **UPI Intent & QR Generation:** Constructs dynamic Paytm UPI intent strings (`upi://pay?pa=...`) and renders base64 PNG/WebP QR code images via `qrcode` package.
* **Webhook Processing:** Receives server-to-server callback notifications at `POST /webhooks/paytm` (`WebhookController`), verifies cryptographic checksums (`WebhookService`), and updates order status.
* **Cryptographic Verification:** Implements `PaytmChecksum` (`payment-service/src/utils/paytmChecksum.ts`) using custom SHA-256 hashing with salt concatenation and AES-128-CBC encryption.

---

## 3. Database Schema & State Models

Both `merchant-service` and `payment-service` use **MySQL** as their relational database engine, explicitly configured via `provider = "mysql"` in their respective `prisma/schema.prisma` definitions.

### 3.1 Required Database Ownership Table

The following table documents the owning microservice, schema file, access method, and caller components for all database models involved in the Paytm payment flow.

> [!IMPORTANT]
> **Strict Database Ownership:** `merchant-service` **never directly accesses** the payment MySQL database. Whenever `OrderStatusCronService` in `merchant-service` needs to read pending orders, synchronize a transaction, or mark an order completed, it executes an **internal HTTP REST call** to `payment-service` over `PAYMENT_SERVICE_URL` (`http://localhost:3103`) authenticated via the `x-internal-token` header.

| Model | Owning Service | Prisma Schema | Accessed By Paytm Component | Access Method |
| :--- | :--- | :--- | :--- | :--- |
| **`MerchantProvider`** | `merchant-service` | `merchant-service/prisma/schema.prisma` | `ProviderConnectionService`, `PaytmSimpleService`, `OrderStatusCronService` (`merchant-service`); `WebhookService` (`payment-service`) | `Local Prisma` (`merchant-service`);<br>`Internal REST` (`GET /merchants/:id/providers/PAYTM/credentials` by `payment-service`) |
| **`Order`** | `payment-service` | `payment-service/prisma/schema.prisma` | `OrderService`, `WebhookService` (`payment-service`); `OrderStatusCronService` (`merchant-service`) | `Local Prisma` (`payment-service`);<br>`Internal REST` (`GET /orders`, `GET /orders/:id`, `PATCH /orders/:id/status` by `merchant-service`) |
| **`Transaction`** | `payment-service` | `payment-service/prisma/schema.prisma` | `TransactionService` (`payment-service`); `OrderStatusCronService` (`merchant-service`) | `Local Prisma` (`payment-service`);<br>`Internal REST` (`POST /transactions/sync` by `merchant-service`) |
| **`PaymentLink`** | `payment-service` | `payment-service/prisma/schema.prisma` | `PaymentLinkService` (`payment-service`) | `Not used by Paytm flow` |
| **`CallbackLog`** | `payment-service` | `payment-service/prisma/schema.prisma` | `WebhookService` (`payment-service`) | `Local Prisma` (`payment-service`) |

---

### 3.2 `MerchantProvider` Table (`merchant-service/prisma/schema.prisma`)

The `merchant_providers` table stores provider credentials, active session tokens, and account identifiers for each connected merchant.

```prisma
model MerchantProvider {
  id                String               @id @default(uuid()) @db.VarChar(36)
  merchantId        String               @map("merchant_id") @db.VarChar(36)
  providerType      ProviderType         @map("provider_type")
  accountIdentifier String?              @map("account_identifier") @db.VarChar(100)
  status            MerchantProviderStatus @default(PENDING_VERIFICATION)
  credentials       Json?
  metadata          Json?
  createdAt         DateTime             @default(now()) @map("created_at")
  updatedAt         DateTime             @updatedAt @map("updated_at")

  merchant          Merchant             @relation(fields: [merchantId], references: [id], onDelete: Cascade)

  @@unique([merchantId, providerType])
  @@index([providerType, status])
  @@index([accountIdentifier])
  @@map("merchant_providers")
}

enum ProviderType {
  PHONEPE
  PAYTM
  GPAY
  BHARATPE
  QUINTUS
  HDFC
}

enum MerchantProviderStatus {
  ACTIVE
  INACTIVE
  EXPIRED
  SUSPENDED
}
```

---

### 3.3 Verified JSON Schema for `credentials` Column

To maintain strict separation between automated onboarding data and out-of-band administrative keys, the `credentials` JSON column is structured into two distinct sources:

#### A. Automatically Stored by Puppeteer Onboarding
When `ProviderConnectionService.connectPaytm` completes OTP verification, it merges `verifyResult` from `PaytmSimpleService.verifyOtpWithPuppeteer` into the `credentials` JSON column. Only the following fields are returned and persisted by the standard Puppeteer onboarding flow:

```json
{
  "upiId": "merchantvpa@paytm",
  "displayName": "Paytm Merchant Display Name",
  "merchantId": "MID_EXTRACTED_FROM_DASHBOARD",
  "username": "9876543210",
  "status": "Active",
  "connectedAt": "2026-07-30T20:00:00.000Z",
  "sessionExpired": false,
  "lastError": null,
  "lastErrorDate": null,
  "merchant_session_id": "SESSION_COOKIE_VALUE",
  "merchant_csrftoken": "CSRF_TOKEN_VALUE",
  "cookies": [
    {
      "name": "merchant_session_id",
      "value": "...",
      "domain": ".paytm.com",
      "path": "/",
      "httpOnly": true,
      "secure": true
    }
  ],
  "qrData": [
    {
      "qrCodeId": "QR_ID_VALUE",
      "qrString": "upi://pay?pa=merchantvpa@paytm&pn=Merchant",
      "status": "ACTIVE"
    }
  ]
}
```

#### B. Optionally or Manually Configured
The following fields are **not extracted by Puppeteer** but are read by `WebhookService` (`payment-service/src/services/webhook.service.ts`, line 154) when verifying server-to-server callback signatures:

```json
{
  "merchantKey": "OPTIONAL_16_CHAR_WEBHOOK_KEY",
  "key": "OPTIONAL_FALLBACK_WEBHOOK_KEY"
}
```

> **These fields are not populated by the standard Puppeteer onboarding flow and must exist through a separate configuration path for webhook verification to succeed.**

---

### 3.4 Status Mappings Across Services

The codebase maintains strict separation between external provider status strings, parsed webhook status strings, and internal database enums.

#### Verified Database Status Enums (`payment-service/prisma/schema.prisma`)

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

enum TransactionStatus {
  PENDING
  SUCCESS
  FAILED
}
```

> **Note on `OrderStatus.PAID` and `FAILED -> PROCESSING`:** `OrderStatus.PAID` does **not exist** in `Prisma.OrderStatus`. Completed orders transition to `OrderStatus.COMPLETED`. Furthermore, transitioning an order from `FAILED -> PROCESSING` is **unsupported and not implemented** in the codebase; once marked `FAILED`, order status cron jobs skip the order.

#### Webhook Mapping Table (`WebhookService`, `payment-service/src/services/webhook.service.ts`)
When a callback arrives at `POST /webhooks/paytm`, `WebhookService.parsePaytmWebhook` evaluates `payload.STATUS` and maps it as follows:

| Paytm Provider Status (`STATUS`) | Parsed Webhook Status (`WebhookPayload.status`) | Mapped `Prisma.OrderStatus` (`mapWebhookStatusToOrderStatus`) | Mapped `Prisma.TransactionStatus` |
| :--- | :--- | :--- | :--- |
| `'TXN_SUCCESS'` | `'SUCCESS'` | `OrderStatus.COMPLETED` | `TransactionStatus.SUCCESS` |
| `'PENDING'` | `'FAILED'` *(mapped to FAILED if not TXN_SUCCESS)* | `OrderStatus.FAILED` | `TransactionStatus.FAILED` |
| `'TXN_FAILURE'` / Any Other String | `'FAILED'` | `OrderStatus.FAILED` | `TransactionStatus.FAILED` |

#### Polling Mapping Table (`OrderStatusCronService`, `merchant-service/src/modules/transaction/order-status-cron.service.ts`)
When `OrderStatusCronService.checkPendingOrders` polls Paytm dashboard order history (`/api/v3/order/list`), it evaluates each transaction's `status` field:

| Paytm Dashboard Order Status (`tx.status`) | Verified Internal Evaluation | Mapped Action / Transition |
| :--- | :--- | :--- |
| `'SUCCESS'` | Exists in `successTransactions` map | Order -> `COMPLETED`, Transaction -> `SUCCESS` |
| `'PENDING'` | Not in success map; order remains `PENDING` / `PROCESSING` | Retained for next polling interval |
| `'FAILED'` / Other | Not in success map | Order -> `FAILED`, Transaction -> `FAILED` |

---

## 4. Merchant Onboarding & Authentication Flow

Onboarding a Paytm merchant in UPipe is performed via an automated, two-phase OTP browser automation flow implemented in `merchant-service`.

### Verified Route & Decorator Verification Table

| Route Path (`GatewayController`) | Controller Decorator (`src/modules/provider/gateway.controller.ts`) | Downstream Service Method Called |
| :--- | :--- | :--- |
| `POST /api/v1/gateway/paytm/send-otp` | `@Controller("gateway")` + `@Post(":providerId/send-otp")` | `ProviderConnectionService.sendPaytmOtp(username, password, organizationId, isSuperAdmin)` |
| `POST /api/v1/gateway/paytm/verify-otp` | `@Controller("gateway")` + `@Post(":providerId/verify-otp")` | `ProviderConnectionService.connectPaytm(merchantId, data)` |

> [!WARNING]
> **No Captcha Flow for Paytm:** The endpoint `POST /api/v1/gateway/:providerId/complete-otp-with-captcha` (`@Post(":providerId/complete-otp-with-captcha")`) in `GatewayController` calls `this.providerService.completePhonePeOtpWithCaptcha(body.sessionId, body.captchaToken)`. This method is **exclusively for PhonePe (`PhonePeSimpleService`)**. `PaytmSimpleService` contains **no captcha handling, no captcha canvas extraction, and no `PaytmCaptchaRequiredException`**.

---

### 4.1 Detailed Onboarding Step-by-Step

```mermaid
sequenceDiagram
    autonumber
    actor Merchant as Merchant (UI)
    participant GW as api-gateway (3100)
    participant Ctrl as GatewayController (3102)
    participant PCS as ProviderConnectionService
    participant PaytmSvc as PaytmSimpleService
    participant Pup as Headless Chromium
    participant PaytmWeb as Paytm Dashboard (dashboard.paytm.com)
    participant DB as MySQL (merchant_providers)

    Merchant->>GW: POST /api/v1/gateway/paytm/send-otp (username, organizationId)
    GW->>Ctrl: POST /gateway/paytm/send-otp (x-organization-id injected)
    Ctrl->>PCS: sendPaytmOtp(username, "", organizationId, isSuperAdmin)
    PCS->>PaytmSvc: sendOtp(username, password, userAgent, sessionId)
    PaytmSvc->>Pup: puppeteer.launch({ headless: true, args: [no-sandbox, StealthPlugin...] })
    Pup->>PaytmWeb: page.goto("https://dashboard.paytm.com/login/?referrer=Business")
    Note over Pup,PaytmWeb: Fallback to /login/ if referrer navigation fails
    PaytmSvc->>Pup: Fill input[name="username"] / mobile field & click Proceed
    PaytmWeb-->>Pup: Paytm sends SMS OTP to merchant mobile
    PaytmSvc-->>PCS: { success: true, sessionId: "uuid-v4", message: "OTP sent" }
    PCS-->>Ctrl: Returns sessionId to client UI
    
    Merchant->>GW: POST /api/v1/gateway/paytm/verify-otp (sessionId, otp, merchantId)
    GW->>Ctrl: POST /gateway/paytm/verify-otp
    Ctrl->>PCS: connectPaytm(merchantId, { username, otp, sessionId, organizationId })
    PCS->>PaytmSvc: verifyOtpWithPuppeteer(sessionId, otp)
    PaytmSvc->>Pup: Enter OTP into digits inputs & await navigation
    Pup->>PaytmWeb: Submit OTP
    PaytmWeb-->>Pup: Login success -> Redirect to Dashboard home
    PaytmSvc->>Pup: Extract browser cookies (merchant_session_id, merchant_csrftoken)
    PaytmSvc->>PaytmWeb: GET /api/v1/merchant/user/qr-data & GET /api/v1/merchant/profile
    PaytmWeb-->>PaytmSvc: Returns UPI VPA (upiId), MID, and QR strings
    PaytmSvc-->>PCS: fullResponse { status: "SUCCESS", upiId, merchantId, qrData... }
    PCS->>DB: prisma.$transaction -> upsert MerchantProvider (status=ACTIVE, credentials=verifyResult)
    PCS-->>Ctrl: { success: true, data: { providerId, upiId, status: "ACTIVE" } }
```

#### Step 1: OTP Initiation (`sendPaytmOtp` -> `PaytmSimpleService.sendOtp`)
1. Client sends `POST /api/v1/gateway/paytm/send-otp` with `{ username: "9876543210", organizationId: "org-uuid" }`.
2. `ProviderConnectionService.sendPaytmOtp` generates a UUID v4 `sessionId` and calls `PaytmSimpleService.sendOtp(username, password, userAgent, sessionId)`.
3. `PaytmSimpleService` initializes Puppeteer with `puppeteer-extra-plugin-stealth`, disabled sandbox flags, and user-agent spoofing.
4. Navigates to `https://dashboard.paytm.com/login/?referrer=Business` (catching navigation errors to retry at `https://dashboard.paytm.com/login/`). Note that `/next/login` **does not exist** in the codebase.
5. Locates the username/mobile input selector, types the phone number, clicks submit, and waits for Paytm's OTP input screen to render.
6. Stores the browser instance and page in `browserSessions.set(sessionId, { browser, page, username, createdAt, expiresAt: now + 600000 })` (10-minute expiry).

#### Step 2: OTP Verification & Account Identification (`connectPaytm` -> `verifyOtpWithPuppeteer`)
1. Client sends `POST /api/v1/gateway/paytm/verify-otp` with `{ sessionId, otp: "123456", merchantId, organizationId }`.
2. `PaytmSimpleService.verifyOtpWithPuppeteer` retrieves the active session from `browserSessions.get(sessionId)`.
3. Types the 6-digit OTP into input fields (`input[type="tel"]`, `.otp-input`, etc.) and awaits network idle.
4. Extracts all browser cookies via `page.cookies()` and locates `merchant_session_id` and `merchant_csrftoken`.
5. Invokes internal Paytm dashboard APIs using the authenticated session cookies:
   * **Merchant Profile:** `https://dashboard.paytm.com/api/v1/merchant/profile` (retrieves merchant display name and profile details).
   * **QR User Data:** `https://dashboard.paytm.com/api/v1/merchant/user/qr-data` (retrieves `upiId` / VPA).
   * **QR Wallet Product:** `https://dashboard.paytm.com/api/v1/qrcode/wallet/product/?type=all&pageNo=1&pageSize=100` (retrieves QR code strings and MID).
6. Returns `fullResponse` containing `upiId`, `displayName`, `merchantId`, `qrData`, and cookies.
7. `ProviderConnectionService.connectPaytm` executes a Prisma transaction (`prisma.$transaction`) to create or update `MerchantProvider` with `status: ACTIVE` and stores the payload in `credentials`.

---

## 5. Payment Processing & QR Generation Flow

UPipe creates Paytm payments by generating dynamic UPI QR codes and deep links that customers scan using any UPI-enabled application (Paytm, Google Pay, PhonePe, BHIM, etc.).

### 5.1 Deep Link and UPI Parameters

When a payment page or API client requests a QR code for a Paytm merchant, `payment-service` constructs a standard NPCI-compliant UPI Intent URI.

```
upi://pay?pa=merchantvpa@paytm&pn=Merchant%20Name&am=150.00&cu=INR&tr=UP1722369600123&tn=Order%20Payment
```

#### Verified Parameter Definitions (`payment-service`)
* **`pa` (Payee Address):** The merchant's Paytm UPI VPA (`upiId` retrieved from `MerchantProvider.credentials.upiId`, e.g., `merchantvpa@paytm`).
* **`pn` (Payee Name):** URL-encoded merchant display name (`displayName` from credentials or merchant profile name).
* **`am` (Amount):** Decimal order amount formatted to two decimal places (`order.amount.toFixed(2)`).
* **`cu` (Currency):** Fixed ISO currency code (`INR`).
* **`tr` (Transaction Reference):** UPipe's unique external order ID (`order.externalOrderId`), which is used during reconciliation to match bank UTRs or order references.
* **`tn` (Transaction Note):** Custom payment description or order summary.

---

## 6. Transaction Synchronization & Polling

To detect successful payments for merchants who do not have server-to-server webhooks configured, UPipe runs scheduled background polling against Paytm's Business Dashboard APIs.

### 6.1 Polling Schedules (`merchant-service`)

All scheduled tasks in `merchant-service` and `payment-service` use `@nestjs/schedule` decorators with literal cron expressions.

| Service | Class / Service | Cron Decorator Schedule Expression | Verified Execution Frequency | Responsibility |
| :--- | :--- | :--- | :--- | :--- |
| `merchant-service` | `OrderStatusCronService` | `@Cron("5,20,35,50 * * * * *", { name: "check-pending-orders" })` | **Every 15 seconds** (at seconds 5, 20, 35, and 50 of each minute) | Polls `/api/v3/order/list` for active Paytm/GPay/PhonePe merchants |
| `merchant-service` | `PaytmSimpleService` | `@Cron("0 */15 * * * *", { name: "paytm-keepalive-inactive-merchants" })` | **Every 15 minutes** (at second 0 of every 15th minute) | Sends lightweight keep-alive requests to keep dashboard session cookies active |
| `merchant-service` | `PaytmSimpleService` | `@Cron("*/30 * * * * *", { name: "paytm-cleanup-abandoned-sessions" })` | **Every 30 seconds** (`sweepAbandonedSessions`) | Sweeps in-memory `browserSessions` and closes Chromium instances exceeding TTL |
| `payment-service` | `CronService` | `@Cron(CronExpression.EVERY_5_MINUTES)` | **Every 5 minutes** (`handlePendingOrders`) | Audits orders stuck in `PENDING` between 10 minutes and 1 hour old |

> **Note on `syncPaytmOrders()`:** No standalone method named `syncPaytmOrders()` exists in the codebase. Transaction synchronization for Paytm is executed inside `OrderStatusCronService.checkPendingOrders()`.

---

### 6.2 Paytm Dashboard API Protocol

During each 15-second tick of `@Cron("5,20,35,50 * * * * *")`, `OrderStatusCronService.checkPendingOrders` calls `PaytmSimpleService.fetchTransactionHistory(provider)` for all active Paytm connections.

#### Verified Request Headers (`PaytmSimpleService.fetchTransactionHistory`)
Requests to `https://dashboard.paytm.com/api/v3/order/list` are authenticated using the session cookies stored in `MerchantProvider.credentials`:

```http
POST /api/v3/order/list HTTP/1.1
Host: dashboard.paytm.com
Content-Type: application/json
Referer: https://dashboard.paytm.com/
Origin: https://dashboard.paytm.com
Cookie: merchant_session_id=SESSION_COOKIE_VALUE; merchant_csrftoken=CSRF_TOKEN_VALUE
x-csrf-token: CSRF_TOKEN_VALUE
```

#### Verified Request Payload (`/api/v3/order/list`)
```json
{
  "startDate": "2026-07-30T19:30:00.000Z",
  "endDate": "2026-07-30T20:00:00.000Z",
  "pageSize": 50,
  "pageNum": 1,
  "orderStatus": "ALL"
}
```

---

## 7. Order Status Verification & Reconciliation

Reconciliation between external Paytm transactions and internal UPipe orders is executed by `OrderStatusCronService.checkPaytmOrdersForMerchant(provider, pendingOrders)` in `merchant-service/src/modules/transaction/order-status-cron.service.ts`.

> [!IMPORTANT]
> **Strict HTTP Communication Flow:** Because `Order` and `Transaction` models are owned by `payment-service`, `OrderStatusCronService` in `merchant-service` executes internal REST calls over HTTP (`PAYMENT_SERVICE_URL`) using `axios` to query pending orders, synchronize transactions, and update order statuses.

```mermaid
flowchart TD
    Start[Cron Tick: 5,20,35,50 * * * * *] --> FetchPending["HTTP GET /orders?status=PENDING,EXPIRED (PAYMENT_SERVICE_URL)"]
    FetchPending --> LoopProviders[Loop Active PAYTM MerchantProviders in Local MySQL]
    LoopProviders --> CallPaytm[PaytmSimpleService.fetchTransactionHistory]
    
    CallPaytm --> Check403{HTTP 403 / Auth Error?}
    Check403 -- Yes --> IncExpired[Increment paytmSessionExpiredHits]
    IncExpired --> CheckThresh{Hits >= paytmSessionExpireThreshold 3 ?}
    CheckThresh -- Yes --> MarkExpired["Update MerchantProvider: status = EXPIRED, paytmSessionExpiredHits = nextHits"]
    CheckThresh -- No --> LogWarning[Log Warning & Retain ACTIVE status]
    
    Check403 -- No --> ResetHits["Reset paytmSessionExpiredHits = 0, status = ACTIVE"]
    ResetHits --> BuildMap[Build successTransactions Map by UTR, OrderID, and Amount]
    
    BuildMap --> IterateOrders[Iterate Pending Orders for Merchant]
    IterateOrders --> MatchCheck{Match Found in successTransactions?}
    
    MatchCheck -- Yes --> SyncTxn["HTTP POST /transactions/sync (status: SUCCESS)"]
    SyncTxn --> CompleteOrder["HTTP PATCH /orders/:id/status (status: COMPLETED, utr)"]
    MatchCheck -- No --> Retain[Retain Status for Next Tick]
```

### 7.1 Verified HTTP REST Calls Between Services (`OrderStatusCronService`)

All calls from `merchant-service` to `payment-service` include the header `x-internal-token: process.env.INTERNAL_TOKEN`:

1. **Pending Order Retrieval (`checkPendingOrders`, lines 66–75):**
   * **Method & Path:** `GET http://localhost:3103/orders` (`PAYMENT_SERVICE_URL`)
   * **Query Params:** `?status=PENDING,EXPIRED&limit=500&includePlatform=true`
   * **Headers:** `{ "x-internal-token": process.env.INTERNAL_TOKEN }`
   * **Controller:** `OrdersController` (`payment-service`)
   * **Failure Behavior:** Catches exception, logs error, and skips polling interval.
2. **Order Status Idempotency Check (`syncTransactionAndCompleteOrder`, lines 1248–1260):**
   * **Method & Path:** `GET http://localhost:3103/orders/:id`
   * **Headers:** `{ "x-internal-token": process.env.INTERNAL_TOKEN }`
   * **Behavior:** Verifies if `orderCheck.data?.order?.status === "COMPLETED"`; if already completed, returns `true` idempotently.
3. **Transaction Synchronization (`syncTransactionAndCompleteOrder`, lines 1268–1279):**
   * **Method & Path:** `POST http://localhost:3103/transactions/sync`
   * **Body Payload:** `{ ...txnData, status: txnData.status === "COMPLETED" ? "SUCCESS" : txnData.status }`
   * **Headers:** `{ "x-internal-token": process.env.INTERNAL_TOKEN }`
   * **Failure Behavior:** If `!syncResponse.data?.success`, logs error `"Failed to sync transaction via API"` and returns `false`.
4. **Order Status Completion (`syncTransactionAndCompleteOrder`, lines 1282–1293):**
   * **Method & Path:** `PATCH http://localhost:3103/orders/:id/status`
   * **Body Payload:** `{ status: "COMPLETED", utr: txnData.utr }`
   * **Headers:** `{ "x-internal-token": process.env.INTERNAL_TOKEN }`
   * **Failure Behavior:** If request fails, catches error and removes `orderId` from in-memory processing lock set.

---

### 7.2 Transaction Matching Algorithm (`checkPaytmOrdersForMerchant`)

1. **Transaction Map Construction:** `checkPaytmOrdersForMerchant` iterates through the array of transactions returned by `/api/v3/order/list` and filters for items where `tx.status === 'SUCCESS'`.
2. **Indexing Keys:** Each successful transaction is indexed in a lookup map (`successTransactions`) under multiple keys:
   * By Paytm Transaction ID (`tx.txnId` or `tx.transactionId`).
   * By Bank UTR / Reference Number (`tx.bankTxnId` or `tx.utr` or `tx.rrn`).
   * By Merchant Order Reference (`tx.orderId` or `tx.merchantOrderId`).
3. **Order Comparison:** For each internal order (`order`) in `PENDING` or `PROCESSING` state:
   * Checks if `order.externalOrderId` or `order.utr` exists in `successTransactions`.
   * **Amount Verification:** Verifies that `parseFloat(tx.amount) === parseFloat(order.amount.toString())`.
4. **State Transition:** When a match is verified, `OrderStatusCronService` calls `payment-service` via REST to mark the order completed and transaction successful.

---

### 7.3 Verified Session Expiration Status (`paytmSessionExpiredHits >= 3`)

Because Paytm dashboard cookies expire over time or upon explicit logout, `OrderStatusCronService` implements automatic failure threshold tracking in `order-status-cron.service.ts` (lines 255–289):

* **Threshold Constant:** `private readonly paytmSessionExpireThreshold = 3;` (line 25).
* **Failure Detection:** If `PaytmSimpleService.fetchTransactionHistory` throws an authentication error or returns HTTP 401/403 (`paytmAuth403`), the cron increments `nextHits = currentHits + 1` and evaluates `const expireNow = nextHits >= this.paytmSessionExpireThreshold;`.
* **Exact Verified State Transition (`lines 266–273`):**
  * When `nextHits < 3`, code updates `MerchantProvider` with `status: "ACTIVE"` and `credentials: { ...config, paytmSessionExpiredHits: nextHits }`, logging a warning while keeping the provider active.
  * When `nextHits >= 3` (`expireNow === true`), code executes:
    ```typescript
    await this.prisma.merchantProvider.update({
      where: { id: provider.id },
      data: {
        status: expireNow ? "EXPIRED" : "ACTIVE",
        credentials: {
          ...config,
          paytmSessionExpiredHits: nextHits,
        },
      },
    });
    ```
  * **Verified Effects:**
    * `status` becomes exact enum value **`EXPIRED`** (from `Prisma.MerchantProviderStatus.EXPIRED`).
    * Notice that code **does not** set `status = INACTIVE`, nor does it inject `credentials.sessionExpired = true` (it only writes `paytmSessionExpiredHits: nextHits`).
    * **Polling Exclusions:** Because `checkPendingOrders` queries `where: { status: "ACTIVE", ... }` (`line 99`), setting `status = "EXPIRED"` causes all subsequent polling intervals to skip this provider until the merchant re-authenticates via OTP.
* **Counter Reset:** Whenever a history fetch succeeds, `paytmSessionExpiredHits` is reset to `0` and `status` is explicitly set back to `"ACTIVE"` (`line 305`).

---

## 8. Webhooks & Callback Handling

For merchants configured with server-to-server callback URLs, `payment-service` exposes an unauthenticated webhook callback endpoint.

### 8.1 Normalized Controller Route Table
The webhook route is defined in `payment-service/src/controllers/webhook.controller.ts` via `@Controller('webhooks')` and `@Post('paytm')`:

| Access Path | Listening Port | Verified Route | Handled By Controller |
| :--- | :--- | :--- | :--- |
| **Direct Microservice Route** | Port `3103` (`payment-service`) | `POST /webhooks/paytm` | `WebhookController.handlePaytmWebhook` |
| **API Gateway Proxy Route** | Port `3100` (`api-gateway`) | `POST /api/v1/webhooks/paytm` | Proxies directly to `http://localhost:3103/webhooks/paytm` via `webhooks` route key |

---

### 8.2 Webhook Signature Verification (`WebhookService.verifyPaytmSignature`)

When a webhook arrives at `POST /webhooks/paytm`, `WebhookService.processPaytmWebhook` invokes `verifyPaytmSignature`:

```typescript
// Verified implementation from payment-service/src/services/webhook.service.ts (lines 148-165)
const providerData = await this.getMerchantCredentials(order.merchantId, 'paytm');
if (!providerData) {
  this.logger.warn('No Paytm credentials found for verification');
  return false;
}

const merchantKey = providerData.credentials?.merchantKey || providerData.credentials?.key;
if (!merchantKey) return false;

const checksum = payload.CHECKSUMHASH;
if (!checksum) return false;

return PaytmChecksum.verifySignature(payload, merchantKey, checksum);
```

> [!CAUTION]
> **Webhook Merchant Key Requirement:** Notice line 154: `const merchantKey = providerData.credentials?.merchantKey || providerData.credentials?.key;`. Because standard Puppeteer OTP onboarding via `dashboard.paytm.com` **does not extract a merchant key**, `merchantKey` evaluates to `undefined` and `verifyPaytmSignature` immediately returns `false` (line 155). **Therefore, webhook verification is unavailable for standard Paytm dashboard connections unless `merchantKey` (or `key`) is separately configured in `MerchantProvider.credentials`.**

---

### 8.3 Webhook Payload Parsing (`parsePaytmWebhook`)

When signature verification succeeds, `parsePaytmWebhook` (`webhook.service.ts` line 362) extracts fields into standard `WebhookPayload`:

```typescript
private parsePaytmWebhook(payload: any): WebhookPayload {
  return {
    orderId: payload.ORDERID || payload.orderId,
    transactionId: payload.TXNID || payload.transactionId,
    status: payload.STATUS === 'TXN_SUCCESS' ? 'SUCCESS' : 'FAILED',
    amount: parseFloat(payload.TXNAMOUNT || payload.amount),
    gatewayResponse: payload,
    utr: payload.BANKTXNID,
    paymentMethod: 'PAYTM',
  };
}
```

#### Verified Example Paytm Webhook Body Payload
```json
{
  "ORDERID": "UP1722369600123",
  "TXNID": "20260730111222333444",
  "TXNAMOUNT": "150.00",
  "PAYMENTMODE": "UPI",
  "CURRENCY": "INR",
  "TXNDATE": "2026-07-30 20:05:00.0",
  "STATUS": "TXN_SUCCESS",
  "RESPCODE": "01",
  "RESPMSG": "Txn Success",
  "GATEWAYNAME": "PPBLC",
  "BANKTXNID": "421234567890",
  "BANKNAME": "PAYTM PAYMENTS BANK",
  "CHECKSUMHASH": "w2Qc97r5X3/V...AES_ENCRYPTED_CIPHERTEXT...="
}
```

---

### 8.4 Security & Amount Mismatch Protection (`updateOrderFromWebhook`)

In `WebhookService.updateOrderFromWebhook(webhookData)`, the service enforces strict order security checks:

1. **Order Lookup:** Retrieves `Order` from MySQL by `externalOrderId = webhookData.orderId`.
2. **Idempotency Guard:** Checks if `order.status === OrderStatus.COMPLETED`. If already completed, logs `"Order already completed, skipping"` and returns idempotently without re-executing database updates.
3. **Amount Mismatch Audit:**
   * Compares `parseFloat(webhookData.amount)` against `parseFloat(order.amount.toString())`.
   * If an amount mismatch is detected, `WebhookService` rejects the webhook and logs an error to prevent underpayment fraud.

---

## 9. Security, Checksums & Cryptography

UPipe implements Paytm's proprietary cryptographic signature scheme in `payment-service/src/utils/paytmChecksum.ts`.

### 9.1 `PaytmChecksum` Cryptographic Implementation (`paytmChecksum.ts`)

> [!IMPORTANT]
> **Correct Cryptographic Classification:** The `PaytmChecksum` class does **not use HMAC-SHA256 (`crypto.createHmac`)**. Instead, it uses **SHA-256 Hashing with Salt Concatenation (`crypto.createHash('sha256')`)** combined with **AES-128-CBC encryption (`crypto.createCipheriv('aes-128-cbc')`)** using a static initialization vector.

```typescript
// Verified core hashing and encryption methods from payment-service/src/utils/paytmChecksum.ts
export class PaytmChecksum {
    private static iv = "@@@@&&&&####$$$$"; // Fixed 16-byte initialization vector

    static encrypt(input: string, key: string): string {
        const cipher = crypto.createCipheriv('aes-128-cbc', key, this.iv);
        let encrypted = cipher.update(input, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return encrypted;
    }

    static decrypt(encrypted: string, key: string): string {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, this.iv);
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    private static calculateHash(params: string, salt: string): string {
        const finalString = params + "|" + salt;
        const hash = crypto.createHash('sha256').update(finalString).digest('hex');
        return hash + salt;
    }
    // ...
```

#### Verified 10-Step Cryptographic Execution Chain
1. **Parameter Normalization:** 
   * Strips the `CHECKSUMHASH` key from parameters.
   * During signing (`generateSignature`), skips nested objects, arrays, `undefined`, and null values (`'null'`).
   * During verification (`verifySignature`), normalizes `null`, `'null'`, or `undefined` values to an empty string `''` (`lines 85`).
2. **Key Sorting:** Sorts parameter keys alphabetically (`Object.keys(params).sort()`).
3. **Pipe-Delimited String Generation:** Joins all normalized parameter values with a pipe delimiter (`"|"`), e.g., `150.00|INR|UP1722369600123`.
4. **Salt Generation / Extraction:**
   * In `generateSignature`: Generates a random 4-character alphanumeric salt (`generateSalt(4)`) from charset `"AbcDE123IJKLMN67QRSTUVWXYZ...0FGH45OP89"`.
   * In `verifySignature`: Decrypts `CHECKSUMHASH` using AES-128-CBC and extracts the trailing 4 characters as salt (`paytm_hash.substr(paytm_hash.length - 4)`).
5. **SHA-256 Hash Calculation:** Computes `crypto.createHash('sha256').update(params + "|" + salt).digest('hex')`.
6. **Salt Attachment:** Appends the 4-character salt to the resulting 64-character hex digest (`hash + salt`).
7. **AES-128-CBC Encryption:** Uses `crypto.createCipheriv('aes-128-cbc', key, "@@@@&&&&####$$$$")` with the merchant's key and static IV `"@@@@&&&&####$$$$"`.
8. **Base64 Encoding:** Outputs encrypted Base64 ciphertext representing the SHA-256 hash plus salt.
9. **Verification Equality Check:** In `verifySignature(params, key, checksum)`, decrypts `checksum`, extracts salt, recomputes `calculateHash(paramStr, salt)`, and checks standard string equality (`calculatedHash === paytm_hash`). Note: Code uses `===` rather than `crypto.timingSafeEqual`.
10. **Exception Recovery:** If AES decryption throws an error (e.g., malformed Base64 ciphertext or wrong merchant key), `verifySignature` catches the exception, logs `"Paytm Checksum Decryption Failed:"`, and returns `false`.

---

### 9.2 Credential Security Assessment
* **Static Initialization Vector (IV):** `paytmChecksum.ts` uses a static 16-byte initialization vector (`"@@@@&&&&####$$$$"`). While this is required for compatibility with legacy Paytm API specifications, static IVs in CBC mode mean identical input plaintext and key produce identical ciphertext.
* **Storage Encryption:** In MySQL (`merchant_providers.credentials`), session cookies (`merchant_session_id`, `merchant_csrftoken`) and `merchantKey` are stored in plain JSON format without database-column encryption. Access is protected by NestJS `JwtAuthGuard` and role checks.

---

## 10. Error Handling, Retries & Edge Cases

### 10.1 Verified Edge Cases & Handlers
1. **Puppeteer Referrer Navigation Failure (`PaytmSimpleService.sendOtp` lines 127-134):**
   * If `page.goto("https://dashboard.paytm.com/login/?referrer=Business")` times out or fails, the catch block logs `"Navigation error... Retrying without referrer..."` and attempts a secondary navigation to `"https://dashboard.paytm.com/login/"`.
2. **Missing Account Identifier (`ProviderConnectionService.connectPaytm` lines 1457-1464):**
   * If Puppeteer onboarding fails to extract `upiId`, `merchantId`, or MID from dashboard HTML, `accountIdentifier` evaluates to `null` and the service throws `BadRequestException("Could not identify Paytm account. Please try again.")`.
3. **Re-onboarding Soft-Deleted Merchants (`lines 1425-1455`):**
   * If a merchant re-authenticates a Paytm account previously linked to a soft-deleted merchant row, `ProviderConnectionService` revives the soft-deleted merchant row (`reviveMerchantIfDeleted`) and restores the previously stored UPI VPA (`extractReconnectStoredUpi`) if the newly extracted UPI ID appears weak or identical to MID.
4. **Stale Lock Safety Valve (`OrderStatusCronService.checkPendingOrders` lines 45-57):**
   * To prevent overlapping cron runs from hanging indefinitely, `checkPendingOrders` checks if `this.isCheckingPendingOrders` has been locked longer than `CHECK_STALE_TIMEOUT_MS`. If elapsed time exceeds the threshold, it force-releases the lock (`this.isCheckingPendingOrders = false`).
5. **Webhook Credential Verification Failure (`webhook.service.ts` line 155):**
   * If `merchantKey` is missing from `credentials`, `WebhookService` silently returns `false` rather than throwing an unhandled exception, ensuring endpoint stability.

---

## 11. Configuration & Environment Variables

### 11.1 Verified Environment Variables (.env / .env.example)

The following table lists only the environment variables explicitly present in the source code or `.env.example` files of `merchant-service`, `payment-service`, and `api-gateway` that govern Paytm integration behavior.

> **Note on Removed Unreferenced Variables:** Dedicated environment variables such as `PAYTM_MERCHANT_KEY`, `PAYTM_ENVIRONMENT`, `PUPPETEER_EXECUTABLE_PATH`, and `CHROMIUM_PATH` **do not appear anywhere in source code or `.env.example`** and have been excluded.

| Environment Variable | Where Defined / Used | Required? | Verified Default / Example | Purpose in Codebase |
| :--- | :--- | :--- | :--- | :--- |
| **`PORT`** | All Services (`main.ts`) | Optional | `3100` (`api-gateway`), `3102` (`merchant-service`), `3103` (`payment-service`) | Application HTTP listening port |
| **`DATABASE_URL`** | `merchant-service`, `payment-service` (`prisma.service`) | Required | `"mysql://user:pass@localhost:3306/greenpay_merchant"` | MySQL connection string for Prisma ORM |
| **`JWT_SECRET`** | All Services (`config.service`) | Required | `"change-me-jwt-secret"` | JWT signature verification and auth guard token decoding |
| **`PAYMENT_SERVICE_URL`** | `merchant-service` (`order-status-cron.service.ts`) | Required | `"http://localhost:3103"` | Target base URL for calling payment-service order APIs |
| **`MERCHANT_SERVICE_URL`** | `api-gateway` (`gateway.controller.ts`) | Required | `"http://localhost:3102"` | Gateway proxy destination for `/api/v1/gateway/*` requests |
| **`REDIS_HOST` / `REDIS_PORT`** | `merchant-service` (`.env.example`) | Optional | `"localhost"` / `6379` | Redis host/port for caching and queue management |

---

## 12. End-to-End Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer (PhonePe/Paytm App)
    actor Merchant as Merchant (UPipe UI)
    participant GW as api-gateway (Port 3100)
    participant PaySvc as payment-service (Port 3103)
    participant MerchSvc as merchant-service (Port 3102)
    participant PaytmDB as Paytm Dashboard (dashboard.paytm.com)
    participant MySQL as MySQL Database (merchant_providers, orders)

    Note over Merchant,MySQL: Phase 1: OTP Browser Onboarding (merchant-service local MySQL)
    Merchant->>GW: POST /api/v1/gateway/paytm/send-otp (username, organizationId)
    GW->>MerchSvc: POST /gateway/paytm/send-otp
    MerchSvc->>PaytmDB: Launch Chromium -> Navigate to /login/?referrer=Business -> Enter Phone
    PaytmDB-->>Merchant: Sends SMS OTP
    Merchant->>GW: POST /api/v1/gateway/paytm/verify-otp (sessionId, otp)
    GW->>MerchSvc: POST /gateway/paytm/verify-otp
    MerchSvc->>PaytmDB: Submit OTP -> Extract Cookies -> Fetch /api/v1/merchant/user/qr-data
    PaytmDB-->>MerchSvc: Returns upiId ("merchant@paytm"), MID
    MerchSvc->>MySQL: Upsert MerchantProvider (status=ACTIVE, credentials={upiId, cookies...})

    Note over Customer,MySQL: Phase 2: QR Payment & Order Creation (payment-service local MySQL)
    Customer->>PaySvc: POST /api/v1/orders (amount: 150.00, merchantId)
    PaySvc->>MySQL: Insert Order (status=PENDING, externalOrderId="UP1722369600123")
    PaySvc-->>Customer: Return UPI Intent URI ("upi://pay?pa=merchant@paytm&am=150.00...")
    Customer->>Customer: Scan QR Code & Authorize Payment on UPI App

    Note over Customer,MySQL: Phase 3A: Server-to-Server Webhook Reconciliation (If merchantKey Configured)
    PaytmDB->>GW: POST /api/v1/webhooks/paytm (STATUS="TXN_SUCCESS", CHECKSUMHASH=...)
    GW->>PaySvc: POST /webhooks/paytm
    PaySvc->>MerchSvc: GET /merchants/:id/providers/PAYTM/credentials (Internal REST)
    MerchSvc-->>PaySvc: Return credentials (check merchantKey)
    PaySvc->>PaySvc: PaytmChecksum.verifySignature(payload, merchantKey, CHECKSUMHASH)
    PaySvc->>MySQL: Update Order status=COMPLETED, Transaction status=SUCCESS

    Note over Customer,MySQL: Phase 3B: 15-Second Dashboard Polling Reconciliation (Default Flow via Internal REST)
    loop Every 15 Seconds (5,20,35,50 * * * * *)
        MerchSvc->>PaySvc: HTTP GET /orders?status=PENDING,EXPIRED&limit=500 (with x-internal-token)
        PaySvc-->>MerchSvc: Return pending orders list
        MerchSvc->>MySQL: Query local MerchantProvider where status=ACTIVE
        MerchSvc->>PaytmDB: POST https://dashboard.paytm.com/api/v3/order/list (with session cookies)
        PaytmDB-->>MerchSvc: Return transactions array [{ txnId, utr, amount: "150.00", status: "SUCCESS" }]
        MerchSvc->>MerchSvc: Index successTransactions by UTR / externalOrderId
        MerchSvc->>PaySvc: HTTP POST /transactions/sync (status="SUCCESS", with x-internal-token)
        MerchSvc->>PaySvc: HTTP PATCH /orders/:id/status (status="COMPLETED", utr, with x-internal-token)
    end
```

---

## 13. Known Tech Debt & Architectural Gaps

1. **Webhook Signature Dependency on Manually Added `merchantKey`:**
   * **Code Location:** `payment-service/src/services/webhook.service.ts` line 154.
   * **Issue:** Because Puppeteer dashboard onboarding via `PaytmSimpleService` only captures session cookies and UPI VPAs without extracting a `merchantKey`, incoming webhook callbacks fail signature verification unless a system administrator manually inserts `merchantKey` into `MerchantProvider.credentials`.
2. **In-Memory Puppeteer Session State (`browserSessions`):**
   * **Code Location:** `merchant-service/src/modules/provider/paytm-simple.service.ts` line 41.
   * **Issue:** Active onboarding sessions (`browserSessions = new Map()`) are stored in application memory. In a multi-instance or Kubernetes deployment, a `verify-otp` request hitting a different `merchant-service` pod than the `send-otp` pod will fail with session not found.
3. **Static CBC Initialization Vector in Checksum Calculation:**
   * **Code Location:** `payment-service/src/utils/paytmChecksum.ts` line 5 (`private static iv = "@@@@&&&&####$$$$";`).
   * **Issue:** The AES-128-CBC encryption method uses a hardcoded initialization vector. While necessary for legacy Paytm API checksum specifications, CBC mode with a static IV does not provide semantic security across repeated ciphertexts.
4. **Standard String Comparison for Checksum Equality:**
   * **Code Location:** `payment-service/src/utils/paytmChecksum.ts` line 104 (`return calculatedHash === paytm_hash;`).
   * **Issue:** Using JavaScript's standard `===` comparison instead of `crypto.timingSafeEqual` introduces theoretical timing side-channel vulnerabilities during hash comparison.

---

## 14. Verification Report

### Verification Checklist
- [x] Service Ports Verified: Confirmed application fallback ports (`main.ts`) for `api-gateway` (`3100`), `merchant-service` (`3102`), `payment-service` (`3103`), `subscription-service` (`3105`), `identity-service` (`3101`), `organization-service` (`3106`), and `notification-service` (`3006`). Referenced `SHARED_BACKEND_FACTS.md`.
- [x] Database Ownership Verified: Confirmed `MerchantProvider` is owned exclusively by `merchant-service`, and `Order`, `Transaction`, `PaymentLink`, `CallbackLog` are owned exclusively by `payment-service` in MySQL.
- [x] Webhook Routes Verified: Confirmed both direct external callback route `POST /webhooks/paytm` on `payment-service` (port 3103) and Gateway proxy route `POST /api/v1/webhooks/paytm` on `api-gateway` (port 3100).
- [x] Cron Intervals Verified: Confirmed literal cron expressions: `@Cron("5,20,35,50 * * * * *")` (every 15 sec), `@Cron("0 */15 * * * *")` (every 15 min), and `@Cron("*/30 * * * * *")` (every 30 sec).
- [x] Status Enums Verified: Confirmed `OrderStatus.COMPLETED` and `TransactionStatus.SUCCESS` literal enums in `payment-service/prisma/schema.prisma`.

### Corrections Made During Audit
| Category | Previous Claim | Verified Fact | Source Code Evidence |
| :--- | :--- | :--- | :--- |
| **Service Application Ports** | Listed ambiguous or incorrect port numbers (`3000`, `3002`, `3003`) or conflated container host mappings with application ports. | Verified exact fallback ports from each service `src/main.ts`: `api-gateway` (`3100`), `merchant-service` (`3102`), `payment-service` (`3103`), `subscription-service` (`3105`), `notification-service` (`3006`), `identity-service` (`3101`), `organization-service` (`3106`). | All microservice `src/main.ts` files |
| **Database Engine** | Claimed PostgreSQL was used for storage | Both microservices explicitly configure `provider = "mysql"` in their datasource blocks. Claims of PostgreSQL were unsupported. | `merchant-service/prisma/schema.prisma` (L6)<br>`payment-service/prisma/schema.prisma` (L6) |
| **Captcha Flow** | Claimed Paytm captcha resolution called `completePhonePeOtpWithCaptcha(...)` | That method is exclusively for PhonePe; `PaytmSimpleService` contains zero captcha handling. | `merchant-service/src/modules/provider/gateway.controller.ts` |
| **Paytm Dashboard URLs** | Referenced `/next/login` and `/api/v2/merchant/profile` | The codebase uses `https://dashboard.paytm.com/login/?referrer=Business` and `/api/v1/merchant/profile`. | `merchant-service/src/modules/provider/paytm-simple.service.ts` |
| **Cryptographic Scheme** | Documented checksum algorithm as keyed HMAC-SHA256 | The Paytm checksum algorithm uses SHA-256 hash calculation with salt concatenation (`hash + salt`) and AES-128-CBC encryption (`createCipheriv('aes-128-cbc')`), not HMAC. | `payment-service/src/utils/paytmChecksum.ts` |
| **Webhook Merchant Key** | Implied Puppeteer onboarding automatically configures webhook verification key | `WebhookService.verifyPaytmSignature` requires `merchantKey` / `key` in `credentials`, which Puppeteer onboarding does not populate without manual configuration. | `payment-service/src/services/webhook.service.ts` |
| **OrderStatus Enums** | Used unsupported statuses (`OrderStatus.PAID`, `FAILED -> PROCESSING`) | `OrderStatus.PAID` does not exist in `schema.prisma` (`COMPLETED` is used). Transitioning `FAILED -> PROCESSING` is not implemented in any handler. | `payment-service/prisma/schema.prisma`<br>`webhook.service.ts` |
| **Literal Cron Schedules** | Described session cleanup as every 15 minutes | Corrected descriptions to match literal cron decorators (`@Cron("*/30 * * * * *")` runs session cleanup every 30 seconds; `@Cron("5,20,35,50 * * * * *")` runs pending order polling every 15 seconds). | `order-status-cron.service.ts`<br>`paytm-simple.service.ts` |
| **Unreferenced Environment Variables** | Included `PAYTM_MERCHANT_KEY`, `PAYTM_ENVIRONMENT`, `PUPPETEER_EXECUTABLE_PATH`, `CHROMIUM_PATH` | These variables are never referenced in source code or `.env.example`. Removed from tables. | `paytm-simple.service.ts`<br>`paytmChecksum.ts` |
| **Database Ownership & HTTP REST** | Shown `merchant-service` accessing MySQL payment database directly | Corrected diagrams and text to show `merchant-service` never accesses the payment database directly; it queries `Order` and `Transaction` models exclusively via internal HTTP REST calls (`PAYMENT_SERVICE_URL`) using header `x-internal-token`. | `order-status-cron.service.ts` |
| **Normalized Webhook Routes** | Documented conflicting `:id` / `:merchantId` variants | Standardized all route references to `POST /webhooks/paytm` (direct route on port 3103) and `POST /api/v1/webhooks/paytm` (Gateway proxy route on port 3100). | `webhook.controller.ts`<br>`gateway.controller.ts` |
| **Session Expiration Status** | Claimed provider is marked `INACTIVE` or sets `credentials.sessionExpired = true` | When `paytmSessionExpiredHits >= 3`, code sets `MerchantProvider.status = "EXPIRED"` (`OrderStatus` / `MerchantProviderStatus`). | `order-status-cron.service.ts` (L267) |

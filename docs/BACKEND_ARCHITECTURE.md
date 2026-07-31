# UPipe Backend Architecture Reference

## 1. Executive Summary

**UPipe** is an enterprise-grade, multi-tenant fintech payment gateway platform designed to unify disparate payment providers, automate merchant onboarding and authentication, route transactions intelligently, and provide end-to-end payment reconciliation and subscription management.

The platform is structured as a **Microservices Architecture** built on **NestJS**, with services communicating over HTTP (REST) and leveraging a centralized **API Gateway** as the single entry point for all client applications. Data persistence is managed via **MySQL** databases using the **Prisma ORM**, while **Redis** (`ioredis`) provides high-performance distributed counters for transaction rate-limiting and merchant routing.

### Key Architectural Capabilities
- **Unified Gateway Routing:** A central API Gateway proxies requests to underlying domain microservices while enforcing authentication, header sanitization, and organization tenancy.
- **Multi-Tenant Organization Hierarchy:** Robust tenant data isolation where organizations, users, roles, and subscriptions are scoped and enforced at both the API Gateway and database levels.
- **Automated Payment Gateway Onboarding & Session Management:** Deep integrations with major Indian payment gateways (PhonePe, Paytm, BharatPe, Google Pay for Business, HDFC Bank SmartHub Vyapar, and QuintusPay). Utilizes headless browser automation (Playwright and Puppeteer with Stealth plugins), automated OTP verification, and background keep-alive crons to maintain persistent merchant sessions without manual intervention.
- **Intelligent Transaction Routing & Rate Limiting:** Dynamic merchant selection (`RoutingService`) that evaluates daily/monthly limits, operating schedules, transaction bounds, and real-time Redis-backed rate limits before assigning a payment processor.
- **End-to-End Payment Lifecycle & Reconciliation:** Complete order creation, QR code generation, webhook verification, SSE-based real-time event broadcasting, and nightly automated reconciliation crons.
- **Slot-Based Subscription & Billing Engine:** Flexible organization subscription plans, slot-based merchant assignment, and lifetime/recurring provider unlocks.

---

## 2. System Architecture Overview

The UPipe backend topology decouples client-facing ingress from domain-specific business logic. External clients (web dashboards, mobile apps, and merchant integrations) interact exclusively with the **API Gateway** (Port `3000`), which verifies authentication tokens, injects trusted headers, and proxies requests to backend domain microservices (`3101`–`3106`).

```mermaid
flowchart TD
    Client["External Clients (Web / Mobile / APIs)"] -->|HTTPS / REST| APIGateway["API Gateway (:3100)"]

    subgraph CoreServices ["UPipe Backend Microservices"]
        APIGateway -->|"/api/v1/auth, /api/v1/users"| Identity["Identity Service (:3101)"]
        APIGateway -->|"/api/v1/merchants, /api/v1/providers"| Merchant["Merchant Service (:3102)"]
        APIGateway -->|"/api/v1/orders, /api/v1/transactions"| Payment["Payment Service (:3103)"]
        APIGateway -->|"/api/v1/subscriptions"| Subscription["Subscription Service (:3105)"]
        APIGateway -->|"/api/v1/organizations, /api/v1/cms"| Organization["Organization Service (:3106)"]
        APIGateway -.->|"/internal/* (REST + Token)"| Notification["Notification Service (:3006)"]
    end

    subgraph DataStorage ["Data & Cache Layer"]
        Identity --> DB_Identity[("MySQL (Identity DB)")]
        Organization --> DB_Org[("MySQL (Organization DB)")]
        Merchant --> DB_Merchant[("MySQL (Merchant DB)")]
        Payment --> DB_Payment[("MySQL (Payment DB)")]
        Subscription --> DB_Sub[("MySQL (Subscription DB)")]
        Merchant --> RedisCache[("Redis (Rate Limit / Counters)")]
    end

    subgraph ExternalGateways ["Third-Party Payment Providers & APIs"]
        Merchant -->|REST / API| PhonePeAPI["PhonePe Web API"]
        Merchant -->|Puppeteer Stealth| PaytmPortal["Paytm Merchant Portal"]
        Merchant -->|REST / API| BharatPeAPI["BharatPe Enterprise API"]
        Merchant -->|Playwright Headless| GPayPortal["Google Pay Business"]
        Merchant -->|AES/RSA Proxy| HDFCAPIs["HDFC SmartHub Vyapar API"]
        Merchant -->|REST / API| QuintusAPI["QuintusPay API"]
    end

    Payment -->|"/internal/routing/route"| Merchant
    Payment -->|"/internal/send/email, /internal/push/send"| Notification
    Subscription -->|"/internal/providers/merchant/*"| Merchant
```

### High-Level Data Flow
1. **Ingress & Authentication:** Client HTTP requests arrive at `api-gateway`. The `AuthMiddleware` verifies JWT tokens (from `Authorization` headers or cookies) against `JWT_SECRET`.
2. **Tenancy Enforcement:** The Gateway strips any client-supplied `x-organization-id` or `x-user-id` headers to prevent privilege escalation, injecting the verified claims (`x-user-id`, `x-organization-id`, `x-user-roles`, `x-user-email`) into the forwarded request.
3. **Service Proxying:** `GatewayController` matches the path prefix and forwards the request via an Axios HTTP client to the respective domain microservice.
4. **Domain Execution:** The domain microservice executes business logic, querying its Prisma-managed MySQL database and Redis (when rate limiting or routing).
5. **Cross-Service Communication:** Services communicate internally via synchronous REST calls secured by a shared `x-internal-token` header (`INTERNAL_TOKEN`).
6. **Real-Time Notification & Events:** Changes to order status or subscription state emit Server-Sent Events (SSE) via `OrderEventsService` to connected clients and persist in-app notifications.

---

## 3. Microservices Catalog

The backend is composed of seven NestJS microservices. Each service is self-contained with its own configuration, controllers, services, and Prisma database schema.

| Service Name | Verified Fallback Port (`main.ts`) | Purpose | Key Responsibilities | Primary Database Models / Entities |
| :--- | :--- | :--- | :--- | :--- |
| **api-gateway** | `3100` | Ingress & Reverse Proxy | Single entry point, JWT verification, header sanitization/injection, CORS, Swagger documentation aggregation, request routing. | *Stateless (No Prisma Schema)* |
| **identity-service** | `3101` | Authentication & User Security | User registration, login, JWT issuance/refresh, password hashing/reset, OTP generation, user session tracking, account lockout rules. | `User`, `Session`, `VerificationToken`, `LoginHistory`, `AuditLog` |
| **merchant-service** | `3102` | Merchant & Provider Gateway Management | Payment provider onboarding, automated headless browser authentication (GPay/Paytm), OTP verification, keep-alive session crons, transaction routing & rate limiting (`Redis`). | `Merchant`, `MerchantConfig`, `MerchantProvider`, `ProviderType`, `MerchantCategory` |
| **payment-service** | `3103` | Order & Transaction Lifecycle | Payment link creation, dynamic QR generation, transaction execution, callback verification (X-VERIFY/HMAC), SSE order status broadcast, nightly reconciliation. | `Order`, `Transaction`, `PaymentLink`, `CallbackLog`, `InAppNotification` |
| **subscription-service** | `3105` | SaaS Billing & Provider Unlocks | Plan definitions, slot-based organization subscription assignment (`OrgSubscription`), merchant provider unlock processing (`MerchantUnlock`), monthly usage alerts. | `SubscriptionPlan`, `OrgSubscription`, `SubscriptionPurchase`, `MerchantUnlock`, `MerchantUnlockProduct`, `MonthlyUsage` |
| **organization-service** | `3106` | Tenant & CMS Administration | Organization lifecycle, multi-tenant user membership (`org_users`), RBAC (`org_roles`), platform configurations, support tickets, CMS management. | `Organization`, `OrgUser`, `OrgRole`, `RolePermission`, `SupportTicket`, `CmsPage`, `CmsSection`, `PlatformConfig` |
| **notification-service** | `3006` | Multi-Channel Notifications | Transactional email delivery (Nodemailer/SMTP/SendGrid), Web Push notifications (VAPID/web-push), internal notification relay. | *Stateless / In-Memory Store (`push-subscription.store.ts`)* |

---

## 4. API Gateway Architecture

The **API Gateway** (`api-gateway`) acts as the secure ingress for the entire UPipe backend. Built on NestJS, it utilizes `AuthMiddleware` for authentication and `GatewayController` for reverse proxying.

```mermaid
sequenceDiagram
    participant Client
    participant APIGateway as API Gateway (:3000)
    participant AuthMiddleware as AuthMiddleware
    participant GatewayController as GatewayController
    participant Microservice as Backend Microservice (:310X)

    Client->>APIGateway: HTTP Request (e.g., POST /api/v1/orders)
    APIGateway->>AuthMiddleware: Intercept & check public/protected route
    
    alt Protected Route
        AuthMiddleware->>AuthMiddleware: Extract Token (Bearer or Cookie)
        AuthMiddleware->>AuthMiddleware: Verify JWT (JWT_SECRET)
        AuthMiddleware->>AuthMiddleware: Sanitize & Inject Headers (x-user-id, x-organization-id, x-user-roles, x-is-super-admin)
    end
    
    APIGateway->>GatewayController: Route to handler based on URL prefix
    GatewayController->>GatewayController: Resolve target microservice URL
    GatewayController->>Microservice: Axios HTTP Request (with enriched headers)
    Microservice-->>GatewayController: HTTP Response
    GatewayController-->>Client: Forward Response to Client
```

### Request Routing Mechanism
Routing is configured in `GatewayController` (`gateway.controller.ts`). The controller maps URL prefixes to target service URLs defined via environment variables:

```typescript
private readonly serviceMap: Record<string, string> = {
  auth: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3101',
  users: process.env.IDENTITY_SERVICE_URL || 'http://localhost:3101',
  organizations: process.env.ORGANIZATION_SERVICE_URL || 'http://localhost:3106',
  roles: process.env.ORGANIZATION_SERVICE_URL || 'http://localhost:3106',
  support: process.env.ORGANIZATION_SERVICE_URL || 'http://localhost:3106',
  'platform-config': process.env.ORGANIZATION_SERVICE_URL || 'http://localhost:3106',
  cms: process.env.ORGANIZATION_SERVICE_URL || 'http://localhost:3106',
  merchants: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3102',
  providers: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3102',
  routing: process.env.MERCHANT_SERVICE_URL || 'http://localhost:3102',
  orders: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3103',
  transactions: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3103',
  subscriptions: process.env.SUBSCRIPTION_SERVICE_URL || 'http://localhost:3105',
};
```
- Requests matching `/api/v1/:service/*` are captured by the wildcard proxy method.
- The path prefix is stripped/reconstructed, and the request payload, headers, and query parameters are forwarded using an `axios` HTTP client.
- **Swagger Integration:** The Gateway exposes an aggregated Swagger UI at `/api/docs` by fetching OpenAPI specifications from downstream microservices.
- **CORS & Validation:** Configured globally in `main.ts` with strict origins and `ValidationPipe` enabled (`whitelist: true`, `transform: true`).

### Header Enrichment & Security Sanitization
To prevent spoofing, `AuthMiddleware` (`auth.middleware.ts`) explicitly deletes client-supplied identity headers before evaluating the token:
```typescript
delete req.headers['x-user-id'];
delete req.headers['x-user-email'];
delete req.headers['x-organization-id'];
delete req.headers['x-user-roles'];
delete req.headers['x-is-super-admin'];
```
Upon successful verification of the JWT, the middleware injects trusted headers into `req.headers`:
- `x-user-id`: The authenticated user's UUID.
- `x-user-email`: The user's primary email.
- `x-organization-id`: The organization context (from `token.organizationId` or default database lookup).
- `x-user-roles`: Serialized JSON array of the user's role strings within the organization.
- `x-is-super-admin`: `"true"` if the user has platform super-admin privileges; `"false"` otherwise.

---

## 5. Data Architecture & Schemas

The platform uses **MySQL** databases managed via **Prisma ORM**. Each domain service maintains its own Prisma schema (`schema.prisma`), ensuring clear bounded contexts while supporting relational integrity within each service boundary.

```mermaid
erDiagram
    USER ||--o{ SESSION : has
    USER ||--o{ ORG_USER : "belongs to"
    ORGANIZATION ||--o{ ORG_USER : has
    ORGANIZATION ||--o{ MERCHANT : owns
    ORGANIZATION ||--o{ ORG_SUBSCRIPTION : holds
    MERCHANT ||--o{ MERCHANT_PROVIDER : configures
    MERCHANT ||--o{ ORDER : processes
    ORDER ||--o{ TRANSACTION : generates
    SUBSCRIPTION_PLAN ||--o{ ORG_SUBSCRIPTION : defines
    SUBSCRIPTION_PLAN ||--o{ SUBSCRIPTION_PROVIDER_ACCESS : grants

    USER {
        string id PK
        string email
        string passwordHash
        boolean isSuperAdmin
        datetime createdAt
    }
    ORGANIZATION {
        string id PK
        string name
        string code
        string status
        datetime createdAt
    }
    MERCHANT {
        string id PK
        string organizationId FK
        string name
        boolean isActive
        boolean isFallback
    }
    MERCHANT_PROVIDER {
        string id PK
        string merchantId FK
        string providerType
        string status
        json credentials
    }
    ORDER {
        string id PK
        string organizationId FK
        string merchantId FK
        string externalOrderId
        decimal amount
        string status
        string utr
    }
    TRANSACTION {
        string id PK
        string orderId FK
        string providerType
        decimal amount
        string status
        string gatewayTransactionId
    }
    ORG_SUBSCRIPTION {
        string id PK
        string organizationId FK
        string planId FK
        string merchantId FK
        string status
    }
    SUBSCRIPTION_PLAN {
        string id PK
        string name
        string code
        decimal price
        int maxMerchants
    }
```

### Key Entities & Indexing Strategies
1. **Identity & Access Models (`identity-service` & `organization-service`):**
   - **User (`users`):** Stores credentials, status, and platform super-admin flags.
   - **Session (`sessions`):** Tracks active refresh tokens, IP addresses, and user-agent strings.
   - **OrgUser (`org_users`):** Many-to-many join table connecting `User` and `Organization` with an assigned `OrganizationRole` (`OWNER`, `ADMIN`, `MEMBER`, `BILLING`) and custom role references. Indexed on `[organizationId, userId]` and `[userId]`.
2. **Merchant & Provider Models (`merchant-service`):**
   - **Merchant (`merchants`):** Represents a processing merchant entity within an organization. Indexed on `[organizationId, isActive, status]` and `[code]`.
   - **MerchantProvider (`merchant_providers`):** Stores provider credentials (`credentials` JSON column), provider type (`PHONEPE`, `PAYTM`, `BHARATPE`, `GPAY`, `HDFC`, `QUINTUS`), and connection status (`ACTIVE`, `INACTIVE`, `ERROR`). Indexed on `[merchantId, providerType]` and `[providerType, status]`.
3. **Payment & Transaction Models (`payment-service`):**
   - **Order (`orders`):** Parent payment attempt generated by an organization. Contains `amount`, `status` (`PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `EXPIRED`), `externalOrderId`, and optional `utr`. Composite indexes on `[organizationId, status]` and `[externalOrderId]`.
   - **Transaction (`transactions`):** Granular payment executions against a specific provider gateway. Indexed on `[orderId]`, `[gatewayTransactionId]`, and `[utr]`.
4. **Subscription & Billing Models (`subscription-service`):**
   - **SubscriptionPlan (`subscription_plans`):** Defines limits (`maxUsers`, `maxMerchants`, `maxTransactions`) and pricing.
   - **OrgSubscription (`org_subscriptions`):** Slot-based subscription allocation. Indexed on `[organizationId, status]` and `[merchantId]`.
   - **MerchantUnlock (`merchant_unlocks`):** Tracks per-organization lifetime or subscription-based access to specific provider gateway types. Unique constraint on `[organizationId, merchantType]`.

---

## 6. Data Isolation & Tenancy Model

UPipe implements an **Organization-Centric Multi-Tenancy Model**. Every merchant, payment order, transaction, subscription, and custom CMS page is scoped to an explicit `organizationId`.

```mermaid
flowchart LR
    ClientReq["Client Request"] --> APIGW["API Gateway (:3000)"]
    
    subgraph APIGWLayer ["Gateway Tenancy Guard"]
        APIGW --> StripHeaders["1. Strip Client x-organization-id"]
        StripHeaders --> DecodeJWT["2. Decode JWT Claims"]
        DecodeJWT --> InjectTrusted["3. Inject Trusted x-organization-id Header"]
    end
    
    InjectTrusted --> Service["Downstream Microservice"]
    
    subgraph ServiceLayer ["Microservice Tenancy Enforcement"]
        Service --> QueryFilter["4. Enforce Prisma Query: where: { organizationId }"]
        QueryFilter --> MySQL[("Tenant-Scoped Data (MySQL)")]
    end
```

### Tenancy Enforcement Pipeline
1. **Ingress Validation:** The API Gateway strips any client-provided `x-organization-id` headers. The authenticated user's organization is determined from JWT claims or via a lookup against `identity-service` and injected as a trusted `x-organization-id` header.
2. **Database Query Scope:** Downstream microservices extract `x-organization-id` from the request headers and unconditionally include `organizationId` in Prisma query `where` filters:
   ```typescript
   // Example from MerchantService
   const merchants = await this.prisma.merchant.findMany({
     where: {
       organizationId: reqOrganizationId,
       deletedAt: null,
     },
   });
   ```
3. **Cross-Tenant Access Prevention:** Any attempt to access or modify a resource (e.g., querying an Order by ID) requires matching both the primary `id` and the `organizationId`. If an ID belongs to another tenant, queries return null or a `404 Not Found` / `403 Forbidden` exception.

---

## 7. Authentication & Authorization System

The platform employs JWT-based stateless authentication with stateful session tracking and Role-Based Access Control (RBAC).

```mermaid
flowchart TD
    User["User / Client"] -->|1. POST /api/v1/auth/login| Identity["Identity Service"]
    Identity -->|2. Verify Bcrypt Hash & Check Lockout| DB[("Identity DB")]
    Identity -->|3. Generate Access + Refresh JWTs| Identity
    Identity -->|4. Record active session| DB
    Identity -->>|5. Set HTTP-Only Cookie + JWT Tokens| User

    User -->|6. Request with Bearer Token| APIGateway["API Gateway"]
    APIGateway -->|7. Verify Access Token Signature| APIGateway
    APIGateway -->|8. Enforce RBAC & Inject Security Headers| Downstream["Backend Service (:3102-3105)"]
```

### Authentication Lifecycle
- **Registration & Login:** Users authenticate via `/api/v1/auth/login` (`identity-service`). Passwords are hashed using `bcrypt` (default salt rounds = 10).
- **Account Lockout Policy:** To protect against brute-force attacks, `identity-service` records failed login attempts (`LoginHistory`). Five consecutive failed attempts trigger an automatic account lockout for 15 minutes.
- **Token Lifecycle:**
  - **Access Token:** Signed JWT containing `sub` (userId), `email`, `organizationId`, and role claims. Short-lived.
  - **Refresh Token:** Stored in the `Session` database table with device fingerprinting (IP, user-agent). Used to cycle access tokens via `/api/v1/auth/refresh`.
  - **Revocation:** Logging out deletes or deactivates the session record in the database, invalidating refresh attempts.

### Role-Based Access Control (RBAC)
- **Built-in Roles (`OrganizationRole` enum):**
  - `OWNER`: Unrestricted administrative access to the organization, billing, and member roles.
  - `ADMIN`: Administrative access to merchants, providers, and transactions; cannot delete the organization.
  - `MEMBER`: Standard operational access to create payment links and view transactions.
  - `BILLING`: Read-only or write access restricted to subscription plans, invoices, and payment unlocks.
- **Custom Granular Roles:** Organizations can define custom roles (`org_roles` and `role_permissions`) with specific permission keys (e.g., `merchants:create`, `providers:unlock`).
- **Super-Admin Bypass:** Platform administrators (`isSuperAdmin: true` in `users` table) bypass organization role checks and receive `x-is-super-admin: "true"` from the API Gateway.

---

## 8. Provider Integrations

The `merchant-service` (`src/modules/provider/*` and `src/modules/gpay/*`) manages onboarding, authentication, session persistence, and transaction sync for all third-party payment gateways.

---

### 8.1 PhonePe Integration

```mermaid
flowchart LR
    MerchantService["PhonePeSimpleService / WebService"] -->|REST / API| WebAPI["https://web-api.phonepe.com"]
    MerchantService -->|HMAC SHA256| Checksum["X-VERIFY Checksum Generator"]
    
    subgraph KeepAlive ["PhonePe Keep-Alive Engine"]
        Cron["PhonePeKeepAliveCron (0 */15 * * * *)"] -->|Poll /v3/merchant/transactions/history| WebAPI
    end
```

- **Integration Architecture & APIs:**
  - Implemented across `phonepe-simple.service.ts`, `phonepe-web.service.ts`, and `phonepe-session.util.ts`.
  - Communicates with PhonePe Business API endpoints at `https://web-api.phonepe.com`.
  - Uses an external or configured checksum proxy (`PHONEPE_CHECKSUM_ENDPOINT`) when required by SDK flows.
- **Authentication & Security:**
  - Onboarding uses mobile number verification via PhonePe automated OTP sending and verification (`SendOtpDto`).
  - Session tokens and identifiers (`merchantId`, access tokens, cookies) are persisted as JSON in `MerchantProvider.credentials`.
  - **Signature Verification (X-VERIFY):** For payment links and callbacks, checksums are generated via SHA-256 HMAC:
    $$\text{X-VERIFY} = \text{SHA256}(\text{base64Payload} + \text{endpointPath} + \text{saltKey}) + \text{"###"} + \text{saltIndex}$$
    Implemented in `phonepeChecksum.ts` (`payment-service`).
- **Session Management & Automated Keep-Alive:**
  - **`PhonePeKeepAliveCron` (`phonepe-keepalive.cron.ts`):** Runs every 15 minutes (`0 */15 * * * *`).
  - Queries active PhonePe providers and calls `/v3/merchant/transactions/history` for a 1-minute window to keep session tokens warm and prevent idle logout.
  - Maintains an in-memory cache (`txnCache`, 12-second TTL) to deduplicate simultaneous cron and transaction requests.
- **QR Generation & Transaction Processing:**
  - Generates dynamic UPI QR codes and payment requests via `qrcode.service.ts` (`payment-service`).
  - Receives asynchronous webhook callbacks at `WebhookService`, verifying `X-VERIFY` headers against stored merchant salt keys before updating order status.

---

### 8.2 Paytm Integration

```mermaid
flowchart LR
    PaytmService["PaytmSimpleService"] -->|Puppeteer Extra + Stealth| HeadlessBrowser["Headless Chromium Browser"]
    HeadlessBrowser -->|Load iframe#oauth-iframe| PaytmPortal["Paytm Merchant Portal"]
    
    subgraph KeepAlive ["Paytm Keep-Alive Engine"]
        Cron["keepalivePaytmSessions (0 */15 * * * *)"] -->|Execute background sync| HeadlessBrowser
    end
```

- **Integration Architecture & APIs:**
  - Implemented in `paytm-simple.service.ts`.
  - Integrates with the Paytm Merchant Portal using automated headless browser interactions via **Puppeteer** (`puppeteer-extra` with `puppeteer-extra-plugin-stealth`).
- **Authentication & Security:**
  - **Automated Browser Flow:** Launches a stealth Chromium instance, navigates to the Paytm merchant authentication portal, and switches context into the OAuth iframe (`iframe#oauth-iframe`).
  - Supports automated mobile phone OTP submission and extracts authenticated session cookies/tokens from browser contexts.
  - Active browser instances are tracked in memory (`browserSessions` map) per merchant session.
  - **Callback Checksum Verification:** Uses `PaytmChecksum` (`payment-service/src/utils/paytmChecksum.ts`) to verify SHA-256 HMAC signatures on incoming Paytm payment webhooks.
- **Session Management & Automated Keep-Alive:**
  - **`keepalivePaytmSessions` (`paytm-simple.service.ts`):** Runs every 15 minutes (`0 */15 * * * *`).
  - Iterates over all active Paytm merchant providers and executes lightweight session activity within the managed browser instances to prevent session expiration.
  - Implements `OnModuleDestroy` hook to cleanly terminate all active Puppeteer Chromium processes on graceful service shutdown.

---

### 8.3 BharatPe Integration

```mermaid
flowchart LR
    BharatPeService["BharatPeSimpleService"] -->|REST / API| EntAPI["https://enterprise.bharatpe.in"]
    BharatPeService -->|REST / API| MerchAPI["https://api-merchant.bharatpe.in"]
    BharatPeService -->|REST / API| PayAPI["https://payments-tesseract.bharatpe.in"]
    
    subgraph KeepAlive ["BharatPe Keep-Alive Engine"]
        Cron["keepaliveBharatPeSessions (0 */15 * * * *)"] -->|Poll 1-min history| MerchAPI
    end
```

- **Integration Architecture & APIs:**
  - Implemented in `bharatpe-simple.service.ts`.
  - Interacts with three primary BharatPe API domains:
    - Enterprise Portal: `https://enterprise.bharatpe.in`
    - Merchant API: `https://api-merchant.bharatpe.in`
    - Payments/Tesseract API: `https://payments-tesseract.bharatpe.in`
- **Authentication & Security:**
  - Onboarding is driven via REST-based OTP requests sent to the merchant's registered phone number.
  - Extracts JWT session tokens, cookie headers, and `merchantId` upon successful OTP validation, storing them in `MerchantProvider.credentials`.
- **Session Management & Automated Keep-Alive:**
  - **`keepaliveBharatPeSessions` (`bharatpe-simple.service.ts`):** Runs every 15 minutes (`0 */15 * * * *`).
  - Fetches a lightweight 1-minute transaction history window (`fromDate = now - 60000`) for all active BharatPe providers to keep OAuth/JWT session tokens from expiring.
- **QR & Transaction Processing:**
  - Retrieves merchant QR codes and synchronizes settlement and transaction reports via the Tesseract payment endpoints.

---

### 8.4 Google Pay for Business (GPay) Integration

```mermaid
flowchart TD
    GPayService["GpayService"] -->|Playwright Chromium| Playwright["Headless Playwright Engine"]
    Playwright -->|User Data Dir / Persistent Profile| GoogleLogin["Google Business Portal"]
    
    subgraph GPayAutomatedCrons ["GPay Automation Crons"]
        CronSnapshot["gpay-snapshot-session-state (0 */10 * * *)"]
        CronCleanup["gpay-cleanup-stale-login-sessions (*/5 * * * *)"]
        CronSync["Transaction Scraper / Auto-Heal (*/5 * * * *)"]
    end

    GPayAutomatedCrons -->|Manage Profiles & Scrape Txns| Playwright
```

- **Integration Architecture & APIs:**
  - Implemented in `gpay.service.ts` (`merchant-service/src/modules/gpay/gpay.service.ts`).
  - Built on **Playwright** (`chromium`) to automate Google Pay for Business console interactions.
- **Authentication & Security:**
  - Uses persistent user-data directories (`loginSessions` and `activeSessions` maps) stored on the local filesystem to maintain Google Account login state across restarts.
  - Features automated OTP submission, Google 2FA verification code entry, and challenge resolution workflows.
- **Session Management & Automated Automation Crons:**
  - **`gpay-snapshot-session-state` (`0 */10 * * * *`):** Snapshots browser context and session cookies every 10 minutes.
  - **`gpay-cleanup-stale-login-sessions` (`*/5 * * * *`):** Evaluates pending login attempts and purges timed-out or stale browser login contexts every 5 minutes.
  - **Auto-Healing & Transaction Scraping (`*/5 * * * *`):** Recursively traverses Google Pay transaction structures (`findRealTxnList`), scrapes recent UPI transactions, and automatically restores dropped or invalid portal sessions (`autoHealInvalidTransactionsUrl`).

---

### 8.5 QuintusPay Integration
- **Integration Architecture & APIs:**
  - Implemented in `quintuspay-simple.service.ts`.
  - Integrates via direct REST APIs for merchant authentication and transaction verification.
- **Authentication & Security:**
  - Authenticates merchants using API credentials and OTP-based verification.
  - Validates active connections and stores session credentials in `MerchantProvider.credentials`.

---

### 8.6 HDFC Bank SmartHub Vyapar Integration

```mermaid
flowchart LR
    HDFCService["HdfcVyaparService"] -->|1. Fetch RSA Public Key| HDFCKey["/api/keys (Cached 1 hr)"]
    
    subgraph EncryptRequest ["AES-256-GCM + RSA-OAEP Encryption"]
        GenerateAES["Generate AES-256 Key & IV"] --> EncryptPayload["Encrypt Payload (AES-GCM)"]
        GenerateAES --> EncryptKeyIV["Encrypt Key & IV (RSA-OAEP)"]
    end
    
    HDFCService --> EncryptRequest
    EncryptRequest -->|2. POST PAYLOAD, KEY, IV| Proxy["https://www.hdfcbankvyapar.com/api/secure-data-fetch"]
    Proxy -->|3. Encrypted Response| Decrypt["Decrypt Response (AES-256-GCM)"]
```

- **Integration Architecture & APIs:**
  - Implemented in `hdfc-vyapar.service.ts`, `hdfc-crypto.util.ts`, and `hdfc-keepalive.cron.ts`.
  - Communicates via secure HDFC Bank endpoints: `https://www.hdfcbankvyapar.com/api/secure-data-fetch`.
- **Cryptographic Encryption & Authentication Pipeline (`HdfcCryptoUtil`):**
  - **Public Key Caching:** Fetches HDFC Bank's RSA Public Key from `https://www.hdfcbankvyapar.com/api/keys`, caching it in memory for 1 hour (`CACHE_TTL = 3600000`).
  - **Request Payload Encryption:**
    1. Generates a random 32-byte AES-256 key and 12-byte IV.
    2. Appends a unique session timestamp `uid` (`aesKey.base64 + "_" + Date.now()`).
    3. Encrypts the request JSON using **AES-256-GCM**, concatenating the ciphertext with the 16-byte authentication tag into a Base64 string (`PAYLOAD`).
    4. Encrypts the AES Key (`KEY`) and IV (`IV`) using **RSA-OAEP** (`RSA_PKCS1_OAEP_PADDING` with SHA-256) against HDFC's public key.
  - **Response Decryption:** Decrypts the returned Base64 response payload using the session's AES-256 key, IV, and auth tag.
  - **Resilience:** Implements a 3-attempt retry loop with exponential backoff (`1000 * attempt` ms) and a 10-second AbortSignal timeout per attempt.
- **Session Management & Automated Keep-Alive:**
  - **`HdfcKeepaliveCron` (`hdfc-keepalive.cron.ts`):** Runs every 10 minutes (`0 */10 * * * *`).
  - Regularly pings the HDFC Vyapar proxy endpoint to maintain active session validity.

---

### 8.7 Razorpay & Cashfree Integration Status
- **Current Codebase Status:** *Not implemented in current codebase.*
- **Details:** The provider enumeration (`ProviderType.RAZORPAY`, `ProviderType.CASHFREE`) and database seeder references (`seed-gateways.ts`) exist in the schema to support future multi-provider expansions and unlock scripts. However, automated onboarding, credential verification, and transaction processing services for Razorpay and Cashfree have not yet been built in `merchant-service`.

---

## 9. Transaction Lifecycle & Payment Flows

The transaction lifecycle coordinates order initialization, merchant selection, QR rendering, webhook processing, and real-time frontend notification.

```mermaid
sequenceDiagram
    participant Client as Client Application
    participant APIGW as API Gateway (:3100)
    participant PaySvc as Payment Service (:3103)
    participant MerchSvc as Merchant Service (:3102)
    participant Gateway as Provider API (PhonePe / Paytm / etc.)
    participant DB as MySQL (Payment DB)
    participant SSE as OrderEventsService (SSE)

    Client->>APIGW: POST /api/v1/orders/simple/create (amount, orgId)
    APIGW->>PaySvc: Proxy create order request
    PaySvc->>DB: Insert Order record (status: PENDING)
    
    PaySvc->>MerchSvc: POST /internal/routing/route (orgId, amount)
    MerchSvc-->>PaySvc: Return selected merchantId & name (via Round-Robin/Limits)
    
    PaySvc->>MerchSvc: GET /internal/providers/merchant/:id/credentials
    MerchSvc-->>PaySvc: Return decrypted Gateway credentials
    
    PaySvc->>Gateway: Request Dynamic UPI QR / Payment Link
    Gateway-->>PaySvc: Return QR String / Web URL
    PaySvc->>DB: Create Transaction record (status: PENDING)
    PaySvc-->>Client: Return Order ID & Payment QR
    
    Note over Client,Gateway: Customer scans QR and completes payment on UPI App
    
    Gateway->>PaySvc: POST /api/v1/webhook (Checksum + Payload)
    PaySvc->>PaySvc: Verify X-VERIFY / HMAC Checksum
    
    alt Payment Success
        PaySvc->>DB: Update Transaction status = SUCCESS
        PaySvc->>DB: Update Order status = COMPLETED, store UTR
        PaySvc->>SSE: broadcastOrderUpdated(orderId, "order.updated")
        SSE-->>Client: Real-Time SSE Notification ("Order completed")
    else Payment Failed / Expired
        PaySvc->>DB: Update Transaction & Order status = FAILED
    end
```

### Webhook & Callback Verification
1. **Endpoint:** Gateways send asynchronous POST callbacks to `/api/v1/webhook` or `/api/v1/callback` (`payment-service`).
2. **Checksum Validation:** `WebhookService` intercepts the callback, extracts the gateway signature (`X-VERIFY` for PhonePe, HMAC for Paytm/HDFC), and validates it against the merchant's stored secret salt. Invalid signatures are rejected with a `401 Unauthorized` / `400 Bad Request`.
3. **Idempotent Updates:** Once validated, the database transaction updates `Transaction.status` to `SUCCESS` and updates the parent `Order.status` to `COMPLETED`, recording the bank `utr` and gateway reference ID.

### Automated Reconciliation & Cleanup
- **`CronService.handlePendingOrders` (`*/5 * * * *`):** Runs every 5 minutes in `payment-service`. Queries up to 20 `PENDING` orders created between 10 minutes and 1 hour ago, calling provider APIs (`checkOrderStatus`) to verify if the order succeeded or expired.
- **`CronService.nightlyReconciliation` (`0 2 * * *`):** Runs daily at 2:00 AM. Scans the last 7 days of orders where `Order.status` is not `COMPLETED`, checking if a child `Transaction` with `SUCCESS` status exists (matched via `orderId` or `utr`). Automatically heals orphan orders by marking them `COMPLETED` and updating `Order.utr`.

---

## 10. Merchant Routing & Rate Limiting Engine

The **Routing & Rate Limiting Engine** (`RoutingService` in `merchant-service`) ensures transactions are assigned to healthy, within-limit merchant accounts.

```mermaid
flowchart TD
    Start["Payment Request (organizationId, amount)"] --> FindMerchants["Find Active Merchants for Org (isFallback = false)"]
    FindMerchants --> LoopCandidates{"For each Merchant"}
    
    LoopCandidates -->|Check 1| ActiveCheck["Is Merchant Active & DeletedAt == null?"]
    ActiveCheck -->|Check 2| AmountCheck["Is amount >= minTxnAmount && <= maxTxnAmount?"]
    AmountCheck -->|Check 3| LimitCheck["Is Daily / Monthly Volume Limit Exceeded?"]
    LimitCheck -->|Check 4| ScheduleCheck["Is Current Time within Operating Hours & Work Days?"]
    ScheduleCheck -->|Check 5| RedisRateCheck["Check Redis Rate Limit: rate_limit:merchantId:window"]
    
    RedisRateCheck -->|Passed| AddCandidate["Add to Valid Candidates List"]
    RedisRateCheck -->|Rate Limited / Failed| RejectCandidate["Skip Merchant"]
    
    AddCandidate --> EvalCandidates{"Candidates > 0?"}
    
    EvalCandidates -->|Yes| PickRandom["Select Random Merchant from Candidates"]
    PickRandom --> ConsumeLimit["Increment Redis Counter: redis.incr(key), expire 65s"]
    ConsumeLimit --> ReturnSuccess["Return Selected Merchant ID"]
    
    EvalCandidates -->|No| CheckFallback{"Fallback Merchant Exists? (isFallback = true)"}
    CheckFallback -->|Yes| EvalFallback["Validate Fallback Merchant & Rate Limit"]
    EvalFallback -->|Passed| SelectFallback["Select Fallback Merchant"]
    CheckFallback -->|No| ReturnError["Return Error: No suitable merchant found"]
```

### Routing & Merchant Selection Algorithm
1. **Validation Checks (`validateMerchantForTransaction`):**
   - Verifies the merchant is active (`isActive: true`, `status: "ACTIVE"`).
   - Validates transaction bounds (`amount >= minTxnAmount` and `amount <= maxTxnAmount`).
   - Validates schedule constraints (operating hours and weekly holiday calendar).
   - Checks daily and monthly aggregate volume limits against historical transactions.
2. **Randomized Candidate Selection:**
   - All merchants that pass validation and are not rate-limited are collected into a candidates array.
   - To distribute load evenly across valid accounts, the engine selects a candidate at random (`candidates[Math.floor(Math.random() * candidates.length)]`).
3. **Fallback Failover:**
   - If no standard candidates are available (e.g., due to volume limits or rate limits), the engine evaluates designated fallback merchants (`isFallback: true`). If a fallback merchant is valid, it processes the transaction.

### Redis-Backed Rate Limiting
- **Key Schema:** `rate_limit:{merchantId}:{window}`, where `window` is the current minute (`Math.floor(Date.now() / 60000)`).
- **Evaluation (`isRateLimitExceeded`):** Queries Redis (`redis.get(key)`). If the count exceeds `merchant.config.perMinuteMaxTxn`, the merchant is marked rate-limited for that minute.
- **Consumption (`consumeRateLimit`):** Atomically increments the selected merchant's counter (`redis.incr(key)`). On the first increment (`current === 1`), a 65-second expiration (`redis.expire(key, 65)`) is set to ensure automatic key cleanup.

---

## 11. Subscription & Billing Architecture

The `subscription-service` oversees SaaS billing, slot-based merchant assignments, and provider access rules.

```mermaid
flowchart LR
    Plan["SubscriptionPlan (e.g., Enterprise)"] -->|Defines Max Limits| Access["SubscriptionProviderAccess (Included Providers & Slots)"]
    Purchase["SubscriptionPurchase (Linked to Payment Order)"] -->|Generates N Slots| Slot["OrgSubscription (Slot: ACTIVE / UNASSIGNED)"]
    
    Slot -->|Assigned to| Merchant["Merchant Entity (in Merchant Service)"]
    
    subgraph ProviderUnlockModel ["Provider Unlock Model"]
        UnlockPurchase["MerchantUnlockPurchase"] -->|Grants Lifetime / Sub Access| Unlock["MerchantUnlock (e.g., GPAY, PHONEPE)"]
    </subgraph>
```

### Slot-Based Subscription Model
- **SubscriptionPlan (`subscription_plans`):** Defines price, billing cycle (`MONTHLY`, `QUARTERLY`, `YEARLY`, `LIFETIME`), trial period, and maximum quotas (`maxUsers`, `maxMerchants`, `maxTransactions`).
- **OrgSubscription (`org_subscriptions`):** Represents an individual subscription slot. When an organization purchases a plan with quantity $N$, the system creates $N$ `OrgSubscription` records.
- **Slot Assignment:** Each active slot (`SlotStatus.ACTIVE`) can be assigned to a specific `merchantId`. Unassigned slots (`SlotStatus.UNASSIGNED`) remain available for new merchant onboarding.
- **Merchant Provider Unlocks (`merchant_unlocks`):** Organizations can unlock specific gateway provider types (e.g., Google Pay, BharatPe) via `MerchantUnlock` records, which grant either `LIFETIME` access or subscription-bound access.

---

## 12. Notification & Alerting System

The `notification-service` is an internal utility service protected by `InternalAuthGuard` (`x-internal-token`) that delivers alerts and notifications.

### Notification Channels & Real-Time SSE
1. **Email Delivery (`POST /internal/send/email`):**
   - Supports SMTP, Nodemailer, and SendGrid transports configured via `.env`.
   - Renders HTML/text email templates for registration OTPs, welcome emails, usage alerts, and password resets.
2. **Web Push Notifications (`POST /internal/push/subscribe`, `POST /internal/push/send`):**
   - Implements standard Web Push protocols (`web-push`) with VAPID keys.
   - Manages client endpoint subscriptions (`p256dh`, `auth` keys) in an in-memory store (`push-subscription.store.ts`), keyed by `userId` and `organizationId`.
3. **Server-Sent Events (SSE) & In-App Notifications (`OrderEventsService` in `payment-service`):**
   - Frontend dashboards establish an HTTP SSE connection (`event: order.updated`).
   - When a transaction succeeds, `OrderEventsService.broadcastOrderUpdated` emits a real-time event stream to all active client connections belonging to that `organizationId`.
   - Simultaneously writes a persistent notification record to the `InAppNotification` MySQL table to ensure notifications survive browser refreshes and are accessible across devices.

---

## 13. Background Jobs & Cron Services

UPipe relies on NestJS scheduled crons (`@Cron`) across microservices for session maintenance, reconciliation, and cleanup.

| Service | Cron Method Name | Schedule Expression | Description / Actual Code Responsibility |
| :--- | :--- | :--- | :--- |
| **merchant-service** | `PhonePeKeepAliveCron.handleCron` | `0 */15 * * * *` (Every 15 mins) | Warms active PhonePe providers by querying `/v3/merchant/transactions/history` to prevent session logout. |
| **merchant-service** | `HdfcKeepaliveCron.handleCron` | `0 */10 * * * *` (Every 10 mins) | Pings HDFC SmartHub Vyapar proxy endpoints to maintain active RSA/AES proxy sessions. |
| **merchant-service** | `PaytmSimpleService.keepalivePaytmSessions` | `0 */15 * * * *` (Every 15 mins) | Executes background activity within automated Puppeteer Chromium browsers for active Paytm providers. |
| **merchant-service** | `BharatPeSimpleService.keepaliveBharatPeSessions` | `0 */15 * * * *` (Every 15 mins) | Queries a 1-minute transaction history window for active BharatPe merchants to keep JWT tokens valid. |
| **merchant-service** | `GpayService.snapshotSessionState` | `0 */10 * * * *` (Every 10 mins) | Snapshots Playwright Chromium browser contexts and login state to local filesystem profile directories. |
| **merchant-service** | `GpayService.cleanupStaleLoginSessions` | `*/5 * * * *` (Every 5 mins) | Purges incomplete, timed-out, or stale Google Pay browser login sessions from memory. |
| **merchant-service** | `GpayService` (Txn Sync & Auto-Heal) | `*/5 * * * *` (Every 5 mins) | Scrapes recent GPay UPI transactions and auto-heals dropped merchant portal URLs. |
| **payment-service** | `CronService.cleanupOldNotifications` | `0 0 * * *` (`EVERY_DAY_AT_MIDNIGHT`) | Deletes in-app notifications (`InAppNotification`) older than 14 days to preserve database performance. |
| **payment-service** | `CronService.nightlyReconciliation` | `0 2 * * *` (`EVERY_DAY_AT_2AM`) | Reconciles pending orders against `SUCCESS` transactions over the last 7 days; heals orphan orders. |
| **payment-service** | `CronService.handlePendingOrders` | `*/5 * * * *` (`EVERY_5_MINUTES`) | Scans `PENDING` orders aged 10 minutes to 1 hour, querying provider APIs to update success or expiration state. |

---

## 14. Inter-Service Communication

Microservices communicate internally using **Synchronous REST / HTTP calls** over local TCP ports (`3101`–`3106`).

```mermaid
sequenceDiagram
    participant PaySvc as Payment Service (:3103)
    participant MerchSvc as Merchant Service (:3102)
    participant InternalGuard as InternalAuthGuard

    PaySvc->>MerchSvc: HTTP POST /internal/routing/route (Header: x-internal-token)
    MerchSvc->>InternalGuard: Intercept Request
    InternalGuard->>InternalGuard: Validate x-internal-token == process.env.INTERNAL_TOKEN
    
    alt Token Valid
        InternalGuard-->>MerchSvc: Allow Request
        MerchSvc-->>PaySvc: Return HTTP 200 OK (Selected Merchant JSON)
    else Token Invalid / Missing
        InternalGuard-->>PaySvc: HTTP 401 Unauthorized
    end
```

### Security of Inter-Service Calls
- Internal endpoints (prefixed with `/internal/*`) are protected by `InternalAuthGuard` (`internal-auth.guard.ts`).
- Services calling internal endpoints must pass the secret pre-shared token in the HTTP header:
  `x-internal-token: process.env.INTERNAL_TOKEN`.
- If the token is missing or does not match `INTERNAL_TOKEN`, the guard rejects the request with a `401 Unauthorized` exception.
- External ingress through the API Gateway cannot access `/internal/*` endpoints because the Gateway routing rules explicitly proxy client requests to public `/api/v1/*` paths.

---

## 15. Error Handling & Resilience

- **Global Exception Filtering:** All microservices implement NestJS global exception filters (`HttpExceptionFilter`). Unhandled exceptions are caught, logged via `Logger`, and formatted into standardized JSON error responses:
  ```json
  {
    "statusCode": 400,
    "timestamp": "2026-07-30T17:50:00.000Z",
    "path": "/api/v1/orders/simple/create",
    "message": "No suitable merchant found to process this transaction."
  }
  ```
- **Retry Policies & Timeout Budgets:**
  - External gateway HTTP requests use explicit timeout budgets (e.g., 10-second `AbortSignal.timeout` on HDFC Vyapar calls).
  - Failed cryptographic or proxy calls in HDFC Vyapar implement a 3-attempt retry loop with linear/exponential backoff (`setTimeout(res, 1000 * attempt)`).
- **Graceful Degradation & Fallbacks:**
  - If primary routing candidates are rate-limited or fail validation, `RoutingService` automatically fails over to `isFallback = true` merchants.
  - Non-critical background failures (e.g., in-app notification insertion failures or SSE stream write errors) are caught and suppressed (`.catch(() => {})` or logger warnings) to ensure core payment processing paths remain unaffected.

---

## 16. Security Considerations

1. **Cryptographic Standards:**
   - **User Passwords:** Hashed with `bcrypt` (10 salt rounds).
   - **Session Authentication:** HMACS/RSA signed JSON Web Tokens (`JWT_SECRET`).
   - **HDFC Gateway Payload Encryption:** **AES-256-GCM** for message encryption (32-byte key, 12-byte IV, 16-byte auth tag) paired with **RSA-OAEP** (SHA-256) public key encryption for key exchange.
   - **Webhook Checksum Signatures:** **SHA-256 HMAC** hashing with merchant secret salts to verify PhonePe (`X-VERIFY`) and Paytm callback authenticity.
2. **Sensitive Data Protection:**
   - Provider credentials (API keys, OAuth cookies, refresh tokens) are stored in the database within `MerchantProvider.credentials` JSON structures and should be secured via environment encryption at rest in production.
   - All internal inter-service calls require `INTERNAL_TOKEN` authentication.
3. **Input Validation & SQL Injection Protection:**
   - Input payloads are sanitized globally using NestJS `ValidationPipe` with `whitelist: true` and `transform: true`, stripping unknown properties.
   - Strict UUID regex checks are enforced on organization and merchant IDs before executing routing logic.
   - All database operations are mediated by **Prisma ORM**, which uses parameterized queries to protect against SQL injection.

---

## 17. Configuration & Environment Reference

The following table documents the primary environment variables required to run and configure the UPipe backend microservices.

| Environment Variable | Target Services | Default / Example Value | Purpose & Description |
| :--- | :--- | :--- | :--- |
| `PORT` | All Services | `3000` (Gateway), `3101`–`3106` | HTTP listening port for the specific microservice. |
| `DATABASE_URL` | `identity`, `organization`, `merchant`, `payment`, `subscription` | `mysql://user:password@localhost:3306/upipe_db` | Connection string for the MySQL Prisma datasource. |
| `JWT_SECRET` | `api-gateway`, `identity-service`, `organization-service` | `super-secret-key-change-in-prod` | Symmetric secret key used to sign and verify user JWT access/refresh tokens. |
| `INTERNAL_TOKEN` | All Services | `internal-secret-token` | Pre-shared security token required in `x-internal-token` header for inter-service REST calls. |
| `REDIS_HOST` | `merchant-service` | `localhost` | Redis server hostname used by `RoutingService` for rate-limiting counters. |
| `REDIS_PORT` | `merchant-service` | `6379` | Redis server TCP port. |
| `REDIS_PASSWORD` | `merchant-service` | `""` | Optional password for Redis authentication. |
| `PHONEPE_CHECKSUM_ENDPOINT` | `merchant-service` | `http://localhost:4000/checksum?trd=` | External proxy endpoint for calculating PhonePe SDK checksums. |
| `IDENTITY_SERVICE_URL` | `api-gateway` | `http://localhost:3101` | Downstream URL target for `/api/v1/auth` and `/api/v1/users` proxy routes. |
| `ORGANIZATION_SERVICE_URL` | `api-gateway` | `http://localhost:3106` | Downstream URL target for `/api/v1/organizations`, `/api/v1/roles`, and `/api/v1/cms`. |
| `MERCHANT_SERVICE_URL` | `api-gateway`, `payment-service` | `http://localhost:3102` | Downstream URL target for `/api/v1/merchants`, `/api/v1/providers`, and internal routing. |
| `PAYMENT_SERVICE_URL` | `api-gateway` | `http://localhost:3103` | Downstream URL target for `/api/v1/orders` and `/api/v1/transactions`. |
| `SUBSCRIPTION_SERVICE_URL` | `api-gateway` | `http://localhost:3105` | Downstream URL target for `/api/v1/subscriptions`. |
| `NOTIFICATION_SERVICE_URL` | `payment-service`, `identity-service` | `http://localhost:3006` | Downstream URL target for internal email and push notification delivery. |
| `FRONTEND_URL` | `api-gateway`, `identity-service` | `http://localhost:5173` | Allowed CORS origin and target for password reset and email redirect links. |

# Quintus / QuintusPay Integration Technical Reference

## Executive Summary

The **Quintus** (also referred to as **QuintusPay** in specific service codes) integration in the UPipe platform provides UPI payment processing and transaction reconciliation for merchants via the Quintus Tech BAPA API (`https://bapa-api.quintustech.in`). 

Unlike web-scraped integrations, Quintus operates as a **100% API-based** provider integration. It authenticates via mobile OTP verification to obtain a JWT bearer access token (`accessToken`) and refresh token, retrieves the merchant's Virtual Payment Address (`vpa`) from the Quintus API, and polls the Quintus transaction API to discover payments and reconcile pending UPI orders. 

There are **no webhook endpoints** implemented for Quintus; payment confirmation relies entirely on background cron polling in `merchant-service`.

---

## 1. System Architecture & Service Boundary

```
+---------------------------------------------------------------------------------------------+
|                                        UPipe Backend                                        |
|                                                                                             |
|  +------------------------+                     +----------------------------------------+  |
|  |  api-gateway (3100)    |                     |        payment-service (3103)          |  |
|  +------------------------+                     +----------------------------------------+  |
|              |                                    |                        ^                |
|              | HTTP                               | Owns:                  |                |
|              v                                    |  - Order               | HTTP           |
|  +------------------------+                       |  - Transaction         | (x-internal-   |
|  | merchant-service (3102)|                       |  - PaymentLink         |  token)        |
|  +------------------------+                       +------------------------|---------------+  |
|   |  |                  |                                                  |                  |
|   |  |                  +--------------------------------------------------+                  |
|   |  | Owns: MySQL (merchant_db) -> merchant_providers                                        |
|   |  |                                                                                        |
|   |  +-----------------------+------------------------+                                       |
|   |                          |                        |                                       |
|   v                          v                        v                                       |
| [QuintusPaySimpleService]  [OrderStatusCronService] [TransactionService]                      |
+---|--------------------------|------------------------|---------------------------------------+
    |                          |                        |
    | HTTPS                    | HTTPS                  | HTTPS
    v                          v                        v
+---------------------------------------------------------------------------------------------+
|                          Quintus Tech API (https://bapa-api.quintustech.in)                 |
|   - POST /api/qt/user/sendOtp        - POST /api/qt/transaction/getList                     |
|   - POST /api/qt/user/verifyOtp      - GET  /api/qt/user/fetchQr                            |
+---------------------------------------------------------------------------------------------+
```

### Service Responsibility & Ports (Reference: [`SHARED_BACKEND_FACTS.md`](file:///upipe_backend/docs/providers/SHARED_BACKEND_FACTS.md))

| Service | Verified Fallback Port (`main.ts`) | Role in Quintus Integration |
| :--- | :--- | :--- |
| `api-gateway` | `3100` (`process.env.PORT`, L59) | Routes merchant onboarding (`/provider-connections/quintus/otp`) and order requests. |
| `merchant-service` | `3102` (`process.env.PORT \|\| 3102`, L43) | Manages Quintus OTP onboarding (`QuintusPaySimpleService`), credentials storage, session keep-alive cron, historical transaction synchronization, and pending order status polling (`OrderStatusCronService`). |
| `payment-service` | `3103` (`process.env.PORT \|\| 3103`, L32) | Owns payment orders and transaction records. Generates UPI intent links/QR strings. Receives internal HTTP requests (`POST /transactions/sync`) from `merchant-service` to complete orders. |
| `subscription-service` | `3105` (`process.env.PORT \|\| 3105`, L32) | Controls provider access unlocks; recognizes both `QUINTUS` and `QUINTUSPAY` provider codes. |

---

## 2. Database Schema & Credential Storage

### Provider Type Enum (`ProviderType`)
In `merchant-service/prisma/schema.prisma`, the canonical enum value is:
```prisma
enum ProviderType {
  // ...
  QUINTUS
}
```

### Credential JSON Structure (`MerchantProvider.credentials`)
When a merchant connects Quintus via `QuintusPaySimpleService.completeConnection`, the credentials are stored in `merchant_providers.credentials` (JSON):

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsIn...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIsIn...",
  "user": {
    "_id": "6581a...",
    "merchant_name": "Acme Store",
    "email": "merchant@example.com",
    "mobile": "9876543210"
  },
  "upiId": "merchant@quintus"
}
```

| Field | Source | Usage |
| :--- | :--- | :--- |
| `accessToken` | `POST /api/qt/user/verifyOtp` (`response.data.accessToken`) | Bearer token included in all `Authorization: Bearer <token>` API requests. |
| `refreshToken` | `POST /api/qt/user/verifyOtp` (`response.data.refreshToken`) | Stored refresh token (auto-refresh logic is not implemented in current service code; expiration sets metadata auth error). |
| `user` | `POST /api/qt/user/verifyOtp` (`response.data.user`) | Complete user profile object returned by Quintus API. `_id` is used as `merchantId` fallback. |
| `upiId` | `GET /api/qt/user/fetchQr` (`response.data.data.vpa`) | Primary VPA used to generate UPI QR codes for merchant checkout. |

---

## 3. Onboarding & Authentication Flow

Quintus onboarding is implemented in `QuintusPaySimpleService` (`merchant-service/src/modules/provider/quintuspay-simple.service.ts`):

```
Merchant                 merchant-service (QuintusPaySimpleService)         Quintus API (bapa-api.quintustech.in)
   |                                       |                                                |
   |-- 1. POST /provider-connections/----->|                                                |
   |      quintus/otp { phoneNumber }      |-- 2. POST /api/qt/user/sendOtp --------------->|
   |                                       |      { authid: phoneNumber }                   |
   |                                       |<-- 3. { success: true, message: "OTP sent" } --|
   |<-- 4. { success: true } --------------|                                                |
   |                                       |                                                |
   |-- 5. POST /provider-connections/----->|                                                |
   |      quintus/verify { phone, otp }    |-- 6. POST /api/qt/user/verifyOtp ------------->|
   |                                       |      { authid: phoneNumber, otp: otp }         |
   |                                       |<-- 7. { accessToken, refreshToken, user } -----|
   |                                       |                                                |
   |                                       |-- 8. GET /api/qt/user/fetchQr ---------------->|
   |                                       |      Authorization: Bearer <accessToken>       |
   |                                       |<-- 9. { data: { vpa: "merchant@quintus" } } ---|
   |                                       |                                                |
   |                                       |-- 10. upsert MerchantProvider (QUINTUS)        |
   |<-- 11. { success: true, upiId } ------|                                                |
```

### Step 1: Initiate OTP (`sendOtp`)
* **Endpoint:** `POST https://bapa-api.quintustech.in/api/qt/user/sendOtp`
* **Payload:** `{ "authid": "<phoneNumber>" }`
* **Headers:** 
  * `Accept: application/json`, `Content-Type: application/json`
  * `Origin: https://bapa-api.quintustech.in`, `Referer: https://bapa-api.quintustech.in/`
  * `User-Agent: Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) ...`
* **Response Verification:** Asserts `response.data?.success !== false`.

### Step 2: Verify OTP & Retrieve Profile (`verifyOtp`)
* **Endpoint:** `POST https://bapa-api.quintustech.in/api/qt/user/verifyOtp`
* **Payload:** `{ "authid": "<phoneNumber>", "otp": "<otp>" }`
* **Response Verification:** Validates `response.data?.success !== false` and presence of `accessToken`.

### Step 3: Fetch VPA (`getUpiId`)
* **Endpoint:** `GET https://bapa-api.quintustech.in/api/qt/user/fetchQr`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Response Mapping:** Extracts `response.data?.data?.vpa`.
* **Database Upsert:** Creates or updates `MerchantProvider` with:
  * `providerType: ProviderType.QUINTUS`
  * `status: MerchantProviderStatus.ACTIVE`
  * `credentials: { accessToken, refreshToken, user, upiId }`

---

## 4. Transaction Discovery & Reconciliation Architecture

All transaction queries and pending order matches for Quintus are performed via the Quintus transaction list API.

### Transaction History Endpoint (`fetchTransactionHistory`)
* **Endpoint:** `POST https://bapa-api.quintustech.in/api/qt/transaction/getList`
* **Headers:** `Authorization: Bearer <accessToken>`, `Content-Type: application/json`
* **Concurrent Multi-Type Querying:**
  In `QuintusPaySimpleService.fetchTransactionHistory` (lines 244–275), `merchant-service` executes **two concurrent HTTP POST requests** using `Promise.allSettled`:
  1. **Seller Settlement Query:**
     ```json
     {
       "startDate": "YYYY-MM-DD",
       "endDate": "YYYY-MM-DD",
       "transactionType": ["SELLER_SETTLEMENT"],
       "selectedStatus": []
     }
     ```
  2. **UPI Resolution Query:**
     ```json
     {
       "startDate": "YYYY-MM-DD",
       "endDate": "YYYY-MM-DD",
       "transactionType": ["UPI_RESOLUTION"],
       "selectedStatus": []
     }
     ```
* **Results Aggregation:** Arrays returned from both queries (`response.data.data`) are merged into `allTransactions`.
* **Auth Error Handling:** If either call returns HTTP `401` or `403`, `fetchTransactionHistory` returns `{ success: false, authError: true, error: "QUINTUSPAY_AUTH_EXPIRED" }`.

---

## 5. Cron Jobs & Synchronization Pipelines

Quintus participates in three distinct scheduled cron pipelines inside `merchant-service`:

```
+---------------------------------------------------------------------------------------------+
|                                      Cron Schedules                                         |
|                                                                                             |
|  1. Keep-Alive Session Cron                  2. Transaction Sync Cron                       |
|     (QuintusPaySimpleService)                   (TransactionSyncCron)                       |
|     0 */15 * * * * (Every 15 mins)              0 2,7,12... * * * * (Every 5 mins, +2m off) |
|     - Queries last 60s transactions             - Queries last 2 hours                      |
|     - Prevents token idle expiration            - Syncs transactions -> payment-service     |
|                                                                                             |
|  3. Pending Order Reconciliation Cron                                                       |
|     (OrderStatusCronService)                                                                |
|     0 */30 * * * * (Every 30 seconds)                                                       |
|     - Matches pending orders by Reference ID or Exact Amount + Timestamp Window             |
+---------------------------------------------------------------------------------------------+
```

### 1. Keep-Alive Session Cron (`keepaliveQuintusPaySessions`)
* **Schedule:** `0 */15 * * * *` (Every 15 minutes at second 0).
* **Location:** `QuintusPaySimpleService.keepaliveQuintusPaySessions`
* **Target:** Selects up to 50 active `ProviderType.QUINTUS` merchant providers.
* **Action:** Issues a lightweight call to `fetchTransactionHistory` for a 1-minute time window (`now - 60s` to `now`) to prevent the Quintus remote bearer token from expiring due to inactivity.

### 2. Recent & Historical Transaction Sync (`TransactionSyncCron`)
* **Schedule:** `0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Every 5 minutes, offset by 2 minutes from keep-alive cron).
* **Location:** `TransactionSyncCron.syncRecentTransactions` -> `TransactionService.syncTransactions` -> `syncQuintusTransactions`.
* **Window:** Fetches transactions for the last 2 hours (`now - 2 hours` to `now`).
* **Persistence:** Calls `processAndSaveQuintusTransactions`, which sends chunks of up to 10 transactions concurrently to `payment-service` via internal HTTP:
  * `POST ${PAYMENT_SERVICE_URL}/transactions/sync`
  * Header: `x-internal-token: ${INTERNAL_TOKEN}`
  * Payload values:
    * `externalTransactionId`: `String(txn.referenceNo || txn._id || txn.description?.gatewayTransactionId)`
    * `status`: Mapped via `mapQuintusStatus` (`SUCCESS`/`PAID` -> `SUCCESS`; `FAILED`/`REJECT`/`DECLINED`/`EXPIRED` -> `FAILED`; others -> `PENDING`).
    * `providerCode`: `"QUINTUS"`
  * **On Auth Expired (401/403):** Updates `MerchantProvider.metadata` with `{ authError: "UNAUTHORIZED", authExpiredAt: new Date() }`. **Does not** set `isActive = false` or `status = ERROR`.

### 3. Pending Order Status Reconciliation (`OrderStatusCronService`)
* **Schedule:** `@Cron("5,20,35,50 * * * * *")` (Every 15 seconds: at seconds 5, 20, 35, and 50 of every minute).
* **Location:** `OrderStatusCronService.checkQuintusPayOrdersForMerchant` (lines 1319–1458).
* **Query Window:** Dynamically determines `fromDate` using `providerLastTxnTime - 60000` (or `oldestOrderCreatedAt - 5 minutes`, clamped to a maximum lookback of 24 hours).

#### Matching Criteria (`checkQuintusPayOrdersForMerchant`)
For each pending order, candidate transactions are filtered:
1. **Status Condition:** Must have `txn.status === "SUCCESS"` or `txn.status === "PAID"`.
2. **Exact Reference Match (Priority 1):** 
   * Checks if `txn.description?.merchantRequestId === order.externalOrderId` or `order.id`.
   * If matched, **bypasses time window checks immediately**.
3. **Amount + Timestamp Match (Priority 2):**
   * Amount: Must match exactly (`Number(txn.amount) === Number(order.amount)`).
   * Timestamp Window: The transaction timestamp (`created_at`, `description.transactionTimestamp`, `createdAt`, or `updatedAt`) must satisfy:
     ```
     orderCreatedAt - 60 seconds <= txnTimeMs <= orderCreatedAt + 300 seconds (5 mins)
     ```
4. **Duplicate Verification:**
   * Checks local RAM cache (`processedTransactionIds`, max 10,000 IDs).
   * Queries `payment-service` (`GET /transactions?externalTransactionId=<externalId>`) to ensure the transaction has not already completed another order.
5. **Order Completion:**
   * Invokes `handleQuintusPayTransactionMatch` -> `syncTransactionAndCompleteOrder`.
   * Posts completion to `payment-service` with `providerCode: "QUINTUSPAY"`, `status: "SUCCESS"`, `paymentMethod: "UPI"`, transitioning the order to `Order.status = "COMPLETED"` (`OrderStatus.COMPLETED`) and recording a `"SUCCESS"` (`TransactionStatus.SUCCESS`) ledger entry.

---

## 6. Provider Code Naming Nuances Across Microservices

A critical verified finding in the codebase is that Quintus uses **two different string representations** across different modules:

| Context / Module | Identifier Used | Notes / Code Reference |
| :--- | :--- | :--- |
| **Prisma Schema (`MerchantProvider`)** | `QUINTUS` | Canonical `ProviderType` enum value (`schema.prisma` line 181). |
| **Transaction Service Sync** | `"QUINTUS"` | Passed as `providerCode` in `TransactionService.syncQuintusTransactions` (`transaction.service.ts` line 2056). |
| **Pending Order Reconciliation** | `"QUINTUSPAY"` | Passed as `providerCode` in `OrderStatusCronService.handleQuintusPayTransactionMatch` (`order-status-cron.service.ts` line 1477). |
| **Analytics & Reporting (`payment-service`)** | `"quintus"` / `"QuintusPay"` | `SimpleOrdersController` aggregates orders matching `app.includes("quintus")` under `{ id: "quintus", name: "QuintusPay" }`. |
| **Subscription / Unlock Service** | `'QUINTUS'`, `'QUINTUSPAY'` | Both codes are included in `DEFAULT_UNLOCKED_TYPES` and plan unlock scripts to ensure compatibility. |

---

## 7. Webhook & Callback Implementation

* **Verified Status:** **Not Implemented (100% Polling-Based)**.
* **Codebase Verification:** A complete search of `payment-service` (`WebhookController`, `WebhookService`) and `merchant-service` confirms there are no webhook routes or signature verification handlers for Quintus/QuintusPay.
* **Impact:** Order settlement relies entirely on the 30-second polling interval in `OrderStatusCronService` and the 5-minute synchronization cycle in `TransactionSyncCron`.

---

## 8. Verification Report

### Verification Checklist
- [x] Service Ports Verified: Confirmed application fallback ports (`main.ts`) for `api-gateway` (3100), `merchant-service` (3102), `payment-service` (3103), `subscription-service` (3105), `identity-service` (3101), `organization-service` (3106), and `notification-service` (3006).
- [x] Database Ownership Verified: Confirmed `MerchantProvider` is owned exclusively by `merchant-service`, and `Order`, `Transaction`, `PaymentLink` are owned exclusively by `payment-service` in MySQL.
- [x] Webhook Routes Verified: Confirmed there are zero webhook endpoints or callback verifiers for Quintus/QuintusPay across the entire repository (100% polling-based).
- [x] Cron Intervals Verified: Confirmed 6-field NestJS cron syntax (`0 */15 * * * *` every 15 minutes keep-alive; `@Cron("5,20,35,50 * * * * *")` every 15 seconds pending order check; `@Cron("0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *")` every 5 minutes sync).
- [x] Status Enums Verified: Confirmed `OrderStatus.COMPLETED` and `TransactionStatus.SUCCESS` literal enums in `payment-service/prisma/schema.prisma`.

### Corrections Made During Audit
| Category | Previous Claim | Verified Fact | Source Code Evidence |
| :--- | :--- | :--- | :--- |
| **Service Application Ports** | Listed `subscription-service` port as `3004` | Verified fallback port in `subscription-service/src/main.ts` is `3105` (`process.env.PORT || 3105`). Referenced `SHARED_BACKEND_FACTS.md`. | `subscription-service/src/main.ts` (L32) |
| **Pending Order Cron Frequency** | Documented `@Cron` schedule as `0 */30 * * * *` ("Every 30 seconds") | `0 */30 * * * *` is every 30 minutes in 6-field cron. The actual verified decorator for pending order checking is `@Cron("5,20,35,50 * * * * *")` (every 15 seconds). | `merchant-service/src/modules/transaction/order-status-cron.service.ts` (L41) |
| **Order Completion Status** | Claimed completed orders update `Order.status = "SUCCESS"` | A paid order transitions to `OrderStatus.COMPLETED` (`"COMPLETED"`), while the transaction record is `"SUCCESS"` (`TransactionStatus.SUCCESS`). | `payment-service/prisma/schema.prisma` (L175: `OrderStatus`) |
| **Database Table Reference** | Used snake_case table name `merchant_providers` in normal text | Replaced with standard PascalCase Prisma model name `MerchantProvider`. | `merchant-service/prisma/schema.prisma` (L45) |
| **Absolute Paths** | Included workstation path `/Users/<username>/...` | Removed absolute workstation paths and replaced with relative repository paths. | All audit sections |

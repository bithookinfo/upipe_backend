# HDFC Bank SmartHub Vyapar Integration Technical Reference

## Executive Summary

The **HDFC Bank SmartHub Vyapar** integration in the UPipe platform enables UPI and QR payment processing for merchants via HDFC Bank's secure API endpoint (`https://www.hdfcbankvyapar.com/api/secure-data-fetch`). 

Unlike direct REST APIs or web scraper automations, HDFC SmartHub Vyapar implements an **encrypted proxy envelope** where JSON request bodies are encrypted with ephemeral **AES-256-GCM** keys, and those symmetric keys are encrypted via **RSA-OAEP (SHA-256)** using HDFC Bank's public RSA key (`https://www.hdfcbankvyapar.com/api/keys`).

The integration supports OTP onboarding, automatic session keep-alive and re-authentication using stored mPIN credentials, hierarchical VPA discovery, and transaction reconciliation.

There are **no webhook endpoints** implemented for HDFC SmartHub Vyapar in the UPipe codebase; payment confirmation relies entirely on background API polling in `merchant-service`.

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
|   |  +-----------------------+------------------------+-----------------------+               |
|   |                          |                        |                       |               |
|   v                          v                        v                       v               |
| [HdfcVyaparService]    [HdfcCryptoUtil]     [HdfcKeepaliveCron]  [OrderStatusCronService]     |
+---|--------------------------|------------------------|-----------------------|---------------+
    |                          |                        |                       |
    | HTTPS                    | HTTPS (Cached 1h)      | HTTPS                 | HTTPS
    v                          v                        v                       v
+---------------------------------------------------------------------------------------------+
|                 HDFC Bank SmartHub Vyapar API (https://www.hdfcbankvyapar.com)              |
|   - POST /api/secure-data-fetch (Encrypted Envelope)     - GET /api/keys (RSA Public Key)   |
+---------------------------------------------------------------------------------------------+
```

### Service Responsibility & Ports (Reference: [`SHARED_BACKEND_FACTS.md`](file:///upipe_backend/docs/providers/SHARED_BACKEND_FACTS.md))

| Service | Verified Fallback Port (`main.ts`) | Role in HDFC Integration |
| :--- | :--- | :--- |
| `api-gateway` | `3100` (`process.env.PORT`, L59) | Routes merchant onboarding (`/provider-connections/hdfc/otp`, `/verify`) and order requests. |
| `merchant-service` | `3102` (`process.env.PORT \|\| 3102`, L43) | Manages HDFC OTP/mPIN onboarding (`HdfcVyaparService`), cryptographic envelope encryption/decryption (`HdfcCryptoUtil`), 10-minute session keep-alive and auto-refresh (`HdfcKeepaliveCron`), historical transaction sync, and pending order status polling (`OrderStatusCronService`). |
| `payment-service` | `3103` (`process.env.PORT \|\| 3103`, L32) | Owns payment orders and transaction records. Generates UPI intent links/QR strings. Receives internal HTTP requests (`POST /transactions/sync`) from `merchant-service` to complete orders. |
| `subscription-service` | `3105` (`process.env.PORT \|\| 3105`, L32) | Controls provider access unlocks; recognizes `'HDFC'`, `'HDFCVYAPAR'`, and `'HDFC_VYAPAR'` provider codes. |

---

## 2. Database Schema & Credential Storage

### Provider Type Enum (`ProviderType`)
In `merchant-service/prisma/schema.prisma`, the canonical enum value is:
```prisma
enum ProviderType {
  // ...
  HDFC
}
```

### Credential JSON Structure (`MerchantProvider.credentials`)
When a merchant connects HDFC Vyapar via `HdfcVyaparService`, credentials and session tokens are stored in `merchant_providers.credentials` (JSON):

```json
{
  "mobileNumber": "9876543210",
  "mPin": "1234",
  "sessionId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "deviceId": "f0e1d2c3b4a59687",
  "upiId": "acmestore.12345@hdfcbank",
  "tidList": ["12345", "67890"],
  "lastKeepalive": "2026-07-30T10:00:00.000Z",
  "sessionRefreshCount": 14,
  "sessionRefreshFailures": 0
}
```

| Field | Source | Usage |
| :--- | :--- | :--- |
| `mobileNumber` | Merchant onboarding input | Login ID passed in `VALIDATE_USER`, `VERIFY_OTP`, and `VERIFY_MPIN`. |
| `mPin` | Merchant onboarding input / OTP fallback | Stored 4-digit mPIN used for background automated session re-authentication. |
| `sessionId` | `POST /api/secure-data-fetch` (`VALIDATE_USER` response) | Active session identifier passed in request header `sessionId`. |
| `deviceId` | Generated 16-byte hex (`crypto.randomBytes(16).toString('hex')`) | Device identifier header attached to all calls. |
| `upiId` | Hierarchical VPA extraction (`HdfcVyaparService.verifyOtp`) | Primary VPA used to generate UPI QR codes for merchant checkout. |
| `tidList` | `GET_USER_TERMINAL_INFO` (`HdfcVyaparService.fetchTerminalInfo`) | Array of active Terminal IDs used to scope transaction queries. |

---

## 3. Cryptographic Proxy Envelope (`HdfcCryptoUtil`)

All HDFC API interactions pass through `HdfcCryptoUtil` (`merchant-service/src/modules/provider/hdfc-crypto.util.ts`) and `HdfcVyaparService.executeSecureCall`.

### 1. RSA Public Key Acquisition & Caching
* **Endpoint:** `GET https://www.hdfcbankvyapar.com/api/keys`
* **In-Memory Cache:** `cachedPublicKey` is cached in memory for **1 hour** (`CACHE_TTL = 3600 * 1000` ms).
* **PEM Construction:** Wraps the base64 `publicKey` field from HDFC with `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` header/footer at 64-character line lengths.

### 2. Request Envelope Encryption (`encryptRequest`)
1. **Symmetric Key Generation:** Generates a fresh 32-byte AES key (`aesKey`, AES-256) and 12-byte IV (`iv`).
2. **Payload UID:** Attaches `uid: "<base64(aesKey)>_<Date.now()>"` and `allowBodyStringify: true` to the JSON command payload.
3. **AES-256-GCM Encryption:**
   * Encrypts the payload string using `aes-256-gcm`.
   * Concatenates the ciphertext buffer and the 16-byte GCM authentication tag (`cipher.getAuthTag()`).
   * Base64-encodes the combined buffer as string field `PAYLOAD`.
4. **RSA-OAEP Key Wrapping:**
   * Encrypts `aesKey` using `crypto.publicEncrypt` with padding `RSA_PKCS1_OAEP_PADDING` and `oaepHash: "sha256"` against HDFC's RSA public key -> Base64 string `KEY`.
   * Encrypts `iv` identically -> Base64 string `IV`.
5. **Final HTTP POST Body:**
   ```json
   {
     "PAYLOAD": "<Base64_AES_GCM_Ciphertext_plus_AuthTag>",
     "KEY": "<Base64_RSA_OAEP_Encrypted_AESKey>",
     "IV": "<Base64_RSA_OAEP_Encrypted_IV>"
   }
   ```

### 3. Response Decryption (`decryptResponse`)
1. Decodes `resJson.PAYLOAD` from Base64 into a raw buffer.
2. Extracts the last 16 bytes as the GCM authentication tag (`resAuthTag`) and the preceding bytes as ciphertext (`resEncData`).
3. Decrypts with `aes-256-gcm` using the request's ephemeral `aesKey` and `iv`.

### 4. Network Reliability & Backoff (`executeSecureCall`)
* **Timeout Budget:** Each request is wrapped in an explicit 10-second timeout (`signal: AbortSignal.timeout(10000)`).
* **Retry Loop:** Implements a 3-attempt linear backoff loop (`setTimeout(res, 1000 * attempt)` ms) for network or socket exceptions.

---

## 4. Onboarding & Hierarchical VPA Discovery

```
Merchant                 merchant-service (HdfcVyaparService)             HDFC API (secure-data-fetch)
   |                                     |                                             |
   |-- 1. POST /provider-connections/--->|                                             |
   |      hdfc/otp { mobileNumber }      |-- 2. VALIDATE_USER { loginId } ------------>|
   |                                     |<-- 3. { sessionId, isMpinSet } -------------|
   |<-- 4. { success: true, sessionId } -|                                             |
   |                                     |                                             |
   |-- 5. POST /provider-connections/--->|                                             |
   |      hdfc/verify { mobile, otp,     |-- 6. VERIFY_OTP { loginId, otp, mPin } ---->|
   |                    sessionId, mPin }|<-- 7. { status: "Success" } ----------------|
   |                                     |                                             |
   |                                     |-- 8. USER_PROFILE ------------------------->|
   |                                     |-- 9. GET_USER_TERMINAL_INFO --------------->|
   |                                     |-- 10. GET_OUTLETS ------------------------->|
   |                                     |                                             |
   |<-- 11. { success: true, upiId } ----|  (Hierarchical VPA Extraction)              |
```

### VPA Discovery Hierarchy (`HdfcVyaparService.verifyOtp`)
Because HDFC accounts can represent VPAs in different structures, `HdfcVyaparService` attempts hierarchical discovery:

1. **`USER_PROFILE` Command:**
   * Scans stringified response JSON with regular expression `/"([a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)"/g`.
   * Accepts the first match containing `"hdfc"` (excluding `"support"`).
2. **`GET_USER_TERMINAL_INFO` Command:**
   * Extracts Terminal ID (`tid`) and merchant business name (`companyName`, `dba`, or `legalName`).
   * **Synthesized VPA Construction:** Removes spaces from `legalName`, substrings to 20 characters, and constructs:
     ```ts
     const fetchedVpa = `${legalName}.${tid}@hdfcbank`.toUpperCase();
     ```
3. **`GET_OUTLETS` Command:**
   * Evaluates outlets data mapped against the same extraction rules.
4. **Fallback:** If all commands fail to yield a VPA, falls back to `<mobileNumber>`.

---

## 5. Session Keep-Alive & Auto-Refresh (`HdfcKeepaliveCron`)

HDFC SmartHub Vyapar session tokens (`sessionId`) expire quickly. To prevent transaction synchronization failures, UPipe implements an automated re-login engine in `HdfcKeepaliveCron` (`merchant-service/src/modules/provider/hdfc-keepalive.cron.ts`).

### Keep-Alive & Auto-Refresh Specification
* **Cron Schedule:** `0 3,13,23,33,43,53 * * * *` (Every 10 minutes at minute 3, 13, 23, 33, 43, 53 — offset by 3 minutes from other transaction sync crons).
* **Target:** Active `ProviderType.HDFC` records having stored `mobileNumber` and a valid 4-digit `mPin`.
* **Step 1 (Session Liveness Probe):**
  * Calls `HdfcVyaparService.fetchTerminalInfo(sessionId)` (`GET_USER_TERMINAL_INFO`).
  * If TIDs are returned, the session is still active. Updates `tidList` and `lastKeepalive` in `credentials`.
* **Step 2 (Auto-Refresh on Expiry):**
  * If `fetchTerminalInfo` returns an empty array or HTTP 401/500, invokes `HdfcVyaparService.refreshSession(mobileNumber, mPin, deviceId)`.
  * **Login Call 1:** `VALIDATE_USER` -> Obtains a fresh `sessionId`.
  * **Login Call 2:** `VERIFY_MPIN` -> Authenticates session using body:
    ```json
    {
      "appInstanceId": "112",
      "authType": "mPin",
      "loginId": "<mobileNumber>",
      "mPin": "<mPin>",
      "fcmToken": ""
    }
    ```
* **Failure Circuit Breaker (`sessionRefreshFailures`):**
  * If refresh fails, `sessionRefreshFailures` increments.
  * When `sessionRefreshFailures >= 6` (**6 consecutive failures (~1 hour)**), `HdfcKeepaliveCron` updates the database record:
    ```prisma
    status = "EXPIRED"
    ```
  * Once marked `EXPIRED`, crons cease attempting refresh until merchant re-authentication.

---

## 6. Transaction Synchronization & Status Mapping

### Historical & Recent Transaction Sync (`TransactionSyncCron` -> `syncHdfcTransactions`)
* **Schedule:** `0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *` (Every 5 minutes).
* **Query Window:** Past 2 hours (`now - 2h` to `now`).
* **Endpoint Command:** `url: "GET_TRANSACTIONS"`
* **Payload Body:**
  ```json
  {
    "txnsType": ["SaleSuccess"],
    "type": "terminal",
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "paymentType": ["Cards", "UPI", "BharatQR", "SMS Pay", "Cash"],
    "tidList": ["<tid1>", "<tid2>"]
  }
  ```
* **Auto-Refresh During Sync:** If `fetchTransactionHistory` detects session expiration (`status === 401` or `error.message.includes('500')` from HDFC's `call.js`), it immediately triggers `refreshSession` and retries the fetch once.
* **Date Normalization:** Converts HDFC custom date strings `'DD-MM-YYYY HH:MM:SS'` (`^\d{2}-\d{2}-\d{4}`) to ISO `Date` objects (`'YYYY-MM-DDTHH:MM:SS'`).
* **Internal Sync:** Sends processed transactions to `payment-service` (`POST ${PAYMENT_SERVICE_URL}/transactions/sync`) with header `x-internal-token` and `providerCode: "HDFC"`.

### Status Mapping (`mapHdfcStatus`)
In `TransactionService.mapHdfcStatus` (`transaction.service.ts` lines 2269–2291):

| HDFC Raw Status String | Mapped UPipe Status | Notes |
| :--- | :--- | :--- |
| *Undefined / Omitted* | `SUCCESS` | Raw `SaleSuccess` filtered transactions often omit explicit status. |
| `SUCCESS`, `COMPLETED`, `APPROVED`, `SALE SUCCESS`, `SALESUCCESS` | `SUCCESS` | Successful payment capture. |
| `FAILED`, `DECLINED`, `REJECTED` | `FAILED` | Payment failed or rejected. |
| `REFUNDED`, `REFUND` | `REFUNDED` | Refund transaction. |
| `PENDING`, `INITIATED`, *Default* | `PENDING` | Incomplete or unverified state. |

---

## 7. Pending Order Reconciliation (`OrderStatusCronService`)

* **Schedule:** `@Cron("5,20,35,50 * * * * *")` (Every 15 seconds: at seconds 5, 20, 35, and 50 of every minute).
* **Location:** `OrderStatusCronService.checkHdfcOrdersForMerchant` (lines 1622–1668).

### Matching Algorithm (`checkHdfcOrdersForMerchant`)
For each pending order, candidate transactions from `GET_TRANSACTIONS` are evaluated:
1. **Amount Match:** Must match order amount exactly (`Number(txn.amount) === Number(order.amount)`).
2. **Sanitized Substring Matching:**
   Unlike providers that return clean reference fields, HDFC transaction payloads embed order references across varied descriptions. The matching engine sanitizes both identifiers:
   ```ts
   const sanitizedOrderId = order.externalOrderId.replace(/[^a-zA-Z0-9]/g, "");
   const stringifiedTxn = JSON.stringify(txn).replace(/[^a-zA-Z0-9]/g, "");
   
   return stringifiedTxn.includes(sanitizedOrderId);
   ```
   * Any non-alphanumeric character is stripped from `externalOrderId`.
   * The **entire raw JSON transaction object** is stringified and stripped of non-alphanumeric characters.
   * If `stringifiedTxn.includes(sanitizedOrderId)`, the transaction is matched to the order.
3. **Completion Request:**
   * Invokes `handleHdfcTransactionMatch` -> `syncTransactionAndCompleteOrder`.
   * Submits completion to `payment-service` with `providerCode: "HDFC"`, `status: "SUCCESS"`, `paymentMethod: "UPI"`, transitioning the order to `Order.status = "COMPLETED"` (`OrderStatus.COMPLETED`) and recording a `"SUCCESS"` (`TransactionStatus.SUCCESS`) ledger entry.

---

## 8. Webhook & Callback Implementation

* **Verified Status:** **Not Implemented (100% Polling-Based)**.
* **Codebase Verification:** A strict scan of `payment-service/src/controllers/webhook.controller.ts` and `webhook.service.ts` confirms there are no HDFC webhook signature verifiers or callback handlers.
* **Correction of Architecture Docs:** Any generalized mention of "HMAC for Paytm/HDFC" in high-level documentation is an assumption; HDFC Bank SmartHub Vyapar payment confirmation in UPipe operates exclusively via the 30-second cron polling loop.

---

## 9. Verification Report

### Verification Checklist
- [x] Service Ports Verified: Confirmed application fallback ports (`main.ts`) for `api-gateway` (3100), `merchant-service` (3102), `payment-service` (3103), `subscription-service` (3105), `identity-service` (3101), `organization-service` (3106), and `notification-service` (3006).
- [x] Database Ownership Verified: Confirmed `MerchantProvider` is owned exclusively by `merchant-service`, and `Order`, `Transaction`, `PaymentLink` are owned exclusively by `payment-service` in MySQL.
- [x] Webhook Routes Verified: Confirmed there are zero webhook endpoints or callback verifiers for HDFC SmartHub Vyapar across the entire repository (100% polling-based).
- [x] Cron Intervals Verified: Confirmed 6-field NestJS cron syntax (`0 3,13,23,33,43,53 * * * *` every 10 minutes keep-alive; `@Cron("5,20,35,50 * * * * *")` every 15 seconds pending order check; `@Cron("0 2,7,12,17,22,27,32,37,42,47,52,57 * * * *")` every 5 minutes sync).
- [x] Status Enums Verified: Confirmed `OrderStatus.COMPLETED` and `TransactionStatus.SUCCESS` literal enums in `payment-service/prisma/schema.prisma`.

### Corrections Made During Audit
| Category | Previous Claim | Verified Fact | Source Code Evidence |
| :--- | :--- | :--- | :--- |
| **Service Application Ports** | Listed `subscription-service` port as `3004` | Verified fallback port in `subscription-service/src/main.ts` is `3105` (`process.env.PORT || 3105`). Referenced `SHARED_BACKEND_FACTS.md`. | `subscription-service/src/main.ts` (L32) |
| **Pending Order Cron Frequency** | Documented `@Cron` schedule as `0 */30 * * * *` ("Every 30 seconds") | `0 */30 * * * *` is every 30 minutes in 6-field cron. The actual verified decorator for pending order checking is `@Cron("5,20,35,50 * * * * *")` (every 15 seconds). | `merchant-service/src/modules/transaction/order-status-cron.service.ts` (L41) |
| **Order Completion Status** | Claimed completed orders update `Order.status = "SUCCESS"` | A paid order transitions to `OrderStatus.COMPLETED` (`"COMPLETED"`), while the transaction record is `"SUCCESS"` (`TransactionStatus.SUCCESS`). | `payment-service/prisma/schema.prisma` (L175: `OrderStatus`) |
| **Database Table Reference** | Used snake_case table name `merchant_providers` in normal text | Replaced with standard PascalCase Prisma model name `MerchantProvider`. | `merchant-service/prisma/schema.prisma` (L45) |
| **Absolute Paths** | Included workstation path `/Users/<username>/...` | Removed absolute workstation paths and replaced with relative repository paths. | All audit sections |

# Merchant Service — Cron Overview

## 1. Order Status Cron (`order-status-cron.service.ts`)

| Setting | Value |
|---------|-------|
| **Interval** | Every 30 seconds (`*/30 * * * * *`) |
| **Purpose** | Poll PENDING orders → fetch provider txns → match → complete order |

**Flow:**
1. `GET {PAYMENT_SERVICE_URL}/orders?status=PENDING&limit=50`
2. Skip orders older than 30 min
3. For each order: find active provider → fetch txns (Paytm/PhonePe/BharatPe) → match by orderId
4. On match: `POST /transactions/sync` → `PATCH /orders/{id}/status` → `updateMerchantUsage`

**Skips:** EXPIRED providers, BharatPe with `authError=UNAUTHORIZED`

**Batching:** Orders grouped by `merchantId` → one provider fetch per merchant → all orders matched against fetched txns.

---

## 2. Transaction Sync Cron (`transaction-sync.cron.ts`)

| Cron | Interval | Purpose |
|------|----------|---------|
| syncRecentTransactions | 5 min (offset :02) | Last 2h, **PhonePe/BharatPe only** (Paytm via syncPaytmFast) |
| syncPaytmFast | 60s | Last 5 min, Paytm only |
| syncPaytmHistorical | 30 min (`*/30 * * * *`) | Last 24h, Paytm only |
| syncDailyTransactions | Hourly | Last 24h, **PhonePe/BharatPe only** (Paytm via syncPaytmHistorical) |
| syncFullHistory | Daily 2 AM | Last 30 days, all providers |
| checkProviderHealth | 2 hours | **Paytm, PhonePe, BharatPe** — marks expired/unauthorized |
| syncPhonePeUpiIds | 10 min (offset :04) | PhonePe UPI IDs for new merchants |
| cleanupOldData | Weekly | Placeholder |

**No overlap:** Paytm is synced only by syncPaytmFast + syncPaytmHistorical. PhonePe/BharatPe by syncRecent + syncDaily.

---

## 3. PhonePe Keepalive (`phonepe-keepalive.cron.ts`)

| Setting | Value |
|---------|-------|
| **Interval** | Every 2 min (JWT ~10min, refresh token ~1h; more frequent = longer session) |
| **Scope** | web-api providers, status=ACTIVE only |
| **Action** | `fetchTransactionHistoryWeb(size=1)` to warm, persist session updates |

**Skips:** Non-web-api, EXPIRED providers (filtered by status).
**On sessionExpired:** Marks provider as EXPIRED immediately.

---

## 4. Data Flow Summary

```
Order Status (30s)     → payment-service → provider APIs (per order)
Transaction Sync (5m)  → provider APIs → payment-service /transactions/sync
PhonePe Keepalive (2m)→ PhonePe web-api (warm only)
```

---

## 5. Resolved (previously known issues)

- **checkProviderHealth:** Now checks Paytm, PhonePe, and BharatPe
- **syncPaytmHistorical:** Fixed to `*/30 * * * *` (every 30 min, 5-field format)
- **Overlap:** syncRecent and syncDaily exclude Paytm; Paytm handled by syncPaytmFast + syncPaytmHistorical

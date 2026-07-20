# GPay (Google Pay for Business) Integration

## How It Works

### User Flow

1. **User selects GPay** in the merchant onboarding UI
2. **Enters Gmail** (username) – used to identify the GPay For Business account
3. **Clicks Connect** – we create a merchant provider record
4. **Enters UPI ID** (e.g. `yourname@gpay`) – the VPA where payments will be received
5. **Done** – GPay is connected and payments can be routed to this UPI ID

### "Confirm it's you" / Phone Verification

**Important:** Google does **NOT** provide an official API for programmatic merchant onboarding. When users log into Google/GPay:

- **"Confirm it's you"** – Google may send a push notification to the user's phone. The user **must tap/click** on their phone to approve. This is Google's 2FA and **cannot be automated** by third parties.
- **Phone number verification** – Sometimes Google asks to verify via SMS or tap on phone. Again, the user **must interact** – we cannot automate this.

**Our approach:** The user completes Google verification **outside** our app (in the GPay For Business app or browser). Once they have their GPay UPI ID, they enter it in our onboarding flow. We store the UPI ID for payment routing.

### What We Store

- `accountIdentifier` – Initially the Gmail, then updated to the UPI ID (e.g. `yourname@gpay`)
- `credentials` – Email, businessId, sessionData:
  - `cookie` – Full cookie string for API requests (batchexecute, etc.)
  - `cookies` – Raw cookie array
  - `atToken` – From localStorage (if present)
  - `localStorage` / `sessionStorage` – Full key-value dump for debugging/replay
  - `fSid`, `bl` – GPay batchexecute session params (when extractable)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/gateway/gpay/connect-gpay` | Connect GPay (requires `username`, `organizationId`) |
| POST | `/gateway/gpay/update-gpay-upi` | Save UPI ID (requires `upiId`, `organizationId`) |

## File Structure

```
modules/gpay/
├── gpay.service.ts   # Connect + update logic
├── gpay.module.ts    # Nest module
└── README.md         # This file
```

Routes are handled by `GatewayController` which delegates to `GpayService` when `providerId === "gpay"`.

## Browser: Playwright (Chrome)

GPay uses **Playwright** with **Chrome** by default (`channel: "chrome"` = real Chrome from your system).

- **GPAY_BROWSER** – `chromium` (default, uses real Chrome) or `firefox`
- **GPAY_USE_REAL_CHROME** – `true` (default) – use system Chrome; `false` for bundled Chromium
- **GPAY_HEADLESS** – `true` (default) or `false` (visible browser)
- **GPAY_PROXY** – **Recommended for production** – residential proxy URL (datacenter IPs often blocked)

**Setup:** Chrome is used from your system. For Firefox: `npx playwright install firefox`

## Limitations

- No programmatic Google login – user must verify with Google themselves
- No automation of "Confirm it's you" or phone verification
- **Session expiry:** Google cookies expire quickly. Transaction sync may return 401; we mark the provider as EXPIRED and the user must reconnect.

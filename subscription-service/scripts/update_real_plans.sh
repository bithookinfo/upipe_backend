#!/usr/bin/env bash
set -euo pipefail

# ===== CONFIGURE THESE BEFORE RUNNING =====
# If you expose subscription-service via API gateway, point BASE_URL there instead.
# Current .env says PORT=4004, so default to that test URL.
# Example (direct service from this machine): http://127.0.0.1:4004/subscriptions
# Example (gateway):                         http://localhost:4000/subscriptions
BASE_URL="http://127.0.0.1:4004/subscriptions"

# Optional: admin JWT that can call /subscriptions/plans PATCH.
# Leave empty if your subscription-service is not protected in local/dev.
AUTH_TOKEN=""

# =========================================

auth_header() {
  if [[ -n "${AUTH_TOKEN}" ]]; then
    echo "Authorization: Bearer ${AUTH_TOKEN}"
  fi
}

get_plans() {
  curl -sS -H "$(auth_header)" "${BASE_URL}/plans?activeOnly=false"
}

plan_id() {
  local name="$1"
  local cycle="$2" # e.g. MONTHLY or QUARTERLY
  get_plans | jq -r \
    --arg n "$name" --arg c "$cycle" '
      .data // .plans // [] | map(select(.name == $n and (.billingCycle // "") == $c)) | .[0].id // empty
    '
}

patch_plan() {
  local id="$1"
  local json_body="$2"

  echo "→ Updating plan ${id}"
  curl -sS -X PATCH \
    -H "Content-Type: application/json" \
    ${AUTH_TOKEN:+-H "$(auth_header)"} \
    -d "${json_body}" \
    "${BASE_URL}/plans/${id}" \
    | jq .
  echo
}

echo "Fetching existing plans..."

# ===== MONTHLY PLANS (28 days) =====
# In your current DB the seeded MONTHLY plans are:
#   Basic, Professional, Enterprise
# We will map them to the UI you shared:
#   Basic       -> Starter (₹1299)
#   Professional-> Startup (₹1999)
#   Enterprise  -> Business (₹2499, Recommended)

starter_monthly_id=$(plan_id "Basic" "MONTHLY")
startup_monthly_id=$(plan_id "Professional" "MONTHLY")
business_monthly_id=$(plan_id "Enterprise" "MONTHLY")

if [[ -z "$starter_monthly_id" || -z "$startup_monthly_id" || -z "$business_monthly_id" ]]; then
  echo "ERROR: Could not find Basic/Professional/Enterprise MONTHLY plans. Check names/billingCycle in DB."
  exit 1
fi

patch_plan "$starter_monthly_id" '{
  "price": 1299,
  "billingCycle": "MONTHLY",
  "isActive": true,
  "isFeatured": false,
  "sortOrder": 10,
  "description": "Starter monthly plan",
  "features": [
    "4,999 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

patch_plan "$startup_monthly_id" '{
  "price": 1999,
  "billingCycle": "MONTHLY",
  "isActive": true,
  "isFeatured": false,
  "sortOrder": 20,
  "description": "Startup monthly plan",
  "features": [
    "8,599 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

patch_plan "$business_monthly_id" '{
  "price": 2499,
  "billingCycle": "MONTHLY",
  "isActive": true,
  "isFeatured": true,
  "sortOrder": 30,
  "description": "Business monthly plan",
  "features": [
    "11,999 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

# ===== QUARTERLY PLANS (84 days, 10% more request) =====

starter_quarterly_id=$(plan_id "Starter" "QUARTERLY")
startup_quarterly_id=$(plan_id "Startup" "QUARTERLY")
business_quarterly_id=$(plan_id "Business" "QUARTERLY")
business_plus_quarterly_id=$(plan_id "Business +" "QUARTERLY")

if [[ -z "$starter_quarterly_id" && -z "$startup_quarterly_id" && -z "$business_quarterly_id" && -z "$business_plus_quarterly_id" ]]; then
  echo "No QUARTERLY plans found in DB, skipping quarterly updates."
else

patch_plan "$starter_quarterly_id" '{
  "price": 3899,
  "billingCycle": "QUARTERLY",
  "isActive": true,
  "isFeatured": false,
  "sortOrder": 50,
  "description": "Starter quarterly plan (10% more requests)",
  "features": [
    "16,499 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

patch_plan "$startup_quarterly_id" '{
  "price": 5999,
  "billingCycle": "QUARTERLY",
  "isActive": true,
  "isFeatured": false,
  "sortOrder": 60,
  "description": "Startup quarterly plan (10% more requests)",
  "features": [
    "28,399 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

patch_plan "$business_quarterly_id" '{
  "price": 7499,
  "billingCycle": "QUARTERLY",
  "isActive": true,
  "isFeatured": true,
  "sortOrder": 70,
  "description": "Business quarterly plan (10% more requests)",
  "features": [
    "39,599 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'

patch_plan "$business_plus_quarterly_id" '{
  "price": 14999,
  "billingCycle": "QUARTERLY",
  "isActive": true,
  "isFeatured": false,
  "sortOrder": 80,
  "description": "Business+ quarterly plan (10% more requests)",
  "features": [
    "82,449 QR Code Request",
    "0 Transaction Fee *",
    "Realtime Transaction",
    "No Amount Limit",
    "Zero Setup Charge",
    "Migration Assistance",
    "24*7 Whatsapp Support",
    "Remove Branding",
    "Direct Intent *",
    "Incognito Payment URL",
    "Allow connecting multiple merchants",
    "Support Special & Star Merchant *"
  ]
}'
fi

echo "✅ Monthly plans updated. Quarterly updated only if QUARTERLY plans existed."


#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Running Prisma db execute for quarterly plans..."
npx prisma db execute --file prisma/seed_quarterly_plans.sql --schema prisma/schema.prisma

echo "Quarterly plans seeded. Current plans:"
curl -s "http://127.0.0.1:4004/subscriptions/plans?activeOnly=false" \
  | jq '.data // .plans | map({name,billingCycle,price})'


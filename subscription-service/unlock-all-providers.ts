import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const providers = [
  'PHONEPE',
  'PAYTM',
  'GPAY',
  'RAZORPAY',
  'CASHFREE',
  'BHARATPE',
  'STRIPE',
  'PAYPAL',
  'HDFCVYAPAR',
  'HDFC_VYAPAR',
  'QUINTUS',
  'QUINTUSPAY',
  'CUSTOM'
];

async function main() {
  console.log("Fetching all subscription plans...");
  const plans = await prisma.subscriptionPlan.findMany();
  console.log(`Found ${plans.length} plans. Unlocking providers...`);
  
  for (const plan of plans) {
    for (const pCode of providers) {
      await prisma.subscriptionProviderAccess.upsert({
        where: {
          planId_providerCode: {
            planId: plan.id,
            providerCode: pCode,
          }
        },
        update: { isIncluded: true },
        create: {
          planId: plan.id,
          providerCode: pCode,
          isIncluded: true,
        }
      });
    }
  }
  console.log("Successfully updated access for all providers across all plans.");
}

main().catch(console.error).finally(() => prisma.$disconnect());

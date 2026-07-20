import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.subscriptionPlan.findMany();
  
  for (const plan of plans) {
    for (const pCode of ['QUINTUS', 'QUINTUSPAY']) {
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
  console.log("Updated QUINTUS access for all plans.");
}

main().catch(console.error).finally(() => prisma.$disconnect());

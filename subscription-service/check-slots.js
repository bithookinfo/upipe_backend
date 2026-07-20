const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const slots = await prisma.orgSubscription.findMany({
    where: { organizationId: '9501bcd1-0fb2-46ac-b589-f92dd4950daf' }
  });
  console.log(`Found ${slots.length} slots:`);
  slots.forEach(s => console.log(`${s.id} - merchantId: ${s.merchantId} - status: ${s.status}`));
}

main().catch(console.error).finally(() => prisma.$disconnect());

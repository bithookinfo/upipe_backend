const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const plans = await prisma.subscriptionPlan.findMany();
  console.log(plans);
}
main().catch(console.error).finally(() => prisma.$disconnect());

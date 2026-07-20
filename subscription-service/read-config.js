const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const config = await prisma.platformConfig.findUnique({
    where: { key: 'subscription_payment_merchant' },
  });
  console.log(JSON.stringify(config, null, 2));
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());

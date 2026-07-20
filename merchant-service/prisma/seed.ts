import { PrismaClient } from "@prisma/client";
import { seedGateways } from "./seed-gateways";
import { seedCategories } from "./seed-categories";
import { seedConfigTemplates } from "./seed-templates";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting merchant-service seed...");
  await prisma.$connect();

  await seedGateways(prisma, { logPrefix: "[gateways]" });
  await seedCategories(prisma, { logPrefix: "[categories]" });
  await seedConfigTemplates(prisma, { logPrefix: "[templates]" });

  console.log("🎉 merchant-service seed completed!");
}

main()
  .catch((e) => {
    console.error("❌ Seeding failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

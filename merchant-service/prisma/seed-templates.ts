import { PrismaClient, type Prisma } from "@prisma/client";

export async function seedConfigTemplates(
  prisma: PrismaClient,
  opts?: { logPrefix?: string },
) {
  const p = opts?.logPrefix ? `${opts.logPrefix} ` : "";
  console.log(`${p}🌱 Seeding configuration templates...`);

  const predefinedTemplates: Array<
    Omit<Prisma.ConfigTemplateCreateInput, "organizationId">
  > = [
    {
      name: "Small Business",
      description: "Ideal for small businesses and startups",
      openTime: "09:00",
      closeTime: "18:00",
      dailyMaxAmount: 25000,
      dailyMaxTxnCount: 50,
      monthlyMaxAmount: 500000,
      monthlyMaxTxnCount: 1000,
      minTxnAmount: 1,
      maxTxnAmount: 5000,
      isGlobal: true,
    },
    {
      name: "Medium Business",
      description:
        "Suitable for growing businesses with moderate transaction volume",
      openTime: "09:00",
      closeTime: "21:00",
      dailyMaxAmount: 50000,
      dailyMaxTxnCount: 100,
      monthlyMaxAmount: 1000000,
      monthlyMaxTxnCount: 2000,
      minTxnAmount: 1,
      maxTxnAmount: 10000,
      isGlobal: true,
    },
    {
      name: "Large Business",
      description: "For established businesses with high transaction volumes",
      openTime: "00:00",
      closeTime: "23:59",
      dailyMaxAmount: 200000,
      dailyMaxTxnCount: 500,
      monthlyMaxAmount: 5000000,
      monthlyMaxTxnCount: 10000,
      minTxnAmount: 1,
      maxTxnAmount: 50000,
      isGlobal: true,
    },
    {
      name: "Retail Store",
      description: "Optimized for retail shops and stores",
      openTime: "10:00",
      closeTime: "22:00",
      dailyMaxAmount: 100000,
      dailyMaxTxnCount: 200,
      monthlyMaxAmount: 2000000,
      monthlyMaxTxnCount: 4000,
      minTxnAmount: 10,
      maxTxnAmount: 25000,
      isGlobal: true,
    },
    {
      name: "Restaurant & Food",
      description: "Tailored for restaurants, cafes, and food businesses",
      openTime: "08:00",
      closeTime: "23:00",
      dailyMaxAmount: 75000,
      dailyMaxTxnCount: 150,
      monthlyMaxAmount: 1500000,
      monthlyMaxTxnCount: 3000,
      minTxnAmount: 50,
      maxTxnAmount: 10000,
      isGlobal: true,
    },
  ];

  let createdCount = 0;
  for (const template of predefinedTemplates) {
    const existing = await prisma.configTemplate.findFirst({
      where: { name: template.name, isGlobal: true },
    });

    if (!existing) {
      await prisma.configTemplate.create({
        data: {
          ...template,
          organizationId: null, // Global templates have no org
        },
      });
      console.log(`${p}✅ Seeded template: ${template.name}`);
      createdCount++;
    } else {
      console.log(`${p}⏭️  Template already exists: ${template.name}`);
    }
  }

  console.log(`${p}🎉 Config templates seeded! (${createdCount} new templates created)`);
}

// Allow running this file directly: `npx ts-node prisma/seed-templates.ts`
if (require.main === module) {
  const prisma = new PrismaClient();
  seedConfigTemplates(prisma)
    .catch((e) => {
      console.error("❌ Seeding failed:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

import { PrismaClient, type Prisma } from "@prisma/client";

export async function seedCategories(
  prisma: PrismaClient,
  opts?: { logPrefix?: string },
) {
  const p = opts?.logPrefix ? `${opts.logPrefix} ` : "";
  console.log(`${p}🌱 Seeding business categories...`);

  const predefinedCategories: Array<
    Pick<Prisma.BusinessCategoryCreateInput, "name" | "code" | "description">
  > = [
    {
      name: "Retail Store",
      code: "RETAIL",
      description: "General retail and shopping stores",
    },
    {
      name: "Restaurant & Food",
      code: "RESTAURANT",
      description: "Restaurants, cafes, food delivery",
    },
    {
      name: "Grocery & Supermarket",
      code: "GROCERY",
      description: "Grocery stores and supermarkets",
    },
    {
      name: "Medical & Healthcare",
      code: "MEDICAL",
      description: "Hospitals, clinics, pharmacies",
    },
    {
      name: "Petrol Pump & Fuel",
      code: "PETROL",
      description: "Petrol pumps and fuel stations",
    },
    {
      name: "Electronics & Mobile",
      code: "ELECTRONICS",
      description: "Electronics and mobile stores",
    },
    {
      name: "Fashion & Clothing",
      code: "FASHION",
      description: "Clothing and fashion stores",
    },
    {
      name: "Education & Training",
      code: "EDUCATION",
      description: "Schools, colleges, training centers",
    },
    {
      name: "Beauty & Salon",
      code: "BEAUTY",
      description: "Beauty parlors and salons",
    },
    {
      name: "Travel & Transport",
      code: "TRAVEL",
      description: "Travel agencies and transport",
    },
    {
      name: "Services & Repairs",
      code: "SERVICES",
      description: "Service providers and repairs",
    },
    { name: "Other", code: "OTHER", description: "Other business types" },
  ];

  for (let i = 0; i < predefinedCategories.length; i++) {
    const category = predefinedCategories[i];
    const result = await prisma.businessCategory.upsert({
      where: { code: category.code },
      update: {
        name: category.name,
        description: category.description,
        isActive: true,
        sortOrder: i,
      },
      create: {
        name: category.name,
        code: category.code,
        description: category.description,
        isActive: true,
        sortOrder: i,
      },
    });

    console.log(`${p}✅ Upserted category: ${result.name}`);
  }

  console.log(`${p}🎉 Business categories seeded!`);
}

// Allow running this file directly: `npx ts-node prisma/seed-categories.ts`
if (require.main === module) {
  const prisma = new PrismaClient();
  seedCategories(prisma)
    .catch((e) => {
      console.error("❌ Seeding failed:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

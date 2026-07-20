import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding Merchant Unlock Products...");

  const products = [
    {
      merchantType: "PREMIUM_GATEWAY_ACCESS",
      displayName: "Premium Gateway Access",
      description: "Lifetime access to all premium gateways including BharatPe and Google Pay.",
      price: 1999,
      isActive: true,
    },
  ];

  for (const product of products) {
    await prisma.merchantUnlockProduct.upsert({
      where: { merchantType: product.merchantType },
      update: product,
      create: product,
    });
    console.log(`✅ Upserted product for ${product.merchantType}`);
  }

  console.log("🎉 Seeding complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

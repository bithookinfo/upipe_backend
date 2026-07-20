import { PrismaClient, type Prisma } from "@prisma/client";

export async function seedGateways(
  prisma: PrismaClient,
  opts?: { logPrefix?: string },
) {
  const p = opts?.logPrefix ? `${opts.logPrefix} ` : "";
  console.log(`${p}🌱 Seeding payment gateways...`);

  const gateways: Array<
    Pick<
      Prisma.PaymentGatewayCreateInput,
      | "code"
      | "name"
      | "description"
      | "type"
      | "logo"
      | "isActive"
      | "sortOrder"
    >
  > = [
    {
      code: "phonepe",
      name: "PhonePe",
      description: "Pay with PhonePe UPI",
      type: "UPI",
      logo: "/gateways/PhonePe.png",
      isActive: true,
      sortOrder: 1,
    },
    {
      code: "paytm",
      name: "Paytm",
      description: "Pay with Paytm Wallet and UPI",
      type: "UPI",
      logo: "/gateways/paytm.png",
      isActive: true,
      sortOrder: 2,
    },
    {
      code: "bharatpe",
      name: "BharatPe",
      description: "Pay with BharatPe UPI",
      type: "UPI",
      logo: "/gateways/Bharatpe.svg",
      isActive: true,
      sortOrder: 3,
    },
    {
      code: "gpay",
      name: "Google Pay",
      description: "Pay with Google Pay UPI",
      type: "UPI",
      logo: "/gateways/gpay.png",
      isActive: true,
      sortOrder: 4,
    },
    {
      code: "quintus",
      name: "QuintusPay",
      description: "Pay with QuintusPay",
      type: "UPI",
      logo: "/quintus/logo1.png",
      isActive: true,
      sortOrder: 5,
    },
    {
      code: "hdfc",
      name: "HDFC Bank SmartHub Vyapar",
      description: "Pay with HDFC SmartHub Vyapar UPI",
      type: "UPI",
      logo: "/gateways/hdfc_hub.png",
      isActive: true,
      sortOrder: 6,
    },
  ];

  for (const gateway of gateways) {
    const result = await prisma.paymentGateway.upsert({
      where: { code: gateway.code },
      update: {
        name: gateway.name,
        description: gateway.description,
        type: gateway.type,
        logo: gateway.logo,
        isActive: gateway.isActive,
        sortOrder: gateway.sortOrder,
      },
      create: gateway,
    });
    console.log(`${p}✅ Upserted gateway: ${result.name}`);
  }

  console.log(`${p}🎉 Payment gateways seeded successfully!`);
}

// Allow running this file directly: `npx ts-node prisma/seed-gateways.ts`
if (require.main === module) {
  const prisma = new PrismaClient();
  seedGateways(prisma)
    .catch((e) => {
      console.error("❌ Seeding failed:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

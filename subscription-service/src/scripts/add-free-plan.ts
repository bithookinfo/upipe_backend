import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addFreePlan() {
  try {
    console.log('🆓 Adding FREE subscription plan...');

    const existingFreePlan = await prisma.subscriptionPlan.findUnique({
      where: { code: 'FREE' }
    });

    if (existingFreePlan) {
      console.log('✅ FREE plan already exists:', existingFreePlan.name);
      return existingFreePlan;
    }

    const freePlan = await prisma.subscriptionPlan.create({
      data: {
        name: 'Free',
        code: 'FREE',
        description: 'Perfect for getting started - includes essential features to begin your payment journey',
        price: 0,
        currency: 'INR',
        billingCycle: 'MONTHLY',
        trialDays: 0, 
        
        maxUsers: 2,
        maxMerchants: 1,
        maxTransactions: 100,
        maxApiCalls: 1000,
        
        features: [
          'Basic payment processing',
          'Single merchant account',
          'Email support',
          'Basic analytics',
          'Standard integrations'
        ],
        
        isActive: true,
        isPublic: true,
        isFeatured: false,
        sortOrder: 0, // Show first
      }
    });

    console.log('✅ FREE plan created:', freePlan);

    // Add provider access for FREE plan (basic providers)
    const providers = [
    ];

    for (const provider of providers) {
      await prisma.subscriptionProviderAccess.create({
        data: {
          planId: freePlan.id,
          providerCode: provider.code,
          isIncluded: true,
        }
      });
      console.log(`✅ Added ${provider.code} access to FREE plan`);
    }

    // Update sort order for other plans
    await prisma.subscriptionPlan.updateMany({
      where: {
        code: { not: 'FREE' }
      },
      data: {
        sortOrder: { increment: 1 }
      }
    });

    console.log('🎉 FREE plan setup completed successfully!');
    return freePlan;

  } catch (error) {
    console.error('❌ Error adding FREE plan:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
addFreePlan()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });

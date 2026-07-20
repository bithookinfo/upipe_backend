import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
    '0 Transaction Fee *',
    'Realtime Transaction',
    'No Amount Limit',
    'Zero Setup Charge',
    'Migration Assistance',
    '24*7 Whatsapp Support',
    'Remove Branding',
    'Direct Intent *',
    'Incognito Payment URL',
    'Allow connecting multiple merchants',
    'Support Special & Star Merchant *',
];

async function main() {
    console.log('🚀 Starting subscription service seed process...\n');

    console.log('🌱 Seeding subscription plans...');

    const plans = [
        {
            name: 'Free Trial',
            code: 'TRIAL',
            description: 'Explore all features for 7 days',
            price: 0,
            currency: 'INR',
            billingCycle: 'MONTHLY' as const,
            trialDays: 7,
            maxUsers: 2,
            maxMerchants: 1,
            maxTransactions: 100,
            maxApiCalls: 1000,
            features: ['All Features Enabled', 'Limited Quotas', '7 Day Duration'],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            isTrial: true,
            sortOrder: 0,
        },
        // ── Monthly Plans ──
        {
            name: 'Starter',
            code: 'STARTER',
            description: 'Starter monthly plan',
            price: 1299,
            currency: 'INR',
            billingCycle: 'MONTHLY' as const,
            trialDays: 0,
            maxUsers: 5,
            maxMerchants: 3,
            maxTransactions: 1000,
            maxApiCalls: 10000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 10,
        },
        {
            name: 'Startup',
            code: 'STARTUP',
            description: 'Startup monthly plan',
            price: 1999,
            currency: 'INR',
            billingCycle: 'MONTHLY' as const,
            trialDays: 0,
            maxUsers: 15,
            maxMerchants: 10,
            maxTransactions: 5000,
            maxApiCalls: 50000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 20,
        },
        {
            name: 'Business',
            code: 'BUSINESS',
            description: 'Business monthly plan',
            price: 2499,
            currency: 'INR',
            billingCycle: 'MONTHLY' as const,
            trialDays: 0,
            maxUsers: 50,
            maxMerchants: 25,
            maxTransactions: 25000,
            maxApiCalls: 250000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: true,
            sortOrder: 30,
        },
        {
            name: 'Business +',
            code: 'BUSINESS_PLUS',
            description: 'Business+ monthly plan',
            price: 4999,
            currency: 'INR',
            billingCycle: 'MONTHLY' as const,
            trialDays: 0,
            maxUsers: 100,
            maxMerchants: 50,
            maxTransactions: 50000,
            maxApiCalls: 500000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 40,
        },

        // ── Quarterly Plans (10% more requests) ──
        {
            name: 'Starter',
            code: 'STARTER_QTR',
            description: 'Starter quarterly plan (10% more requests)',
            price: 3899,
            currency: 'INR',
            billingCycle: 'QUARTERLY' as const,
            trialDays: 0,
            maxUsers: 5,
            maxMerchants: 3,
            maxTransactions: 1000,
            maxApiCalls: 10000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 50,
        },
        {
            name: 'Startup',
            code: 'STARTUP_QTR',
            description: 'Startup quarterly plan (10% more requests)',
            price: 5999,
            currency: 'INR',
            billingCycle: 'QUARTERLY' as const,
            trialDays: 0,
            maxUsers: 15,
            maxMerchants: 10,
            maxTransactions: 5000,
            maxApiCalls: 50000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 60,
        },
        {
            name: 'Business',
            code: 'BUSINESS_QTR',
            description: 'Business quarterly plan (10% more requests)',
            price: 7499,
            currency: 'INR',
            billingCycle: 'QUARTERLY' as const,
            trialDays: 0,
            maxUsers: 50,
            maxMerchants: 25,
            maxTransactions: 25000,
            maxApiCalls: 250000,
            features: ['39,599 QR Code Request', ...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: true,
            sortOrder: 70,
        },
        {
            name: 'Business +',
            code: 'BUSINESS_PLUS_QTR',
            description: 'Business+ quarterly plan (10% more requests)',
            price: 14999,
            currency: 'INR',
            billingCycle: 'QUARTERLY' as const,
            trialDays: 0,
            maxUsers: 100,
            maxMerchants: 50,
            maxTransactions: 50000,
            maxApiCalls: 500000,
            features: [...FEATURES],
            isActive: true,
            isPublic: true,
            isFeatured: false,
            sortOrder: 80,
        },
    ];

    for (const plan of plans) {
        await prisma.subscriptionPlan.upsert({
            where: { code: plan.code },
            update: plan,
            create: plan,
        });
        console.log(`✅ Seeded plan: ${plan.name} (₹${plan.price}/${plan.billingCycle.toLowerCase()})`);
    }

    // Seed Provider Access for each plan
    console.log('\n🌱 Seeding provider access...');

    const providers = ['PHONEPE', 'PAYTM', 'GPAY', 'BHARATPE', 'HDFC', 'QUINTUS'];

    const planProviderAccess = plans.map(plan => ({
        planCode: plan.code,
        providers,
    }));

    for (const access of planProviderAccess) {
        const plan = await prisma.subscriptionPlan.findUnique({ where: { code: access.planCode } });
        if (!plan) continue;

        for (const providerCode of access.providers) {
            await prisma.subscriptionProviderAccess.upsert({
                where: {
                    planId_providerCode: {
                        planId: plan.id,
                        providerCode,
                    },
                },
                update: {
                    isIncluded: true,
                },
                create: {
                    planId: plan.id,
                    providerCode,
                    isIncluded: true,
                },
            });
        }
        console.log(`✅ Set provider access for ${access.planCode}: ${access.providers.join(', ')}`);
    }

    console.log('\n✨ Subscription seed completed successfully!');
    console.log('\n📝 Summary:');
    console.log(`   - ${plans.length} subscription plans created/updated`);
    console.log(`   - Provider access configured for all plans`);
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

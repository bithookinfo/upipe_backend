
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding audit logs...');

    // Get an existing organization or create a dummy one if none exists (though user JSON showed one)
    const org = await prisma.organizations.findFirst();
    const orgId = org?.id || 'cc5ad8e1-aabc-4815-9be4-794396d0c3a3'; // Fallback to the one from user JSON

    const actions = [
        'MERCHANT_CREATED',
        'USER_LOGIN',
        'SETTINGS_UPDATED',
        'API_KEY_GENERATED',
        'PAYOUT_PROCESSED',
        'REFUND_INITIATED'
    ];

    const entities = ['merchant', 'user', 'settings', 'api_key', 'payout', 'refund'];

    // Create 15 dummy logs
    for (let i = 0; i < 15; i++) {
        const actionIndex = Math.floor(Math.random() * actions.length);
        const date = new Date();
        date.setMinutes(date.getMinutes() - Math.floor(Math.random() * 10000)); // Random time in last few days

        await prisma.audit_logs.create({
            data: {
                id: randomUUID(),
                organization_id: orgId,
                action: actions[actionIndex],
                performed_by: 'Test User',
                performed_by_type: 'USER',
                entity_id: randomUUID(),
                entity_type: entities[actionIndex],
                metadata: JSON.stringify({ browser: 'Chrome', os: 'MacOS' }),
                ip_address: '127.0.0.1',
                created_at: date,
            },
        });
    }

    console.log('Seeded 15 audit logs.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

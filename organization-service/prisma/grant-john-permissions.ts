const { PrismaClient } = require('@prisma/client');
const nodeCrypto = require('crypto');

const prisma = new PrismaClient();

function generateUUID() {
    return nodeCrypto.randomUUID();
}

async function grantAllPermissionsToOwner() {
    console.log('🔍 Looking for OWNER role...');

    // Get the OWNER role
    const ownerRole = await prisma.org_roles.findFirst({
        where: { name: 'Owner' }
    });

    if (!ownerRole) {
        console.log('❌ Owner role not found');
        return;
    }

    console.log('✅ Found Owner role:', ownerRole.id);

    // Get current permissions
    const currentPerms = await prisma.role_permissions.findMany({
        where: { role_id: ownerRole.id }
    });
    console.log('📝 Current permissions:', currentPerms.length);

    // List of ALL permissions (using correct underscore format matching frontend PERMISSIONS constant)
    const allPermissionIds = [
        // Organization management
        'manage_organization',
        'view_organization',
        // User management
        'manage_users',
        'view_users',
        'invite_users',
        // Merchant management
        'manage_merchants',
        'view_merchants',
        'create_merchants',
        // Payment operations
        'create_orders',
        'view_orders',
        'manage_payments',
        // Provider management
        'manage_providers',
        'view_providers',
        // Subscription management
        'view_subscription',
        'manage_subscription',
        // Analytics and reports
        'view_analytics',
        'export_data',
        // Additional permissions from existing roles
        'user:create',
        'user:update',
        'user:view',
        'user:invite',
        'user:activate',
        'user:deactivate',
        'merchant:create',
        'merchant:update',
        'merchant:view',
        'merchant:configure',
        'merchant:verify',
        'payment:create',
        'payment:view',
        'payment:refund',
        'payment:settle',
        'payment:export',
        'report:view',
        'report:create',
        'report:export',
        'analytics:view',
        'analytics:export',
        'org:view',
        'org:update',
        'org:settings:view',
        'org:settings:update',
        'role:view',
        'role:create',
        'role:update',
        'role:assign',
        'billing:view',
        'billing:update',
        'invoice:view',
        'invoice:download',
        'webhook:view',
        'webhook:create',
        'webhook:update',
        'api_key:view',
        'api_key:create',
        'api_key:update',
        'subscription:view',
        'subscription:update',
        'audit:view',
    ];

    // Delete existing permissions
    await prisma.role_permissions.deleteMany({
        where: { role_id: ownerRole.id }
    });
    console.log('🗑️ Cleared existing permissions');

    // Add all permissions
    for (const permId of allPermissionIds) {
        await prisma.role_permissions.create({
            data: {
                id: generateUUID(),
                role_id: ownerRole.id,
                permission_id: permId
            }
        });
    }

    console.log('✅ Added', allPermissionIds.length, 'permissions to Owner role!');
    console.log('🎉 Owner (john@example.com) now has FULL access!');

    await prisma.$disconnect();
}

grantAllPermissionsToOwner();

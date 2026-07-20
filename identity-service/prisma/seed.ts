import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = [
  { code: 'org:view', name: 'View Organization', category: 'ORGANIZATION', description: 'View organization details' },
  { code: 'org:update', name: 'Update Organization', category: 'ORGANIZATION', description: 'Update organization information' },
  { code: 'org:delete', name: 'Delete Organization', category: 'ORGANIZATION', description: 'Delete organization' },
  { code: 'org:settings:view', name: 'View Organization Settings', category: 'ORGANIZATION', description: 'View organization settings' },
  { code: 'org:settings:update', name: 'Update Organization Settings', category: 'ORGANIZATION', description: 'Update organization settings' },

  { code: 'user:view', name: 'View Users', category: 'USERS', description: 'View users in organization' },
  { code: 'user:create', name: 'Create Users', category: 'USERS', description: 'Create new users' },
  { code: 'user:invite', name: 'Invite Users', category: 'USERS', description: 'Invite users to organization' },
  { code: 'user:update', name: 'Update Users', category: 'USERS', description: 'Update user information' },
  { code: 'user:delete', name: 'Delete Users', category: 'USERS', description: 'Delete users from organization' },
  { code: 'user:activate', name: 'Activate Users', category: 'USERS', description: 'Activate user accounts' },
  { code: 'user:deactivate', name: 'Deactivate Users', category: 'USERS', description: 'Deactivate user accounts' },

  { code: 'role:view', name: 'View Roles', category: 'ROLES', description: 'View organization roles' },
  { code: 'role:create', name: 'Create Roles', category: 'ROLES', description: 'Create new roles' },
  { code: 'role:update', name: 'Update Roles', category: 'ROLES', description: 'Update role permissions' },
  { code: 'role:delete', name: 'Delete Roles', category: 'ROLES', description: 'Delete organization roles' },
  { code: 'role:assign', name: 'Assign Roles', category: 'ROLES', description: 'Assign roles to users' },

  { code: 'merchant:view', name: 'View Merchants', category: 'MERCHANTS', description: 'View merchant details' },
  { code: 'merchant:create', name: 'Create Merchants', category: 'MERCHANTS', description: 'Create new merchants' },
  { code: 'merchant:update', name: 'Update Merchants', category: 'MERCHANTS', description: 'Update merchant information' },
  { code: 'merchant:delete', name: 'Delete Merchants', category: 'MERCHANTS', description: 'Delete merchants' },
  { code: 'merchant:configure', name: 'Configure Merchants', category: 'MERCHANTS', description: 'Configure merchant settings' },
  { code: 'merchant:verify', name: 'Verify Merchants', category: 'MERCHANTS', description: 'Verify merchant accounts' },
  { code: 'merchant:block', name: 'Block Merchants', category: 'MERCHANTS', description: 'Block merchant accounts' },
  { code: 'merchant:unblock', name: 'Unblock Merchants', category: 'MERCHANTS', description: 'Unblock merchant accounts' },

  // Payment Operations
  { code: 'payment:view', name: 'View Payments', category: 'PAYMENTS', description: 'View payment transactions' },
  { code: 'payment:create', name: 'Create Payments', category: 'PAYMENTS', description: 'Create payment transactions' },
  { code: 'payment:refund', name: 'Refund Payments', category: 'PAYMENTS', description: 'Process payment refunds' },
  { code: 'payment:settle', name: 'Settle Payments', category: 'PAYMENTS', description: 'Settle payment transactions' },
  { code: 'payment:export', name: 'Export Payments', category: 'PAYMENTS', description: 'Export payment data' },

  // Analytics & Reporting
  { code: 'analytics:view', name: 'View Analytics', category: 'ANALYTICS', description: 'View analytics dashboards' },
  { code: 'analytics:export', name: 'Export Analytics', category: 'ANALYTICS', description: 'Export analytics data' },
  { code: 'report:view', name: 'View Reports', category: 'ANALYTICS', description: 'View generated reports' },
  { code: 'report:create', name: 'Create Reports', category: 'ANALYTICS', description: 'Create new reports' },
  { code: 'report:export', name: 'Export Reports', category: 'ANALYTICS', description: 'Export report data' },

  // Billing & Subscription
  { code: 'subscription:view', name: 'View Subscription', category: 'BILLING', description: 'View subscription details' },
  { code: 'subscription:update', name: 'Update Subscription', category: 'BILLING', description: 'Update subscription plan' },
  { code: 'subscription:cancel', name: 'Cancel Subscription', category: 'BILLING', description: 'Cancel subscription' },
  { code: 'billing:view', name: 'View Billing', category: 'BILLING', description: 'View billing information' },
  { code: 'billing:update', name: 'Update Billing', category: 'BILLING', description: 'Update billing details' },
  { code: 'invoice:view', name: 'View Invoices', category: 'BILLING', description: 'View invoices' },
  { code: 'invoice:download', name: 'Download Invoices', category: 'BILLING', description: 'Download invoice PDFs' },

  // API & Webhooks
  { code: 'api_key:view', name: 'View API Keys', category: 'API', description: 'View API keys' },
  { code: 'api_key:create', name: 'Create API Keys', category: 'API', description: 'Create new API keys' },
  { code: 'api_key:revoke', name: 'Revoke API Keys', category: 'API', description: 'Revoke API keys' },
  { code: 'webhook:view', name: 'View Webhooks', category: 'API', description: 'View webhook configurations' },
  { code: 'webhook:create', name: 'Create Webhooks', category: 'API', description: 'Create webhook endpoints' },
  { code: 'webhook:update', name: 'Update Webhooks', category: 'API', description: 'Update webhook configurations' },
  { code: 'webhook:delete', name: 'Delete Webhooks', category: 'API', description: 'Delete webhook endpoints' },

  // Audit & Logs
  { code: 'audit:view', name: 'View Audit Logs', category: 'AUDIT', description: 'View audit trail' },
  { code: 'audit:export', name: 'Export Audit Logs', category: 'AUDIT', description: 'Export audit logs' },
];

// Define default roles
const DEFAULT_ROLES = [
  {
    name: 'Owner',
    description: 'Full access to everything - Organization Owner',
    permissions: PERMISSIONS.map(p => p.code), // All permissions
    isDefault: true,
  },
  {
    name: 'Admin',
    description: 'Administrative access with user management',
    permissions: [
      'org:view', 'org:update', 'org:settings:view', 'org:settings:update',
      'user:view', 'user:create', 'user:invite', 'user:update', 'user:deactivate', 'user:activate',
      'role:view', 'role:assign',
      'merchant:view', 'merchant:create', 'merchant:update', 'merchant:configure', 'merchant:verify',
      'payment:view', 'payment:create', 'payment:refund',
      'analytics:view', 'analytics:export',
      'report:view', 'report:create', 'report:export',
      'subscription:view', 'billing:view',
      'invoice:view', 'invoice:download',
      'api_key:view', 'webhook:view', 'webhook:create', 'webhook:update',
      'audit:view',
    ],
    isDefault: true,
  },
  {
    name: 'Manager',
    description: 'Can manage merchants and view reports',
    permissions: [
      'org:view', 'org:settings:view',
      'user:view',
      'merchant:view', 'merchant:create', 'merchant:update', 'merchant:configure',
      'payment:view', 'payment:create',
      'analytics:view',
      'report:view', 'report:export',
      'invoice:view', 'invoice:download',
    ],
    isDefault: true,
  },
  {
    name: 'Operator',
    description: 'Can handle day-to-day operations and payments',
    permissions: [
      'org:view',
      'merchant:view', 'merchant:update',
      'payment:view', 'payment:create',
      'analytics:view',
      'report:view',
    ],
    isDefault: true,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to view data',
    permissions: [
      'org:view', 'org:settings:view',
      'user:view',
      'merchant:view',
      'payment:view',
      'analytics:view',
      'report:view',
      'invoice:view',
    ],
    isDefault: true,
  },
  {
    name: 'Accountant',
    description: 'Financial data access and billing management',
    permissions: [
      'org:view',
      'payment:view', 'payment:export', 'payment:settle',
      'analytics:view', 'analytics:export',
      'report:view', 'report:create', 'report:export',
      'subscription:view',
      'billing:view', 'billing:update',
      'invoice:view', 'invoice:download',
    ],
    isDefault: true,
  },
];

async function seedPermissions() {
  console.log('🌱 Seeding permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: {
        name: permission.name,
        description: permission.description,
        category: permission.category,
        service: 'organization-service',
      },
      create: {
        code: permission.code,
        name: permission.name,
        description: permission.description,
        category: permission.category,
        service: 'organization-service',
        isActive: true,
      },
    });
  }

  console.log(`✅ Seeded ${PERMISSIONS.length} permissions`);
}

async function seedSuperAdmin() {
  console.log('🌱 Seeding SuperAdmin...');
  const bcrypt = require('bcryptjs');
  const hashedPassword = await bcrypt.hash('SuperAdmin@1234', 12);

  await prisma.superAdmin.upsert({
    where: { email: 'admin@upipe.tech' },
    update: {
      organizationId: 'd50344ec-d659-47a7-b149-7f558451ea1a'
    },
    create: {
      name: 'Super Admin',
      email: 'admin@upipe.tech',
      password: hashedPassword,
      role: 'SUPER_ADMIN',
      permissions: ['*'],
      isActive: true,
      organizationId: 'd50344ec-d659-47a7-b149-7f558451ea1a'
    },
  });
  console.log('✅ SuperAdmin seeded and linked');
}

async function main() {
  try {
    console.log('🚀 Starting seed process...\n');

    await seedPermissions();
    await seedSuperAdmin();

    console.log('\n✨ Seed completed successfully!');
    console.log('\n📝 Summary:');
    console.log(`   - ${PERMISSIONS.length} permissions created/updated`);
    console.log(`\n💡 Note: Roles will be created automatically when organizations register`);
    console.log(`   Default roles: ${DEFAULT_ROLES.map(r => r.name).join(', ')}`);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// Export for use in organization-service
export { PERMISSIONS, DEFAULT_ROLES };

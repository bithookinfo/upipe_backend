export enum Permission {
    ORG_VIEW = 'org:view',
    ORG_UPDATE = 'org:update',
    ORG_DELETE = 'org:delete',
    ORG_SETTINGS_VIEW = 'org:settings:view',
    ORG_SETTINGS_UPDATE = 'org:settings:update',

    USER_VIEW = 'user:view',
    USER_CREATE = 'user:create',
    USER_INVITE = 'user:invite',
    USER_UPDATE = 'user:update',
    USER_DELETE = 'user:delete',
    USER_DEACTIVATE = 'user:deactivate',
    USER_ACTIVATE = 'user:activate',

    ROLE_VIEW = 'role:view',
    ROLE_CREATE = 'role:create',
    ROLE_UPDATE = 'role:update',
    ROLE_DELETE = 'role:delete',
    ROLE_ASSIGN = 'role:assign',

    MERCHANT_VIEW = 'merchant:view',
    MERCHANT_CREATE = 'merchant:create',
    MERCHANT_UPDATE = 'merchant:update',
    MERCHANT_DELETE = 'merchant:delete',
    MERCHANT_CONFIGURE = 'merchant:configure',
    MERCHANT_VERIFY = 'merchant:verify',
    MERCHANT_BLOCK = 'merchant:block',
    MERCHANT_UNBLOCK = 'merchant:unblock',

    PAYMENT_VIEW = 'payment:view',
    PAYMENT_CREATE = 'payment:create',
    PAYMENT_REFUND = 'payment:refund',
    PAYMENT_SETTLE = 'payment:settle',
    PAYMENT_EXPORT = 'payment:export',

    ANALYTICS_VIEW = 'analytics:view',
    ANALYTICS_EXPORT = 'analytics:export',
    REPORT_VIEW = 'report:view',
    REPORT_CREATE = 'report:create',
    REPORT_EXPORT = 'report:export',

    SUBSCRIPTION_VIEW = 'subscription:view',
    SUBSCRIPTION_UPDATE = 'subscription:update',
    SUBSCRIPTION_CANCEL = 'subscription:cancel',

    BILLING_VIEW = 'billing:view',
    BILLING_UPDATE = 'billing:update',
    INVOICE_VIEW = 'invoice:view',
    INVOICE_DOWNLOAD = 'invoice:download',

    API_KEY_VIEW = 'api_key:view',
    API_KEY_CREATE = 'api_key:create',
    API_KEY_REVOKE = 'api_key:revoke',
    WEBHOOK_VIEW = 'webhook:view',
    WEBHOOK_CREATE = 'webhook:create',
    WEBHOOK_UPDATE = 'webhook:update',
    WEBHOOK_DELETE = 'webhook:delete',

    AUDIT_VIEW = 'audit:view',
    AUDIT_EXPORT = 'audit:export'
}

export const DEFAULT_ROLES = {
    OWNER: {
        name: 'Owner',
        description: 'Full access to everything - Organization Owner',
        permissions: Object.values(Permission),
        isDefault: true
    },

    ADMIN: {
        name: 'Admin',
        description: 'Administrative access with user management',
        permissions: [
            Permission.ORG_VIEW,
            Permission.ORG_UPDATE,
            Permission.ORG_SETTINGS_VIEW,
            Permission.ORG_SETTINGS_UPDATE,

            Permission.USER_VIEW,
            Permission.USER_CREATE,
            Permission.USER_INVITE,
            Permission.USER_UPDATE,
            Permission.USER_DEACTIVATE,
            Permission.USER_ACTIVATE,

            Permission.ROLE_VIEW,
            Permission.ROLE_ASSIGN,

            Permission.MERCHANT_VIEW,
            Permission.MERCHANT_CREATE,
            Permission.MERCHANT_UPDATE,
            Permission.MERCHANT_CONFIGURE,
            Permission.MERCHANT_VERIFY,

            Permission.PAYMENT_VIEW,
            Permission.PAYMENT_CREATE,
            Permission.PAYMENT_REFUND,

            Permission.ANALYTICS_VIEW,
            Permission.ANALYTICS_EXPORT,
            Permission.REPORT_VIEW,
            Permission.REPORT_CREATE,
            Permission.REPORT_EXPORT,

            Permission.SUBSCRIPTION_VIEW,
            Permission.BILLING_VIEW,
            Permission.INVOICE_VIEW,
            Permission.INVOICE_DOWNLOAD,

            Permission.API_KEY_VIEW,
            Permission.WEBHOOK_VIEW,
            Permission.WEBHOOK_CREATE,
            Permission.WEBHOOK_UPDATE,

            Permission.AUDIT_VIEW
        ],
        isDefault: true
    },

    MANAGER: {
        name: 'Manager',
        description: 'Can manage merchants and view reports',
        permissions: [
            Permission.ORG_VIEW,
            Permission.ORG_SETTINGS_VIEW,

            Permission.USER_VIEW,

            Permission.MERCHANT_VIEW,
            Permission.MERCHANT_CREATE,
            Permission.MERCHANT_UPDATE,
            Permission.MERCHANT_CONFIGURE,

            Permission.PAYMENT_VIEW,
            Permission.PAYMENT_CREATE,

            Permission.ANALYTICS_VIEW,
            Permission.REPORT_VIEW,
            Permission.REPORT_EXPORT,

            Permission.INVOICE_VIEW,
            Permission.INVOICE_DOWNLOAD
        ],
        isDefault: true
    },

    OPERATOR: {
        name: 'Operator',
        description: 'Can handle day-to-day operations and payments',
        permissions: [
            Permission.ORG_VIEW,

            Permission.MERCHANT_VIEW,
            Permission.MERCHANT_UPDATE,

            Permission.PAYMENT_VIEW,
            Permission.PAYMENT_CREATE,

            Permission.ANALYTICS_VIEW,
            Permission.REPORT_VIEW
        ],
        isDefault: true
    },

    VIEWER: {
        name: 'Viewer',
        description: 'Read-only access to view data',
        permissions: [
            Permission.ORG_VIEW,
            Permission.ORG_SETTINGS_VIEW,

            Permission.USER_VIEW,

            Permission.MERCHANT_VIEW,

            Permission.PAYMENT_VIEW,

            Permission.ANALYTICS_VIEW,
            Permission.REPORT_VIEW,

            Permission.INVOICE_VIEW
        ],
        isDefault: true
    },

    ACCOUNTANT: {
        name: 'Accountant',
        description: 'Financial data access and billing management',
        permissions: [
            Permission.ORG_VIEW,

            Permission.PAYMENT_VIEW,
            Permission.PAYMENT_EXPORT,
            Permission.PAYMENT_SETTLE,

            Permission.ANALYTICS_VIEW,
            Permission.ANALYTICS_EXPORT,
            Permission.REPORT_VIEW,
            Permission.REPORT_CREATE,
            Permission.REPORT_EXPORT,

            Permission.SUBSCRIPTION_VIEW,
            Permission.BILLING_VIEW,
            Permission.BILLING_UPDATE,
            Permission.INVOICE_VIEW,
            Permission.INVOICE_DOWNLOAD
        ],
        isDefault: true
    }
};

// Permission Categories for UI grouping
export const PERMISSION_CATEGORIES = {
    ORGANIZATION: {
        label: 'Organization',
        permissions: [
            Permission.ORG_VIEW,
            Permission.ORG_UPDATE,
            Permission.ORG_DELETE,
            Permission.ORG_SETTINGS_VIEW,
            Permission.ORG_SETTINGS_UPDATE
        ]
    },
    USERS: {
        label: 'User Management',
        permissions: [
            Permission.USER_VIEW,
            Permission.USER_CREATE,
            Permission.USER_INVITE,
            Permission.USER_UPDATE,
            Permission.USER_DELETE,
            Permission.USER_DEACTIVATE,
            Permission.USER_ACTIVATE
        ]
    },
    ROLES: {
        label: 'Role Management',
        permissions: [
            Permission.ROLE_VIEW,
            Permission.ROLE_CREATE,
            Permission.ROLE_UPDATE,
            Permission.ROLE_DELETE,
            Permission.ROLE_ASSIGN
        ]
    },
    MERCHANTS: {
        label: 'Merchant Management',
        permissions: [
            Permission.MERCHANT_VIEW,
            Permission.MERCHANT_CREATE,
            Permission.MERCHANT_UPDATE,
            Permission.MERCHANT_DELETE,
            Permission.MERCHANT_CONFIGURE,
            Permission.MERCHANT_VERIFY,
            Permission.MERCHANT_BLOCK,
            Permission.MERCHANT_UNBLOCK
        ]
    },
    PAYMENTS: {
        label: 'Payments & Transactions',
        permissions: [
            Permission.PAYMENT_VIEW,
            Permission.PAYMENT_CREATE,
            Permission.PAYMENT_REFUND,
            Permission.PAYMENT_SETTLE,
            Permission.PAYMENT_EXPORT
        ]
    },
    ANALYTICS: {
        label: 'Analytics & Reports',
        permissions: [
            Permission.ANALYTICS_VIEW,
            Permission.ANALYTICS_EXPORT,
            Permission.REPORT_VIEW,
            Permission.REPORT_CREATE,
            Permission.REPORT_EXPORT
        ]
    },
    BILLING: {
        label: 'Billing & Subscription',
        permissions: [
            Permission.SUBSCRIPTION_VIEW,
            Permission.SUBSCRIPTION_UPDATE,
            Permission.SUBSCRIPTION_CANCEL,
            Permission.BILLING_VIEW,
            Permission.BILLING_UPDATE,
            Permission.INVOICE_VIEW,
            Permission.INVOICE_DOWNLOAD
        ]
    },
    API: {
        label: 'API & Webhooks',
        permissions: [
            Permission.API_KEY_VIEW,
            Permission.API_KEY_CREATE,
            Permission.API_KEY_REVOKE,
            Permission.WEBHOOK_VIEW,
            Permission.WEBHOOK_CREATE,
            Permission.WEBHOOK_UPDATE,
            Permission.WEBHOOK_DELETE
        ]
    },
    AUDIT: {
        label: 'Audit & Logs',
        permissions: [
            Permission.AUDIT_VIEW,
            Permission.AUDIT_EXPORT
        ]
    }
};

export function isCriticalPermission(permission: Permission): boolean {
    const criticalPermissions = [
        Permission.ORG_DELETE,
        Permission.USER_DELETE,
        Permission.ROLE_DELETE,
        Permission.SUBSCRIPTION_CANCEL,
        Permission.API_KEY_REVOKE
    ];
    return criticalPermissions.includes(permission);
}

export function getPermissionCategory(permission: Permission): string {
    for (const [category, data] of Object.entries(PERMISSION_CATEGORIES)) {
        if (data.permissions.includes(permission)) {
            return category;
        }
    }
    return 'OTHER';
}

export function getPermissionLabel(permission: Permission): string {
    const labels: Record<string, string> = {
        [Permission.ORG_VIEW]: 'View Organization',
        [Permission.ORG_UPDATE]: 'Update Organization',
        [Permission.ORG_DELETE]: 'Delete Organization',
        [Permission.USER_VIEW]: 'View Users',
        [Permission.USER_CREATE]: 'Create Users',
        [Permission.USER_INVITE]: 'Invite Users',
        [Permission.MERCHANT_VIEW]: 'View Merchants',
        [Permission.MERCHANT_CREATE]: 'Create Merchants',
    };
    return labels[permission] || permission;
}

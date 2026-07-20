export const generateId = () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const createMockSubscriptionPlan = (overrides: any = {}) => ({
    id: generateId(),
    name: 'FREE Plan',
    code: 'FREE',
    description: 'Free tier',
    price: 0,
    billingCycle: 'MONTHLY',
    maxTransactions: 100,
    features: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});

export const createMockSubscription = (overrides: any = {}) => ({
    id: generateId(),
    organizationId: generateId(),
    planId: generateId(),
    status: 'ACTIVE',
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    transactionCount: 0,
    createdAt: new Date(),
    ...overrides,
});

export const createMockPrismaService = (): any => ({
    subscriptionPlan: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    orgSubscription: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
    },
    subscriptionUsage: {
        upsert: jest.fn(),
    },
});

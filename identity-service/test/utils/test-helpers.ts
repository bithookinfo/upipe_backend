export const generateId = () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const createMockUser = (overrides: any = {}) => ({
    id: generateId(),
    email: 'test@example.com',
    mobile: '1234567890',
    name: 'Test User',
    password: '$2a$12$hashedpassword',
    isActive: true,
    emailVerified: false,
    mobileVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLoginAt: null,
    ...overrides,
});

export const createMockJwtPayload = (overrides: any = {}) => ({
    sub: generateId(),
    email: 'test@example.com',
    organizationId: generateId(),
    ...overrides,
});

export const createMockPermission = (overrides: any = {}) => ({
    id: generateId(),
    code: 'TEST_PERMISSION',
    description: 'Test permission description',
    createdAt: new Date(),
    ...overrides,
});

export const createMockPrismaService = (): any => ({
    user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    permission: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
    },
    userPermission: {
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(this)),
});

export const waitFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const expectToReject = async (promise: Promise<any>, errorMessage?: string) => {
    try {
        await promise;
        throw new Error('Expected promise to reject but it resolved');
    } catch (err) {
        const error = err as Error;
        if (errorMessage && !error.message.includes(errorMessage)) {
            throw new Error(`Expected error message to include "${errorMessage}", but got "${error.message}"`);
        }
        return error;
    }
};

export const generateId = () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const createMockOrganization = (overrides: any = {}) => ({
    id: generateId(),
    name: 'Test Organization',
    email: 'test@org.com',
    phone: '1234567890',
    ownerUserId: generateId(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});

export const createMockRole = (overrides: any = {}) => ({
    id: generateId(),
    organizationId: generateId(),
    name: 'OWNER',
    description: 'Organization owner',
    isSystemRole: true,
    createdAt: new Date(),
    ...overrides,
});

export const createMockUser = (overrides: any = {}) => ({
    id: generateId(),
    userId: generateId(),
    organizationId: generateId(),
    roleId: generateId(),
    isActive: true,
    joinedAt: new Date(),
    ...overrides,
});

export const createMockPrismaService = (): any => ({
    organization: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    role: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
    },
    organizationUser: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
});

export const generateId = () => `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const createMockRequest = (overrides: any = {}) => ({
    headers: {
        authorization: 'Bearer test-token',
        ...overrides.headers,
    },
    user: {
        sub: generateId(),
        email: 'test@example.com',
        organizationId: generateId(),
    },
    method: 'GET',
    url: '/test',
    ...overrides,
});

export const createMockResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
});

export const createMockJwtService = () => ({
    sign: jest.fn(),
    verify: jest.fn(),
    decode: jest.fn(),
});

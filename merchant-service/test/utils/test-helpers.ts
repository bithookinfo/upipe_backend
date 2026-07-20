export const generateId = () =>
  `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const createMockTransaction = (overrides: any = {}) => ({
  id: generateId(),
  merchantId: generateId(),
  externalTransactionId: generateId(),
  amount: 100,
  currency: "INR",
  status: "SUCCESS",
  providerCode: "PAYTM",
  createdAt: new Date(),
  ...overrides,
});

export const createMockProvider = () => ({
  id: "provider-" + Math.random(),
  merchantId: "merchant-" + Math.random(),
  providerType: "PAYTM",
  accountIdentifier: "test@example.com",
  credentials: {},
  status: "ACTIVE",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const createMockMerchant = (overrides: any = {}) => ({
  id: "merchant-" + Math.random(),
  organizationId: "org-123",
  name: "Test Merchant",
  businessName: "Test Business",
  email: "test@merchant.com",
  phone: "9876543210",
  status: "ACTIVE",
  verified: true,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  providers: [createMockProvider()],
  ...overrides,
});

export const createMockPrismaService = (): any => ({
  merchant: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  provider: {
    findMany: jest.fn(),
  },
  transaction: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
});

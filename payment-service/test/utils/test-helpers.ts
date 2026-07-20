import { OrderStatus, PaymentMethod, TransactionStatus } from '@prisma/client';

export const generateId = (prefix = 'test'): string => {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
};

export const createMockOrder = (overrides: Partial<any> = {}) => {
    const orderId = generateId('ord');
    return {
        id: orderId,
        externalOrderId: `EXT_${orderId}`,
        organizationId: generateId('org'),
        merchantId: generateId('merchant'),
        providerId: generateId('provider'),
        amount: 100.0,
        currency: 'INR',
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.UPI,
        customerName: 'Test Customer',
        customerEmail: 'test@example.com',
        customerPhone: '+919876543210',
        description: 'Test Order',
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
};

export const createMockTransaction = (overrides: Partial<any> = {}) => {
    return {
        id: generateId('txn'),
        orderId: generateId('ord'),
        merchantId: generateId('merchant'),
        providerId: generateId('provider'),
        externalTransactionId: `TXN_${Date.now()}`,
        amount: 100.0,
        netAmount: 95.0,
        currency: 'INR',
        status: TransactionStatus.SUCCESS,
        paymentMethod: PaymentMethod.UPI,
        providerCode: 'PHONEPE',
        providerResponse: {},
        utr: `UTR${Date.now()}`,
        completedAt: new Date(),
        failedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
};

export const createMockPaymentLink = (overrides: Partial<any> = {}) => {
    return {
        id: generateId('link'),
        orderId: generateId('ord'),
        linkToken: generateId('token'),
        shortUrl: `https://pay.greenpay.com/${generateId('short')}`,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes from now
        isSingleUse: true,
        state: 'GENERATED',
        scannedCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
};

export const createMockMerchantResponse = (overrides: Partial<any> = {}) => {
    return {
        merchant: {
            id: generateId('merchant'),
            organizationId: generateId('org'),
            name: 'Test Merchant',
            upiId: '9876543210@ybl',
            providers: [
                {
                    id: generateId('provider'),
                    paymentGateway: 'PHONEPE',
                    isActive: true,
                    accountIdentifier: '9876543210@ybl',
                    credentials: {
                        merchantUpiId: '9876543210@ybl',
                        phone: '9876543210',
                    },
                },
            ],
            ...overrides,
        },
    };
};

export const createMockProvider = (overrides: Partial<any> = {}) => {
    return {
        id: generateId('provider'),
        paymentGateway: 'PHONEPE',
        isActive: true,
        accountIdentifier: '9876543210@ybl',
        credentials: {
            merchantUpiId: '9876543210@ybl',
            phone: '9876543210',
        },
        ...overrides,
    };
};

export const createMockPaytmWebhook = (overrides: Partial<any> = {}) => {
    return {
        ORDERID: `ORD_${Date.now()}`,
        TXNID: `TXN_${Date.now()}`,
        STATUS: 'TXN_SUCCESS',
        TXNAMOUNT: '100.00',
        BANKTXNID: `BANK_${Date.now()}`,
        ...overrides,
    };
};

export const createMockPhonePeWebhook = (overrides: Partial<any> = {}) => {
    const innerPayload = {
        code: 'PAYMENT_SUCCESS',
        data: {
            merchantTransactionId: `ORD_${Date.now()}`,
            transactionId: `TXN_${Date.now()}`,
            amount: 10000, // in paise
            utr: `UTR_${Date.now()}`,
        },
        ...overrides,
    };
    return {
        response: Buffer.from(JSON.stringify(innerPayload)).toString('base64'),
    };
};

export const createMockBharatPeWebhook = (overrides: Partial<any> = {}) => {
    return {
        orderId: `ORD_${Date.now()}`,
        transactionId: `TXN_${Date.now()}`,
        status: 'SUCCESS',
        amount: '100.00',
        utr: `UTR_${Date.now()}`,
        ...overrides,
    };
};

export const createMockPrismaService = () => {
    return {
        order: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            count: jest.fn(),
        },
        transaction: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            upsert: jest.fn(),
            count: jest.fn(),
        },
        paymentLink: {
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
        $disconnect: jest.fn(),
        $connect: jest.fn(),
    };
};

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

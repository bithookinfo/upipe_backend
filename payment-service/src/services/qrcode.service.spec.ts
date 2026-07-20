import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, Logger } from '@nestjs/common';
import { QrcodeService } from './qrcode.service';
import { PaymentLinkService } from './payment-link.service';
import { PrismaService } from '../prisma.service';
import {
    createMockPrismaService,
    createMockOrder,
    createMockPaymentLink,
    createMockMerchantResponse,
    createMockProvider,
} from '../../test/utils/test-helpers';
import axios from 'axios';
import * as QRCode from 'qrcode';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock QRCode library
jest.mock('qrcode', () => ({
    toDataURL: jest.fn(),
}));

describe('QrcodeService', () => {
    let service: QrcodeService;
    let prismaService: any;
    let paymentLinkService: PaymentLinkService;

    beforeEach(async () => {
        // Create mock services
        prismaService = createMockPrismaService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                QrcodeService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: PaymentLinkService,
                    useValue: {
                        createPaymentLink: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<QrcodeService>(QrcodeService);
        paymentLinkService = module.get<PaymentLinkService>(PaymentLinkService);

        // Suppress logger output
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();

        // Mock QRCode toDataURL method  
        (QRCode.toDataURL as jest.Mock).mockResolvedValue('data:image/png;base64,MOCK_QR_CODE');

        // Set environment variables
        process.env.MERCHANT_SERVICE_URL = 'http://localhost:3102';
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ============================================================================
    // MERCHANT VPA RETRIEVAL TESTS
    // ============================================================================

    describe('getMerchantVPA', () => {
        it('should fetch VPA from merchant service successfully', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: '9876543210@ybl',
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(mockedAxios.get).toHaveBeenCalledWith(
                'http://localhost:3102/merchant/merchant-123'
            );
            expect(vpa).toBe('9876543210@ybl');
        });

        it('should prioritize VPA from specific provider', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: '1111111111@ybl',
                providers: [
                    createMockProvider({
                        id: 'provider-phonepe',
                        paymentGateway: 'PHONEPE',
                        credentials: { merchantUpiId: '9999999999@ybl' },
                    }),
                    createMockProvider({
                        id: 'provider-paytm',
                        paymentGateway: 'PAYTM',
                        credentials: { merchantUpiId: '8888888888@paytm' },
                    }),
                ],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123', 'provider-phonepe');

            // Assert
            expect(vpa).toBe('9999999999@ybl');
        });

        it('should fallback to merchant.upiId if provider not found', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: '5555555555@ybl',
                providers: [],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123', 'non-existent-provider');

            // Assert
            expect(vpa).toBe('5555555555@ybl');
        });

        it('should find VPA from any active provider if none specified', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: null,
                providers: [
                    createMockProvider({
                        id: 'provider-inactive',
                        isActive: false,
                        credentials: { merchantUpiId: '1111111111@ybl' },
                    }),
                    createMockProvider({
                        id: 'provider-active',
                        isActive: true,
                        credentials: { merchantUpiId: '9876543210@ybl' },
                    }),
                ],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(vpa).toBe('9876543210@ybl');
        });

        it('should skip inactive providers', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: null,
                providers: [
                    createMockProvider({
                        id: 'provider-1',
                        isActive: false,
                        credentials: { merchantUpiId: '1111@ybl' },
                    }),
                    createMockProvider({
                        id: 'provider-2',
                        isActive: false,
                        credentials: { merchantUpiId: '2222@ybl' },
                    }),
                ],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(vpa).toBeNull();
        });

        it('should handle merchant not found', async () => {
            // Arrange
            mockedAxios.get.mockResolvedValue({ data: { merchant: null } });

            // Act
            const vpa = await service.getMerchantVPA('non-existent');

            // Assert
            expect(vpa).toBeNull();
        });

        it('should handle merchant service error', async () => {
            // Arrange
            mockedAxios.get.mockRejectedValue(new Error('Service unavailable'));

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(vpa).toBeNull();
        });

        it('should handle VPA marked as "Not configured"', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: 'Not configured',
                providers: [
                    createMockProvider({
                        isActive: true,
                        credentials: { merchantUpiId: 'Not configured' },
                    }),
                ],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(vpa).toBeNull();
        });

        it('should try multiple credential fields for VPA', async () => {
            // Arrange
            const merchantResponse = createMockMerchantResponse({
                upiId: null,
                providers: [
                    createMockProvider({
                        isActive: true,
                        accountIdentifier: '9876543210@ybl',
                        credentials: {
                            // No merchantUpiId or upiId
                        },
                    }),
                ],
            });
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const vpa = await service.getMerchantVPA('merchant-123');

            // Assert
            expect(vpa).toBe('9876543210@ybl');
        });
    });

    // ============================================================================
    // QR CODE CREATION TESTS
    // ============================================================================

    describe('createQrCode', () => {
        beforeEach(() => {
            (QRCode.toDataURL as jest.Mock).mockResolvedValue('data:image/png;base64,MOCK_QR_CODE');
        });

        it('should create QR code for valid order with merchant VPA', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-123',
                externalOrderId: 'EXT_ORD_123',
                merchantId: 'merchant-123',
                amount: 100,
            });
            const mockPaymentLink = createMockPaymentLink({
                linkToken: 'token-123',
                state: 'GENERATED',
            });
            const merchantResponse = createMockMerchantResponse({
                upiId: '9876543210@ybl',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(mockPaymentLink as any);

            // Act
            const result = await service.createQrCode('order-123', 5);

            // Assert
            expect(result.success).toBe(true);
            expect(result.qrCode).toHaveProperty('dataUrl', 'data:image/png;base64,MOCK_QR_CODE');
            expect(result.qrCode).toHaveProperty('paymentLink', 'token-123');
            expect(result.merchantVPA).toBe('9876543210@ybl');
            expect(paymentLinkService.createPaymentLink).toHaveBeenCalledWith('order-123', 5, true, false);
        });

        it('should generate correct UPI string format', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-upi',
                externalOrderId: 'EXT_UPI_123',
                amount: 250.50,
                merchantId: 'merchant-123',
            });
            const merchantResponse = createMockMerchantResponse({
                upiId: 'test@ybl',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            const result = await service.createQrCode('order-upi');

            // Assert
            expect(result.qrCode.upiString).toContain('upi://pay?');
            expect(result.qrCode.upiString).toContain('pa=test%40ybl'); // URL encoded @
            expect(result.qrCode.upiString).toContain('am=250.5');
            expect(result.qrCode.upiString).toContain('tr=EXT_UPI_123');
            expect(result.qrCode.upiString).toContain('tn=EXTUPI123'); // underscores stripped by sanitizer
            expect(result.qrCode.upiString).toContain('pn=Upipe+Merchant'); // URL encoded spaces
            expect(result.qrCode.upiString).toContain('mc=5411');
            expect(result.qrCode.upiString).toContain('mode=00');
        });

        it('should throw BadRequestException if order not found', async () => {
            // Arrange
            prismaService.order.findFirst.mockResolvedValue(null);

            // Act & Assert
            await expect(service.createQrCode('non-existent'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.createQrCode('non-existent'))
                .rejects
                .toThrow('Order not found with ID: non-existent');
        });

        it('should throw BadRequestException if merchant VPA not configured', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-no-vpa',
                merchantId: 'merchant-no-vpa',
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: { merchant: { upiId: null, providers: [] } } });

            // Act & Assert
            await expect(service.createQrCode('order-no-vpa'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.createQrCode('order-no-vpa'))
                .rejects
                .toThrow('Merchant UPI ID not configured');
        });

        it('should find order by internal or external ID', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'internal-123',
                externalOrderId: 'external-123',
                merchantId: 'merchant-123',
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            await service.createQrCode('external-123');

            // Assert
            expect(prismaService.order.findFirst).toHaveBeenCalledWith({
                where: {
                    OR: [
                        { id: 'external-123' },
                        { externalOrderId: 'external-123' },
                    ],
                },
            });
        });

        it('should use provider-specific VPA if providerId in order', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                id: 'order-provider',
                merchantId: 'merchant-123',
                providerId: 'provider-phonepe',
            });
            const merchantResponse = createMockMerchantResponse({
                providers: [
                    createMockProvider({
                        id: 'provider-phonepe',
                        credentials: { merchantUpiId: 'phonepe@ybl' },
                    }),
                ],
            });

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            const result = await service.createQrCode('order-provider');

            // Assert
            expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:3102/merchant/merchant-123');
            expect(result.merchantVPA).toBe('phonepe@ybl');
        });

        it('should generate QR code with correct dimensions', async () => {
            // Arrange
            const mockOrder = createMockOrder({ merchantId: 'merchant-123' });
            const merchantResponse = createMockMerchantResponse();

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            await service.createQrCode('order-123');

            // Assert
            expect((QRCode.toDataURL as jest.Mock)).toHaveBeenCalledWith(
                expect.stringContaining('upi://pay'),
                expect.objectContaining({
                    type: 'image/png',
                    margin: 1,
                    width: 300,
                    color: {
                        dark: '#000000',
                        light: '#ffffff',
                    },
                })
            );
        });
    });

    // ============================================================================
    // QR CODE RETRIEVAL TESTS
    // ============================================================================

    describe('getQrCode', () => {
        beforeEach(() => {
            (QRCode.toDataURL as jest.Mock).mockResolvedValue('data:image/png;base64,MOCK_QR_CODE');
        });

        it('should retrieve valid QR code', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                linkToken: 'token-123',
                expiresAt: futureDate,
                state: 'GENERATED',
                scannedCount: 0,
                order: createMockOrder({
                    merchantId: 'merchant-123',
                    externalOrderId: 'EXT_123',
                    amount: 100,
                }) as any,
            });
            const merchantResponse = createMockMerchantResponse({
                upiId: '9876543210@ybl',
            });

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const result = await service.getQrCode('token-123');

            // Assert
            expect(result.success).toBe(true);
            expect(result.qrCode).toHaveProperty('dataUrl');
            expect(result.qrCode).toHaveProperty('upiString');
            expect(result.merchantVPA).toBe('9876543210@ybl');
        });

        it('should throw BadRequestException if payment link not found', async () => {
            // Arrange
            prismaService.paymentLink.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.getQrCode('non-existent'))
                .rejects
                .toThrow(BadRequestException);

            await expect(service.getQrCode('non-existent'))
                .rejects
                .toThrow('Payment link not found');
        });

        it('should throw BadRequestException if payment link expired', async () => {
            // Arrange
            const pastDate = new Date(Date.now() - 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                id: 'link-expired',
                linkToken: 'expired-token',
                expiresAt: pastDate,
                order: createMockOrder() as any,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            prismaService.paymentLink.update.mockResolvedValue({});

            // Act & Assert
            await expect(service.getQrCode('expired-token'))
                .rejects
                .toThrow('QR code has expired');

            expect(prismaService.paymentLink.update).toHaveBeenCalledWith({
                where: { id: 'link-expired' },
                data: {
                    state: 'EXPIRED',
                    scannedCount: { increment: 0 },
                },
            });
        });

        it('should throw BadRequestException if payment already completed (single-use)', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                linkToken: 'completed-token',
                expiresAt: futureDate,
                isSingleUse: true,
                state: 'COMPLETED',
                order: createMockOrder() as any,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);

            // Act & Assert
            await expect(service.getQrCode('completed-token'))
                .rejects
                .toThrow('Payment already completed');
        });

        it('should mark link as SCANNED on first mobile scan', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                id: 'link-scan',
                linkToken: 'scan-token',
                expiresAt: futureDate,
                state: 'GENERATED',
                scannedCount: 0,
                order: createMockOrder({ merchantId: 'merchant-123' }) as any,
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            prismaService.paymentLink.update.mockResolvedValue({});
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            await service.getQrCode('scan-token', { deviceType: 'mobile' });

            // Assert
            expect(prismaService.paymentLink.update).toHaveBeenCalledWith({
                where: { id: 'link-scan' },
                data: {
                    state: 'SCANNED',
                    scannedCount: { increment: 1 },
                },
            });
        });

        it('should not mark as SCANNED if already scanned', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                id: 'link-already-scanned',
                linkToken: 'scanned-token',
                expiresAt: futureDate,
                state: 'SCANNED',
                scannedCount: 5,
                order: createMockOrder({ merchantId: 'merchant-123' }) as any,
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            await service.getQrCode('scanned-token', { deviceType: 'mobile' });

            // Assert
            // Should not update state to SCANNED again
            expect(prismaService.paymentLink.update).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException if merchant VPA missing', async () => {
            // Arrange
            const futureDate = new Date(Date.now() + 10 * 60 * 1000);
            const mockPaymentLink = createMockPaymentLink({
                linkToken: 'no-vpa-token',
                expiresAt: futureDate,
                order: createMockOrder({ merchantId: 'merchant-no-vpa' }) as any,
            });

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            mockedAxios.get.mockResolvedValue({ data: { merchant: { upiId: null, providers: [] } } });

            // Act & Assert
            await expect(service.getQrCode('no-vpa-token'))
                .rejects
                .toThrow('Merchant UPI ID missing');
        });
    });

    // ============================================================================
    // QR STATE MANAGEMENT TESTS
    // ============================================================================

    describe('updateQrState', () => {
        it('should update QR state correctly', async () => {
            // Arrange
            prismaService.paymentLink.update.mockResolvedValue({});

            // Act
            await service.updateQrState('link-123', 'SCANNED');

            // Assert
            expect(prismaService.paymentLink.update).toHaveBeenCalledWith({
                where: { id: 'link-123' },
                data: {
                    state: 'SCANNED',
                    scannedCount: { increment: 1 },
                },
            });
        });

        it('should not increment scan count for non-SCANNED states', async () => {
            // Arrange
            prismaService.paymentLink.update.mockResolvedValue({});

            // Act
            await service.updateQrState('link-123', 'COMPLETED');

            // Assert
            expect(prismaService.paymentLink.update).toHaveBeenCalledWith({
                where: { id: 'link-123' },
                data: {
                    state: 'COMPLETED',
                    scannedCount: { increment: 0 },
                },
            });
        });

        it('should expire order when link is marked EXPIRED', async () => {
            // Arrange
            const mockPaymentLink = {
                id: 'link-expire',
                orderId: 'order-to-expire',
                order: {
                    status: 'PENDING',
                    externalOrderId: 'EXT_ORD_EXPIRE',
                },
            };

            prismaService.paymentLink.update.mockResolvedValue({});
            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            prismaService.order.update.mockResolvedValue({});

            // Act
            await service.updateQrState('link-expire', 'EXPIRED');

            // Assert
            expect(prismaService.paymentLink.findUnique).toHaveBeenCalledWith({
                where: { id: 'link-expire' },
                select: {
                    orderId: true,
                    order: {
                        select: {
                            status: true,
                            externalOrderId: true,
                        },
                    },
                },
            });
            expect(prismaService.order.update).toHaveBeenCalledWith({
                where: { id: 'order-to-expire' },
                data: {
                    status: 'EXPIRED',
                    updatedAt: expect.any(Date),
                },
            });
        });

        it('should not expire order if already completed', async () => {
            // Arrange
            const mockPaymentLink = {
                id: 'link-completed',
                orderId: 'order-completed',
                order: {
                    status: 'COMPLETED',
                    externalOrderId: 'EXT_COMPLETED',
                },
            };

            prismaService.paymentLink.update.mockResolvedValue({});
            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);

            // Act
            await service.updateQrState('link-completed', 'EXPIRED');

            // Assert
            expect(prismaService.order.update).not.toHaveBeenCalled();
        });
    });

    // ============================================================================
    // CRON JOB TESTS - checkExpiredLinks
    // ============================================================================

    describe('checkExpiredLinks', () => {
        it('should find and expire old payment links', async () => {
            // Arrange
            const now = new Date();
            const expiredLinks = [
                { id: 'link-1', orderId: 'order-1', linkToken: 'token-1', expiresAt: new Date(now.getTime() - 1000) },
                { id: 'link-2', orderId: 'order-2', linkToken: 'token-2', expiresAt: new Date(now.getTime() - 2000) },
            ];

            prismaService.paymentLink.findMany.mockResolvedValue(expiredLinks);
            prismaService.paymentLink.update.mockResolvedValue({});
            prismaService.paymentLink.findUnique.mockResolvedValue({
                orderId: 'order-1',
                order: { status: 'PENDING', externalOrderId: 'EXT_1' },
            });
            prismaService.order.update.mockResolvedValue({});

            // Act
            await service.checkExpiredLinks();

            // Assert
            expect(prismaService.paymentLink.findMany).toHaveBeenCalledWith({
                where: {
                    expiresAt: { lt: expect.any(Date) },
                    state: { notIn: ['EXPIRED', 'COMPLETED'] },
                },
                select: {
                    id: true,
                    orderId: true,
                    linkToken: true,
                    expiresAt: true,
                },
            });

            // Should update state for both links
            expect(prismaService.paymentLink.update).toHaveBeenCalledTimes(2); // 2 links, 1 update each
        });

        it('should not fail if no expired links found', async () => {
            // Arrange
            prismaService.paymentLink.findMany.mockResolvedValue([]);

            // Act & Assert - should not throw
            await expect(service.checkExpiredLinks()).resolves.not.toThrow();
        });

        it('should handle errors in cron job gracefully', async () => {
            // Arrange
            prismaService.paymentLink.findMany.mockRejectedValue(new Error('Database error'));

            // Act & Assert - should not throw
            await expect(service.checkExpiredLinks()).resolves.not.toThrow();
        });
    });

    // ============================================================================
    // EDGE CASES
    // ============================================================================

    describe('Edge Cases', () => {
        beforeEach(() => {
            (QRCode.toDataURL as jest.Mock).mockResolvedValue('data:image/png;base64,MOCK');
        });

        it('should handle zero amount order', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                merchantId: 'merchant-123',
                amount: 0,
                externalOrderId: 'ZERO_AMT',
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            const result = await service.createQrCode('order-zero');

            // Assert
            expect(result.qrCode.upiString).toContain('am=0');
            expect(result.success).toBe(true);
        });

        it('should handle very large amount', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                merchantId: 'merchant-123',
                amount: 999999.99,
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            const result = await service.createQrCode('order-large');

            // Assert
            expect(result.qrCode.upiString).toContain('am=999999.99');
        });

        it('should handle special characters in order ID', async () => {
            // Arrange
            const mockOrder = createMockOrder({
                merchantId: 'merchant-123',
                externalOrderId: 'ORD-123_ABC@2024',
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.order.findFirst.mockResolvedValue(mockOrder);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });
            jest.spyOn(paymentLinkService, 'createPaymentLink').mockResolvedValue(createMockPaymentLink() as any);

            // Act
            const result = await service.createQrCode('order-special');

            // Assert
            expect(result.qrCode.upiString).toContain('tr=');
            expect(result.success).toBe(true);
        });

        it('should handle payment link with null expiresAt', async () => {
            // Arrange
            const mockPaymentLink = createMockPaymentLink({
                linkToken: 'no-expiry',
                expiresAt: null,
                order: createMockOrder({ merchantId: 'merchant-123' }) as any,
            });
            const merchantResponse = createMockMerchantResponse();

            prismaService.paymentLink.findUnique.mockResolvedValue(mockPaymentLink);
            mockedAxios.get.mockResolvedValue({ data: merchantResponse });

            // Act
            const result = await service.getQrCode('no-expiry');

            // Assert
            expect(result.success).toBe(true);
            expect(prismaService.paymentLink.update).not.toHaveBeenCalled();
        });
    });
});

import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PaymentServiceClient } from '../../../src/clients/payment-service.client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
(
  mockedAxios as unknown as { isAxiosError: (err: unknown) => boolean }
).isAxiosError = (err: unknown) =>
  Boolean((err as { isAxiosError?: boolean })?.isAxiosError);

describe('PaymentServiceClient', () => {
  let client: PaymentServiceClient;
  let configService: jest.Mocked<ConfigService>;
  let mockAxiosInstance: {
    get: jest.Mock;
    post: jest.Mock;
    patch: jest.Mock;
  };

  beforeEach(() => {
    mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
    };

    mockedAxios.create.mockReturnValue(
      mockAxiosInstance as unknown as AxiosInstance,
    );

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'PAYMENT_SERVICE_URL') return 'http://localhost:4003';
        if (key === 'INTERNAL_TOKEN') return 'secret-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    client = new PaymentServiceClient(configService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize axios with correct baseURL and x-internal-token header', () => {
    expect(mockedAxios.create as jest.Mock).toHaveBeenCalledWith({
      baseURL: 'http://localhost:4003',
      timeout: 5000,
      headers: {
        'x-internal-token': 'secret-token',
        'Content-Type': 'application/json',
      },
    });
  });

  it('should fetch pending orders via fetchPendingOrders()', async () => {
    const mockOrders = [{ id: 'order_1', status: 'PENDING' }];
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrders });

    const result = await client.fetchPendingOrders('merch_1');
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/orders?status=PENDING&merchantId=merch_1',
    );
    expect(result).toEqual(mockOrders);
  });

  it('should fetch order by ID via fetchOrder()', async () => {
    const mockOrder = { id: 'order_1', amount: 100 };
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrder });

    const result = await client.fetchOrder('order_1');
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/orders/order_1');
    expect(result).toEqual(mockOrder);
  });

  it('should sync transaction via syncTransaction()', async () => {
    const mockTx = { id: 'tx_1', status: 'SUCCESS' };
    mockAxiosInstance.post.mockResolvedValueOnce({ data: mockTx });

    const payload = {
      orderId: 'order_1',
      externalTransactionId: 'ext_1',
      amount: 100,
      status: 'SUCCESS' as const,
      providerCode: 'GPAY' as const,
    };
    const result = await client.syncTransaction(payload);
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      '/transactions/sync',
      payload,
    );
    expect(result).toEqual(mockTx);
  });

  it('should complete order via completeOrder()', async () => {
    const mockOrder = { id: 'order_1', status: 'COMPLETED' };
    mockAxiosInstance.patch.mockResolvedValueOnce({ data: mockOrder });

    const result = await client.completeOrder('order_1');
    expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
      '/orders/order_1/status',
      { status: 'COMPLETED' },
    );
    expect(result).toEqual(mockOrder);
  });

  it('should throw InternalServerErrorException on POST failure', async () => {
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.post.mockRejectedValueOnce(err500);

    await expect(
      client.syncTransaction({
        orderId: 'order_1',
        externalTransactionId: 'ext_1',
        amount: 100,
        status: 'SUCCESS',
        providerCode: 'GPAY',
      }),
    ).rejects.toThrow(InternalServerErrorException);
  });

  it('should retry once on 5xx error for GET and succeed on second attempt', async () => {
    const mockOrder = { id: 'order_1', amount: 100 };
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.get
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce({ data: mockOrder });

    const result = await client.fetchOrder('order_1');
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    expect(result).toEqual(mockOrder);
  });

  it('should NOT retry GET on HTTP 4xx error (e.g. 401 Unauthorized)', async () => {
    const err401 = {
      isAxiosError: true,
      response: { status: 401, data: { message: 'Unauthorized' } },
      message: 'Unauthorized',
    };

    mockAxiosInstance.get.mockRejectedValueOnce(err401);

    await expect(client.fetchOrder('order_1')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry POST on HTTP 500 error (only calls post once)', async () => {
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.post.mockRejectedValueOnce(err500);

    await expect(
      client.syncTransaction({
        orderId: 'order_1',
        externalTransactionId: 'ext_1',
        amount: 100,
        status: 'SUCCESS',
        providerCode: 'GPAY',
      }),
    ).rejects.toThrow(InternalServerErrorException);
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
  });
});

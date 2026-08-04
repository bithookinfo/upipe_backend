import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { MerchantServiceClient } from '../../../src/clients/merchant-service.client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
(
  mockedAxios as unknown as { isAxiosError: (err: unknown) => boolean }
).isAxiosError = (err: unknown) =>
  Boolean((err as { isAxiosError?: boolean })?.isAxiosError);

describe('MerchantServiceClient', () => {
  let client: MerchantServiceClient;
  let configService: jest.Mocked<ConfigService>;
  let mockAxiosInstance: {
    get: jest.Mock;
    patch: jest.Mock;
  };

  beforeEach(() => {
    mockAxiosInstance = {
      get: jest.fn(),
      patch: jest.fn(),
    };

    mockedAxios.create.mockReturnValue(
      mockAxiosInstance as unknown as AxiosInstance,
    );

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'MERCHANT_SERVICE_URL') return 'http://localhost:4002';
        if (key === 'INTERNAL_TOKEN') return 'secret-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    client = new MerchantServiceClient(configService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should initialize axios with correct baseURL and x-internal-token header', () => {
    expect(mockedAxios.create as jest.Mock).toHaveBeenCalledWith({
      baseURL: 'http://localhost:4002',
      timeout: 5000,
      headers: {
        'x-internal-token': 'secret-token',
        'Content-Type': 'application/json',
      },
    });
  });

  it('should fetch provider details via getProvider()', async () => {
    const mockProvider = {
      id: 'prov_123',
      merchantId: 'merch_1',
      provider: 'gpay',
      status: 'CONNECTED',
      credentials: {},
      metadata: { gpayRuntime: 'NEW' },
    };
    mockAxiosInstance.get.mockResolvedValueOnce({ data: mockProvider });

    const result = await client.getProvider('prov_123');
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(
      '/internal/gpay/providers/prov_123',
    );
    expect(result).toEqual(mockProvider);
  });

  it('should patch session state via updateSessionState()', async () => {
    const mockProvider = {
      id: 'prov_123',
      status: 'CONNECTED',
    };
    mockAxiosInstance.patch.mockResolvedValueOnce({ data: mockProvider });

    const result = await client.updateSessionState(
      'prov_123',
      'encrypted_session',
      '2026-07-31T00:00:00Z',
    );
    expect(mockAxiosInstance.patch).toHaveBeenCalledWith(
      '/internal/gpay/providers/prov_123/session',
      {
        sessionStateEncrypted: 'encrypted_session',
        sessionSavedAt: '2026-07-31T00:00:00Z',
      },
    );
    expect(result).toEqual(mockProvider);
  });

  it('should retry once on 5xx error and succeed on second attempt', async () => {
    const mockProvider = { id: 'prov_123' };
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.get
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce({ data: mockProvider });

    const result = await client.getProvider('prov_123');
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
    expect(result).toEqual(mockProvider);
  });

  it('should throw InternalServerErrorException after retries are exhausted', async () => {
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.get
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500);

    await expect(client.getProvider('prov_123')).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('should NOT retry GET on HTTP 4xx error (e.g. 404 Not Found)', async () => {
    const err404 = {
      isAxiosError: true,
      response: { status: 404, data: { message: 'Not found' } },
      message: 'Not found',
    };

    mockAxiosInstance.get.mockRejectedValueOnce(err404);

    await expect(client.getProvider('prov_123')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry PATCH on HTTP 500 error', async () => {
    const err500 = {
      isAxiosError: true,
      response: { status: 500, data: { message: 'Server error' } },
      message: 'Server error',
    };

    mockAxiosInstance.patch.mockRejectedValueOnce(err500);

    await expect(
      client.updateSessionState(
        'prov_123',
        'encrypted_session',
        '2026-07-31T00:00:00Z',
      ),
    ).rejects.toThrow(InternalServerErrorException);
    expect(mockAxiosInstance.patch).toHaveBeenCalledTimes(1);
  });
});

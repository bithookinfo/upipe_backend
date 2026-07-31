import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { sanitizeLog } from '../common/logging/log-sanitizer';

export interface GpayProviderData {
  id: string;
  merchantId: string;
  provider: string;
  status: string;
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
  upiId?: string;
  sessionState?: string;
  email?: string;
  businessId?: string;
}

@Injectable()
export class MerchantServiceClient {
  private readonly logger = new Logger(MerchantServiceClient.name);
  private readonly client: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    const baseURL =
      this.configService.get<string>('MERCHANT_SERVICE_URL') ||
      'http://localhost:4002';
    const internalToken =
      this.configService.get<string>('INTERNAL_TOKEN') || '';

    this.client = axios.create({
      baseURL,
      timeout: 5000,
      headers: {
        'x-internal-token': internalToken,
        'Content-Type': 'application/json',
      },
    });
  }

  private async executeGet<T>(url: string, retries = 1): Promise<T> {
    try {
      const response = await this.client.get<T>(url);
      return response.data;
    } catch (error) {
      if (retries > 0 && this.isRetryableError(error)) {
        this.logger.warn(
          `Retrying GET ${url} after error: ${this.getErrorMessage(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        return this.executeGet<T>(url, retries - 1);
      }
      this.handleError('GET', url, error);
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (axios.isAxiosError(error)) {
      if (!error.response) return true;
      const status = error.response.status;
      return status >= 500 || status === 429;
    }
    return false;
  }

  private getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as Record<string, unknown> | undefined;
      const msg =
        data && typeof data.message === 'string' ? data.message : undefined;
      return msg || error.message || 'Axios request failed';
    }
    return error instanceof Error ? error.message : String(error);
  }

  private handleError(method: string, url: string, error: unknown): never {
    const sanitizedErr = sanitizeLog({
      method,
      url,
      error: this.getErrorMessage(error),
      status: axios.isAxiosError(error) ? error.response?.status : undefined,
    });
    this.logger.error(
      `MerchantServiceClient error [${method} ${url}]: ${JSON.stringify(
        sanitizedErr,
      )}`,
    );
    throw new InternalServerErrorException(
      `MerchantService communication failed: ${this.getErrorMessage(error)}`,
    );
  }

  async getActiveProviders(): Promise<GpayProviderData[]> {
    return this.executeGet<GpayProviderData[]>('/internal/gpay/providers');
  }

  async getProvider(providerId: string): Promise<GpayProviderData> {
    return this.executeGet<GpayProviderData>(
      `/internal/gpay/providers/${providerId}`,
    );
  }

  async updateSessionState(
    providerId: string,
    sessionStateEncrypted: string,
    sessionSavedAt: string,
  ): Promise<GpayProviderData> {
    try {
      const response = await this.client.patch<GpayProviderData>(
        `/internal/gpay/providers/${providerId}/session`,
        { sessionStateEncrypted, sessionSavedAt },
      );
      return response.data;
    } catch (error) {
      this.handleError(
        'PATCH',
        `/internal/gpay/providers/${providerId}/session`,
        error,
      );
    }
  }

  async updateStatus(
    providerId: string,
    status: string,
    metadata?: Record<string, unknown>,
  ): Promise<GpayProviderData> {
    try {
      const response = await this.client.patch<GpayProviderData>(
        `/internal/gpay/providers/${providerId}/status`,
        { status, metadata },
      );
      return response.data;
    } catch (error) {
      this.handleError(
        'PATCH',
        `/internal/gpay/providers/${providerId}/status`,
        error,
      );
    }
  }

  async updateUpi(
    providerId: string,
    upiId: string,
  ): Promise<GpayProviderData> {
    try {
      const response = await this.client.patch<GpayProviderData>(
        `/internal/gpay/providers/${providerId}/upi`,
        { upiId },
      );
      return response.data;
    } catch (error) {
      this.handleError(
        'PATCH',
        `/internal/gpay/providers/${providerId}/upi`,
        error,
      );
    }
  }

  async finalizeConnection(data: {
    merchantId: string;
    email: string;
    businessId: string;
    businessName?: string;
    organizationId: string;
    upiId?: string;
    isSuperAdmin?: boolean;
    gpayRuntime?: 'LEGACY' | 'NEW';
  }): Promise<GpayProviderData> {
    try {
      const response = await this.client.post<GpayProviderData>(
        '/internal/gpay/finalize-connection',
        data,
      );
      return response.data;
    } catch (error) {
      this.handleError('POST', '/internal/gpay/finalize-connection', error);
    }
  }

  async getProviderByMerchant(merchantId: string): Promise<GpayProviderData | null> {
    try {
      return await this.executeGet<GpayProviderData>(
        `/internal/gpay/merchants/${encodeURIComponent(merchantId)}/providers/by-type/GPAY`,
      );
    } catch {
      return null;
    }
  }
}


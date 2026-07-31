import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { sanitizeLog } from '../common/logging/log-sanitizer';

export interface OrderData {
  id: string;
  merchantId: string;
  amount: number;
  status: string;
  providerCode?: string;
  paymentApp?: string;
  description?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionData {
  id: string;
  orderId: string;
  externalTransactionId: string;
  amount: number;
  status: string;
  providerCode: string;
  payerVpa?: string;
  paidAt?: string;
  rawPayload?: Record<string, unknown>;
}

export interface SyncTransactionPayload {
  orderId?: string;
  merchantId?: string;
  providerId?: string;
  externalTransactionId: string;
  utr?: string | null;
  amount: number;
  currency?: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  providerCode: 'GPAY';
  providerResponse?: Record<string, unknown> | any;
  rawPayload?: Record<string, unknown> | any;
  createdAt?: Date;
  completedAt?: Date | null;
  paidAt?: Date;
  payerVpa?: string | null;
  customerName?: string | null;
  customerContact?: string | null;
  paymentMethod?: string;
}

@Injectable()
export class PaymentServiceClient {
  private readonly logger = new Logger(PaymentServiceClient.name);
  private readonly client: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    const baseURL =
      this.configService.get<string>('PAYMENT_SERVICE_URL') ||
      'http://localhost:4003';
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
      `PaymentServiceClient error [${method} ${url}]: ${JSON.stringify(
        sanitizedErr,
      )}`,
    );
    throw new InternalServerErrorException(
      `PaymentService communication failed: ${this.getErrorMessage(error)}`,
    );
  }

  async fetchPendingOrders(merchantId?: string): Promise<OrderData[]> {
    const query = merchantId
      ? `?status=PENDING&merchantId=${encodeURIComponent(merchantId)}`
      : '?status=PENDING';
    return this.executeGet<OrderData[]>(`/orders${query}`);
  }

  async fetchOrder(orderId: string): Promise<OrderData> {
    return this.executeGet<OrderData>(`/orders/${encodeURIComponent(orderId)}`);
  }

  async findTransactionByExternalId(
    externalTransactionId: string,
  ): Promise<TransactionData[]> {
    return this.executeGet<TransactionData[]>(
      `/transactions?externalTransactionId=${encodeURIComponent(
        externalTransactionId,
      )}`,
    );
  }

  async syncTransaction(
    payload: SyncTransactionPayload,
  ): Promise<TransactionData> {
    try {
      const response = await this.client.post<TransactionData>(
        '/transactions/sync',
        payload,
      );
      return response.data;
    } catch (error) {
      this.handleError('POST', '/transactions/sync', error);
    }
  }

  async completeOrder(orderId: string): Promise<OrderData> {
    try {
      const response = await this.client.patch<OrderData>(
        `/orders/${encodeURIComponent(orderId)}/status`,
        { status: 'COMPLETED' },
      );
      return response.data;
    } catch (error) {
      this.handleError(
        'PATCH',
        `/orders/${encodeURIComponent(orderId)}/status`,
        error,
      );
    }
  }
}

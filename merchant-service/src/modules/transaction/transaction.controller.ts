import { Controller, Get, Query, Param, Logger, Headers } from "@nestjs/common";
import { TransactionService } from "./transaction.service";

@Controller()
export class TransactionController {
  private readonly logger = new Logger(TransactionController.name);

  constructor(private readonly transactionService: TransactionService) {}

  // Dashboard transactions endpoint
  @Get("dashboard/transactions")
  async getDashboardTransactions(
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("merchantId") merchantId?: string,
  ) {
    this.logger.log("Fetching dashboard transactions");

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;

    return this.transactionService.getDashboardTransactions(
      pageNum,
      limitNum,
      merchantId,
    );
  }

  // Provider-specific transactions
  @Get("providers/:provider/transactions")
  async getProviderTransactions(
    @Param("provider") provider: string,
    @Query("merchantId") merchantId?: string,
    @Query("connectorId") connectorId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    this.logger.log(`Fetching ${provider} transactions`);

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 100;

    return this.transactionService.getProviderTransactions(
      provider,
      merchantId,
      connectorId,
      pageNum,
      limitNum,
    );
  }

  // Merchant-specific transactions
  @Get("merchant/:merchantId/transactions")
  async getTransactions(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
    @Query("status") status?: string,
  ) {
    this.logger.log(`Fetching transactions for merchant: ${merchantId}`);

    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;
    const from = fromDate ? new Date(fromDate) : undefined;
    const to = toDate ? new Date(toDate) : undefined;

    return this.transactionService.getTransactions(
      merchantId,
      organizationId,
      pageNum,
      limitNum,
      from,
      to,
      status,
    );
  }

  @Get("merchant/:merchantId/transactions/sync")
  async syncMerchantTransactions(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
  ) {
    this.logger.log(`Syncing recent transactions for merchant: ${merchantId}`);

    const from = fromDate
      ? new Date(fromDate)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = toDate ? new Date(toDate) : new Date();

    return this.transactionService.syncTransactions(merchantId, organizationId, from, to);
  }

  @Get("merchant/:merchantId/transactions/sync-all")
  async syncAllMerchantTransactions(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("months") months?: string,
    @Query("excludeProviders") excludeProviders?: string,
  ) {
    this.logger.log(
      `Syncing ALL transaction history for merchant: ${merchantId}${excludeProviders ? ` (excluding: ${excludeProviders})` : ''}`,
    );

    // Default to last 12 months for full history, or custom months
    const monthsBack = months ? parseInt(months, 10) : 12;
    const from = new Date(Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000);
    const to = new Date();

    const excludeList = excludeProviders ? excludeProviders.split(',').map(p => p.trim().toUpperCase()) : [];

    return this.transactionService.syncAllTransactions(merchantId, organizationId, from, to, excludeList);
  }

  // Get transaction stats for merchant
  @Get("merchant/:merchantId/transactions/stats")
  async getMerchantTransactionStats(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    this.logger.log(`Getting transaction stats for merchant: ${merchantId}`);

    return this.transactionService.getTransactionStats(merchantId, organizationId);
  }

  @Get("sync")
  async syncTransactions(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
    @Query("fromDate") fromDate?: string,
    @Query("toDate") toDate?: string,
  ) {
    this.logger.log(`Syncing transactions for merchant: ${merchantId}`);

    const from = fromDate
      ? new Date(fromDate)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = toDate ? new Date(toDate) : new Date();

    return this.transactionService.syncTransactions(merchantId, organizationId, from, to);
  }

  @Get("stats")
  async getTransactionStats(
    @Param("merchantId") merchantId: string,
    @Headers("x-organization-id") organizationId: string,
  ) {
    this.logger.log(`Fetching transaction stats for merchant: ${merchantId}`);
    return this.transactionService.getTransactionStats(merchantId, organizationId);
  }
}

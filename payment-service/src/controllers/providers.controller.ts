import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma.service';
import axios from 'axios';

@Controller('providers')
@ApiTags('Providers')
export class ProvidersController {
  constructor(private readonly prisma: PrismaService) { }

  @Get()
  @ApiOperation({ summary: 'Get all payment providers for super admin' })
  @ApiResponse({ status: 200, description: 'Providers retrieved successfully' })
  async getAllProviders(@Query('enabled') enabled?: string) {
    try {
      const merchantServiceUrl = process.env.MERCHANT_SERVICE_URL;
      const response = await axios.get(`${merchantServiceUrl}/gateway/available`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } });

      if (response.data?.data) {
        const providers = response.data.data;

        const filteredProviders = enabled !== undefined
          ? providers.filter((p: any) => {
            const isActive = p.isActive !== undefined ? p.isActive : true;
            return isActive === (enabled === 'true');
          })
          : providers;

        return {
          success: true,
          data: filteredProviders.map((g: any) => ({
            id: g.id,
            code: g.code,
            name: g.name,
            type: g.type,
            providerType: g.provider_type || g.type?.toLowerCase(),
            enabled: true,
            status: 'active',
            description: g.description,
            logo: g.logo,
            metadata: g.metadata,
          })),
        };
      }

      return {
        success: true,
        data: [],
      };
    } catch (error) {
      console.error('Error fetching providers from merchant-service:', error);
      return {
        success: false,
        data: [],
        error: 'Failed to fetch providers',
      };
    }
  }

  @Get(':provider/transactions')
  @ApiOperation({ summary: 'Get provider-specific transactions' })
  @ApiResponse({ status: 200, description: 'Provider transactions retrieved successfully' })
  async getProviderTransactions(
    @Param('provider') provider: string,
    @Query('merchantId') merchantId?: string,
    @Query('connectorId') connectorId?: string,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '100',
  ) {
    try {
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);
      const skip = (pageNum - 1) * limitNum;

      // Build where clause for orders
      const where: any = {};
      if (merchantId) {
        where.merchantId = merchantId;
      }
      if (provider) {
        // Filter by payment method or provider
        where.paymentMethod = provider.toUpperCase();
      }

      // Get orders from database
      const orders = await this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      });

      // Get total count
      const total = await this.prisma.order.count({ where });

      // Format as transactions
      const transactions = orders.map(order => ({
        id: order.id,
        merchantId: order.merchantId,
        amount: Number(order.amount || 0),
        currency: order.currency || 'INR',
        status: order.status,
        customerName: order.customerName || 'N/A',
        transactionDate: order.createdAt,
        externalOrderId: order.externalOrderId,
        paymentMethod: order.paymentMethod || provider.toUpperCase(),
        provider: provider.toUpperCase(),
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      }));

      return {
        success: true,
        transactions,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
        provider: provider.toUpperCase(),
        message: transactions.length > 0 ?
          `Found ${transactions.length} transactions` :
          'No transactions found for this provider',
      };
    } catch (error) {
      console.error(`Error fetching ${provider} transactions:`, error);
      return {
        success: false,
        error: `Failed to fetch ${provider} transactions`,
        transactions: [],
        pagination: {
          page: parseInt(page, 10),
          limit: parseInt(limit, 10),
          total: 0,
          totalPages: 0,
        },
      };
    }
  }
}
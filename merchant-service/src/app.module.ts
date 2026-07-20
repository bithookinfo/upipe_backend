import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health.controller";

import { MerchantController } from "./modules/merchant/merchant.controller";
import { BusinessCategoryController } from "./modules/business-category/business-category.controller";
import { ProviderConnectionController } from "./modules/provider/provider-connection.controller";
import { GatewayController } from "./modules/provider/gateway.controller";
import { TransactionController } from "./modules/transaction/transaction.controller";
import { ConfigTemplateController } from "./modules/config/config-template.controller";
import { MerchantService } from "./modules/merchant/merchant.service";
import { BusinessCategoryService } from "./modules/business-category/business-category.service";
import { ProviderConnectionService } from "./modules/provider/provider-connection.service";
import { TransactionService } from "./modules/transaction/transaction.service";
import { ConfigTemplateService } from "./modules/config/config-template.service";
import { TransactionSyncCron } from "./modules/transaction/transaction-sync.cron";
import { PhonePeSimpleService } from "./modules/provider/phonepe-simple.service";
import { PhonePeWebService } from "./modules/provider/phonepe-web.service";
import { PhonePeKeepaliveCron } from "./modules/provider/phonepe-keepalive.cron";
import { HdfcKeepaliveCron } from "./modules/provider/hdfc-keepalive.cron";
import { PaytmSimpleService } from "./modules/provider/paytm-simple.service";
import { BharatPeSimpleService } from "./modules/provider/bharatpe-simple.service";
import { QuintusPaySimpleService } from "./modules/provider/quintuspay-simple.service";
import { HdfcCryptoUtil } from "./modules/provider/hdfc-crypto.util";
import { HdfcVyaparService } from "./modules/provider/hdfc-vyapar.service";
import { DeviceService } from "./modules/device/device.service";
import { PrismaService } from "./prisma/prisma.service";
import { OrderStatusCronService } from "./modules/transaction/order-status-cron.service";
import { MerchantLimitResetCron } from "./modules/merchant/merchant-limit-reset.cron";
import { StatsController } from "./stats/stats.controller";
import { MerchantsController } from "./controllers/merchants.controller";
import { RoutingController } from "./modules/routing/routing.controller";
import { RoutingService } from "./modules/routing/routing.service";
import { GpayModule } from "./modules/gpay/gpay.module";

@Module({
  imports: [
    GpayModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    HealthController,
    BusinessCategoryController,
    MerchantController,
    ProviderConnectionController,
    GatewayController,
    TransactionController,
    ConfigTemplateController,
    StatsController,
    MerchantsController,
    RoutingController,
  ],
  providers: [
    MerchantService,
    BusinessCategoryService,
    ProviderConnectionService,
    TransactionService,
    ConfigTemplateService,
    TransactionSyncCron,
    PhonePeSimpleService,
    PhonePeWebService,
    PhonePeKeepaliveCron,
    HdfcKeepaliveCron,
    MerchantLimitResetCron,
    PaytmSimpleService,
    BharatPeSimpleService,
    QuintusPaySimpleService,
    HdfcCryptoUtil,
    HdfcVyaparService,
    DeviceService,
    PrismaService,
    OrderStatusCronService,
    RoutingService,
  ],
  exports: [
    MerchantService,
    BusinessCategoryService,
    ProviderConnectionService,
    PhonePeSimpleService,
    PhonePeWebService,
    PaytmSimpleService,
    BharatPeSimpleService,
    QuintusPaySimpleService,
    HdfcVyaparService,
    PrismaService,
  ],
})
export class AppModule {}

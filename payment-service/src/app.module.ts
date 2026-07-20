import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './controllers/health.controller';
import { SimpleOrdersController, OrdersService } from './controllers/simple-orders.controller';
import { DashboardController, DashboardService } from './controllers/dashboard.controller';
import { ProvidersController } from './controllers/providers.controller';
import { WebhookController } from './controllers/webhook.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { WebhookService } from './services/webhook.service';
import { CallbackService } from './services/callback.service';
import { PaymentPageController } from './controllers/payment-page.controller';
import { OrdersSseController } from './controllers/orders-sse.controller';
import { PaymentLinkService } from './services/payment-link.service';
import { OrderEventsService } from './services/order-events.service';
import { InAppNotificationsService } from './services/in-app-notifications.service';
import { QrcodeService } from './services/qrcode.service';
import { PrismaService } from './prisma.service';
import { StatsController } from './stats/stats.controller';
import { CronService } from './services/cron.service';
import { HealthMonitorService } from './services/health-monitor.service';
import { InternalNotificationsController } from './controllers/internal-notifications.controller';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env'
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [HealthController, SimpleOrdersController, DashboardController, ProvidersController, WebhookController, TransactionsController, PaymentPageController, StatsController, OrdersSseController,InternalNotificationsController],
  providers: [PrismaService, OrdersService, DashboardService, WebhookService, CallbackService, PaymentLinkService, QrcodeService, CronService, HealthMonitorService, InAppNotificationsService, OrderEventsService]
})
export class AppModule { }

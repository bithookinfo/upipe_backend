import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './controllers/health.controller';
import { RealSubscriptionController } from './controllers/real-subscription.controller';
import { SubscriptionAssignmentController } from './controllers/subscription-assignment.controller';
import { UnlockController } from './controllers/unlock.controller';
import { RealSubscriptionService } from './services/real-subscription.service';
import { UnlockService } from './services/unlock.service';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot()],
  controllers: [HealthController, RealSubscriptionController, SubscriptionAssignmentController, UnlockController],
  providers: [RealSubscriptionService, UnlockService, PrismaService],
  exports: [RealSubscriptionService, UnlockService, PrismaService],
})
export class AppModule { }

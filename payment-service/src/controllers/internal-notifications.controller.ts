import { Controller, Post, Body, Logger, UseGuards } from '@nestjs/common';
import { OrderEventsService } from '../services/order-events.service';
import { InternalAuthGuard } from '../guards/internal-auth.guard';

import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateInternalNotificationDto {
  @IsString()
  type: string;

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsString()
  @IsOptional()
  organizationId?: string;

  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  orderId?: string;

  @IsString()
  @IsOptional()
  externalOrderId?: string;

  @IsBoolean()
  @IsOptional()
  forSuperAdmins?: boolean;
}

@UseGuards(InternalAuthGuard)
@Controller('internal-notifications')
export class InternalNotificationsController {
  private readonly logger = new Logger(InternalNotificationsController.name);

  constructor(private readonly orderEvents: OrderEventsService) {}

  @Post()
  async createNotification(@Body() dto: CreateInternalNotificationDto) {
    this.logger.debug(`Internal notification request received: ${dto.title}`);
    await this.orderEvents.broadcastNotification(dto);
    return { success: true };
  }
}
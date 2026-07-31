import { Module } from "@nestjs/common";
import { GpayService } from "./gpay.service";
import { PrismaService } from "../../prisma/prisma.service";
import { InternalGpayController } from "./internal-gpay.controller";

@Module({
  controllers: [InternalGpayController],
  providers: [GpayService, PrismaService],
  exports: [GpayService],
})
export class GpayModule { }
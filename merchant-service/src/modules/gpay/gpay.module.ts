import { Module } from "@nestjs/common";
import { GpayService } from "./gpay.service";
import { PrismaService } from "../../prisma/prisma.service";

@Module({
  providers: [GpayService, PrismaService],
  exports: [GpayService],
})
export class GpayModule {}

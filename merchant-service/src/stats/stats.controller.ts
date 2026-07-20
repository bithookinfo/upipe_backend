import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("stats")
export class StatsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async getGlobalStats() {
    const [total, active] = await Promise.all([
      this.prisma.merchant.count({ where: { isPlatform: true, deletedAt: null } }),
      this.prisma.merchant.count({ where: { isPlatform: true, isActive: true, deletedAt: null } }),
    ]);
  
    return {
      total,
      active,
    };
  }
}

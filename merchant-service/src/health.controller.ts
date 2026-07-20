import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  getHealth() {
    return {
      status: "healthy",
      service: "merchant-service",
      timestamp: new Date(),
      database: "greenpay_merchant",
    };
  }
}

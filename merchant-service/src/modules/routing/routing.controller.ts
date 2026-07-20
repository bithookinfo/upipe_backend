import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { RoutingService } from "./routing.service";

@ApiTags("Routing")
@Controller("routing")
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  // Internal endpoint - only called by payment-service, no external auth needed
  @Post("route")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Route a transaction to the best available merchant (internal)",
  })
  @ApiResponse({ status: 200, description: "Route found successfully" })
  @ApiResponse({ status: 404, description: "No route found" })
  async route(@Body() body: { organizationId: string; amount: number }) {
    return this.routingService.routeTransaction(
      body.organizationId,
      body.amount,
    );
  }
}

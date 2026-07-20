import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as path from "path";
import { HealthController } from "./controllers/health.controller";
import { GatewayController } from "./controllers/gateway.controller";
import { JwtModule } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        path.resolve(__dirname, "..", ".env"), // For local dev (src/../.env)
        path.resolve(__dirname, "..", "..", ".env"), // For prod build (dist/src/../../.env)
        ".env", // Fallback to CWD
      ],
    }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [HealthController, GatewayController],
})
export class AppModule {}

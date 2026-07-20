import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [
      ...(process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : [
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:3000",
            "http://localhost:4000",
            "https://upipe.tech",
            "https://www.upipe.tech",
            "https://admin.upipe.tech",
          ]),
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Origin",
      "X-Requested-With",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
      "x-organization-id",
      "x-user-id",
      "x-internal-token",
      "x-cookie-consent",
    ],
  });
  const port = process.env.PORT || 3006;
  await app.listen(port);
  console.log(`Notification service listening on port ${port}`);
}
bootstrap();

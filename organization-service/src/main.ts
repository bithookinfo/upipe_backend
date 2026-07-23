import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [],
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

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true
  }));

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Upipe Organization Service')
    .setDescription('Organization and user management service')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('organizations', 'Organization management')
    .addTag('users', 'User management within organizations')
    .addTag('roles', 'Role and permission management')
    .addTag('settings', 'Organization settings')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3106;
  await app.listen(port);

  console.log(`🏢 [ORGANIZATION SERVICE] Running on http://localhost:${port}`);
  console.log(`📚 Swagger docs available at http://localhost:${port}/api/docs`);
}

bootstrap();

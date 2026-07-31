import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(1024)
  @Max(65535)
  @IsOptional()
  PORT: number = 4007;

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  MERCHANT_SERVICE_URL: string = 'http://localhost:4002';

  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  PAYMENT_SERVICE_URL: string = 'http://localhost:4003';

  @IsString()
  @IsNotEmpty()
  INTERNAL_TOKEN: string = '';

  @IsString()
  @IsNotEmpty()
  REDIS_URL: string = 'redis://localhost:6379';

  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  GPAY_MAX_CONTEXTS_PER_BROWSER: number = 5;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  GPAY_MAX_BROWSERS_PER_INSTANCE: number = 3;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE: number = 3;

  @IsInt()
  @Min(1000)
  @IsOptional()
  GPAY_IDLE_TIMEOUT_MS: number = 900000;

  @IsInt()
  @Min(60000)
  @IsOptional()
  GPAY_BROWSER_MAX_AGE_MS: number = 21600000;

  @IsInt()
  @Min(256)
  @IsOptional()
  GPAY_BROWSER_MEMORY_LIMIT_MB: number = 2048;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `gpay-service environment validation failed: ${errors
        .map((err) => Object.values(err.constraints || {}).join(', '))
        .join('; ')}`,
    );
  }
  return validatedConfig;
}

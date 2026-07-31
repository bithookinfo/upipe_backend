import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'node:crypto';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const internalToken = request.headers['x-internal-token'];

    if (
      !internalToken ||
      typeof internalToken !== 'string' ||
      internalToken.trim().length === 0
    ) {
      this.logger.warn('Missing or invalid x-internal-token header');
      throw new UnauthorizedException('Missing internal token');
    }

    const expectedToken = this.configService.get<string>('INTERNAL_TOKEN');

    if (
      !expectedToken ||
      expectedToken.trim().length === 0 ||
      expectedToken === 'replace-me'
    ) {
      this.logger.error('INTERNAL_TOKEN is not properly configured');
      throw new UnauthorizedException('Internal token not configured');
    }

    const providedBuf = Buffer.from(internalToken);
    const expectedBuf = Buffer.from(expectedToken);

    if (providedBuf.length !== expectedBuf.length) {
      this.logger.warn('Invalid x-internal-token provided (length mismatch)');
      throw new UnauthorizedException('Invalid internal token');
    }

    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      this.logger.warn('Invalid x-internal-token provided');
      throw new UnauthorizedException('Invalid internal token');
    }

    return true;
  }
}

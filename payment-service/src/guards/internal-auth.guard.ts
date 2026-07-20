import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);

  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const internalToken = request.headers['x-internal-token'];
    
    if (!internalToken) {
      this.logger.warn('Missing x-internal-token header');
      throw new UnauthorizedException('Missing internal token');
    }

    const expectedToken = this.configService.get<string>('INTERNAL_TOKEN');
    
    if (!expectedToken) {
      this.logger.error('INTERNAL_TOKEN is not configured in environment');
      throw new UnauthorizedException('Internal token not configured');
    }

    if (internalToken !== expectedToken) {
      this.logger.warn('Invalid x-internal-token provided');
      throw new UnauthorizedException('Invalid internal token');
    }

    return true;
  }
}

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalAuthGuard } from '../../../../src/common/guards/internal-auth.guard';

describe('InternalAuthGuard', () => {
  let guard: InternalAuthGuard;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue('super-secret-token'),
    } as unknown as jest.Mocked<ConfigService>;

    guard = new InternalAuthGuard(configService);
  });

  const createMockContext = (headers: Record<string, string>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    }) as unknown as ExecutionContext;

  it('should allow access when x-internal-token matches INTERNAL_TOKEN', () => {
    const context = createMockContext({
      'x-internal-token': 'super-secret-token',
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw UnauthorizedException when x-internal-token header is missing', () => {
    const context = createMockContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when token length differs', () => {
    const context = createMockContext({ 'x-internal-token': 'short' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when token differs in content', () => {
    const context = createMockContext({
      'x-internal-token': 'super-secret-tokeX',
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when INTERNAL_TOKEN is replace-me', () => {
    configService.get.mockReturnValue('replace-me');
    const context = createMockContext({ 'x-internal-token': 'replace-me' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when INTERNAL_TOKEN is empty string or undefined', () => {
    configService.get.mockReturnValue('');
    const context = createMockContext({ 'x-internal-token': '' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});

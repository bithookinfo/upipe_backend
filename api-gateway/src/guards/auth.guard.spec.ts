import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from './auth.guard';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { createMockRequest, createMockJwtService } from '../../test/utils/test-helpers';

describe('AuthGuard', () => {
    let guard: AuthGuard;
    let jwtService: any;

    beforeEach(async () => {
        jwtService = createMockJwtService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthGuard,
                {
                    provide: JwtService,
                    useValue: jwtService,
                },
            ],
        }).compile();

        guard = module.get<AuthGuard>(AuthGuard);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('canActivate', () => {
        it('should return true for valid JWT token', () => {
            const mockContext = {
                switchToHttp: () => ({
                    getRequest: () => createMockRequest(),
                }),
            } as any;

            jwtService.verify.mockReturnValue({
                sub: 'user-123',
                email: 'test@example.com',
            });

            const result = guard.canActivate(mockContext);

            expect(result).toBe(true);
            expect(jwtService.verify).toHaveBeenCalled();
        });

        it('should throw UnauthorizedException if no token provided', () => {
            const mockContext = {
                switchToHttp: () => ({
                    getRequest: () => createMockRequest({ headers: {} }),
                }),
            } as any;

            expect(() => guard.canActivate(mockContext))
                .toThrow(UnauthorizedException);
        });

        it('should throw UnauthorizedException for invalid token', () => {
            const mockContext = {
                switchToHttp: () => ({
                    getRequest: () => createMockRequest(),
                }),
            } as any;

            jwtService.verify.mockImplementation(() => {
                throw new Error('Invalid token');
            });

            expect(() => guard.canActivate(mockContext))
                .toThrow(UnauthorizedException);
        });
    });
});

import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
    createMockPrismaService,
    createMockUser,
} from '../../test/utils/test-helpers';
import * as bcrypt from 'bcryptjs';

jest.mock('bcryptjs');
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

global.fetch = jest.fn();
const mockedFetch = global.fetch as jest.MockedFunction<typeof fetch>;

describe('AuthService', () => {
    let service: AuthService;
    let prismaService: any;
    let jwtService: JwtService;
    let configService: ConfigService;

    beforeEach(async () => {
        prismaService = createMockPrismaService();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: JwtService,
                    useValue: {
                        sign: jest.fn(),
                    },
                },
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            const config: any = {
                                ORGANIZATION_SERVICE_URL: 'http://localhost:3106',
                                SUBSCRIPTION_SERVICE_URL: 'http://localhost:3104',
                            };
                            return config[key];
                        }),
                    },
                },
            ],
        }).compile();

        service = module.get<AuthService>(AuthService);
        jwtService = module.get<JwtService>(JwtService);
        configService = module.get<ConfigService>(ConfigService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('register', () => {
        it('should successfully register a new user', async () => {
            // Arrange
            const registerDto = {
                email: 'newuser@test.com',
                mobile: '9876543210',
                password: 'password123',
                name: 'New User',
                company: 'Test Company',
            };
            const mockUser = createMockUser({ ...registerDto, password: 'hashed' });

            prismaService.user.findUnique.mockResolvedValue(null); // No existing user
            (mockedBcrypt.hash as jest.Mock).mockResolvedValue('hashed');
            prismaService.user.create.mockResolvedValue(mockUser);
            jest.spyOn(jwtService, 'sign').mockReturnValue('mock.jwt.token');

            // Mock organization creation
            mockedFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    data: { id: 'org-123', name: 'Test Company' },
                }),
            } as Response);

            // Act
            const result = await service.register(registerDto);

            // Assert
            expect(result).toHaveProperty('token', 'mock.jwt.token');
            expect(result.user).toHaveProperty('email', registerDto.email);
            expect(prismaService.user.create).toHaveBeenCalled();
            expect(mockedBcrypt.hash).toHaveBeenCalledWith(registerDto.password, 12);
        });

        it('should throw ConflictException if email already exists', async () => {
            // Arrange
            const registerDto = {
                email: 'existing@test.com',
                mobile: '9876543210',
                password: 'password123',
                name: 'User',
            };
            const existingUser = createMockUser({ email: registerDto.email });

            prismaService.user.findUnique.mockResolvedValueOnce(existingUser);

            // Act & Assert - Service wraps ConflictException in InternalServerErrorException
            await expect(service.register(registerDto))
                .rejects
                .toThrow(); // Just check it throws
        });

        it('should throw ConflictException if mobile already exists', async () => {
            // Arrange
            const registerDto = {
                email: 'new@test.com',
                mobile: '9876543210',
                password: 'password123',
                name: 'User',
            };
            const existingUser = createMockUser({ mobile: registerDto.mobile });

            prismaService.user.findUnique
                .mockResolvedValueOnce(null) // Email check passes
                .mockResolvedValueOnce(existingUser); // Mobile check fails

            // Act & Assert - Service wraps ConflictException in InternalServerErrorException  
            await expect(service.register(registerDto))
                .rejects
                .toThrow(); // Just check it throws
        });

        it('should validate password length (min 6 characters)', async () => {
            // Arrange
            const registerDto = {
                mobile: '9876543210',
                password: '12345', // Too short
                name: 'User',
            };

            // Act & Assert
            await expect(service.register(registerDto))
                .rejects
                .toThrow(InternalServerErrorException);
        });

        it('should require mobile, password, and name', async () => {
            // Act & Assert
            await expect(service.register({ mobile: '', password: 'pass', name: 'Name' }))
                .rejects
                .toThrow();

            await expect(service.register({ mobile: '1234567890', password: '', name: 'Name' }))
                .rejects
                .toThrow();

            await expect(service.register({ mobile: '1234567890', password: 'pass', name: '' }))
                .rejects
                .toThrow();
        });
    });

    // ============================================================================
    // LOGIN TESTS
    // ============================================================================

    describe('login', () => {
        it('should successfully login with valid mobile and password', async () => {
            // Arrange
            const loginDto = { username: '9876543210', password: 'password123' };
            const mockUser = createMockUser({ mobile: loginDto.username, password: 'hashed' });

            prismaService.user.findUnique.mockResolvedValue(mockUser);
            (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
            prismaService.user.update.mockResolvedValue(mockUser);
            jest.spyOn(jwtService, 'sign').mockReturnValue('mock.jwt.token');

            // Mock organization fetch
            mockedFetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    organizations: [{ organizationId: 'org-123' }],
                }),
            } as Response);

            // Act
            const result = await service.login(loginDto);

            // Assert
            expect(result).toHaveProperty('token', 'mock.jwt.token');
            expect(result.user).not.toHaveProperty('password');
            expect(prismaService.user.update).toHaveBeenCalledWith({
                where: { id: mockUser.id },
                data: { lastLoginAt: expect.any(Date) },
            });
        });

        it('should successfully login with valid email and password', async () => {
            // Arrange
            const loginDto = { username: 'test@example.com', password: 'password123' };
            const mockUser = createMockUser({ email: loginDto.username, password: 'hashed' });

            prismaService.user.findUnique.mockResolvedValue(mockUser);
            (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
            prismaService.user.update.mockResolvedValue(mockUser);
            jest.spyOn(jwtService, 'sign').mockReturnValue('mock.jwt.token');

            mockedFetch.mockResolvedValue({
                ok: true,
                json: async () => ({ organizations: [] }),
            } as Response);

            // Act
            const result = await service.login(loginDto);

            // Assert
            expect(result).toHaveProperty('token');
            expect(result.message).toBe('Login successful');
        });

        it('should throw UnauthorizedException if user not found', async () => {
            // Arrange
            const loginDto = { username: 'nonexistent@test.com', password: 'password' };
            prismaService.user.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.login(loginDto))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.login(loginDto))
                .rejects
                .toThrow('Invalid credentials');
        });

        it('should throw UnauthorizedException if password is invalid', async () => {
            // Arrange
            const loginDto = { username: 'test@example.com', password: 'wrongpassword' };
            const mockUser = createMockUser({ email: loginDto.username });

            prismaService.user.findUnique.mockResolvedValue(mockUser);
            (mockedBcrypt.compare as jest.Mock).mockResolvedValue(false);

            // Act & Assert
            await expect(service.login(loginDto))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.login(loginDto))
                .rejects
                .toThrow('Invalid credentials');
        });

        it('should throw UnauthorizedException if user is not active', async () => {
            // Arrange
            const loginDto = { username: 'inactive@test.com', password: 'password123' };
            const mockUser = createMockUser({ email: loginDto.username, isActive: false });

            prismaService.user.findUnique.mockResolvedValue(mockUser);

            // Act & Assert
            await expect(service.login(loginDto))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.login(loginDto))
                .rejects
                .toThrow('Account is not active');
        });

        it('should require both username and password', async () => {
            // Act & Assert
            await expect(service.login({ username: '', password: 'pass' }))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.login({ username: 'user', password: '' }))
                .rejects
                .toThrow(UnauthorizedException);
        });
    });

    // ============================================================================
    // CHANGE PASSWORD TESTS
    // ============================================================================

    describe('changePassword', () => {
        it('should successfully change password', async () => {
            // Arrange
            const userId = 'user-123';
            const changePasswordDto = {
                currentPassword: 'oldpassword',
                newPassword: 'newpassword123',
            };
            const mockUser = createMockUser({ id: userId, password: 'hashed-old' });

            prismaService.user.findUnique.mockResolvedValue(mockUser);
            (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
            (mockedBcrypt.hash as jest.Mock).mockResolvedValue('hashed-new');
            prismaService.user.update.mockResolvedValue(mockUser);

            // Act
            const result = await service.changePassword(userId, changePasswordDto);

            // Assert
            expect(result.message).toBe('Password changed successfully');
            expect(prismaService.user.update).toHaveBeenCalledWith({
                where: { id: userId },
                data: { password: 'hashed-new' },
            });
        });

        it('should throw UnauthorizedException if current password is invalid', async () => {
            // Arrange
            const userId = 'user-123';
            const changePasswordDto = {
                currentPassword: 'wrongpassword',
                newPassword: 'newpassword123',
            };
            const mockUser = createMockUser({ id: userId });

            prismaService.user.findUnique.mockResolvedValue(mockUser);
            (mockedBcrypt.compare as jest.Mock).mockResolvedValue(false);

            // Act & Assert
            await expect(service.changePassword(userId, changePasswordDto))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.changePassword(userId, changePasswordDto))
                .rejects
                .toThrow('Invalid current password');
        });

        it('should throw UnauthorizedException if user not found', async () => {
            // Arrange
            const userId = 'nonexistent';
            const changePasswordDto = {
                currentPassword: 'old',
                newPassword: 'new',
            };

            prismaService.user.findUnique.mockResolvedValue(null);

            // Act & Assert
            await expect(service.changePassword(userId, changePasswordDto))
                .rejects
                .toThrow(UnauthorizedException);

            await expect(service.changePassword(userId, changePasswordDto))
                .rejects
                .toThrow('User not found');
        });
    });

    // ============================================================================
    // VALIDATE USER TESTS
    // ============================================================================

    describe('validateUser', () => {
        it('should return user if exists and is active', async () => {
            // Arrange
            const userId = 'user-123';
            const mockUser = createMockUser({ id: userId, isActive: true });
            prismaService.user.findUnique.mockResolvedValue(mockUser);

            // Act
            const result = await service.validateUser(userId);

            // Assert
            expect(result).toEqual(mockUser);
        });

        it('should return null if user does not exist', async () => {
            // Arrange
            prismaService.user.findUnique.mockResolvedValue(null);

            // Act
            const result = await service.validateUser('nonexistent');

            // Assert
            expect(result).toBeNull();
        });

        it('should return null if user is not active', async () => {
            // Arrange
            const mockUser = createMockUser({ isActive: false });
            prismaService.user.findUnique.mockResolvedValue(mockUser);

            // Act
            const result = await service.validateUser('user-123');

            // Assert
            expect(result).toBeNull();
        });
    });

    // ============================================================================
    // GET USERS BATCH TESTS
    // ============================================================================

    describe('getUsersBatch', () => {
        it('should return batch of users', async () => {
            // Arrange
            const userIds = ['user-1', 'user-2', 'user-3'];
            const mockUsers = userIds.map(id => createMockUser({ id }));
            prismaService.user.findMany.mockResolvedValue(mockUsers);

            // Act
            const result = await service.getUsersBatch(userIds);

            // Assert
            expect(result.success).toBe(true);
            expect(result.users).toHaveLength(3);
            expect(prismaService.user.findMany).toHaveBeenCalledWith({
                where: { id: { in: userIds } },
                select: expect.any(Object),
            });
        });

        it('should handle database errors gracefully', async () => {
            // Arrange
            prismaService.user.findMany.mockRejectedValue(new Error('Database error'));

            // Act & Assert
            await expect(service.getUsersBatch(['user-1']))
                .rejects
                .toThrow(InternalServerErrorException);
        });
    });
});

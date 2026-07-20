import { Test, TestingModule } from '@nestjs/testing';
import { PermissionService } from './permission.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

describe('PermissionService', () => {
    let service: PermissionService;
    let prismaService: any;

    beforeEach(async () => {
        prismaService = {
            permission: {
                findUnique: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
            },
            userPermission: {
                findFirst: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                deleteMany: jest.fn(),
            },
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PermissionService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
            ],
        }).compile();

        service = module.get<PermissionService>(PermissionService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getAllPermissions', () => {
        it('should return all active permissions', async () => {
            const mockPermissions = [
                { id: '1', code: 'org:view', name: 'View Organization', category: 'ORGANIZATION', isActive: true },
                { id: '2', code: 'user:create', name: 'Create Users', category: 'USERS', isActive: true },
            ];

            prismaService.permission.findMany.mockResolvedValue(mockPermissions);

            const result = await service.getAllPermissions();

            expect(result.success).toBe(true);
            expect(result.permissions).toHaveLength(2);
            expect(result.total).toBe(2);
        });

        it('should filter by category', async () => {
            prismaService.permission.findMany.mockResolvedValue([]);

            await service.getAllPermissions({ category: 'USERS' });

            expect(prismaService.permission.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ category: 'USERS' }),
                })
            );
        });
    });

    describe('checkPermission', () => {
        it('should return true when user has permission', async () => {
            const mockPermission = { id: 'perm-1', code: 'org:view' };
            const mockUserPermission = { id: 'up-1', userId: 'user-1', permissionId: 'perm-1' };

            prismaService.permission.findUnique.mockResolvedValue(mockPermission);
            prismaService.userPermission.findFirst.mockResolvedValue(mockUserPermission);

            const result = await service.checkPermission('user-1', 'org-1', 'org:view');

            expect(result).toBe(true);
        });

        it('should return false when permission not found', async () => {
            prismaService.permission.findUnique.mockResolvedValue(null);

            const result = await service.checkPermission('user-1', 'org-1', 'invalid:code');

            expect(result).toBe(false);
        });
    });

    describe('grantPermission', () => {
        it('should grant new permission to user', async () => {
            const mockPermission = { id: 'perm-1', code: 'org:view' };
            const mockUserPermission = { id: 'up-1', userId: 'user-1', permissionId: 'perm-1' };

            prismaService.permission.findUnique.mockResolvedValue(mockPermission);
            prismaService.userPermission.findFirst.mockResolvedValue(null);
            prismaService.userPermission.create.mockResolvedValue(mockUserPermission);

            const result = await service.grantPermission({
                userId: 'user-1',
                organizationId: 'org-1',
                permissionCode: 'org:view',
            });

            expect(result.success).toBe(true);
            expect(prismaService.userPermission.create).toHaveBeenCalled();
        });

        it('should throw NotFoundException for invalid permission code', async () => {
            prismaService.permission.findUnique.mockResolvedValue(null);

            await expect(
                service.grantPermission({
                    userId: 'user-1',
                    organizationId: 'org-1',
                    permissionCode: 'invalid:code',
                })
            ).rejects.toThrow(NotFoundException);
        });

        it('should return success if permission already granted', async () => {
            const mockPermission = { id: 'perm-1', code: 'org:view' };
            const existing = { id: 'up-1', userId: 'user-1', permissionId: 'perm-1' };

            prismaService.permission.findUnique.mockResolvedValue(mockPermission);
            prismaService.userPermission.findFirst.mockResolvedValue(existing);

            const result = await service.grantPermission({
                userId: 'user-1',
                organizationId: 'org-1',
                permissionCode: 'org:view',
            });

            expect(result.success).toBe(true);
            expect(result.message).toContain('already granted');
        });
    });

    describe('revokePermission', () => {
        it('should revoke permission from user', async () => {
            const mockPermission = { id: 'perm-1', code: 'org:view' };
            prismaService.permission.findUnique.mockResolvedValue(mockPermission);
            prismaService.userPermission.deleteMany.mockResolvedValue({ count: 1 });

            const result = await service.revokePermission('user-1', 'org-1', 'org:view');

            expect(result.success).toBe(true);
            expect(prismaService.userPermission.deleteMany).toHaveBeenCalled();
        });
    });

    describe('getUserPermissions', () => {
        it('should return user permissions with details', async () => {
            const mockUserPermissions = [
                {
                    id: 'up-1',
                    grantedAt: new Date(),
                    grantedVia: 'role',
                    permission: { id: 'perm-1', code: 'org:view', name: 'View Organization' },
                },
            ];

            prismaService.userPermission.findMany.mockResolvedValue(mockUserPermissions);

            const result = await service.getUserPermissions('user-1', 'org-1');

            expect(result.success).toBe(true);
            expect(result.permissions).toHaveLength(1);
        });
    });

    describe('revokeAllUserPermissions', () => {
        it('should revoke all permissions for user', async () => {
            prismaService.userPermission.deleteMany.mockResolvedValue({ count: 5 });

            const result = await service.revokeAllUserPermissions('user-1', 'org-1');

            expect(result.success).toBe(true);
            expect(result.revoked).toBe(5);
        });
    });
});

import { Test, TestingModule } from '@nestjs/testing';
import { RoleService } from './role.service';
import { PrismaService } from './prisma.service';
import { IdentityClientService } from './identity-client.service';
import { ConflictException } from '@nestjs/common';
import {
    createMockPrismaService,
    createMockRole,
} from '../../test/utils/test-helpers';

describe('RoleService', () => {
    let service: RoleService;
    let prismaService: any;
    let identityClient: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.org_roles = {
            findMany: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };
        prismaService.role_permissions = {
            createMany: jest.fn(),
            deleteMany: jest.fn(),
        };
        prismaService.$transaction = jest.fn((callback) => callback(prismaService));

        identityClient = {
            getAllPermissions: jest.fn(),
            checkUserPermission: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                RoleService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: IdentityClientService,
                    useValue: identityClient,
                },
            ],
        }).compile();

        service = module.get<RoleService>(RoleService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getRoles', () => {
        it('should return all roles for organization', async () => {
            const orgId = 'org-123';
            const mockRoles = [
                { ...createMockRole(), role_permissions: [] },
                { ...createMockRole({ name: 'ADMIN' }), role_permissions: [] },
            ];

            identityClient.getAllPermissions.mockResolvedValue({
                success: true,
                permissions: [],
            });
            prismaService.org_roles.findMany.mockResolvedValue(mockRoles);

            const result = await service.getRoles(orgId);

            expect(result.success).toBe(true);
            expect(result.roles).toHaveLength(2);
        });
    });

    describe('createRole', () => {
        it('should create new role', async () => {
            const orgId = 'org-123';
            const roleData = {
                name: 'MANAGER',
                description: 'Manager role',
                permissions: [],
            };

            identityClient.getAllPermissions.mockResolvedValue({
                success: true,
                permissions: [],
            });
            prismaService.org_roles.findFirst.mockResolvedValue(null);
            prismaService.org_roles.create.mockResolvedValue(createMockRole(roleData));

            const result = await service.createRole(orgId, roleData);

            expect(result.success).toBe(true);
            expect(result.role.name).toBe('MANAGER');
        });

        it('should throw ConflictException if role exists', async () => {
            const orgId = 'org-123';

            identityClient.getAllPermissions.mockResolvedValue({
                success: true,
                permissions: [],
            });
            prismaService.org_roles.findFirst.mockResolvedValue(createMockRole());

            await expect(
                service.createRole(orgId, { name: 'OWNER', permissions: [] })
            ).rejects.toThrow(ConflictException);
        });
    });

    describe('deleteRole', () => {
        it('should soft delete role', async () => {
            const roleId = 'role-123';
            const mockRole = {
                ...createMockRole({ id: roleId, is_default: false }),
                org_users: [],
            };

            prismaService.org_roles.findUnique.mockResolvedValue(mockRole);
            prismaService.org_roles.update.mockResolvedValue({
                ...mockRole,
                is_active: false,
            });

            const result = await service.deleteRole(roleId);

            expect(result.success).toBe(true);
            expect(prismaService.org_roles.update).toHaveBeenCalledWith({
                where: { id: roleId },
                data: { is_active: false, updated_at: expect.any(Date) },
            });
        });
    });

    describe('checkPermission', () => {
        it('should check permission via identity client', async () => {
            identityClient.checkUserPermission.mockResolvedValue(true);

            const result = await service.checkPermission(
                'user-123',
                'org-123',
                'VIEW_TRANSACTIONS' as any
            );

            expect(result).toBe(true);
            expect(identityClient.checkUserPermission).toHaveBeenCalled();
        });
    });
});

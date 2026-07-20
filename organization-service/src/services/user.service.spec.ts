import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from './user.service';
import { PrismaService } from './prisma.service';
import { IdentityClientService } from './identity-client.service';
import { RoleService } from './role.service';
import { ConfigService } from '@nestjs/config';
import { createMockPrismaService } from '../../test/utils/test-helpers';

describe('UserService', () => {
    let service: UserService;
    let prismaService: any;
    let identityClient: any;
    let roleService: any;
    let configService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.org_users = {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        };

        identityClient = {
            inviteUser: jest.fn(),
            grantPermissionsToUser: jest.fn(),
            revokeAllUserPermissions: jest.fn(),
            getUsersBatch: jest.fn(),
        };

        roleService = {
            getRole: jest.fn(),
        };

        configService = {
            get: jest.fn().mockReturnValue('http://subscription-service'),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                UserService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
                {
                    provide: IdentityClientService,
                    useValue: identityClient,
                },
                {
                    provide: RoleService,
                    useValue: roleService,
                },
                {
                    provide: ConfigService,
                    useValue: configService,
                },
            ],
        }).compile();

        service = module.get<UserService>(UserService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('getOrganizationUsers', () => {
        it('should return users for organization', async () => {
            const orgId = 'org-123';
            const mockUsers = [
                {
                    id: 'user-1',
                    user_id: 'user-id-1',
                    organization_id: orgId,
                    is_active: true,
                    joined_at: new Date(),
                    org_roles: { id: 'role-1', name: 'ADMIN' },
                },
            ];

            prismaService.org_users.findMany.mockResolvedValue(mockUsers);
            identityClient.getUsersBatch.mockResolvedValue({
                success: true,
                users: [{ id: 'user-id-1', email: 'test@example.com', name: 'Test User', mobile: '1234567890' }],
            });

            const result = await service.getOrganizationUsers(orgId);

            expect(result.success).toBe(true);
            expect(result.users).toHaveLength(1);
            expect(result.users[0].email).toBe('test@example.com');
        });
    });

    describe('addUserToOrganization', () => {
        it('should add user to organization', async () => {
            const orgId = 'org-123';
            const userId = 'user-123';
            const roleId = 'role-123';

            prismaService.org_users.findFirst.mockResolvedValue(null);
            roleService.getRole.mockResolvedValue({
                success: true,
                role: { id: roleId, permissions: ['VIEW_DASHBOARD'] },
            });
            prismaService.org_users.create.mockResolvedValue({
                id: 'org-user-123',
                user_id: userId,
                organization_id: orgId,
                role_id: roleId,
            });
            identityClient.grantPermissionsToUser.mockResolvedValue({ success: true });

            const result = await service.addUserToOrganization({
                userId,
                organizationId: orgId,
                roleId,
            });

            expect(result.success).toBe(true);
            expect(prismaService.org_users.create).toHaveBeenCalled();
            expect(identityClient.grantPermissionsToUser).toHaveBeenCalled();
        });
    });

    describe('removeUserFromOrganization', () => {
        it('should remove user from organization', async () => {
            const orgUserId = 'org-user-123';

            prismaService.org_users.findUnique.mockResolvedValue({
                id: orgUserId,
                user_id: 'user-123',
                organization_id: 'org-123',
                is_active: true,
            });
            prismaService.org_users.update.mockResolvedValue({
                id: orgUserId,
                is_active: false,
            });
            identityClient.revokeAllUserPermissions.mockResolvedValue({ success: true });

            const result = await service.removeUserFromOrganization(orgUserId);

            expect(result.success).toBe(true);
            expect(prismaService.org_users.update).toHaveBeenCalledWith({
                where: { id: orgUserId },
                data: { is_active: false, updated_at: expect.any(Date) },
            });
            expect(identityClient.revokeAllUserPermissions).toHaveBeenCalled();
        });
    });
});

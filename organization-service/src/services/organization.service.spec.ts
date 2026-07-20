import { Test, TestingModule } from '@nestjs/testing';
import { OrganizationService } from './organization.service';
import { PrismaService } from './prisma.service';
import { NotFoundException } from '@nestjs/common';
import {
    createMockPrismaService,
    createMockOrganization,
} from '../../test/utils/test-helpers';

describe('OrganizationService', () => {
    let service: OrganizationService;
    let prismaService: any;

    beforeEach(async () => {
        prismaService = createMockPrismaService();
        prismaService.organizations = {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        };
        prismaService.org_users = {
            findMany: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                OrganizationService,
                {
                    provide: PrismaService,
                    useValue: prismaService,
                },
            ],
        }).compile();

        service = module.get<OrganizationService>(OrganizationService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('createOrganization', () => {
        it('should create organization successfully', async () => {
            const createDto = {
                name: 'Test Org',
                slug: 'test-org',
                ownerUserId: 'user-123',
                email: 'test@org.com',
            };
            const mockOrg = createMockOrganization(createDto);

            prismaService.organizations.findUnique.mockResolvedValue(null);
            prismaService.organizations.create.mockResolvedValue(mockOrg);

            const result = await service.createOrganization(createDto);

            expect(result.success).toBe(true);
            expect(result.organization.name).toBe('Test Org');
        });
    });

    describe('findOne', () => {
        it('should return organization by id', async () => {
            const orgId = 'org-123';
            const mockOrg = {
                ...createMockOrganization({ id: orgId }),
                org_users: [],
                org_subscriptions: [],
                org_roles: [],
            };
            prismaService.organizations.findUnique.mockResolvedValue(mockOrg);

            const result = await service.findOne(orgId);

            expect(result.success).toBe(true);
            expect(result.organization.id).toBe(orgId);
        });

        it('should throw NotFoundException if not found', async () => {
            prismaService.organizations.findUnique.mockResolvedValue(null);

            await expect(service.findOne('nonexistent'))
                .rejects
                .toThrow(NotFoundException);
        });
    });

    describe('findAll', () => {
        it('should return list of organizations', async () => {
            const mockOrgs = [
                { ...createMockOrganization(), org_users: [], org_subscriptions: [] },
                { ...createMockOrganization(), org_users: [], org_subscriptions: [] },
            ];

            prismaService.organizations.findMany.mockResolvedValue(mockOrgs);
            prismaService.organizations.count.mockResolvedValue(2);

            const result = await service.findAll();

            expect(result.success).toBe(true);
            expect(result.organizations).toHaveLength(2);
        });
    });

    describe('updateOrganization', () => {
        it('should update organization', async () => {
            const orgId = 'org-123';
            const updateDto = { name: 'Updated Org' };
            const mockOrg = {
                ...createMockOrganization({ id: orgId, ...updateDto }),
                org_users: [],
                org_subscriptions: [],
                org_roles: [],
            };

            prismaService.organizations.findUnique.mockResolvedValue(mockOrg);
            prismaService.organizations.update.mockResolvedValue(mockOrg);

            const result = await service.updateOrganization(orgId, updateDto);

            expect(result.success).toBe(true);
            expect(result.organization.name).toBe('Updated Org');
        });
    });

    describe('getOrganizationUsers', () => {
        it('should return users for organization', async () => {
            const orgId = 'org-123';
            const mockUsers = [
                { id: 'user-1', organization_id: orgId, org_roles: {} },
            ];

            prismaService.org_users.findMany.mockResolvedValue(mockUsers);

            const result = await service.getOrganizationUsers(orgId);

            expect(result.success).toBe(true);
            expect(result.users).toHaveLength(1);
        });
    });
});

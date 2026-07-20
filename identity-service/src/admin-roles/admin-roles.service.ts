import {
    Injectable,
    Logger,
    NotFoundException,
    ConflictException,
    BadRequestException,
    InternalServerErrorException,
    OnModuleInit
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

const SYSTEM_ROLES = {
    SUPER_ADMIN: {
        name: 'Super Admin',
        key: 'super_admin',
        description: 'Full platform access — can manage everything including other admins',
        permissions: [
            'org:view', 'org:update', 'org:delete', 'org:settings:view', 'org:settings:update',
            'user:view', 'user:create', 'user:invite', 'user:update', 'user:delete', 'user:deactivate', 'user:activate',
            'role:view', 'role:create', 'role:update', 'role:delete', 'role:assign',
            'merchant:view', 'merchant:create', 'merchant:update', 'merchant:delete',
            'merchant:configure', 'merchant:verify', 'merchant:block', 'merchant:unblock',
            'payment:view', 'payment:create', 'payment:refund', 'payment:settle', 'payment:export',
            'analytics:view', 'analytics:export', 'report:view', 'report:create', 'report:export',
            'subscription:view', 'subscription:update', 'subscription:cancel',
            'billing:view', 'billing:update', 'invoice:view', 'invoice:download',
            'api_key:view', 'api_key:create', 'api_key:revoke',
            'webhook:view', 'webhook:create', 'webhook:update', 'webhook:delete',
            'audit:view', 'audit:export'
        ]
    },
    ADMIN: {
        name: 'Admin',
        key: 'admin',
        description: 'Administrative access — can manage merchants, organizations, and view analytics',
        permissions: [
            'org:view', 'org:update', 'org:settings:view', 'org:settings:update',
            'user:view', 'user:create', 'user:invite', 'user:update', 'user:deactivate', 'user:activate',
            'role:view', 'role:assign',
            'merchant:view', 'merchant:create', 'merchant:update', 'merchant:configure', 'merchant:verify',
            'payment:view', 'payment:create', 'payment:refund',
            'analytics:view', 'analytics:export', 'report:view', 'report:create', 'report:export',
            'subscription:view', 'billing:view', 'invoice:view', 'invoice:download',
            'api_key:view', 'webhook:view', 'webhook:create', 'webhook:update',
            'audit:view'
        ]
    },
    SUPPORT: {
        name: 'Support',
        key: 'support',
        description: 'Customer support access — can view merchants, payments, and manage support tickets',
        permissions: [
            'org:view', 'org:settings:view',
            'user:view',
            'merchant:view', 'merchant:update',
            'payment:view', 'payment:refund',
            'analytics:view', 'report:view',
            'subscription:view', 'billing:view', 'invoice:view',
            'audit:view'
        ]
    },
    FINANCE: {
        name: 'Finance',
        key: 'finance',
        description: 'Financial operations — can view/export payments, billing, and financial reports',
        permissions: [
            'org:view',
            'merchant:view',
            'payment:view', 'payment:settle', 'payment:export',
            'analytics:view', 'analytics:export', 'report:view', 'report:create', 'report:export',
            'subscription:view', 'subscription:update',
            'billing:view', 'billing:update', 'invoice:view', 'invoice:download',
            'audit:view', 'audit:export'
        ]
    },
    ANALYTICS: {
        name: 'Analytics',
        key: 'analytics',
        description: 'Analytics and reporting access — read-only with export capabilities',
        permissions: [
            'org:view',
            'merchant:view',
            'payment:view', 'payment:export',
            'analytics:view', 'analytics:export', 'report:view', 'report:create', 'report:export',
            'subscription:view', 'billing:view', 'invoice:view'
        ]
    },
    VIEWER: {
        name: 'Viewer',
        key: 'viewer',
        description: 'Read-only access — can only view data across the platform',
        permissions: [
            'org:view', 'org:settings:view',
            'user:view',
            'merchant:view',
            'payment:view',
            'analytics:view', 'report:view',
            'subscription:view', 'billing:view', 'invoice:view'
        ]
    }
};

@Injectable()
export class AdminRolesService implements OnModuleInit {
    private readonly logger = new Logger(AdminRolesService.name);

    constructor(private readonly prisma: PrismaService) { }

    async onModuleInit() {
        await this.seedSystemRoles();
    }

    async seedSystemRoles() {
        try {
            this.logger.log('🎭 Seeding system admin roles...');
            let created = 0;
            let skipped = 0;

            for (const [, roleTemplate] of Object.entries(SYSTEM_ROLES)) {
                const existing = await this.prisma.adminRole.findUnique({
                    where: { key: roleTemplate.key }
                });

                if (!existing) {
                    await this.prisma.adminRole.create({
                        data: {
                            id: randomUUID(),
                            name: roleTemplate.name,
                            key: roleTemplate.key,
                            description: roleTemplate.description,
                            permissions: roleTemplate.permissions,
                            isSystem: true,
                            isActive: true,
                        }
                    });
                    created++;
                    this.logger.log(`  ✅ Created: ${roleTemplate.name}`);
                } else {
                    await this.prisma.adminRole.update({
                        where: { id: existing.id },
                        data: {
                            permissions: roleTemplate.permissions,
                            description: roleTemplate.description,
                        }
                    });
                    skipped++;
                }
            }

            this.logger.log(`✅ Admin roles seeded: ${created} created, ${skipped} updated`);
            return {
                success: true,
                created,
                updated: skipped,
                total: Object.keys(SYSTEM_ROLES).length
            };
        } catch (error) {
            this.logger.error('❌ Failed to seed admin roles:', error);
            throw new InternalServerErrorException('Failed to seed admin roles');
        }
    }

    /**
     * Get all admin roles
     */
    async getAllRoles(includeInactive = false) {
        try {
            const where: any = {};
            if (!includeInactive) {
                where.isActive = true;
            }

            const roles = await this.prisma.adminRole.findMany({
                where,
                orderBy: [
                    { isSystem: 'desc' },
                    { name: 'asc' }
                ]
            });

            return {
                success: true,
                roles,
                total: roles.length
            };
        } catch (error) {
            this.logger.error('❌ Failed to get admin roles:', error);
            throw new InternalServerErrorException('Failed to retrieve admin roles');
        }
    }

    /**
     * Get a single role by ID
     */
    async getRoleById(id: string) {
        try {
            const role = await this.prisma.adminRole.findUnique({ where: { id } });

            if (!role) {
                throw new NotFoundException(`Admin role ${id} not found`);
            }

            // Count super admins with this role
            const adminCount = await this.prisma.superAdmin.count({
                where: { role: role.key }
            });

            return {
                success: true,
                role: { ...role, adminCount }
            };
        } catch (error) {
            this.logger.error(`❌ Failed to get role ${id}:`, error);
            if (error instanceof NotFoundException) throw error;
            throw new InternalServerErrorException('Failed to retrieve role');
        }
    }

    /**
     * Create a custom admin role
     */
    async createRole(data: {
        name: string;
        key: string;
        description?: string;
        permissions: string[];
    }) {
        try {
            this.logger.log(`🎭 Creating custom admin role: ${data.name}`);

            // Validate key format (lowercase, underscores only)
            if (!/^[a-z][a-z0-9_]*$/.test(data.key)) {
                throw new BadRequestException('Role key must be lowercase alphanumeric with underscores (e.g., "content_manager")');
            }

            // Check uniqueness
            const existingName = await this.prisma.adminRole.findUnique({ where: { name: data.name } });
            if (existingName && existingName.isActive) {
                throw new ConflictException(`Role with name "${data.name}" already exists`);
            }

            const existingKey = await this.prisma.adminRole.findUnique({ where: { key: data.key } });
            if (existingKey && existingKey.isActive) {
                throw new ConflictException(`Role with key "${data.key}" already exists`);
            }

            const existingInactive = existingKey || existingName;

            let role;
            if (existingInactive && !existingInactive.isActive) {
                this.logger.log(`🔄 Reactivating soft-deleted role: ${data.name}`);
                role = await this.prisma.adminRole.update({
                    where: { id: existingInactive.id },
                    data: {
                        name: data.name,
                        key: data.key,
                        description: data.description,
                        permissions: data.permissions,
                        isActive: true,
                    }
                });
            } else {
                role = await this.prisma.adminRole.create({
                    data: {
                        id: randomUUID(),
                        name: data.name,
                        key: data.key,
                        description: data.description,
                        permissions: data.permissions,
                        isSystem: false,
                        isActive: true,
                    }
                });
            }

            this.logger.log(`✅ Custom admin role created: ${role.name} (${role.key})`);
            return {
                success: true,
                role,
                message: 'Role created successfully'
            };
        } catch (error) {
            this.logger.error('❌ Failed to create admin role:', error);
            if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
            throw new InternalServerErrorException('Failed to create admin role');
        }
    }

    /**
     * Update a custom admin role
     */
    async updateRole(id: string, data: {
        name?: string;
        description?: string;
        permissions?: string[];
    }) {
        try {
            const existing = await this.prisma.adminRole.findUnique({ where: { id } });

            if (!existing) {
                throw new NotFoundException(`Admin role ${id} not found`);
            }

            // System roles: only allow updating description and permissions, not name/key
            if (existing.isSystem && data.name && data.name !== existing.name) {
                throw new BadRequestException('Cannot rename system roles');
            }

            // Check name uniqueness if changing
            if (data.name && data.name !== existing.name) {
                const nameConflict = await this.prisma.adminRole.findUnique({ where: { name: data.name } });
                if (nameConflict) {
                    throw new ConflictException(`Role with name "${data.name}" already exists`);
                }
            }

            const updateData: any = {};
            if (data.name !== undefined) updateData.name = data.name;
            if (data.description !== undefined) updateData.description = data.description;
            if (data.permissions !== undefined) updateData.permissions = data.permissions;

            const role = await this.prisma.adminRole.update({
                where: { id },
                data: updateData
            });

            this.logger.log(`✅ Admin role updated: ${role.name}`);
            return {
                success: true,
                role,
                message: 'Role updated successfully'
            };
        } catch (error) {
            this.logger.error(`❌ Failed to update admin role ${id}:`, error);
            if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof ConflictException) throw error;
            throw new InternalServerErrorException('Failed to update admin role');
        }
    }

    /**
     * Delete a custom admin role (soft delete)
     */
    async deleteRole(id: string) {
        try {
            const role = await this.prisma.adminRole.findUnique({ where: { id } });

            if (!role) {
                throw new NotFoundException(`Admin role ${id} not found`);
            }

            if (role.isSystem) {
                throw new BadRequestException('Cannot delete system roles');
            }

            // Check if any super admins are using this role
            const adminCount = await this.prisma.superAdmin.count({
                where: { role: role.key }
            });

            if (adminCount > 0) {
                throw new ConflictException(`Cannot delete role "${role.name}" — ${adminCount} admin(s) are currently assigned to it`);
            }

            await this.prisma.adminRole.update({
                where: { id },
                data: { isActive: false }
            });

            this.logger.log(`✅ Admin role deleted: ${role.name}`);
            return {
                success: true,
                message: 'Role deleted successfully'
            };
        } catch (error) {
            this.logger.error(`❌ Failed to delete admin role ${id}:`, error);
            if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof ConflictException) throw error;
            throw new InternalServerErrorException('Failed to delete admin role');
        }
    }
}

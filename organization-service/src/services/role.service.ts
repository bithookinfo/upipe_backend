import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException
} from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { IdentityClientService } from './identity-client.service';
import { Permission, DEFAULT_ROLES, PERMISSION_CATEGORIES } from '../constants/permissions';
import { randomUUID } from 'crypto';

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityClient: IdentityClientService
  ) { }

  async initializeDefaultRoles(organizationId: string) {
    try {
      this.logger.log(`🎭 Initializing default roles for org: ${organizationId}`);

      const createdRoles = [];

      for (const [key, roleTemplate] of Object.entries(DEFAULT_ROLES)) {
        try {
          const existing = await this.prisma.org_roles.findFirst({
            where: {
              organization_id: organizationId,
              name: roleTemplate.name
            }
          });

          if (!existing) {
            const role = await this.prisma.org_roles.create({
              data: {
                id: randomUUID(),
                organizations: { connect: { id: organizationId } },
                name: roleTemplate.name,
                description: roleTemplate.description,
                is_default: roleTemplate.isDefault,
                is_active: true,
                updated_at: new Date()
              }
            });

            const allPermsResult = await this.identityClient.getAllPermissions();
            const codeToIdMap = new Map<string, string>();
            if (allPermsResult.success) {
              allPermsResult.permissions.forEach((p: any) => codeToIdMap.set(p.code, p.id));
            }

            const validPerms = roleTemplate.permissions.map(code => ({ code, id: codeToIdMap.get(code) })).filter(p => p.id);
            if (validPerms.length > 0) {
              await this.prisma.role_permissions.createMany({
                data: validPerms.map(p => ({
                  id: randomUUID(),
                  role_id: role.id,
                  permission_id: p.id!
                }))
              });
            }

            createdRoles.push(role);
            this.logger.log(`✅ Created role: ${roleTemplate.name}`);
          }
        } catch (error) {
          this.logger.warn(`Role ${roleTemplate.name} already exists`);
        }
      }

      return {
        success: true,
        message: 'Default roles initialized',
        createdCount: createdRoles.length,
        roles: createdRoles
      };
    } catch (error) {
      this.logger.error(`❌ Failed to initialize default roles:`, error);
      throw new InternalServerErrorException('Failed to initialize default roles');
    }
  }

  async createRole(organizationId: string, data: {
    name: string;
    description?: string;
    permissions: Permission[];
  }) {
    try {
      this.logger.log(`🎭 Creating custom role: ${data.name} for org: ${organizationId}`);

      // Get permissions map only if permissions are provided
      const codeToIdMap = new Map<string, string>();
      if (data.permissions && data.permissions.length > 0) {
        const allPermsResult = await this.identityClient.getAllPermissions();
        if (allPermsResult.success) {
          allPermsResult.permissions.forEach((p: any) => codeToIdMap.set(p.code, p.id));
        }
      }

      const existing = await this.prisma.org_roles.findFirst({
        where: {
          organization_id: organizationId,
          name: data.name
        }
      });

      if (existing) {
        throw new ConflictException(`Role '${data.name}' already exists in this organization`);
      }

      // Create role + permissions transaction
      const role = await this.prisma.$transaction(async (tx) => {
        // 1. Create Role
        const newRole = await tx.org_roles.create({
          data: {
            id: randomUUID(),
            organizations: { connect: { id: organizationId } },
            name: data.name,
            description: data.description,
            is_default: false,
            is_active: true,
            updated_at: new Date()
          }
        });

        // 2. Create Role Permissions
        const validPerms = data.permissions.map(code => ({ code, id: codeToIdMap.get(code as string) })).filter(p => p.id);
        
        // Deduplicate permissions to avoid unique constraint violation
        const uniquePerms = Array.from(new Map(validPerms.map(p => [p.id, p])).values());

        if (uniquePerms.length > 0) {
          await tx.role_permissions.createMany({
            data: uniquePerms.map(p => ({
              id: randomUUID(),
              role_id: newRole.id,
              permission_id: p.id!
            }))
          });
        }

        return newRole;
      });

      return {
        success: true,
        role: {
          ...role,
          permissions: data.permissions
        },
        message: 'Role created successfully'
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create role:`, error);
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException('Failed to create role');
    }
  }

  async getRoles(organizationId: string, includeUserCount = false) {
    try {
      // Fetch Map
      const allPermsResult = await this.identityClient.getAllPermissions();
      const idToCodeMap = new Map<string, string>();
      if (allPermsResult.success) {
        allPermsResult.permissions.forEach((p: any) => idToCodeMap.set(p.id, p.code));
      }

      const roles = await this.prisma.org_roles.findMany({
        where: {
          organization_id: organizationId,
          is_active: true
        },
        include: {
          role_permissions: true, // Fetch standardized perms
          ...(includeUserCount ? {
            org_users: {
              select: { id: true },
              where: { is_active: true }
            }
          } : {})
        },
        orderBy: [
          { is_default: 'desc' },
          { name: 'asc' }
        ]
      });

      const rolesWithDetails = roles.map((role: any) => {
        // Map permission IDs back to codes
        const permissions = role.role_permissions.map((rp: any) => idToCodeMap.get(rp.permission_id) || rp.permission_id);

        return {
          ...role,
          permissions: permissions.length > 0 ? permissions : [],
          userCount: includeUserCount ? role.org_users?.length || 0 : undefined,
          org_users: undefined,
          role_permissions: undefined
        };
      });

      return {
        success: true,
        roles: rolesWithDetails,
        total: roles.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get roles for org ${organizationId}:`, error);
      throw new InternalServerErrorException('Failed to retrieve roles');
    }
  }

  async getRoleByName(organizationId: string, roleName: string) {
    try {
      this.logger.log(`🔍 Getting role by name: ${roleName} for org: ${organizationId}`);

      const role = await this.prisma.org_roles.findFirst({
        where: {
          organization_id: organizationId,
          name: roleName.toUpperCase(),
          is_active: true
        },
        include: { role_permissions: true }
      });

      if (!role) {
        throw new NotFoundException(`Role '${roleName}' not found in organization`);
      }

      // Map permissions
      const allPermsResult = await this.identityClient.getAllPermissions();
      const idToCodeMap = new Map<string, string>();
      if (allPermsResult.success) {
        allPermsResult.permissions.forEach((p: any) => idToCodeMap.set(p.id, p.code));
      }

      const permissions = role.role_permissions.map((rp: any) => idToCodeMap.get(rp.permission_id)).filter(Boolean);

      return {
        success: true,
        role: {
          ...role,
          permissions: permissions
        }
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get role by name:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to retrieve role');
    }
  }

  async getRole(roleId: string, organizationId: string) {
    try {
      const role = await this.prisma.org_roles.findFirst({
        where: { id: roleId, organization_id: organizationId },
        include: {
          role_permissions: true,
          org_users: {
            select: {
              id: true,
              user_id: true,
              is_active: true,
              joined_at: true
            },
            where: { is_active: true }
          }
        }
      });

      if (!role) {
        throw new NotFoundException(`Role ${roleId} not found`);
      }

      // Map permissions
      const allPermsResult = await this.identityClient.getAllPermissions();
      const idToCodeMap = new Map<string, string>();
      if (allPermsResult.success) {
        allPermsResult.permissions.forEach((p: any) => idToCodeMap.set(p.id, p.code));
      }

      const permissions = role.role_permissions.map((rp: any) => idToCodeMap.get(rp.permission_id)).filter(Boolean);

      return {
        success: true,
        role: {
          ...role,
          permissions: permissions,
          userCount: role.org_users.length,
          users: role.org_users
        }
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get role ${roleId}:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to retrieve role');
    }
  }

  async updateRole(
    roleId: string,
    organizationId: string,
    data: {
      name?: string;
      description?: string;
      permissions?: Permission[];
    }
  ) {
    try {
      this.logger.log(`🎭 Updating role: ${roleId}`);

      const existingRole = await this.prisma.org_roles.findFirst({
        where: { id: roleId, organization_id: organizationId }
      });

      if (!existingRole) {
        throw new NotFoundException(`Role ${roleId} not found`);
      }

      if (existingRole.is_default && data.permissions) {
        throw new BadRequestException('Cannot modify permissions of default roles');
      }

      // Get permissions map if updating perms
      let codeToIdMap = new Map<string, string>();
      if (data.permissions) {
        const allPermsResult = await this.identityClient.getAllPermissions();
        if (allPermsResult.success) {
          allPermsResult.permissions.forEach((p: any) => codeToIdMap.set(p.code, p.id));
        }
      }

      const updatedRole = await this.prisma.$transaction(async (tx) => {
        // 1. Update Role fields
        const updateData: any = { updated_at: new Date() };
        if (data.name) updateData.name = data.name;
        if (data.description !== undefined) updateData.description = data.description;

        const role = await tx.org_roles.update({
          where: { id: roleId },
          data: updateData
        });

        // 2. Update Permissions (Delete All + Insert New)
        if (data.permissions) {
          await tx.role_permissions.deleteMany({ where: { role_id: roleId } });

          const validPerms = data.permissions.map(code => ({ code, id: codeToIdMap.get(code as string) })).filter(p => p.id);

          if (validPerms.length > 0) {
            await tx.role_permissions.createMany({
              data: validPerms.map(p => ({
                id: randomUUID(),
                role_id: roleId,
                permission_id: p.id!
              }))
            });
          }
        }
        return role;
      });

      return {
        success: true,
        role: {
          ...updatedRole,
          permissions: data.permissions || []
        },
        message: 'Role updated successfully'
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update role ${roleId}:`, error);
      if (error instanceof NotFoundException || error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException('Failed to update role');
    }
  }

  async deleteRole(roleId: string, organizationId: string) {
    try {
      this.logger.log(`🗑️ Deleting role: ${roleId}`);

      const role = await this.prisma.org_roles.findFirst({
        where: { id: roleId, organization_id: organizationId },
        include: {
          org_users: {
            where: { is_active: true }
          }
        }
      });

      if (!role) {
        throw new NotFoundException(`Role ${roleId} not found`);
      }

      // Don't allow deleting default roles
      if (role.is_default) {
        throw new BadRequestException('Cannot delete default roles');
      }

      // Check if role has active users
      if (role.org_users.length > 0) {
        throw new ConflictException(`Cannot delete role with ${role.org_users.length} active users`);
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.role_permissions.deleteMany({
          where: { role_id: roleId }
        });

        await tx.org_roles.delete({
          where: { id: roleId }
        });
      });

      return {
        success: true,
        message: 'Role deleted successfully'
      };
    } catch (error) {
      this.logger.error(`❌ Failed to delete role ${roleId}:`, error);
      if (error instanceof NotFoundException || error instanceof BadRequestException || error instanceof ConflictException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to delete role');
    }
  }

  async checkPermission(userId: string, organizationId: string, permission: Permission): Promise<boolean> {
    try {
      return await this.identityClient.checkUserPermission(userId, organizationId, permission);
    } catch (error) {
      this.logger.error(`❌ Failed to check permission via Identity Service:`, error);

      return this.checkPermissionLocal(userId, organizationId, permission);
    }
  }

  private async checkPermissionLocal(userId: string, organizationId: string, permission: Permission): Promise<boolean> {
    try {
      const orgUser = await this.prisma.org_users.findFirst({
        where: {
          user_id: userId,
          organization_id: organizationId,
          is_active: true
        },
        include: {
          org_roles: {
            include: {
              role_permissions: true
            }
          }
        }
      });

      if (!orgUser) return false;

      // Check role permissions from role_permissions table
      if (orgUser.org_roles?.role_permissions) {
        // Without Identity Service, we cannot map IDs to Codes.
        // So local check is effectively disabled/impossible for now unless we cache codes.
        this.logger.warn('Cannot perform local permission check without Identity Service mapping');
        return false;
      }

      return false;
    } catch (error) {
      this.logger.error(`❌ Local permission check failed:`, error);
      return false;
    }
  }

  // SYNC ROLE PERMISSIONS TO IDENTITY SERVICE
  async syncRolePermissionsToIdentity(roleId: string, permissionCodes: string[]) {
    try {
      this.logger.log(`🔗 Syncing role ${roleId} permissions to Identity Service`);

      // Get all users with this role
      const usersWithRole = await this.prisma.org_users.findMany({
        where: {
          role_id: roleId,
          is_active: true
        }
      });

      // Get role details
      const role = await this.prisma.org_roles.findUnique({
        where: { id: roleId }
      });

      if (!role) return { success: false, message: 'Role not found' };

      // Sync each user's permissions
      for (const user of usersWithRole) {
        await this.identityClient.grantPermissionsToUser({
          userId: user.user_id,
          organizationId: user.organization_id,
          permissionCodes,
          roleId,
          grantedBy: undefined
        });
      }

      this.logger.log(`✅ Synced permissions for ${usersWithRole.length} users`);
      return {
        success: true,
        syncedUsers: usersWithRole.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to sync role permissions:`, error);
      return { success: false, error: error.message };
    }
  }

  // GET ROLE PERMISSIONS FROM role_permissions TABLE
  async getRolePermissionsFromTable(roleId: string): Promise<string[]> {
    try {
      const rolePermissions = await this.prisma.role_permissions.findMany({
        where: { role_id: roleId }
      });

      // Get permission codes from Identity Service
      const allPermsResult = await this.identityClient.getAllPermissions();
      if (!allPermsResult.success) {
        return [];
      }

      const permissionMap = new Map();
      allPermsResult.permissions.forEach((p: any) => permissionMap.set(p.id, p.code));

      return rolePermissions
        .map(rp => permissionMap.get(rp.permission_id))
        .filter(Boolean);
    } catch (error) {
      this.logger.error(`❌ Failed to get role permissions from table:`, error);
      return [];
    }
  }

  // GET ALL AVAILABLE PERMISSIONS (from Identity Service)
  async getAllPermissions() {
    try {
      const result = await this.identityClient.getAllPermissions();
      if (result.success) {
        return {
          success: true,
          permissions: result.permissions,
          total: result.total
        };
      }
    } catch (error) {
      this.logger.warn(`⚠️ Failed to get permissions from Identity Service, using local`);
    }

    // Fallback to local permissions
    return {
      success: true,
      permissions: Object.values(Permission),
      categories: PERMISSION_CATEGORIES,
      total: Object.values(Permission).length
    };
  }

  // GET ROLE TEMPLATES
  async getRoleTemplates() {
    try {
      const templates = Object.entries(DEFAULT_ROLES).map(([key, template]) => ({
        id: key,
        name: template.name,
        description: template.description,
        permissions: template.permissions,
        permissionCount: template.permissions.length,
        isDefault: template.isDefault
      }));

      return {
        success: true,
        templates,
        count: templates.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get role templates:`, error);
      throw new InternalServerErrorException('Failed to get role templates');
    }
  }

  // MIGRATION: Move permissions from JSON column to role_permissions table
  async migratePermissionsToTable() {
    try {
      this.logger.log('🔄 Starting migration of permissions to normalized table...');

      // 1. Get all permissions from Identity Service to map Code -> ID
      const allPermsResult = await this.identityClient.getAllPermissions();
      if (!allPermsResult.success) {
        throw new Error('Failed to fetch permissions from Identity Service');
      }

      const codeToIdMap = new Map<string, string>();
      allPermsResult.permissions.forEach((p: any) => codeToIdMap.set(p.code, p.id));

      // 2. Get all roles
      const roles = await this.prisma.org_roles.findMany();
      this.logger.log(`Found ${roles.length} roles to process`);

      let totalMigrated = 0;
      let errors = 0;

      for (const role of roles) {
        try {
          // No JSON permissions to migrate anymore as column is removed
          // This method should arguably be removed or updated to just sync verify
          const codes = [];

          if (codes.length === 0) continue;

          // Insert into role_permissions
          for (const code of codes) {
            const permissionId = codeToIdMap.get(code);
            if (!permissionId) {
              this.logger.warn(`Permission code '${code}' not found in Identity Service, skipping`);
              continue;
            }

            // Check if already exists
            const existing = await this.prisma.role_permissions.findUnique({
              where: {
                role_id_permission_id: {
                  role_id: role.id,
                  permission_id: permissionId
                }
              }
            });

            if (!existing) {
              await this.prisma.role_permissions.create({
                data: {
                  id: randomUUID(),
                  role_id: role.id,
                  permission_id: permissionId
                }
              });
              totalMigrated++;
            }
          }
        } catch (err) {
          this.logger.error(`Failed to migrate role ${role.id}: ${err.message}`);
          errors++;
        }
      }

      this.logger.log(`✅ Migration complete. Migrated ${totalMigrated} permission assignments. Errors: ${errors}`);
      return { success: true, count: totalMigrated, errors };

    } catch (error) {
      this.logger.error('❌ Migration failed:', error);
      throw new InternalServerErrorException('Migration failed');
    }
  }
}

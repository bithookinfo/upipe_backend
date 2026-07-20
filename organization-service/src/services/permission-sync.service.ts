import { Injectable, Logger } from '@nestjs/common';
import { IdentityClientService } from './identity-client.service';
import { PrismaService } from './prisma.service';
import { randomUUID } from 'crypto';

@Injectable()
export class PermissionSyncService {
  private readonly logger = new Logger(PermissionSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityClient: IdentityClientService
  ) { }


  async syncRolePermissions(roleId: string, permissionCodes: string[]) {
    try {
      this.logger.log(`🔗 Syncing ${permissionCodes.length} permissions for role ${roleId}`);

      const identityPermissions = await this.identityClient.getAllPermissions();

      if (!identityPermissions.success) {
        this.logger.warn('⚠️ Failed to fetch permissions from Identity Service, using fallback');
        return { success: false, message: 'Identity Service not available' };
      }

      const permissionMap = new Map();
      identityPermissions.permissions.forEach((perm: any) => {
        permissionMap.set(perm.code, perm.id);
      });

      await this.prisma.role_permissions.deleteMany({
        where: { role_id: roleId }
      });

      const rolePermissions = [];
      for (const code of permissionCodes) {
        const permissionId = permissionMap.get(code);
        if (permissionId) {
          rolePermissions.push({
            id: randomUUID(),
            role_id: roleId,
            permission_id: permissionId,
            created_at: new Date()
          });
        } else {
          this.logger.warn(`⚠️ Permission code '${code}' not found in Identity Service`);
        }
      }

      if (rolePermissions.length > 0) {
        await this.prisma.role_permissions.createMany({
          data: rolePermissions
        });
      }

      this.logger.log(`✅ Synced ${rolePermissions.length}/${permissionCodes.length} permissions for role`);
      return {
        success: true,
        synced: rolePermissions.length,
        total: permissionCodes.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to sync role permissions:`, error);
      return { success: false, error: error.message };
    }
  }

  async getRolePermissionCodes(roleId: string): Promise<string[]> {
    try {
      const identityPermissions = await this.identityClient.getAllPermissions();

      if (!identityPermissions.success) {
        this.logger.warn('⚠️ Identity Service unavailable, cannot map permission IDs to codes');
        return [];
      }

      const rolePermissions = await this.prisma.role_permissions.findMany({
        where: { role_id: roleId }
      });

      const permissionMap = new Map();
      identityPermissions.permissions.forEach((perm: any) => {
        permissionMap.set(perm.id, perm.code);
      });

      const permissionCodes = rolePermissions
        .map(rp => permissionMap.get(rp.permission_id))
        .filter(Boolean);

      return permissionCodes;
    } catch (error) {
      this.logger.error(`❌ Failed to get role permission codes:`, error);
      return [];
    }
  }

  async migrateExistingRoles(organizationId: string) {
    try {
      this.logger.log(`🔄 Migrating existing roles to use permission IDs for org: ${organizationId}`);

      const roles = await this.prisma.org_roles.findMany({
        where: {
          organization_id: organizationId,
          is_active: true
        }
      });

      let migrated = 0;
      // Legacy migration logic removed as column 'permissions' no longer exists
      // This method is now a no-op or can be removed entirely in future cleanup
      this.logger.warn('Legacy migration from JSON column not supported (column removed)');

      this.logger.log(`✅ Migrated ${migrated}/${roles.length} roles to use permission IDs`);
      return {
        success: true,
        migrated,
        total: roles.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to migrate existing roles:`, error);
      return { success: false, error: error.message };
    }
  }
}

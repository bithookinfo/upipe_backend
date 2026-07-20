import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { IdentityClientService } from './identity-client.service';
import { RoleService } from './role.service';
import { randomUUID } from 'crypto';
import axios from 'axios';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityClient: IdentityClientService,
    private readonly roleService: RoleService,
    private readonly configService: ConfigService
  ) { }

  async addUserToOrganization(data: {
    organizationId: string;
    userId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    roleId: string;
    invitedBy?: string;
    password?: string;
  }) {
    try {
      let targetUserId = data.userId;

      if (!targetUserId && data.email && data.firstName && data.lastName) {
        this.logger.log(`📧 Inviting user ${data.email} to organization ${data.organizationId}`);

        const organization = await this.prisma.organizations.findUnique({ where: { id: data.organizationId } });
        const roleResult = await this.roleService.getRole(data.roleId, data.organizationId);

        const inviteResult = await this.identityClient.inviteUser({
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          invitedBy: data.invitedBy,
          password: data.password,
          organizationName: organization?.name,
          roleName: roleResult?.role?.name
        });

        if (inviteResult.success && inviteResult.user) {
          targetUserId = inviteResult.user.id;
        } else {
          throw new InternalServerErrorException('Failed to create/find user for invitation');
        }
      }

      if (!targetUserId) {
        throw new BadRequestException('User ID or full invite details (email, firstName, lastName) are required');
      }

      this.logger.log(`👤 Adding user ${targetUserId} to organization ${data.organizationId}`);

      const existing = await this.prisma.org_users.findFirst({
        where: {
          organization_id: data.organizationId,
          user_id: targetUserId
        }
      });

      if (existing) {
        if (!existing.is_active) {
          const updated = await this.prisma.org_users.update({
            where: { id: existing.id },
            data: {
              is_active: true,
              role_id: data.roleId,
              updated_at: new Date()
            }
          });
          return {
            success: true,
            message: 'User reactivated in organization',
            orgUser: updated
          };
        }
        throw new ConflictException('User already exists in this organization');
      }

      const roleResult = await this.roleService.getRole(data.roleId, data.organizationId);
      const role = roleResult.role;

      const orgUser = await this.prisma.org_users.create({
        data: {
          id: randomUUID(),
          organization_id: data.organizationId,
          user_id: targetUserId,
          role_id: data.roleId,
          invited_by: data.invitedBy,
          is_active: true,
          updated_at: new Date()
        }
      });

      await this.identityClient.grantPermissionsToUser({
        userId: targetUserId,
        organizationId: data.organizationId,
        permissionCodes: role.permissions,
        roleId: data.roleId,
        grantedBy: data.invitedBy
      });

      this.logger.log(`✅ User added to organization and permissions synced`);
      return {
        success: true,
        message: 'User added to organization successfully',
        orgUser
      };
    } catch (error) {
      this.logger.error(`❌ Failed to add user to organization:`, error);
      if (error instanceof ConflictException || error instanceof NotFoundException || error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException('Failed to add user to organization');
    }
  }

  async updateUserRole(orgUserId: string, organizationId: string, newRoleId: string, updatedBy?: string) {
    try {
      this.logger.log(`🔄 Updating role for org user: ${orgUserId} to role: ${newRoleId}`);

      const orgUser = await this.prisma.org_users.findFirst({
        where: { id: orgUserId, organization_id: organizationId }
      });

      if (!orgUser) {
        throw new NotFoundException('Organization user not found');
      }

      const roleResult = await this.roleService.getRole(newRoleId, organizationId);
      const newRole = roleResult.role;

      const updated = await this.prisma.org_users.update({
        where: { id: orgUserId },
        data: {
          role_id: newRoleId,
          updated_at: new Date()
        }
      });

      await this.identityClient.revokeAllUserPermissions(
        orgUser.user_id,
        orgUser.organization_id
      );

      await this.identityClient.grantPermissionsToUser({
        userId: orgUser.user_id,
        organizationId: orgUser.organization_id,
        permissionCodes: newRole.permissions,
        roleId: newRoleId,
        grantedBy: updatedBy
      });

      this.logger.log(`✅ User role updated and permissions synced`);
      return {
        success: true,
        message: 'User role updated successfully',
        orgUser: updated
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update user role:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to update user role');
    }
  }

  async removeUserFromOrganization(orgUserId: string, organizationId: string) {
    try {
      this.logger.log(`🗑️ Removing user from organization: ${orgUserId}`);

      const orgUser = await this.prisma.org_users.findFirst({
        where: { id: orgUserId, organization_id: organizationId }
      });

      if (!orgUser) {
        throw new NotFoundException('Organization user not found');
      }

      await this.prisma.org_users.delete({
        where: { id: orgUserId }
      });

      await this.identityClient.revokeAllUserPermissions(
        orgUser.user_id,
        orgUser.organization_id
      );

      try {
        const subscriptionServiceUrl = this.configService.get('SUBSCRIPTION_SERVICE_URL');
        await axios.post(`${subscriptionServiceUrl}/real-subscriptions/organizations/${orgUser.organization_id}/update-usage`, {
          action: 'REMOVE_USER'
        }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN, 'x-organization-id': orgUser.organization_id } });
        this.logger.log(`✅ Decremented subscription usage for org ${orgUser.organization_id}`);
      } catch (err) {
        this.logger.warn(`Failed to update subscription usage: ${err.message}`);
      }

      this.logger.log(`✅ User removed from organization and permissions revoked`);
      return {
        success: true,
        message: 'User removed from organization successfully'
      };
    } catch (error) {
      this.logger.error(`❌ Failed to remove user from organization:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to remove user');
    }
  }

  async getOrganizationUsers(organizationId: string, statusFilter?: 'all' | 'active' | 'inactive') {
    try {
      this.logger.log(`📋 Getting users for org ${organizationId} with filter: ${statusFilter}`);

      const whereClause: any = {
        organization_id: organizationId
      };

      if (statusFilter === 'active') {
        whereClause.is_active = true;
      } else if (statusFilter === 'inactive') {
        whereClause.is_active = false;
      }
      this.logger.log(`🔍 Query where clause: ${JSON.stringify(whereClause)}`);

      const orgUsers = await this.prisma.org_users.findMany({
        where: whereClause,
        include: {
          org_roles: true
        },
        orderBy: { joined_at: 'desc' }
      });

      const userIds = orgUsers.map(u => u.user_id);
      let userDetailsMap = new Map();
      let fetchSuccess = false;

      if (userIds.length > 0) {
        this.logger.log(`🔗 Fetching user details for ${userIds.length} users from Identity Service`);
        const identityResult = await this.identityClient.getUsersBatch(userIds);
        this.logger.log(`📡 Identity Service response: ${JSON.stringify(identityResult)}`);

        if (identityResult.success && identityResult.users) {
          identityResult.users.forEach((u: any) => userDetailsMap.set(u.id, u));
          fetchSuccess = true;
          this.logger.log(`✅ Loaded ${identityResult.users.length} user details into map`);
        } else {
          this.logger.warn(`⚠️ Identity Service returned no users or failed: ${JSON.stringify(identityResult)}`);
        }
      }

      const enrichedUsers = orgUsers.map(orgUser => {
        const details = userDetailsMap.get(orgUser.user_id) || {};
        const userEmail = details.email || 'unknown@example.com';
        if (userEmail === 'unknown@example.com') {
          this.logger.warn(`❓ Missing details for user ID ${orgUser.user_id} in Identity Service`);
        }
        return {
          id: orgUser.id,
          userId: orgUser.user_id,
          organizationId: orgUser.organization_id,
          email: userEmail,
          firstName: details.name ? details.name.split(' ')[0] : (details.firstName || ''),
          lastName: details.name ? details.name.split(' ').slice(1).join(' ') : (details.lastName || ''),
          phone: details.mobile || details.phone,
          status: orgUser.is_active ? 'ACTIVE' : 'INACTIVE',
          joinedAt: orgUser.joined_at,
          role: orgUser.org_roles ? {
            id: orgUser.org_roles.id,
            name: orgUser.org_roles.name,
            permissions: []
          } : null
        };
      });

      this.logger.log(`💡 Enriched ${enrichedUsers.length} users. Fetch success: ${fetchSuccess}`);

      const finalUsers = fetchSuccess
        ? enrichedUsers.filter(u => u.email !== 'unknown@example.com')
        : enrichedUsers;

      this.logger.log(`🏁 Returning ${finalUsers.length} users after filtering`);

      return {
        success: true,
        users: finalUsers,
        total: finalUsers.length
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get organization users:`, error);
      throw new InternalServerErrorException('Failed to retrieve organization users');
    }
  }

  async updateUserStatus(organizationId: string, orgUserId: string, isActive: boolean, reason?: string) {
    try {
      this.logger.log(`🔄 Updating user status: ${orgUserId} → ${isActive ? 'ACTIVE' : 'INACTIVE'}`);

      const orgUser = await this.prisma.org_users.findUnique({
        where: { id: orgUserId },
        include: {
          org_roles: true
        }
      });

      if (!orgUser) {
        throw new NotFoundException('User not found in organization');
      }

      this.logger.log(`📊 Current user status: is_active=${orgUser.is_active}, updating to: ${isActive}`);

      // Update status
      const updated = await this.prisma.org_users.update({
        where: { id: orgUserId },
        data: {
          is_active: isActive,
          updated_at: new Date()
        }
      });

      this.logger.log(`✅ Database updated! New is_active value: ${updated.is_active}`);

      // If deactivating, revoke permissions
      if (!isActive) {
        await this.identityClient.revokeAllUserPermissions(
          orgUser.user_id,
          orgUser.organization_id
        );
        this.logger.log(`✅ User deactivated and permissions revoked`);
      } else {
        // If reactivating, grant permissions back
        if (orgUser.org_roles) {
          const roleResult = await this.roleService.getRole(orgUser.role_id, orgUser.organization_id);
          await this.identityClient.grantPermissionsToUser({
            userId: orgUser.user_id,
            organizationId: orgUser.organization_id,
            permissionCodes: roleResult.role.permissions,
            roleId: orgUser.role_id,
            grantedBy: 'system'
          });
          this.logger.log(`✅ User reactivated and permissions granted`);
        }
      }

      return {
        success: true,
        message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
        user: updated,
        reason
      };
    } catch (error) {
      this.logger.error(`❌ Failed to update user status:`, error);
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Failed to update user status');
    }
  }

  async checkUserPermission(userId: string, organizationId: string, permission: string): Promise<boolean> {
    return this.identityClient.checkUserPermission(userId, organizationId, permission);
  }

  async getUserOrganizations(userId: string) {
    try {
      const orgUsers = await this.prisma.org_users.findMany({
        where: { user_id: userId, is_active: true },
        include: {
          organizations: true,
          org_roles: true
        },
        orderBy: { joined_at: 'desc' }, // newest org first so login uses most recently joined org
      });

      return {
        success: true,
        data: orgUsers.map(ou => ({
          ...ou.organizations,
          userCount: 1, // Simplified for list view
          role: ou.org_roles?.name || 'Unknown',
          roleId: ou.role_id,
          joinedAt: ou.joined_at,
          subscription: null // TODO: Fetch if critical for list view, but usually detail view handles this
        }))
      };
    } catch (error) {
      this.logger.error(`❌ Failed to get user organizations:`, error);
      return { success: false, organizations: [] };
    }
  }
}

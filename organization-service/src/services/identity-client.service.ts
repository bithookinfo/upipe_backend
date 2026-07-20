import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class IdentityClientService {
  private readonly logger = new Logger(IdentityClientService.name);
  private readonly identityServiceUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.identityServiceUrl = this.configService.get('IDENTITY_SERVICE_URL');
  }

  async grantPermissionsToUser(data: {
    userId: string;
    organizationId: string;
    permissionCodes: string[];
    roleId: string;
    grantedBy?: string;
  }) {
    try {
      this.logger.log(`🔗 Syncing ${data.permissionCodes.length} permissions to Identity Service for user ${data.userId}`);

      const response = await axios.post(
        `${this.identityServiceUrl}/permissions/grant-multiple`,
        {
          userId: data.userId,
          organizationId: data.organizationId,
          permissionCodes: data.permissionCodes,
          grantedBy: data.grantedBy,
          roleId: data.roleId
        },
        {
          timeout: 5000,
          headers: { 
            'Content-Type': 'application/json',
            'x-internal-token': process.env.INTERNAL_TOKEN
          }
        }
      );

      this.logger.log(`✅ Synced permissions to Identity Service: ${response.data.granted}/${response.data.total}`);
      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to sync permissions to Identity Service:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async revokeAllUserPermissions(userId: string, organizationId: string) {
    try {
      this.logger.log(`🔗 Revoking all permissions from Identity Service for user ${userId}`);

      const response = await axios.delete(
        `${this.identityServiceUrl}/permissions/user/${userId}/organization/${organizationId}`,
        { 
          timeout: 5000,
          headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        }
      );

      this.logger.log(`✅ Revoked permissions from Identity Service`);
      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to revoke permissions from Identity Service:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async checkUserPermission(userId: string, organizationId: string, permission: string): Promise<boolean> {
    try {
      const response = await axios.post(
        `${this.identityServiceUrl}/permissions/check`,
        {
          userId,
          organizationId,
          permission
        },
        {
          timeout: 3000,
          headers: { 
            'Content-Type': 'application/json',
            'x-internal-token': process.env.INTERNAL_TOKEN
          }
        }
      );

      return response.data.hasPermission === true;
    } catch (error) {
      this.logger.error(`❌ Failed to check permission from Identity Service:`, error.message);
      return false;
    }
  }

  async getAllPermissions() {
    try {
      const response = await axios.get(
        `${this.identityServiceUrl}/permissions`,
        { 
          timeout: 5000,
          headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        }
      );

      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to get permissions from Identity Service:`, error.message);
      return { success: false, permissions: [], total: 0 };
    }
  }

  // Internal user management methods
  async getUsersBatch(userIds: string[]) {
    try {
      const response = await axios.post(
        `${this.identityServiceUrl}/auth/internal/users/batch`,
        { userIds },
        { 
          timeout: 5000,
          headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        }
      );
      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to fetch users batch from Identity Service:`, error.message);
      return { success: false, users: [] };
    }
  }

  async inviteUser(data: { email: string; firstName: string; lastName: string; invitedBy?: string; password?: string; organizationName?: string; roleName?: string }) {    try {
      const response = await axios.post(
        `${this.identityServiceUrl}/auth/internal/users/invite`,
        data,
        { 
          timeout: 5000,
          headers: { 'x-internal-token': process.env.INTERNAL_TOKEN }
        }
      );
      return response.data;
    } catch (error) {
      this.logger.error(`❌ Failed to invite user via Identity Service:`, error.message);
      throw error; // Let caller handle errors (e.g. duplicate email)
    }
  }
}

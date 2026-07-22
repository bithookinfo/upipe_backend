import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityClientService } from '../services/identity-client.service';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private identityClient: IdentityClientService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    
    const userType = request.user?.userType || request.headers['x-user-type'];
    const isSuperAdmin = userType?.toLowerCase() === 'super_admin' || request.headers['x-is-super-admin'] === 'true' || request.user?.role === 'super_admin';
    if (isSuperAdmin) {
      return true;
    }

    const userId = request.user?.sub || request.headers['x-user-id'];
    const organizationId = request.params?.organizationId || request.headers['x-organization-id'];

    if (!userId || !organizationId) {
      throw new ForbiddenException('User ID and Organization ID are required');
    }

    // Check if user has at least one of the required permissions
    for (const permission of requiredPermissions) {
      const hasPermission = await this.identityClient.checkUserPermission(
        userId,
        organizationId,
        permission
      );

      if (hasPermission) {
        return true;
      }
    }

    throw new ForbiddenException(
      `Missing required permissions: ${requiredPermissions.join(' OR ')}`
    );
  }
}

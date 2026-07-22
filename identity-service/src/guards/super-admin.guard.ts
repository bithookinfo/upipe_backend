import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class SuperAdminGuard implements CanActivate {
    constructor(private reflector: Reflector) {}

    canActivate(
        context: ExecutionContext,
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context.switchToHttp().getRequest();

        // Check headers injected by API Gateway
        const userType = request.headers['x-user-type'];
        const userRole = request.headers['x-user-role'];

        // Allow super_admin user type or valid internal calls
        const internalToken = request.headers['x-internal-token'];
        const isInternalCall = internalToken && process.env.INTERNAL_TOKEN && internalToken === process.env.INTERNAL_TOKEN;
        const isSuperAdmin = isInternalCall || (userType && (userType.toLowerCase() === 'super_admin' || userType.toLowerCase() === 'superadmin'));

        if (!isSuperAdmin) {
            throw new UnauthorizedException('Super admin access required');
        }

        if (isInternalCall) {
            return true;
        }

        const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (!requiredPermissions || requiredPermissions.length === 0) {
            return true;
        }

        const permissionsHeader = request.headers['x-user-permissions'];
        let userPermissions: string[] = [];

        if (permissionsHeader) {
            try {
                userPermissions = JSON.parse(permissionsHeader as string);
            } catch (e) {
                userPermissions = [];
            }
        }

        // If user has wildcard permission, allow them
        if (userPermissions.includes('*')) {
            return true;
        }

        const hasPermission = requiredPermissions.every(permission => 
            userPermissions.includes(permission)
        );

        if (!hasPermission) {
            throw new ForbiddenException(`Missing required permissions: ${requiredPermissions.join(', ')}`);
        }

        return true;
    }
}

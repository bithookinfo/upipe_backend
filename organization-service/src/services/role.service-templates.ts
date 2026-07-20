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

    // Existing methods continue below...
}

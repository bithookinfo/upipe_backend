import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { CreateSuperAdminDto, UpdateSuperAdminDto } from '../dto/auth.dto';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SuperAdminService {
    private readonly logger = new Logger(SuperAdminService.name);

    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
        private configService: ConfigService,
        private auditService: AuditService,
    ) { }


    async createFirstSuperAdmin(dto: CreateSuperAdminDto) {
        // Check if any super admin exists
        const existingCount = await this.prisma.superAdmin.count();
        if (existingCount > 0) {
            throw new ConflictException('Super admin already exists. Use creation endpoint instead.');
        }

        return this.createSuperAdmin(dto);
    }

    /**
     * Create a new super admin
     */
    async createSuperAdmin(dto: CreateSuperAdminDto, createdBy?: string) {
        this.logger.log(`Creating super admin: ${dto.email}`);

        // Check if email already exists
        const existing = await this.prisma.superAdmin.findUnique({
            where: { email: dto.email },
        });

        if (existing) {
            throw new ConflictException('Super admin with this email already exists');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(dto.password, 12);

        // Create super admin
        const superAdmin = await this.prisma.superAdmin.create({
            data: {
                name: dto.name,
                email: dto.email,
                password: hashedPassword,
                role: dto.role,
                permissions: dto.permissions || null,
                isActive: true,
            },
        });

        // Log audit
        if (createdBy) {
            await this.auditService.log({
                superAdminId: createdBy,
                action: 'SUPER_ADMIN_CREATED',
                entityType: 'super_admin',
                entityId: superAdmin.id,
                details: {
                    email: superAdmin.email,
                    role: superAdmin.role,
                },
            });
        }

        this.logger.log(`✅ Super admin created: ${superAdmin.email}`);

        // Remove password from response
        const { password, ...result } = superAdmin;
        return result;
    }

    /**
     * Validate super admin credentials
     */
    async validateCredentials(email: string, password: string) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { email },
        });

        if (!superAdmin) {
            return null;
        }

        if (!superAdmin.isActive) {
            throw new UnauthorizedException('Account is deactivated');
        }

        const isPasswordValid = await bcrypt.compare(password, superAdmin.password);

        if (!isPasswordValid) {
            return null;
        }

        return superAdmin;
    }

    /**
     * Generate JWT token for super admin
     */
    async generateToken(superAdmin: any) {
        let permissions = superAdmin.permissions;

        // If permissions are not explicitly set on the user, fetch them from the assigned role
        if (!permissions || permissions.length === 0 || permissions === null) {
            if (superAdmin.role) {
                const adminRole = await this.prisma.adminRole.findUnique({
                    where: { key: superAdmin.role }
                });
                if (adminRole && adminRole.permissions) {
                    try {
                        permissions = typeof adminRole.permissions === 'string' 
                            ? JSON.parse(adminRole.permissions) 
                            : adminRole.permissions;
                    } catch (e) {
                        permissions = adminRole.permissions;
                    }
                }
            }
        }

        const payload = {
            sub: superAdmin.id,
            email: superAdmin.email,
            role: superAdmin.role,
            userType: 'super_admin',
            permissions: permissions || [],
            organizationId: superAdmin.organizationId,
        };

        const token = this.jwtService.sign(payload, {
            secret: this.configService.get('JWT_SECRET'),
            expiresIn: '24h',
        });

        return { token, resolvedPermissions: permissions || [] };
    }

    /**
     * Create session for super admin
     */
    async createSession(superAdminId: string, token: string, ipAddress?: string, userAgent?: string) {
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24);

        return this.prisma.session.create({
            data: {
                superAdminId,
                token,
                ipAddress,
                userAgent,
                expiresAt,
            },
        });
    }

    /**
     * Update last login timestamp
     */
    async updateLastLogin(superAdminId: string) {
        return this.prisma.superAdmin.update({
            where: { id: superAdminId },
            data: { lastLoginAt: new Date() },
        });
    }

    /**
     * Find all super admins
     */
    async findAll() {
        const superAdmins = await this.prisma.superAdmin.findMany({
            orderBy: { createdAt: 'desc' },
        });

        return superAdmins.map(({ password, mfaSecret, ...admin }) => admin);
    }

    /**
     * Find super admin by ID
     */
    async findById(id: string) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { id },
        });

        if (!superAdmin) {
            throw new NotFoundException('Super admin not found');
        }

        const { password, mfaSecret, ...result } = superAdmin;
        return result;
    }

    /**
     * Update super admin
     */
    async update(id: string, dto: UpdateSuperAdminDto, updatedBy: string) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { id },
        });

        if (!superAdmin) {
            throw new NotFoundException('Super admin not found');
        }

        const updated = await this.prisma.superAdmin.update({
            where: { id },
            data: {
                name: dto.name,
                role: dto.role,
                permissions: dto.permissions,
                isActive: dto.isActive,
            },
        });

        // Log audit
        await this.auditService.log({
            superAdminId: updatedBy,
            action: 'SUPER_ADMIN_UPDATED',
            entityType: 'super_admin',
            entityId: id,
            details: dto,
        });

        const { password, mfaSecret, ...result } = updated;
        return result;
    }

    /**
     * Update own settings (email, password)
     */
    async updateMySettings(id: string, dto: any) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { id },
        });

        if (!superAdmin) {
            throw new NotFoundException('Super admin not found');
        }

        const dataToUpdate: any = {};
        
        if (dto.email) {
            dataToUpdate.email = dto.email;
        }

        if (dto.password) {
            dataToUpdate.password = await bcrypt.hash(dto.password, 10);
        }

        if (Object.keys(dataToUpdate).length === 0) {
            return { message: 'No changes provided' };
        }

        const updated = await this.prisma.superAdmin.update({
            where: { id },
            data: dataToUpdate,
        });

        // Log audit
        await this.auditService.log({
            superAdminId: id,
            action: 'SUPER_ADMIN_UPDATED_SETTINGS',
            entityType: 'super_admin',
            entityId: id,
            details: { updatedFields: Object.keys(dataToUpdate) },
        });

        const { password, mfaSecret, ...result } = updated;
        return result;
    }

    /**
     * Delete super admin
     */
    async delete(id: string, deletedBy: string) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { id },
        });

        if (!superAdmin) {
            throw new NotFoundException('Super admin not found');
        }

        await this.prisma.superAdmin.delete({
            where: { id },
        });

        // Log audit
        await this.auditService.log({
            superAdminId: deletedBy,
            action: 'SUPER_ADMIN_DELETED',
            entityType: 'super_admin',
            entityId: id,
            details: { email: superAdmin.email },
        });

        this.logger.log(`✅ Super admin deleted: ${superAdmin.email}`);

        return { message: 'Super admin deleted successfully' };
    }

    /**
     * Reset super admin password
     */
    async resetPassword(id: string, newPassword: string, resetBy: string) {
        const superAdmin = await this.prisma.superAdmin.findUnique({
            where: { id },
        });

        if (!superAdmin) {
            throw new NotFoundException('Super admin not found');
        }

        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await this.prisma.superAdmin.update({
            where: { id },
            data: { password: hashedPassword },
        });

        // Log audit
        await this.auditService.log({
            superAdminId: resetBy,
            action: 'SUPER_ADMIN_PASSWORD_RESET',
            entityType: 'super_admin',
            entityId: id,
            details: { email: superAdmin.email },
        });

        this.logger.log(`✅ Password reset for: ${superAdmin.email}`);

        return { message: 'Password reset successfully' };
    }

    /**
     * Verify MFA code (placeholder for future implementation)
     */
    async verifyMfaCode(superAdminId: string, code: string): Promise<boolean> {
        // TODO: Implement actual MFA verification
        // For now, return true if code is provided
        return !!code;
    }
}

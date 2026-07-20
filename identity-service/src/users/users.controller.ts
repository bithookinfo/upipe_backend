import { Controller, Get, Post, Put, Body, Headers, Logger, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Users')
@Controller('users')
export class UsersController {
    private readonly logger = new Logger(UsersController.name);

    constructor(private prisma: PrismaService) { }

    @Get('profile')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get current user profile' })
    @ApiResponse({ status: 200, description: 'Returns user profile' })
    async getProfile(@Headers('x-user-id') userId: string) {
        if (!userId) {
            throw new UnauthorizedException('User not authenticated');
        }

        this.logger.debug(`Fetching profile for user: ${userId}`);

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                email: true,
                mobile: true,
                emailVerified: true,
                mobileVerified: true,
                whatsapp: true,
                alternateEmail: true,
                alternateEmailVerified: true,
                callbackUrl: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        // Split name into firstName and lastName
        const nameParts = user.name?.split(' ') || [];
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        return {
            id: user.id,
            firstName,
            lastName,
            name: user.name,
            email: user.email,
            mobile: user.mobile,
            phone: user.mobile,
            callbackUrl: user.callbackUrl,
            emailVerified: user.emailVerified,
            mobileVerified: user.mobileVerified,
            whatsapp: user.whatsapp,
            alternateEmail: user.alternateEmail,
            alternateEmailVerified: user.alternateEmailVerified,
            isActive: user.isActive,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }

    @Put('profile')
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Update current user profile' })
    @ApiResponse({ status: 200, description: 'Profile updated successfully' })
    async updateProfile(
        @Headers('x-user-id') userId: string,
        @Body() body: { firstName?: string; lastName?: string; phone?: string; callbackUrl?: string; whatsapp?: string; alternateEmail?: string },
    ) {
        if (!userId) {
            throw new UnauthorizedException('User not authenticated');
        }

        this.logger.debug(`Updating profile for user: ${userId}`, body);

        // Combine firstName and lastName into name
        const name = [body.firstName, body.lastName].filter(Boolean).join(' ') || undefined;

        const updateData: any = {};
        if (name) updateData.name = name;
        if (body.phone) updateData.mobile = body.phone;
        if (body.callbackUrl !== undefined) updateData.callbackUrl = body.callbackUrl || null;
        if (body.whatsapp !== undefined) updateData.whatsapp = body.whatsapp || null;
        if (body.alternateEmail !== undefined) updateData.alternateEmail = body.alternateEmail || null;

        const user = await this.prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                name: true,
                email: true,
                mobile: true,
                emailVerified: true,
                mobileVerified: true,
                whatsapp: true,
                alternateEmail: true,
                alternateEmailVerified: true,
                callbackUrl: true,
                isActive: true,
                lastLoginAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        // Split name into firstName and lastName
        const nameParts = user.name?.split(' ') || [];
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        return {
            success: true,
            message: 'Profile updated successfully',
            id: user.id,
            firstName,
            lastName,
            name: user.name,
            email: user.email,
            mobile: user.mobile,
            phone: user.mobile,
            callbackUrl: user.callbackUrl,
            emailVerified: user.emailVerified,
            mobileVerified: user.mobileVerified,
            whatsapp: user.whatsapp,
            alternateEmail: user.alternateEmail,
            alternateEmailVerified: user.alternateEmailVerified,
            isActive: user.isActive,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }

    @Post('internal/batch')
    @ApiOperation({ summary: 'Get basic details for multiple users (Internal)' })
    async getBatchUsers(
        @Body() body: { userIds: string[] },
        @Headers('x-internal-token') internalToken?: string
    ) {
        if (!internalToken || internalToken !== process.env.INTERNAL_TOKEN) {
            throw new UnauthorizedException('Invalid internal token');
        }

        const users = await this.prisma.user.findMany({
            where: {
                id: { in: body.userIds }
            },
            select: {
                id: true,
                name: true,
                email: true,
            }
        });
        
        // Also check super admins if not all IDs found
        const foundIds = new Set(users.map(u => u.id));
        const missingIds = body.userIds.filter(id => !foundIds.has(id));

        if (missingIds.length > 0) {
            const superAdmins = await this.prisma.superAdmin.findMany({
                where: {
                    id: { in: missingIds }
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                }
            });
            users.push(...superAdmins);
        }

        return {
            success: true,
            data: users
        };
    }
}

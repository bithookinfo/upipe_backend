import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Controller('internal')
export class InternalController {
    constructor(private readonly prisma: PrismaService) {}

    @Get('super-admin/primary')
    async getPrimarySuperAdmin(@Headers('x-internal-token') token: string) {
        if (!token || token !== process.env.INTERNAL_TOKEN) {
            throw new UnauthorizedException('Invalid internal token');
        }

        const superAdmin = await this.prisma.superAdmin.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'asc' }
        });

        if (!superAdmin) {
            return { email: 'admin@upipe.tech' }; // Fallback
        }

        return superAdmin;
    }
}

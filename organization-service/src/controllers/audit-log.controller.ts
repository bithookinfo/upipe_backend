import { Controller, Get, Query, Post, Body, Headers, ForbiddenException, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuditService } from '../services/audit.service';

@ApiTags('audit-logs')
@Controller('audit-logs')
export class AuditLogController {
    constructor(private readonly auditService: AuditService) { }

    private validateSuperAdmin(isSuperAdmin?: string, userType?: string) {
        if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
        throw new ForbiddenException("Super admin access required");
    }

    @Get('recent')
    @ApiOperation({ summary: 'Get recent audit logs across all organizations' })
    @ApiResponse({ status: 200, description: 'Recent audit logs retrieved successfully' })
    async getRecentLogs(
        @Query('limit') limit?: number,
        @Query('offset') offset?: number,
        @Query('action') action?: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        this.validateSuperAdmin(isSuperAdmin, userType);
        return this.auditService.getAllLogs({
            limit: limit ? parseInt(limit.toString()) : 20,
            offset: offset ? parseInt(offset.toString()) : 0,
            action,
        });
    }
    @Post()
    @UseGuards(InternalAuthGuard)
    @ApiOperation({ summary: 'Create an audit log (internal)' })
    @ApiResponse({ status: 201, description: 'Audit log created successfully' })
    async createLog(@Body() data: any) {
        await this.auditService.log({
            organizationId: data.organizationId,
            action: data.action,
            performedBy: data.performedBy,
            performedByType: data.performedByType,
            entityId: data.entityId,
            entityType: data.entityType,
            metadata: data.metadata,
            reason: data.reason,
            ipAddress: data.ipAddress,
        });
        return { success: true, message: 'Audit log created' };
    }
}

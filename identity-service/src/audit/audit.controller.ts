import {
    Controller,
    Get,
    Query,
    UseGuards,
    ParseIntPipe,
    DefaultValuePipe,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiQuery,
} from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { SuperAdminGuard } from '../guards/super-admin.guard';

@Controller('audit')
@ApiTags('audit')
@UseGuards(SuperAdminGuard)
@ApiBearerAuth()
export class AuditController {
    constructor(private readonly auditService: AuditService) { }

    @Get('logs')
    @ApiOperation({ summary: 'Query audit logs' })
    @ApiQuery({ name: 'superAdminId', required: false })
    @ApiQuery({ name: 'action', required: false })
    @ApiQuery({ name: 'entityType', required: false })
    @ApiQuery({ name: 'entityId', required: false })
    @ApiQuery({ name: 'startDate', required: false })
    @ApiQuery({ name: 'endDate', required: false })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'Audit logs retrieved successfully' })
    async queryLogs(
        @Query('superAdminId') superAdminId?: string,
        @Query('action') action?: string,
        @Query('entityType') entityType?: string,
        @Query('entityId') entityId?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
    ) {
        return this.auditService.query({
            superAdminId,
            action,
            entityType,
            entityId,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            limit,
            offset,
        });
    }

    @Get('recent')
    @ApiOperation({ summary: 'Get recent audit activity' })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'Recent activity retrieved successfully' })
    async getRecentActivity(
        @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit?: number,
    ) {
        return this.auditService.getRecentActivity(limit);
    }

    @Get('login-history')
    @ApiOperation({ summary: 'Get login history' })
    @ApiQuery({ name: 'type', required: false, enum: ['super_admin', 'user', 'all'] })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiResponse({ status: 200, description: 'Login history retrieved successfully' })
    async getLoginHistory(
        @Query('type') type?: string,
        @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
        @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
    ) {
        return this.auditService.getLoginHistory(type, limit, offset);
    }

    @Get('stats')
    @ApiOperation({ summary: 'Get audit statistics' })
    @ApiResponse({ status: 200, description: 'Audit stats retrieved successfully' })
    async getStats() {
        return this.auditService.getStats();
    }
}

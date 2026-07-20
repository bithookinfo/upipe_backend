import {
    Controller,
    Get,
    Post,
    Put,
    Delete,
    Body,
    Param,
    UseGuards,
    Req,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
} from '@nestjs/swagger';
import { Request } from 'express';
import { SuperAdminService } from './super-admin.service';
import { CreateSuperAdminDto, UpdateSuperAdminDto, UpdateMySettingsDto } from '../dto/auth.dto';
import { SuperAdminGuard } from '../guards/super-admin.guard';
import { RequirePermissions } from '../decorators/permissions.decorator';

@Controller('super-admins')
@ApiTags('super-admin')
@UseGuards(SuperAdminGuard)
@ApiBearerAuth()
export class SuperAdminController {
    constructor(private readonly superAdminService: SuperAdminService) { }

    @Get()
    @RequirePermissions('user:view')
    @ApiOperation({ summary: 'List all super admins' })
    @ApiResponse({ status: 200, description: 'Super admins retrieved successfully' })
    async findAll() {
        return this.superAdminService.findAll();
    }

    @Get(':id')
    @RequirePermissions('user:view')
    @ApiOperation({ summary: 'Get super admin by ID' })
    @ApiResponse({ status: 200, description: 'Super admin retrieved successfully' })
    async findById(@Param('id') id: string) {
        return this.superAdminService.findById(id);
    }

    @Post()
    @RequirePermissions('user:create')
    @ApiOperation({ summary: 'Create new super admin' })
    @ApiResponse({ status: 201, description: 'Super admin created successfully' })
    async create(@Body() dto: CreateSuperAdminDto, @Req() req: Request) {
        const createdBy = req.headers['x-user-id'] as string;
        return this.superAdminService.createSuperAdmin(dto, createdBy);
    }

    @Put('me/settings')
    @ApiOperation({ summary: 'Update own super admin settings' })
    @ApiResponse({ status: 200, description: 'Settings updated successfully' })
    async updateMySettings(
        @Body() dto: UpdateMySettingsDto,
        @Req() req: Request,
    ) {
        const userId = req.headers['x-user-id'] as string;
        return this.superAdminService.updateMySettings(userId, dto);
    }

    @Put(':id')
    @RequirePermissions('user:update')
    @ApiOperation({ summary: 'Update super admin' })
    @ApiResponse({ status: 200, description: 'Super admin updated successfully' })
    async update(
        @Param('id') id: string,
        @Body() dto: UpdateSuperAdminDto,
        @Req() req: Request,
    ) {
        const updatedBy = req.headers['x-user-id'] as string;
        return this.superAdminService.update(id, dto, updatedBy);
    }

    @Delete(':id')
    @RequirePermissions('user:delete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Delete super admin' })
    @ApiResponse({ status: 200, description: 'Super admin deleted successfully' })
    async delete(@Param('id') id: string, @Req() req: Request) {
        const deletedBy = req.headers['x-user-id'] as string;
        return this.superAdminService.delete(id, deletedBy);
    }

    @Post(':id/reset-password')
    @RequirePermissions('user:update')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Reset super admin password' })
    @ApiResponse({ status: 200, description: 'Password reset successfully' })
    async resetPassword(
        @Param('id') id: string,
        @Body('newPassword') newPassword: string,
        @Req() req: Request,
    ) {
        const resetBy = req.headers['x-user-id'] as string;
        return this.superAdminService.resetPassword(id, newPassword, resetBy);
    }
}

import { Controller, Get, Post, Patch, Body, Param, Query, Req, Logger, HttpException, HttpStatus, Headers, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../services/prisma.service';
import { IdentityClientService } from '../services/identity-client.service';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

class CreateTicketDto {
    organizationId: string;
    userId: string;
    subject: string;
    message: string;
    priority?: string;
    category?: string;
}

@Controller('support')
@ApiTags('support')
export class SupportController {
    private readonly logger = new Logger(SupportController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly identityClient: IdentityClientService
    ) { }

    private validateSuperAdmin(isSuperAdmin?: string, userType?: string) {
        if (isSuperAdmin === 'true' || userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
        throw new ForbiddenException("Super admin access required");
    }

    private validateAccess(id: string, reqOrgId: string, userType: string) {
        if (userType?.toUpperCase() === 'SUPER_ADMIN' || userType?.toUpperCase() === 'SUPERADMIN' || userType?.toUpperCase() === 'SUPER_ADMIN') return;
        if (id !== reqOrgId) throw new ForbiddenException("Tenant Isolation Violation");
    }

    @Get('tickets')
    @ApiOperation({ summary: 'Get all support tickets (Admin/Super Admin)' })
    async getAllTickets(
        @Query('status') status?: string,
        @Query('priority') priority?: string,
        @Query('category') category?: string,
        @Query('search') search?: string,
        @Query('organizationId') queryOrganizationId?: string,
        @Headers('x-organization-id') reqOrgId?: string,
        @Headers('x-user-type') userType?: string,
        @Headers('x-is-super-admin') isSuperAdmin?: string
    ) {
        const userTypeUpper = userType?.toUpperCase();
        const isAdmin = isSuperAdmin === 'true' || userTypeUpper === 'SUPER_ADMIN' || userTypeUpper === 'SUPERADMIN';
        
        let organizationId = queryOrganizationId;
        if (!isAdmin) {
            if (!reqOrgId) throw new ForbiddenException("Organization ID required for merchants");
            if (organizationId && organizationId !== reqOrgId) throw new ForbiddenException("Tenant Isolation Violation");
            organizationId = reqOrgId;
        }

        try {
            const where: any = { AND: [] };

            if (status && status !== 'all') {
                where.AND.push({ status: status.toUpperCase() });
            }

            if (priority && priority !== 'all') {
                where.AND.push({ priority: priority.toUpperCase() });
            }

            if (category && category !== 'all') {
                where.AND.push({ category: category.toUpperCase() });
            }

            if (organizationId) {
                where.AND.push({ organization_id: organizationId });
            }

            if (search && search.trim() !== '') {
                where.AND.push({
                    OR: [
                        { subject: { contains: search } },
                        { message: { contains: search } }
                    ]
                });
            }

            // Prisma cannot receive empty AND
            if (where.AND.length === 0) delete where.AND;

            this.logger.debug(`Fetching tickets with where: ${JSON.stringify(where)}`);

            const tickets = await this.prisma.support_tickets.findMany({
                where,
                include: {
                    organizations: {
                        select: {
                            id: true,
                            name: true,
                            email: true
                        }
                    },
                    support_replies: {
                        select: {
                            id: true
                        }
                    }
                },
                orderBy: {
                    created_at: 'desc'
                }
            });

            // Enrich with user data via batch
            const userIds = [...new Set(tickets.map((t) => t.created_by))];
            const batchResult = userIds.length > 0 ? await this.identityClient.getUsersBatch(userIds) : { users: [] };
            type UserInfo = { id: string; name?: string; email?: string };
            const userMap = new Map<string, UserInfo>((batchResult.users || []).map((u: UserInfo) => [u.id, u]));

            const enrichedTickets = tickets.map((ticket) => {
                const user = userMap.get(ticket.created_by);
                const createdByName = user?.name || user?.email || 'Unknown User';
                const createdByEmail = user?.email || ticket.organizations.email || 'N/A';
                return {
                    id: ticket.id,
                    organizationId: ticket.organization_id,
                    organizationName: ticket.organizations.name,
                    subject: ticket.subject,
                    message: ticket.message,
                    status: ticket.status,
                    priority: ticket.priority,
                    category: (ticket as any).category,
                    createdBy: ticket.created_by,
                    createdByName,
                    createdByEmail,
                    createdAt: ticket.created_at,
                    updatedAt: ticket.updated_at,
                    replyCount: ticket.support_replies.length
                };
            });

            return {
                success: true,
                data: enrichedTickets
            };
        } catch (error) {
            this.logger.error('Failed to fetch support tickets:', error);
            throw new HttpException('Failed to fetch support tickets', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Get('tickets/unread-count')
    @ApiOperation({ summary: 'Get unread/open ticket count' })
    async getUnreadCount() {
        try {
            const count = await this.prisma.support_tickets.count({
                where: {
                    OR: [
                        { status: 'OPEN' },
                        { status: 'IN_PROGRESS' }
                    ]
                }
            });

            return {
                success: true,
                count
            };
        } catch (error) {
            this.logger.error('Failed to get unread count:', error);
            return { success: true, count: 0 };
        }
    }

    @Get('tickets/:id')
    @ApiOperation({ summary: 'Get ticket details' })
    async getTicketDetails(
        @Param('id') id: string,
        @Headers('x-organization-id') reqOrgId?: string,
        @Headers('x-user-type') userType?: string
    ) {
        try {
            const whereClause: any = { id };
            const userTypeUpper = userType?.toUpperCase();
            if (reqOrgId && reqOrgId !== 'platform-org-id' && userTypeUpper !== 'SUPER_ADMIN' && userTypeUpper !== 'SUPERADMIN') {
                whereClause.organization_id = reqOrgId;
            }
            const ticket = await this.prisma.support_tickets.findFirst({
                where: whereClause,
                include: {
                    organizations: {
                        select: {
                            id: true,
                            name: true,
                            email: true
                        }
                    },
                    support_replies: {
                        orderBy: {
                            created_at: 'asc'
                        }
                    }
                }
            });

            if (!ticket) {
                throw new HttpException('Ticket not found', HttpStatus.NOT_FOUND);
            }

            // Enrich with user data via batch (ticket creator + all reply authors)
            const replyUserIds = ticket.support_replies.map((r) => r.created_by);
            const allUserIds = [ticket.created_by, ...replyUserIds].filter(Boolean);
            const uniqueIds = [...new Set(allUserIds)];
            const batchResult = uniqueIds.length > 0 ? await this.identityClient.getUsersBatch(uniqueIds) : { users: [] };
            type UserInfo = { id: string; name?: string; email?: string };
            const userMap = new Map<string, UserInfo>((batchResult.users || []).map((u: UserInfo) => [u.id, u]));

            const creator = userMap.get(ticket.created_by);
            const createdByName = creator?.name || creator?.email || 'Unknown User';
            const createdByEmail = creator?.email || ticket.organizations.email || 'N/A';

            const enrichedReplies = ticket.support_replies.map((reply) => {
                const replyUser = userMap.get(reply.created_by);
                const replyName = replyUser?.name || replyUser?.email || 'Unknown';
                return {
                    id: reply.id,
                    message: reply.message,
                    createdBy: reply.created_by,
                    createdByName: replyName,
                    isAdmin: reply.is_admin,
                    createdAt: reply.created_at
                };
            });

            return {
                success: true,
                data: {
                    id: ticket.id,
                    organizationId: ticket.organization_id,
                    organizationName: ticket.organizations.name,
                    subject: ticket.subject,
                    message: ticket.message,
                    status: ticket.status,
                    priority: ticket.priority,
                    category: (ticket as any).category,
                    createdBy: ticket.created_by,
                    createdByName,
                    createdByEmail,
                    createdAt: ticket.created_at,
                    updatedAt: ticket.updated_at,
                    replies: enrichedReplies
                }
            };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            this.logger.error('Failed to fetch ticket details:', error);
            throw new HttpException('Failed to fetch ticket details', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Post('tickets/:id/reply')
    @ApiOperation({ summary: 'Reply to support ticket' })
    async replyToTicket(
        @Param('id') ticketId: string,
        @Body() body: { message: string; userId?: string; isAdmin?: boolean },
        @Req() request: Request,
        @Headers('x-organization-id') reqOrgId?: string,
        @Headers('x-user-type') userType?: string
    ) {
        const headerUserId = request.headers['x-user-id'];
        const createdBy = body.userId ?? (request as any).user?.sub ?? (Array.isArray(headerUserId) ? headerUserId[0] : headerUserId);
        if (!createdBy || typeof createdBy !== 'string') {
            throw new HttpException('User ID is required (send userId in body or use authenticated request)', HttpStatus.BAD_REQUEST);
        }
        try {
            const whereClause: any = { id: ticketId };
            const userTypeUpper = userType?.toUpperCase();
            if (reqOrgId && reqOrgId !== 'platform-org-id' && userTypeUpper !== 'SUPER_ADMIN' && userTypeUpper !== 'SUPERADMIN') {
                whereClause.organization_id = reqOrgId;
            }
            
            // Validate ticket exists in the user's organization
            const ticketExists = await this.prisma.support_tickets.findFirst({
                where: whereClause
            });
            if (!ticketExists) throw new HttpException('Ticket not found', HttpStatus.NOT_FOUND);

            const reply = await this.prisma.support_replies.create({
                data: {
                    id: randomUUID(),
                    ticket_id: ticketId,
                    message: body.message,
                    created_by: createdBy,
                    is_admin: body.isAdmin ?? false
                }
            });

            // Update ticket updated_at
            const ticket = await this.prisma.support_tickets.update({
                where: { id: ticketId },
                data: { updated_at: new Date() }
            });

            // Send notification
            const paymentServiceUrl = this.configService.get('PAYMENT_SERVICE_URL');
            if (paymentServiceUrl) {
                const userType = request.headers['x-user-type'] as string;
                const isSuperAdmin = userType === 'superadmin' || userType === 'super_admin';
                const fromSuperAdmin = body.isAdmin ?? isSuperAdmin;

                if (fromSuperAdmin) {
                    // Notify ticket owner (merchant admin)
                    axios.post(`${paymentServiceUrl}/internal-notifications`, {
                        type: 'ticket_reply',
                        title: 'New Reply on Ticket',
                        message: `Greenpay Support replied to your ticket ${ticket.id.substring(0, 8)}`,
                        organizationId: ticket.organization_id,
                        userId: ticket.created_by,
                        externalOrderId: ticket.id,
                    }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }).catch(err => this.logger.warn(`Failed to send notification: ${err.message}`));
                } else {
                    // Notify super admins
                    axios.post(`${paymentServiceUrl}/internal-notifications`, {
                        type: 'ticket_reply',
                        title: 'New Reply on Ticket',
                        message: `User from Organization ${ticket.organization_id.substring(0,8)} replied to ticket ${ticket.id.substring(0, 8)}`,
                        organizationId: ticket.organization_id,
                        forSuperAdmins: true,
                        externalOrderId: ticket.id,
                    }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }).catch(err => this.logger.warn(`Failed to send notification: ${err.message}`));
                }
            }

            return {
                success: true,
                data: reply
            };
        } catch (error) {
            this.logger.error('Failed to create reply:', error);
            throw new HttpException('Failed to create reply', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Patch('tickets/:id/status')
    @ApiOperation({ summary: 'Update ticket status' })
    async updateTicketStatus(
        @Param('id') id: string,
        @Body() body: { status: string },
        @Headers('x-organization-id') reqOrgId?: string,
        @Headers('x-user-type') userType?: string
    ) {
        try {
            const whereClause: any = { id };
            const userTypeUpper = userType?.toUpperCase();
            if (reqOrgId && reqOrgId !== 'platform-org-id' && userTypeUpper !== 'SUPER_ADMIN' && userTypeUpper !== 'SUPERADMIN') {
                whereClause.organization_id = reqOrgId;
            }

            const ticketExists = await this.prisma.support_tickets.findFirst({
                where: whereClause
            });
            if (!ticketExists) throw new HttpException('Ticket not found', HttpStatus.NOT_FOUND);

            const ticket = await this.prisma.support_tickets.update({
                where: { id },
                data: {
                    status: body.status as any,
                    updated_at: new Date()
                }
            });

            // Notify the client user
            const paymentServiceUrl = this.configService.get('PAYMENT_SERVICE_URL');
            this.logger.log(`Attempting to send notification to payment service at: ${paymentServiceUrl}`);
            if (paymentServiceUrl) {
                axios.post(`${paymentServiceUrl}/internal-notifications`, {
                    type: 'ticket_status_changed',
                    title: 'Ticket Updated',
                    message: `Your ticket ${ticket.id.substring(0, 8)} status changed to ${body.status.toLowerCase().replace(/_/g, ' ')}`,
                    organizationId: ticket.organization_id,
                    userId: ticket.created_by, // Notify ticket owner
                    externalOrderId: ticket.id,
                }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } })
                    .then(() => this.logger.log(`Successfully sent ticket status notification for ticket ${ticket.id}`))
                    .catch(err => this.logger.warn(`Failed to send ticket status notification: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`));
            } else {
                this.logger.warn('PAYMENT_SERVICE_URL is not configured. Cannot send notification.');
            }

            return {
                success: true,
                data: ticket
            };
        } catch (error) {
            this.logger.error('Failed to update ticket status:', error);
            throw new HttpException('Failed to update ticket status', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }

    @Post('tickets')
    @ApiOperation({ summary: 'Create support ticket (Client Admin)' })
    async createTicket(@Body() body: any, @Headers('x-organization-id') reqOrgId: string, @Headers('x-user-type') userType: string) {
        this.validateAccess(body.organizationId, reqOrgId, userType);
        try {
            const ticket = await this.prisma.support_tickets.create({
                data: {
                    id: randomUUID(),
                    organization_id: body.organizationId,
                    created_by: body.userId,
                    subject: body.subject,
                    message: body.message,
                    priority: (body.priority || 'MEDIUM').toUpperCase() as any,
                    category: (body.category || 'GENERAL').toUpperCase() as any,
                    status: 'OPEN'
                }
            });

            const org = await this.prisma.organizations.findUnique({
                where: { id: body.organizationId },
                select: { name: true }
            });
            const orgName = org?.name;

            const paymentServiceUrl = this.configService.get('PAYMENT_SERVICE_URL');
            if (paymentServiceUrl) {
                const orgDisplay = orgName ? `Organization "${orgName}"` : 'A User';
                axios.post(`${paymentServiceUrl}/internal-notifications`, {
                    type: 'ticket_created',
                    title: 'New Ticket Raised',
                    message: `${orgDisplay} created ticket ${ticket.id.substring(0, 8)}: ${body.subject}`,
                    organizationId: body.organizationId,
                    forSuperAdmins: true,
                    externalOrderId: ticket.id,
                }, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } }).catch(err => this.logger.warn(`Failed to send new ticket notification: ${err.message}`));
            }

            return { success: true, data: ticket };
        } catch (error) {
            this.logger.error('Failed to create ticket:', error);
            throw new HttpException('Failed to create ticket', HttpStatus.INTERNAL_SERVER_ERROR);
        }
    }
}

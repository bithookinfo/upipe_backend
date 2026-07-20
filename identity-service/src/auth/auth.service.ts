import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { RegisterDto, LoginDto, ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto, VerifyEmailDto } from './dto/auth.dto';

import { ConfigService } from '@nestjs/config';

const TOKEN_BYTES = 32;
const VERIFY_EXPIRY_HOURS = 24;
const RESET_EXPIRY_HOURS = 1;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly organizationServiceUrl: string;
  private readonly subscriptionServiceUrl: string;
  private readonly notificationServiceUrl: string;
  private readonly frontendUrl: string;
  private readonly emailVerificationEnabled: boolean;

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.organizationServiceUrl = this.configService.get<string>('ORGANIZATION_SERVICE_URL');
    this.subscriptionServiceUrl = this.configService.get<string>('SUBSCRIPTION_SERVICE_URL');
    this.notificationServiceUrl = this.configService.get<string>('NOTIFICATION_SERVICE_URL') || '';
    this.frontendUrl = this.configService.get<string>('FRONTEND_URL') as string;
    this.emailVerificationEnabled = this.configService.get<string>('EMAIL_VERIFICATION_ENABLED') === 'true';
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async sendEmailViaNotificationService(payload: { to: string; type: string; data: Record<string, string | number | undefined> }): Promise<void> {
    if (!this.notificationServiceUrl) {
      this.logger.warn('NOTIFICATION_SERVICE_URL not set, skipping email');
      return;
    }
    try {
      const res = await fetch(`${this.notificationServiceUrl.replace(/\/$/, '')}/internal/send/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': this.configService.get('INTERNAL_TOKEN') || '' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        this.logger.warn(`Notification service send failed: ${res.status} ${err}`);
      }
    } catch (e: any) {
      this.logger.warn('Notification service request failed', e?.message || e);
    }
  }

  async registerPushSubscription(
    userId: string,
    organizationId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null },
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.notificationServiceUrl) {
      return { success: false, error: 'Push not configured' };
    }
    try {
      const res = await fetch(`${this.notificationServiceUrl.replace(/\/$/, '')}/internal/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
        body: JSON.stringify({ userId, organizationId, subscription }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { success: false, error: data?.error || `HTTP ${res.status}` };
      return { success: true };
    } catch (e: any) {
      this.logger.warn('Push subscribe failed', e?.message || e);
      return { success: false, error: e?.message || 'Request failed' };
    }
  }

  async register(
    registerDto: RegisterDto,
    ipAddress?: string,
    userAgent?: string
  ) {
    const { email, mobile, password, name, company, subscriptionPlanId, pan, location, pin } = registerDto;
    try {
      if (!mobile || !password || !name) {
        throw new Error('Mobile, password, and name are required');
      }
      if (password.length < 6) {
        throw new Error('Password must be at least 6 characters long');
      }

      if (email) {
        const existingUserByEmail = await this.prisma.user.findUnique({ where: { email } });
        if (existingUserByEmail) {
          this.logger.warn(`Registration attempt with existing email: ${email}`);
          throw new ConflictException('User with this email already exists');
        }
      }

      const existingUserByMobile = await this.prisma.user.findUnique({ where: { mobile } });
      if (existingUserByMobile) {
        this.logger.warn(`Registration attempt with existing mobile: ${mobile}`);
        throw new ConflictException('User with this mobile number already exists');
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      // Create user in identity service
      const user = await this.prisma.user.create({
        data: {
          name,
          mobile,
          email,
          password: hashedPassword,
        },
      });

      this.logger.log(`✅ User created in identity service: ${user.id}`);

      // Optional: send email verification if enabled and user has email
      if (user.email && this.emailVerificationEnabled) {
        await this.createAndSendVerificationToken(user.id, user.email, user.name);
      }

      // Create organization for the user (or assign to existing one)
      const organizationData = await this.createOrAssignOrganization(user, company || `${name}'s Organization`, { pan, location, pin }, subscriptionPlanId);

      const payload = {
        sub: user.id,
        email: user.email || user.mobile,
        organizationId: organizationData.organizationId
      };
      const token = this.jwtService.sign(payload);

      this.logger.log(`✅ User registered successfully: ${mobile} (User ID: ${user.id}, Org: ${organizationData.organizationId})`);

      const response = {
        user: {
          id: user.id,
          name: user.name,
          mobile: user.mobile,
          email: user.email,
          isActive: user.isActive,
          emailVerified: user.emailVerified ?? false,
          organizationId: organizationData.organizationId,
          organizationName: organizationData.organizationName,
          role: organizationData.role
        },
        token,
        message: 'Registration successful - Organization created',
        requiresEmailVerification: !!(user.email && this.emailVerificationEnabled),
      };
      
      // Log Registration
      try {
        await fetch(`${this.organizationServiceUrl}/audit-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
          body: JSON.stringify({
            organizationId: organizationData.organizationId || null,
            action: 'USER_REGISTER',
            performedBy: user.id,
            performedByType: 'USER',
            entityId: user.id,
            entityType: 'USER',
            ipAddress: ipAddress || null,
            metadata: { 
              userAgent: userAgent || null,
              email: user.email,
              mobile: user.mobile
            },
          })
        });
      } catch (auditErr) {
        this.logger.warn(`Failed to record registration audit log for user ${user.id}:`, auditErr);
      }
      
      return response;
    } catch (error) {
      this.logger.error(`Registration failed for ${mobile}:`, error);
      if (error instanceof ConflictException) throw error;
      throw new InternalServerErrorException('Failed to register user');
    }
  }

  private async createOrAssignOrganization(user: any, companyName: string, extraData: any, subscriptionPlanId?: string) {
    try {
      const organizationResponse = await fetch(`${this.organizationServiceUrl}/organizations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN,
        },
        body: JSON.stringify({
          name: companyName,
          email: user.email,
          phone: user.mobile,
          ownerUserId: user.id,
          pan: extraData.pan,
          address: extraData.location,
          pincode: extraData.pin
        })
      });

      if (!organizationResponse.ok) {
        throw new Error('Failed to create organization');
      }

      const orgData = await organizationResponse.json();
      const organization = orgData.data || orgData.organization;

      this.logger.log(`✅ Organization created: ${organization.id} for user: ${user.id}`);

      // Step 2: Initialize default roles for the organization
      const rolesResponse = await fetch(`${this.organizationServiceUrl}/organizations/${organization.id}/roles/initialize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id,
        }
      });

      if (!rolesResponse.ok) {
        this.logger.warn('Failed to initialize roles, but organization was created');
      }

      // Step 3: Get the OWNER role ID (using direct database query to avoid permission issues)
      const ownerRoleResponse = await fetch(`${this.organizationServiceUrl}/organizations/${organization.id}/roles/by-name/OWNER`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id } });
      let ownerRoleId = null;

      if (ownerRoleResponse.ok) {
        const roleData = await ownerRoleResponse.json();
        ownerRoleId = roleData.role?.id;
        this.logger.log(`✅ Found OWNER role: ${ownerRoleId}`);
      } else {
        this.logger.warn('Failed to get OWNER role, trying alternative method');
        // Fallback: try to get roles without permission check
        try {
          const fallbackResponse = await fetch(`${this.organizationServiceUrl}/organizations/${organization.id}/roles/permissions`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id } });
          if (fallbackResponse.ok) {
            this.logger.log('✅ Roles exist, will create user without specific role for now');
          }
        } catch (error) {
          this.logger.warn('Fallback role check failed:', error);
        }
      }

      // Step 4: Create organization user entry (link user to organization)
      if (ownerRoleId) {
        const orgUserResponse = await fetch(`${this.organizationServiceUrl}/organizations/${organization.id}/users`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id,
          },
          body: JSON.stringify({
            userId: user.id,
            roleId: ownerRoleId,
            invitedBy: null // Self-registration
          })
        });

        if (!orgUserResponse.ok) {
          this.logger.warn('Failed to create organization user, but organization was created');
        } else {
          this.logger.log(`✅ Organization user created for user: ${user.id} in org: ${organization.id} with OWNER role`);
        }
      } else {
        this.logger.warn('Could not find OWNER role, user not added to organization');
      }

      // Step 5: Assign Trial Plan (New default flow)
      if (!subscriptionPlanId) {
        try {
          this.logger.log(`Auto-assigning trial plan for organization: ${organization.id}`);
          const trialResponse = await fetch(`${this.subscriptionServiceUrl}/real-subscriptions/organizations/${organization.id}/assign-trial`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id,
            }
          });

          if (trialResponse.ok) {
            this.logger.log(`✅ Trial plan assigned for organization: ${organization.id}`);
          } else {
            const err = await trialResponse.text();
            this.logger.warn(`Failed to assign trial plan: ${err}`);
          }
        } catch (error) {
          this.logger.warn('Error assigning trial plan:', error);
        }
      } else {
        // Step 5 (Legacy): Create subscription only if user explicitly selected a plan at signup
        try {
          const subscriptionResponse = await fetch(`${this.subscriptionServiceUrl}/real-subscriptions/organizations/${organization.id}/subscribe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organization.id,
            },
            body: JSON.stringify({
              planId: subscriptionPlanId,
              userId: user.id
            })
          });

          if (subscriptionResponse.ok) {
            this.logger.log(`✅ Subscription created for organization: ${organization.id} with plan: ${subscriptionPlanId}`);
          } else {
            this.logger.warn('Failed to create subscription, but organization was created');
          }
        } catch (error) {
          this.logger.warn('Error creating subscription:', error);
        }
      }

      return {
        organizationId: organization.id,
        organizationName: organization.name,
        role: 'OWNER'
      };
    } catch (error) {
      this.logger.error('Failed to create organization:', error);
      // Fallback - still allow user creation without organization
      return {
        organizationId: null,
        organizationName: null,
        role: null
      };
    }
  }

  private generateInstanceId(): string {
    const characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let randomString = 'I';

    for (let i = 1; i < 10; i++) {
      randomString += characters.charAt(Math.floor(Math.random() * characters.length));
    }

    const randInt = Math.floor(Math.random() * 800) + 100;
    randomString += randInt;

    const currentTime = Math.floor(Date.now() / 1000);
    const lastSixDigits = currentTime.toString().slice(-6);
    randomString += lastSixDigits;

    return randomString;
  }

  async login(loginDto: LoginDto, ipAddress?: string, userAgent?: string) {
    const { username, password } = loginDto;
    try {
      if (!username || !password) throw new UnauthorizedException('Username/email and password are required');

      const isEmail = String(username).includes('@');
      let user;
      if (isEmail) {
        user = await this.prisma.user.findUnique({
          where: { email: username },
        });
      } else {
        user = await this.prisma.user.findUnique({
          where: { mobile: username },
        });
      }

      if (!user) {
        this.logger.warn(`Login attempt with non-existent ${isEmail ? 'email' : 'mobile'}: ${username}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      if (!user.isActive) {
        this.logger.warn(`Login attempt with inactive account: ${username}`);
        throw new UnauthorizedException('User deactivated. Please contact your organization to activate your account.');
      }

      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        this.logger.warn(`Login attempt with invalid password: ${username}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      // Require email verification when enabled and user has email
      if (user.email && !user.emailVerified && this.emailVerificationEnabled) {
        this.logger.warn(`Login blocked - email not verified: ${username}`);
        throw new UnauthorizedException(
          'Please verify your email before signing in. Check your inbox for the verification link, or use "Resend verification" after signing up again.',
        );
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() }
      });

      // Fetch user's organization
      let organizationId = null;
      let organizationStatus = null;
      try {
        const orgUserResponse = await fetch(`${this.organizationServiceUrl}/organizations/users/${user.id}/organizations`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN } });
        if (orgUserResponse.ok) {
          const orgData = await orgUserResponse.json();
          const orgList = orgData.data || orgData.organizations;

          if (!orgList || orgList.length === 0) {
            this.logger.warn(`⛔ Login blocked for user ${user.id} - No active organizations found`);
            throw new UnauthorizedException('User deactivated. Please contact your organization to activate your account.');
          }

          if (orgList && orgList.length > 0) {
            const firstOrg = orgList[0];
            organizationId = firstOrg.id || firstOrg.organizationId;
            this.logger.log(`✅ Found organization ${organizationId} for user ${user.id}`);

            const isActive = firstOrg.is_active ?? firstOrg.isActive ?? firstOrg.status === 'ACTIVE';
            this.logger.log(`🔍 Organization Status Check (Direct): ID=${organizationId}, isActive=${isActive}, status=${firstOrg.status}`);

            if (isActive === false || firstOrg.status === 'SUSPENDED' || firstOrg.status === 'INACTIVE') {
              this.logger.warn(`⛔ Login blocked for user ${user.id} - Organization ${organizationId} is suspended/inactive`);
              throw new UnauthorizedException('Your organization has been suspended. Please contact support for assistance.');
            }

            if (isActive === undefined) {
              this.logger.log(`⚠️ Status missing in firstOrg, performing fallback fetch for ${organizationId}`);
              const orgStatusResponse = await fetch(`${this.organizationServiceUrl}/organizations/${organizationId}`, { headers: { 'x-internal-token': process.env.INTERNAL_TOKEN || '', 'x-organization-id': organizationId } });
              if (orgStatusResponse.ok) {
                const orgDetails = await orgStatusResponse.json();
                // Handle nested structure: { data: { organization: { is_active: ... } } }
                const org = orgDetails.data?.organization || orgDetails.organization || orgDetails.data || orgDetails;
                organizationStatus = org?.is_active ?? org?.isActive;
                this.logger.log(`🔍 Organization Status Check (Fallback): ID=${organizationId}, status=${organizationStatus}`);

                if (organizationStatus === false) {
                  this.logger.warn(`⛔ Login blocked for user ${user.id} - Organization ${organizationId} is suspended`);
                  throw new UnauthorizedException('Your organization has been suspended. Please contact support for assistance.');
                }
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          throw error;
        }
        this.logger.warn(`Could not fetch organization for user ${user.id}:`, error);
      }

      const payload = {
        sub: user.id,
        email: user.email || user.mobile,
        organizationId: organizationId
      };
      const token = this.jwtService.sign(payload);

      const { password: _password, ...userWithoutPassword } = user;

      this.logger.log(`User logged in successfully: ${username}`);
      
      const sessionExpiration = this.configService.get<string>('JWT_EXPIRATION', '1d');
      const expiresInDays = parseInt(sessionExpiration.replace('d', '')) || 1;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiresInDays);

      await this.prisma.session.create({
        data: {
          token,
          userId: user.id,
          ipAddress: ipAddress || null,
          userAgent: userAgent || null,
          expiresAt,
        }
      });

      // Log login event to organization audit logs if organizationId is present
      if (organizationId) {
        try {
          await fetch(`${this.organizationServiceUrl}/audit-logs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
            body: JSON.stringify({
              organizationId,
              action: 'USER_LOGIN',
              performedBy: user.id,
              performedByType: 'USER',
              entityId: user.id,
              entityType: 'USER',
              ipAddress: ipAddress || null,
              metadata: { 
                method: isEmail ? 'email' : 'mobile',
                userAgent: userAgent || null
              },
            })
          });
        } catch (auditErr) {
          this.logger.warn(`Failed to record login audit log for user ${user.id}:`, auditErr);
        }
      }

      return {
        user: {
          ...userWithoutPassword,
          organizationId,
          emailVerified: user.emailVerified ?? false,
        },
        token,
        message: 'Login successful'
      };
    } catch (error) {
      this.logger.error(`Login failed:`, error);
      if (error instanceof UnauthorizedException) throw error;
      throw new InternalServerErrorException('Login failed');
    }
  }

  async logout(userId: string, token: string, organizationId?: string, ipAddress?: string, userAgent?: string) {
    try {
      // 1. Invalidate session
      if (token) {
        await this.prisma.session.deleteMany({
          where: { token, userId }
        });
      }

      // 2. Log audit event
      try {
        await fetch(`${this.organizationServiceUrl}/audit-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
          body: JSON.stringify({
            organizationId: organizationId || null,
            action: 'USER_LOGOUT',
            performedBy: userId,
            performedByType: 'USER',
            entityId: userId,
            entityType: 'USER',
            ipAddress: ipAddress || null,
            metadata: { userAgent: userAgent || null },
          })
        });
      } catch (auditErr) {
        this.logger.warn(`Failed to record logout audit log for user ${userId}:`, auditErr);
      }

      this.logger.log(`User logged out successfully: ${userId}`);
      return { message: 'Logged out successfully' };
    } catch (error) {
      this.logger.error(`Logout failed for user ${userId}:`, error);
      throw new InternalServerErrorException('Logout failed');
    }
  }

  async validateUser(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user || !user.isActive) return null;
      return user;
    } catch (error) {
      this.logger.error(`Failed to validate user ${userId}:`, error);
      return null;
    }
  }

  async changePassword(
    userId: string, 
    changePasswordDto: ChangePasswordDto, 
    organizationId?: string, 
    ipAddress?: string, 
    userAgent?: string
  ) {
    const { currentPassword, newPassword } = changePasswordDto;
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new UnauthorizedException('User not found');

      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
      if (!isCurrentPasswordValid) throw new UnauthorizedException('Invalid current password');

      const hashedNewPassword = await bcrypt.hash(newPassword, 12);
      await this.prisma.user.update({ where: { id: userId }, data: { password: hashedNewPassword } });
      this.logger.log(`Password changed successfully for user: ${userId}`);
      
      // Log Audit Event
      try {
        await fetch(`${this.organizationServiceUrl}/audit-logs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
          body: JSON.stringify({
            organizationId: organizationId || null,
            action: 'PASSWORD_CHANGE',
            performedBy: userId,
            performedByType: 'USER',
            entityId: userId,
            entityType: 'USER',
            ipAddress: ipAddress || null,
            metadata: { userAgent: userAgent || null },
          })
        });
      } catch (auditErr) {
        this.logger.warn(`Failed to record password change audit log for user ${userId}:`, auditErr);
      }
      
      return { message: 'Password changed successfully' };
    } catch (error) {
      this.logger.error(`Failed to change password for user ${userId}:`, error);
      if (error instanceof UnauthorizedException) throw error;
      throw new InternalServerErrorException('Failed to change password');
    }
  }

  async getUsersBatch(userIds: string[]) {
    try {
      const uniqueIds = [...new Set(userIds)].filter(Boolean);
      if (uniqueIds.length === 0) {
        return { success: true, users: [] };
      }

      const [users, superAdmins] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: uniqueIds } },
          select: {
            id: true,
            email: true,
            name: true,
            mobile: true,
            isActive: true,
            createdAt: true,
          },
        }),
        this.prisma.superAdmin.findMany({
          where: { id: { in: uniqueIds } },
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            createdAt: true,
          },
        }),
      ]);

      const superAdminAsUserShape = superAdmins.map((sa) => ({
        id: sa.id,
        email: sa.email,
        name: sa.name,
        mobile: null as string | null,
        isActive: sa.isActive,
        createdAt: sa.createdAt,
      }));

      const userById = new Map(users.map((u) => [u.id, u]));
      superAdminAsUserShape.forEach((u) => userById.set(u.id, u));
      const merged = uniqueIds.map((id) => userById.get(id)).filter(Boolean) as typeof users;

      return { success: true, users: merged };
    } catch (error) {
      this.logger.error('Failed to fetch batch users', error);
      throw new InternalServerErrorException('Failed to fetch users');
    }
  }

  async createAndSendVerificationToken(userId: string, email: string, userName?: string, organizationName?: string, roleName?: string): Promise<void> {
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFY_EXPIRY_HOURS * 60 * 60 * 1000);
    await this.prisma.emailVerificationToken.create({
      data: { userId, tokenHash, expiresAt, email },
    });
    const verifyUrl = `${this.frontendUrl.replace(/\/$/, '')}/verify-email?token=${rawToken}`;
    await this.sendEmailViaNotificationService({
      to: email,
      type: 'verify_email',
      data: { verifyUrl, userName: userName || 'User', organizationName: organizationName || '', roleName: roleName || '' },
    });
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string; code?: string }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const message = 'If an account exists with this email, you will receive a password reset link shortly.';
    if (!user) return { message };

    // Do not send reset link to unverified emails
    if (!user.emailVerified) {
      return {
        message: 'Your email is not verified yet. Please verify your email before resetting your password.',
        code: 'EMAIL_NOT_VERIFIED',
      };
    }

    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });
    const resetUrl = `${this.frontendUrl.replace(/\/$/, '')}/reset-password?token=${rawToken}`;
    await this.sendEmailViaNotificationService({
      to: user.email!,
      type: 'reset_password',
      data: { resetUrl, userName: user.name },
    });
    return { message };
  }

  async resetPassword(
    dto: ResetPasswordDto,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ message: string }> {
    const tokenHash = this.hashToken(dto.token);
    const record = await this.prisma.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired reset link. Please request a new one.');
    }
    const hashedPassword = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: { password: hashedPassword } }),
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    this.logger.log(`Password reset completed for user ${record.userId}`);
    
    // Log Audit Event
    try {
      await fetch(`${this.organizationServiceUrl}/audit-logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN },
        body: JSON.stringify({
          organizationId: null, // Don't have it easily here without another fetch
          action: 'PASSWORD_RESET',
          performedBy: record.userId,
          performedByType: 'USER',
          entityId: record.userId,
          entityType: 'USER',
          ipAddress: ipAddress || null,
          metadata: { userAgent: userAgent || null },
        })
      });
    } catch (auditErr) {
      this.logger.warn(`Failed to record password reset audit log for user ${record.userId}:`, auditErr);
    }

    return { message: 'Password has been reset. You can now sign in.' };
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<{ message: string }> {
    const tokenHash = this.hashToken(dto.token);
    const record = await this.prisma.emailVerificationToken.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      include: { user: true }
    });
    if (!record) {
      throw new BadRequestException('Invalid or expired verification link.');
    }

    const { user, email: tokenEmail } = record;
    const updateData: any = { emailVerified: true };
    
    // If token was for a specific email (like alternate), verify that one instead
    if (tokenEmail && tokenEmail === user.alternateEmail) {
      updateData.alternateEmailVerified = true;
      delete updateData.emailVerified;
    } else if (tokenEmail && tokenEmail !== user.email) {
      // Security check: if the email in the token doesn't match either current email, fail
      throw new BadRequestException('Verification link is no longer valid for this email.');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: record.userId }, data: updateData }),
      this.prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    
    this.logger.log(`Email verified (${tokenEmail || 'primary'}) for user ${record.userId}`);
    return { message: 'Email verified successfully. You can now sign in.' };
  }

  async getNotificationPreferences(userId: string) {
    const prefs = await this.prisma.userNotificationPreferences.findUnique({
      where: { userId },
    });
    return {
      accountActivity: prefs?.accountActivity ?? true,
      securityAlerts: prefs?.securityAlerts ?? true,
      marketing: prefs?.marketing ?? false,
    };
  }

  async updateNotificationPreferences(
    userId: string,
    data: { accountActivity?: boolean; securityAlerts?: boolean; marketing?: boolean },
  ) {
    await this.prisma.userNotificationPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    return this.getNotificationPreferences(userId);
  }

  async resendVerificationEmail(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.email) throw new BadRequestException('No email to verify.');
    if (user.emailVerified) throw new BadRequestException('Email is already verified.');
    await this.createAndSendVerificationToken(user.id, user.email, user.name);
    return { message: 'Verification email sent. Please check your inbox.' };
  }

  async resendAlternateVerificationEmail(userId: string, alternateEmail: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    
    if (!user.alternateEmail || user.alternateEmail !== alternateEmail) {
      throw new BadRequestException('Alternate email does not match user record.');
    }
    
    if (user.alternateEmailVerified) {
      throw new BadRequestException('Alternate email is already verified.');
    }

    await this.createAndSendVerificationToken(user.id, alternateEmail, user.name);
    return { message: 'Verification email sent to your alternate address. Please check your inbox.' };
  }

  private readonly resendVerificationCooldownMs = 60_000; // 60s
  private readonly resendVerificationLastSent = new Map<string, number>();

  /**
   * Public: resend verification email by email address.
   * Rate limited (once per 60s per email). Does not reveal whether the email exists or is already verified.
   */
  async resendVerificationEmailByEmail(email: string): Promise<{ message: string }> {
    const generic = 'If an account exists with this email and is not verified, a verification link will be sent shortly.';
    if (!email) return { message: generic };

    const now = Date.now();
    const last = this.resendVerificationLastSent.get(email.toLowerCase());
    if (last != null && now - last < this.resendVerificationCooldownMs) {
      return { message: generic };
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user?.email && !user.emailVerified && user.isActive !== false) {
      await this.createAndSendVerificationToken(user.id, user.email, user.name);
      this.resendVerificationLastSent.set(email.toLowerCase(), now);
    }

    return { message: generic };
  }

  async inviteUser(data: { email: string; firstName: string; lastName: string; invitedBy?: string; password?: string; organizationName?: string; roleName?: string }) {
    try {
      // Check if user exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email: data.email }
      });

      if (existingUser) {
        return {
          success: true,
          isNewUser: false,
          user: {
            id: existingUser.id,
            email: existingUser.email,
            name: existingUser.name,
            isActive: existingUser.isActive
          }
        };
      }

      // Create new user (Simulated invite flow)
      // Note: Using a temp mobile number because schema requires unique mobile
      // Scheme: matches 15 char limit. IMPT: mobile is varchar(15)
      const uniqueSuffix = Date.now().toString().slice(-8); // Last 8 digits of timestamp
      const passwordToHash = data.password || `Temp@${uniqueSuffix}`;
      const newUser = await this.prisma.user.create({
        data: {
          email: data.email,
          name: `${data.firstName} ${data.lastName}`.trim(),
          mobile: `INV-${uniqueSuffix}`, // Format: INV-12345678 (12 chars)
          password: await bcrypt.hash(passwordToHash, 10),
          emailVerified: false,
          isActive: true
        }
      });

      this.logger.log(`✅ Invited new user: ${data.email} -> ${newUser.id}`);

      // Send verification email
      await this.createAndSendVerificationToken(newUser.id, newUser.email, newUser.name, data.organizationName, data.roleName);

      return {
        success: true,
        isNewUser: true,
        user: {
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
          isActive: newUser.isActive
        }
      };
    } catch (error) {
      this.logger.error('Failed to invite user', error);
      throw new InternalServerErrorException('Failed to invite user');
    }
  }
}
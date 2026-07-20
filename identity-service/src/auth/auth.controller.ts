import { Controller, Post, Get, Put, Body, HttpCode, HttpStatus, UseGuards, Request, Ip, Headers } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiUnauthorizedResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto, VerifyEmailDto } from './dto/auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) { }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new merchant account',
    description:
      'Creates a new merchant account with email, password, and optional business details. Returns user data and JWT token.',
  })
  @ApiBody({
    type: RegisterDto,
    description: 'Merchant registration data',
    examples: {
      'valid-registration': {
        summary: 'Valid Registration',
        description: 'Complete registration with all fields',
        value: {
          email: 'merchant@example.com',
          password: 'securePassword123',
          businessName: 'GreenTech Solutions',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
        },
      },
      'minimal-registration': {
        summary: 'Minimal Registration',
        description: 'Registration with only required fields',
        value: {
          email: 'merchant@example.com',
          password: 'securePassword123',
        },
      },
      'invalid-email': {
        summary: 'Invalid Email',
        description: 'Registration with invalid email format',
        value: {
          email: 'invalid-email',
          password: 'securePassword123',
        },
      },
      'short-password': {
        summary: 'Short Password',
        description: 'Registration with password too short',
        value: {
          email: 'merchant@example.com',
          password: '123',
        },
      },
      'empty-fields': {
        summary: 'Empty Fields',
        description: 'Registration with missing required fields',
        value: {
          email: '',
          password: '',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'User registered successfully',
    schema: {
      example: {
        user: {
          id: 'cmgm83v7a0000rj3524b29zgo',
          email: 'merchant@example.com',
          businessName: 'GreenTech Solutions',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
          userToken: 'GP_okh0qw3dakg_mgm83v7a',
          apiKey: 'gp_turgcxhviiq_mgm83v7a',
          webhookSecret: 'wh_m2y9zh1no2q_mgm83v7a',
          role: 'MERCHANT',
          status: 'ACTIVE',
          planType: 'FREE',
          isActive: true,
          createdAt: '2025-10-11T12:00:00.695Z',
        },
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        message: 'User registered successfully',
      },
    },
  })
  @ApiConflictResponse({
    description: 'User with this email already exists',
    schema: {
      example: {
        statusCode: 409,
        error: 'Conflict',
        message: 'User with this email already exists',
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/register',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid input data or validation errors',
    schema: {
      example: {
        statusCode: 400,
        error: 'Bad Request',
        message: [
          'email must be an email',
          'password must be longer than or equal to 6 characters',
        ],
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/register',
      },
    },
  })
  async register(
    @Body() registerDto: RegisterDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.register(registerDto, ipAddress, userAgent);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login merchant account',
    description:
      'Authenticates merchant with email and password. Returns user data and JWT token.',
  })
  @ApiBody({
    type: LoginDto,
    description: 'Merchant login credentials',
    examples: {
      'valid-login': {
        summary: 'Valid Login',
        description: 'Login with correct credentials',
        value: {
          email: 'merchant@example.com',
          password: 'securePassword123',
        },
      },
      'invalid-password': {
        summary: 'Invalid Password',
        description: 'Login with wrong password',
        value: {
          email: 'merchant@example.com',
          password: 'wrongpassword',
        },
      },
      'non-existent-user': {
        summary: 'Non-existent User',
        description: 'Login with email that does not exist',
        value: {
          email: 'nonexistent@example.com',
          password: 'securePassword123',
        },
      },
      'invalid-email': {
        summary: 'Invalid Email Format',
        description: 'Login with invalid email format',
        value: {
          email: 'invalid-email',
          password: 'securePassword123',
        },
      },
      'empty-credentials': {
        summary: 'Empty Credentials',
        description: 'Login with empty email and password',
        value: {
          email: '',
          password: '',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    schema: {
      example: {
        user: {
          id: 'cmgm83v7a0000rj3524b29zgo',
          email: 'merchant@example.com',
          businessName: 'GreenTech Solutions',
          firstName: 'John',
          lastName: 'Doe',
          phone: '+1234567890',
          userToken: 'GP_okh0qw3dakg_mgm83v7a',
          apiKey: 'gp_turgcxhviiq_mgm83v7a',
          webhookSecret: 'wh_m2y9zh1no2q_mgm83v7a',
          role: 'MERCHANT',
          status: 'ACTIVE',
          planType: 'FREE',
          isActive: true,
          createdAt: '2025-10-11T12:00:00.695Z',
          lastLoginAt: '2025-10-11T12:00:03.057Z',
        },
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        message: 'Login successful',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials or user not found',
    schema: {
      example: {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid credentials',
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/login',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid input data or validation errors',
    schema: {
      example: {
        statusCode: 400,
        error: 'Bad Request',
        message: ['email must be an email', 'password should not be empty'],
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/login',
      },
    },
  })
  async login(
    @Body() loginDto: LoginDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.login(loginDto, ipAddress, userAgent);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout merchant account' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  async logout(
    @Request() req: any,
    @Headers('x-user-id') userId: string,
    @Headers('x-organization-id') organizationId: string,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    // If the API gateway stripped the auth header, the token won't be on req.
    // We rely on x-user-id from API Gateway.
    const uid = userId || (req.user && req.user.sub);
    const authHeader = req.headers.authorization;
    let token = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
    
    if (uid) {
      return this.authService.logout(uid, token, organizationId, ipAddress, userAgent);
    }
    
    return { message: 'Logged out successfully' };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change user password',
    description: 'Changes the password for the authenticated user. Requires current password verification.',
  })
  @ApiBody({
    type: ChangePasswordDto,
    description: 'Password change data',
    examples: {
      'valid-change': {
        summary: 'Valid Password Change',
        description: 'Change password with correct current password',
        value: {
          currentPassword: 'currentPassword123',
          newPassword: 'newPassword123',
        },
      },
      'short-new-password': {
        summary: 'Short New Password',
        description: 'Attempt to set password shorter than 6 characters',
        value: {
          currentPassword: 'currentPassword123',
          newPassword: '123',
        },
      },
      'wrong-current-password': {
        summary: 'Wrong Current Password',
        description: 'Attempt to change password with incorrect current password',
        value: {
          currentPassword: 'wrongPassword',
          newPassword: 'newPassword123',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Password changed successfully',
    schema: {
      example: {
        message: 'Password changed successfully',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid current password or unauthorized',
    schema: {
      example: {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid current password',
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/change-password',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid input data or validation errors',
    schema: {
      example: {
        statusCode: 400,
        error: 'Bad Request',
        message: ['newPassword must be longer than or equal to 6 characters'],
        timestamp: '2025-10-11T12:00:00.000Z',
        path: '/api/v1/auth/change-password',
      },
    },
  })
  async changePassword(
    @Request() req: any,
    @Body() changePasswordDto: ChangePasswordDto,
    @Headers('x-organization-id') organizationId: string,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.changePassword(req.user.sub, changePasswordDto, organizationId, ipAddress, userAgent);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  @ApiResponse({ status: 200, description: 'If the email exists, a reset link is sent. Same message either way.' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token from email' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiBadRequestResponse({ description: 'Invalid or expired token' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Ip() ipAddress: string,
    @Headers('user-agent') userAgent: string,
  ) {
    return this.authService.resetPassword(dto, ipAddress, userAgent);
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with token from email' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiBadRequestResponse({ description: 'Invalid or expired token' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
  }

  @Get('notification-preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get email notification preferences' })
  async getNotificationPreferences(@Request() req: any) {
    return this.authService.getNotificationPreferences(req.user.sub);
  }

  @Put('notification-preferences')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update email notification preferences' })
  async updateNotificationPreferences(
    @Request() req: any,
    @Body() body: { accountActivity?: boolean; securityAlerts?: boolean; marketing?: boolean },
  ) {
    return this.authService.updateNotificationPreferences(req.user.sub, body);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend verification email' })
  async resendVerification(@Request() req: any) {
    return this.authService.resendVerificationEmail(req.user.sub);
  }

  @Post('resend-alternate-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resend verification email for alternate email address' })
  async resendAlternateVerification(@Request() req: any, @Body() body: { email: string }) {
    return this.authService.resendAlternateVerificationEmail(req.user.sub, body.email);
  }

  @Post('resend-verification-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Public: resend verification email by email address' })
  @ApiResponse({
    status: 200,
    description: 'If an account exists and is not verified, a verification email will be (re)sent. Same message either way.',
  })
  async resendVerificationByEmail(@Body() body: { email: string }) {
    return this.authService.resendVerificationEmailByEmail(body.email);
  }

  @Post('push-subscribe')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register PWA push subscription' })
  @ApiResponse({ status: 200, description: 'Subscription registered' })
  async pushSubscribe(
    @Request() req: any,
    @Body() body: { organizationId: string; subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null } },
  ) {
    if (!body?.organizationId || !body?.subscription?.endpoint || !body?.subscription?.keys) {
      return { success: false, error: 'Missing organizationId or subscription' };
    }
    return this.authService.registerPushSubscription(req.user.sub, body.organizationId, body.subscription);
  }

  @Post('internal/users/batch')
  @ApiOperation({ summary: 'Internal: Get users by batch IDs' })
  async getUsersBatch(@Body() body: { userIds: string[] }) {
    return this.authService.getUsersBatch(body.userIds);
  }

  @Post('internal/users/invite')
  @ApiOperation({ summary: 'Internal: Invite/Create user' })
async inviteUser(@Body() body: { email: string; firstName: string; lastName: string; invitedBy?: string; password?: string; organizationName?: string; roleName?: string }) {    return this.authService.inviteUser(body);
  }
}

import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  Matches,
  IsBoolean,
  Length,
  MaxLength
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({
    example: 'John Doe',
    description: 'Full name of the user',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    example: '9876543210',
    description: 'Mobile number (10 digits, Indian format)',
  })
  @IsString()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'Mobile number must be 10 digits starting with 6-9',
  })
  mobile!: string;

  @ApiProperty({
    example: 'user@example.com',
    description: 'Valid email address (optional)',
    required: false,
    format: 'email',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({
    example: 'securePassword123',
    description: 'Password must be at least 6 characters long',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiProperty({
    example: 'ABC Corp',
    description: 'Company name (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  company?: string;

  @ApiProperty({
    example: 'ABCDE1234F',
    description: 'PAN number (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, {
    message: 'PAN must be in format ABCDE1234F',
  })
  pan?: string;

  @ApiProperty({
    example: '123456789012',
    description: 'Aadhaar number (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Length(12, 12, { message: 'Aadhaar must be 12 digits' })
  @Matches(/^\d{12}$/, { message: 'Aadhaar must contain only digits' })
  aadhaar?: string;

  @ApiProperty({
    example: 'Mumbai, Maharashtra',
    description: 'Location/Address (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiProperty({
    example: '400001',
    description: 'PIN code (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'PIN must be 6 digits' })
  pin?: string;

  @ApiProperty({
    example: 'SPONSOR123',
    description: 'Sponsor ID (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sponsorId?: string;

  @ApiProperty({
    example: true,
    description: 'Terms and conditions acceptance',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;

  @ApiProperty({
    example: 'ecc27bb7-1f75-4970-86e9-8dd058219287',
    description: 'Selected subscription plan ID (optional)',
    required: false,
  })
  @IsOptional()
  @IsString()
  subscriptionPlanId?: string;
}

export class LoginDto {
  @ApiProperty({
    example: '9876543210',
    description: 'Mobile number or email address',
  })
  @IsString()
  username!: string;

  @ApiProperty({
    example: 'securePassword123',
    description: 'Account password',
  })
  @IsString()
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty({
    example: 'currentPassword123',
    description: 'Current password',
  })
  @IsString()
  currentPassword!: string;

  @ApiProperty({
    example: 'newPassword123',
    description: 'New password must be at least 6 characters long',
    minLength: 6,
  })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com', description: 'Registered email' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token from reset email link' })
  @IsString()
  token!: string;

  @ApiProperty({ example: 'newPassword123', description: 'New password', minLength: 6 })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from verification email' })
  @IsString()
  token!: string;
}

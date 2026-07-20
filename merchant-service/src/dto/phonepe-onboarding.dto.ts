import {
  IsString,
  IsNotEmpty,
  Matches,
  Length,
  ValidateNested,
  IsObject,
  IsOptional,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class DeviceDataDto {
  @ApiProperty({
    description: "Platform type",
    example: "ANDROID",
    enum: ["ANDROID", "IOS", "WEB"],
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(ANDROID|IOS|WEB)$/)
  platform!: string;

  @ApiProperty({
    description: "Device version/OS version",
    example: "11",
  })
  @IsString()
  @IsNotEmpty()
  version!: string;

  @ApiProperty({
    description: "Unique device identifier",
    example: "abc123xyz-device",
  })
  @IsString()
  @IsNotEmpty()
  fingerprint!: string;

  @ApiProperty({
    description: "IP Address",
    example: "192.168.1.1",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)
  ip!: string;
}

export class SendOtpDto {
  @ApiProperty({
    description: "Phone number for OTP verification",
    example: "9876543210",
    pattern: "^[6-9]\\d{9}$",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[6-9]\d{9}$/, {
    message:
      "Phone number must be a valid 10-digit Indian mobile number starting with 6-9",
  })
  phoneNumber!: string;

  @ApiPropertyOptional({
    description: "Device information",
    type: DeviceDataDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDataDto)
  deviceData?: DeviceDataDto;
}

export class VerifyOtpDto {
  @ApiProperty({
    description: "Phone number for verification",
    example: "9876543210",
    pattern: "^[6-9]\\d{9}$",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[6-9]\d{9}$/, {
    message:
      "Phone number must be a valid 10-digit Indian mobile number starting with 6-9",
  })
  phoneNumber!: string;

  @ApiProperty({
    description: "OTP received on phone",
    example: "123456",
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: "OTP must be exactly 6 digits" })
  @Matches(/^\d{6}$/, { message: "OTP must contain only digits" })
  otp!: string;

  @ApiProperty({
    description: "Token received during OTP sending",
    example: "abc123xyz-token",
  })
  @IsString()
  @IsNotEmpty()
  otpToken!: string;

  @ApiProperty({
    description: "Unique device fingerprint",
    example: "abc123xyz-device",
  })
  @IsString()
  @IsNotEmpty()
  deviceFingerprint!: string;

  @ApiPropertyOptional({
    description: "Device information",
    type: DeviceDataDto,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDataDto)
  deviceData?: DeviceDataDto;
}

export class PhonePeUserInfoDto {
  @ApiProperty({
    description: "User name from PhonePe",
    example: "John Doe",
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    description: "PhonePe user ID",
    example: "PHONEPE123",
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;
}

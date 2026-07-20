import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class OperatingSlot {
  @IsString()
  open: string;

  @IsString()
  close: string;
}

export class MerchantConfigDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  businessName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  pincode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  pan?: string;

  @ApiProperty()
  @IsOptional()
  @IsString()
  openTime: string; // Made optional to avoid strict failures if partial update, but verify uses it

  @ApiProperty()
  @IsOptional()
  @IsString()
  closeTime: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  operatingSlots?: Array<{ open: string; close: string }>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsArray()
  weeklyHolidays?: number[];

  @ApiProperty()
  @IsOptional()
  @IsNumber()
  dailyMaxAmount: number;

  @ApiProperty()
  @IsOptional()
  @IsNumber()
  dailyMaxTxnCount: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  dailyMinAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  dailyMinTxnCount?: number;

  @ApiProperty()
  @IsOptional()
  @IsNumber()
  monthlyMaxAmount: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  monthlyMaxTxnCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  monthlyMinAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  monthlyMinTxnCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  minTxnAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  maxTxnAmount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  perMinuteMaxTxn?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isFallback?: boolean;
}

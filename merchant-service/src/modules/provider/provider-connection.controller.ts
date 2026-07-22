import { Controller, Post, Get, Delete, Body, Param, Headers, Ip } from "@nestjs/common";
import { logAuditActivity } from "../../utils/audit.util";
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from "@nestjs/swagger";
import { ProviderConnectionService } from "./provider-connection.service";
import { MerchantService } from "../merchant/merchant.service";

@ApiTags("Provider Connections")
@Controller("merchants/:merchantId/providers")
export class ProviderConnectionController {
  constructor(private readonly providerService: ProviderConnectionService, private readonly merchantService: MerchantService) {}

  @Post("phonepe/send-otp")
  @ApiOperation({
    summary: "Send OTP for PhonePe connection",
    description: "Send OTP to PhonePe registered mobile number",
  })
  @ApiResponse({ status: 200, description: "OTP sent successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async sendPhonePeOtp(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
    },
    @Headers("x-organization-id") organizationId?: string,
  ) {
    if (body.phoneNumber && organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.phoneNumber, "PHONEPE", organizationId);
    }
    return this.providerService.sendPhonePeOtp(merchantId, body.phoneNumber);
  }

  @Post("phonepe/verify-otp")
  @ApiOperation({
    summary: "Verify OTP and connect PhonePe",
    description: "Verify OTP and connect PhonePe account to merchant",
  })
  @ApiResponse({ status: 201, description: "PhonePe connected successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async connectPhonePe(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
      otp: string;
      otpToken: string;
      deviceFingerprint: string;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("x-organization-id") organizationId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.providerService.connectPhonePe(merchantId, body);
    if (userId && organizationId) {
      await logAuditActivity("PROVIDER_CONNECTED", merchantId, "MERCHANT", userId, userType || "USER", organizationId, ipAddress, userAgent, { providerType: "PhonePe" });
    }
    return result;
  }

  @Post("gpay/connect")
  @ApiOperation({
    summary: "Connect GPay to merchant",
    description: "Connect GPay Business account using Puppeteer automation",
  })
  @ApiResponse({ status: 201, description: "GPay connected successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async connectGPay(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      email: string;
      businessId: string;
      sessionData: any;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("x-organization-id") organizationId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    if (body.email && organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.email, "GPAY", organizationId);
    }
    const result = await this.providerService.connectGPay(merchantId, body);
    if (userId && organizationId) {
      await logAuditActivity("PROVIDER_CONNECTED", merchantId, "MERCHANT", userId, userType || "USER", organizationId, ipAddress, userAgent, { providerType: "GPay" });
    }
    return result;
  }

  @Post("paytm/send-otp")
  @ApiOperation({
    summary: "Send OTP for Paytm connection",
    description: "Send OTP to Paytm account using credentials",
  })
  @ApiResponse({ status: 200, description: "OTP sent successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async sendPaytmOtp(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      username: string;
      password: string;
    },
    @Headers("x-organization-id") organizationId?: string,
  ) {
    if (body.username && organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.username, "PAYTM", organizationId);
    }
    return this.providerService.sendPaytmOtp(
      merchantId,
      body.username,
      body.password,
    );
  }

  @Post("paytm/verify-otp")
  @ApiOperation({
    summary: "Verify OTP and connect Paytm",
    description: "Verify OTP and connect Paytm account to merchant",
  })
  @ApiResponse({ status: 201, description: "Paytm connected successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async connectPaytm(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      username: string;
      password: string;
      otp: string;
      sessionId: string;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("x-organization-id") organizationId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.providerService.connectPaytm(merchantId, body);
    if (userId && organizationId) {
      await logAuditActivity("PROVIDER_CONNECTED", merchantId, "MERCHANT", userId, userType || "USER", organizationId, ipAddress, userAgent, { providerType: "Paytm" });
    }
    return result;
  }

  @Post("quintus/send-otp")
  @ApiOperation({
    summary: "Send OTP for QuintusPay connection",
    description: "Send OTP to QuintusPay registered mobile number",
  })
  @ApiResponse({ status: 200, description: "OTP sent successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async sendQuintusOtp(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
    },
    @Headers("x-organization-id") organizationId?: string,
  ) {
    if (body.phoneNumber && organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.phoneNumber, "QUINTUS", organizationId);
    }
    return this.providerService.sendQuintusOtp(merchantId, body.phoneNumber);
  }

  @Post("quintus/verify-otp")
  @ApiOperation({
    summary: "Verify OTP and connect QuintusPay",
    description: "Verify OTP and connect QuintusPay account to merchant",
  })
  @ApiResponse({ status: 201, description: "QuintusPay connected successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async connectQuintus(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
      otp: string;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("x-organization-id") organizationId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.providerService.connectQuintus(merchantId, body);
    if (userId && organizationId) {
      await logAuditActivity("PROVIDER_CONNECTED", merchantId, "MERCHANT", userId, userType || "USER", organizationId, ipAddress, userAgent, { providerType: "QuintusPay" });
    }
    return result;
  }

  @Post("hdfc/send-otp")
  @ApiOperation({
    summary: "Send OTP for HDFC SmartHub Vyapar connection",
    description: "Send OTP to HDFC SmartHub Vyapar registered mobile number",
  })
  @ApiResponse({ status: 200, description: "OTP sent successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async sendHdfcOtp(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
    },
    @Headers("x-organization-id") organizationId?: string,
  ) {
    if (body.phoneNumber && organizationId) {
      await this.merchantService.validateDuplicateMerchantConnection(body.phoneNumber, "HDFC", organizationId);
    }
    return this.providerService.sendHdfcOtp(merchantId, body.phoneNumber);
  }

  @Post("hdfc/verify-otp")
  @ApiOperation({
    summary: "Verify OTP and connect HDFC SmartHub Vyapar",
    description: "Verify OTP and connect HDFC SmartHub Vyapar account to merchant",
  })
  @ApiResponse({ status: 201, description: "HDFC connected successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async connectHdfc(
    @Param("merchantId") merchantId: string,
    @Body()
    body: {
      phoneNumber: string;
      otp: string;
      sessionId: string;
      deviceId: string;
    },
    @Headers("x-user-type") userType?: string,
    @Headers("x-user-id") userId?: string,
    @Headers("x-organization-id") organizationId?: string,
    @Headers("user-agent") userAgent?: string,
    @Ip() ipAddress?: string,
  ) {
    const result = await this.providerService.connectHdfc(merchantId, body);
    if (userId && organizationId) {
      await logAuditActivity("PROVIDER_CONNECTED", merchantId, "MERCHANT", userId, userType || "USER", organizationId, ipAddress, userAgent, { providerType: "HDFC" });
    }
    return result;
  }

  @Get()
  @ApiOperation({
    summary: "Get connected providers",
    description: "Get all connected payment providers for merchant",
  })
  @ApiResponse({ status: 200, description: "Connected providers retrieved" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  async getConnectedProviders(@Param("merchantId") merchantId: string) {
    return this.providerService.getConnectedProviders(merchantId);
  }

  @Delete(":providerId")
  @ApiOperation({
    summary: "Disconnect provider",
    description: "Disconnect a payment provider from merchant",
  })
  @ApiResponse({
    status: 200,
    description: "Provider disconnected successfully",
  })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  @ApiParam({ name: "providerId", description: "Provider Connection ID" })
  async disconnectProvider(
    @Param("merchantId") merchantId: string,
    @Param("providerId") providerId: string,
  ) {
    return this.providerService.disconnectProvider(merchantId, providerId);
  }

  @Post(":providerId/update")
  @ApiOperation({
    summary: "Update provider details",
    description: "Update provider details manually (e.g., UPI ID)",
  })
  @ApiResponse({ status: 200, description: "Provider updated successfully" })
  @ApiParam({ name: "merchantId", description: "Merchant ID" })
  @ApiParam({ name: "providerId", description: "Provider Connection ID" })
  async updateProvider(
    @Param("merchantId") merchantId: string,
    @Param("providerId") providerId: string,
    @Body()
    body: {
      accountIdentifier?: string;
    },
  ) {
    return this.providerService.updateProvider(merchantId, providerId, body);
  }
}

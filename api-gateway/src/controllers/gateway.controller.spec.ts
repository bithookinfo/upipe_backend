import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { GatewayController } from "./gateway.controller";
import axios from "axios";
import { Request, Response } from "express";

jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe("GatewayController", () => {
  let controller: GatewayController;
  let configService: jest.Mocked<ConfigService>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(async () => {
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        const config: Record<string, string> = {
          MERCHANT_SERVICE_URL: "http://localhost:4002",
          PAYMENT_SERVICE_URL: "http://localhost:4003",
          GPAY_SERVICE_URL: "http://localhost:4007",
          GPAY_SERVICE_ENABLED: "false",
          INTERNAL_TOKEN: "gateway-secret-token",
          JWT_SECRET: "jwt-secret",
        };
        return config[key];
      }),
    } as unknown as jest.Mocked<ConfigService>;

    jwtService = {
      verify: jest.fn().mockReturnValue({
        sub: "user-123",
        organizationId: "org-456",
        userType: "MERCHANT_USER",
        role: "ADMIN",
      }),
    } as unknown as jest.Mocked<JwtService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [
        { provide: ConfigService, useValue: configService },
        { provide: JwtService, useValue: jwtService },
      ],
    }).compile();

    controller = module.get<GatewayController>(GatewayController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Route Matching & GPAY_SERVICE_ENABLED flag", () => {
    it("should route GPay endpoints to MERCHANT_SERVICE_URL when GPAY_SERVICE_ENABLED is false", () => {
      const getUrl = (controller as any).getServiceUrl.bind(controller);
      expect(getUrl("/api/v1/gateway/prov_123/connect-gpay")).toBe(
        "http://localhost:4002",
      );
      expect(getUrl("/api/v1/gateway/prov_123/update-gpay-upi")).toBe(
        "http://localhost:4002",
      );
      expect(getUrl("/api/v1/gateway/gpay/metrics")).toBe(
        "http://localhost:4002",
      );
    });

    it("should route GPay endpoints to MERCHANT_SERVICE_URL even when GPAY_SERVICE_ENABLED is true (direct gateway routing disabled during coexistence)", () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "GPAY_SERVICE_ENABLED") return "true";
        if (key === "GPAY_SERVICE_URL") return "http://localhost:4007";
        if (key === "MERCHANT_SERVICE_URL") return "http://localhost:4002";
        return undefined;
      });

      const getUrl = (controller as any).getServiceUrl.bind(controller);
      expect(getUrl("/api/v1/gateway/prov_123/connect-gpay")).toBe(
        "http://localhost:4002",
      );
      expect(getUrl("/api/v1/gateway/prov_123/update-gpay-upi")).toBe(
        "http://localhost:4002",
      );
      expect(getUrl("/api/v1/gateway/gpay/metrics")).toBe(
        "http://localhost:4002",
      );
    });

    it("should route non-GPay endpoints normally regardless of GPAY_SERVICE_ENABLED", () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "GPAY_SERVICE_ENABLED") return "true";
        if (key === "PAYMENT_SERVICE_URL") return "http://localhost:4003";
        if (key === "MERCHANT_SERVICE_URL") return "http://localhost:4002";
        return undefined;
      });

      const getUrl = (controller as any).getServiceUrl.bind(controller);
      expect(getUrl("/api/v1/orders")).toBe("http://localhost:4003");
      expect(getUrl("/api/v1/merchants")).toBe("http://localhost:4002");
    });
  });

  describe("Trusted Header Handling & Sanitization", () => {
    it("should strip client identity headers and inject server-verified claims and internal token", async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: { success: true },
      });

      const req = {
        method: "GET",
        path: "/api/v1/gateway/prov_123/connect-gpay",
        url: "/api/v1/gateway/prov_123/connect-gpay",
        headers: {
          authorization: "Bearer valid-jwt",
          "x-internal-token": "client-fake-token",
          "x-user-id": "client-fake-user",
          "x-organization-id": "client-fake-org",
          "x-user-role": "client-fake-role",
          "x-user-type": "client-fake-type",
          "custom-header": "keep-me",
        },
        body: {},
        query: {},
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;

      await controller.proxyRequest(req, res);

      expect(mockedAxios).toHaveBeenCalledTimes(1);
      const callArgs = mockedAxios.mock.calls[0][0] as any;
      const headers = callArgs.headers;

      // Verify client-supplied values were overwritten/stripped
      expect(headers["custom-header"]).toBe("keep-me");
      expect(headers["x-user-id"]).toBe("user-123");
      expect(headers["x-organization-id"]).toBe("org-456");
      expect(headers["x-user-type"]).toBe("MERCHANT_USER");
      expect(headers["x-user-role"]).toBe("ADMIN");
      expect(headers["x-internal-token"]).toBe("gateway-secret-token");
    });
  });
});

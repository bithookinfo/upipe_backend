import { All, Controller, Req, Res, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Request, Response } from "express";
import axios from "axios";

@Controller()
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {}

  private getServiceUrl(path: string): string | null {
    // Ensure all /auth/* (login, register, resend-verification-email, forgot-password, etc.) go to identity
    if (path.includes("/auth")) {
      const url = this.configService.get("IDENTITY_SERVICE_URL");
      if (url) return url;
    }
    /**
     * Notifications routing:
     * - /api/v1/notifications/... -> notification service
     * - /api/v1/dashboard/notifications/... -> payment service (handled below via "dashboard" route key)
     */
    if (
      path.startsWith("/api/v1/notifications") ||
      path.startsWith("/notifications")
    ) {
      const url = this.configService.get("NOTIFICATION_SERVICE_URL");
      if (url) return url;
    }

    const routes: Record<string, string> = {
      auth: this.configService.get("IDENTITY_SERVICE_URL"),
      "super-admins": this.configService.get("IDENTITY_SERVICE_URL"),
      "admin-roles": this.configService.get("IDENTITY_SERVICE_URL"),
      users: this.configService.get("IDENTITY_SERVICE_URL"),
      platform: this.configService.get("IDENTITY_SERVICE_URL"),
      audit: this.configService.get("IDENTITY_SERVICE_URL"),
      translations: this.configService.get("IDENTITY_SERVICE_URL"),

      merchants: this.configService.get("MERCHANT_SERVICE_URL"),
      merchant: this.configService.get("MERCHANT_SERVICE_URL"),
      "business-categories": this.configService.get("MERCHANT_SERVICE_URL"),
      gateway: this.configService.get("MERCHANT_SERVICE_URL"),
      "config-templates": this.configService.get("MERCHANT_SERVICE_URL"),
      routing: this.configService.get("MERCHANT_SERVICE_URL"),

      orders: this.configService.get("PAYMENT_SERVICE_URL"),
      transactions: this.configService.get("PAYMENT_SERVICE_URL"),
      payments: this.configService.get("PAYMENT_SERVICE_URL"),
      payment: this.configService.get("PAYMENT_SERVICE_URL"),
      links: this.configService.get("PAYMENT_SERVICE_URL"),
      dashboard: this.configService.get("PAYMENT_SERVICE_URL"),
      webhooks: this.configService.get("PAYMENT_SERVICE_URL"),
      providers: this.configService.get("PAYMENT_SERVICE_URL"),
      sse: this.configService.get("PAYMENT_SERVICE_URL"),
      stats: this.configService.get("PAYMENT_SERVICE_URL"),

      plans: this.configService.get("SUBSCRIPTION_SERVICE_URL"),
      subscriptions: this.configService.get("SUBSCRIPTION_SERVICE_URL"),
      "real-subscriptions": this.configService.get("SUBSCRIPTION_SERVICE_URL"),
      "merchant-unlocks": this.configService.get("SUBSCRIPTION_SERVICE_URL"),

      organizations: this.configService.get("ORGANIZATION_SERVICE_URL"),
      "platform-configs": this.configService.get("ORGANIZATION_SERVICE_URL"),
      cms: this.configService.get("ORGANIZATION_SERVICE_URL"),
      permissions: this.configService.get("IDENTITY_SERVICE_URL"),
      support: this.configService.get("ORGANIZATION_SERVICE_URL"),
      notifications: this.configService.get("NOTIFICATION_SERVICE_URL"),
    };

    const segments = path.split("/").filter(Boolean);

    if (segments[2] === "organizations") {
      if (
        segments[4] === "roles" ||
        segments[4] === "users" ||
        segments[4] === "permissions"
      ) {
        return routes["organizations"];
      }

      if (segments[4] === "merchants") {
        return routes["merchants"];
      }

      return routes["organizations"];
    }

    if (segments[2] === "merchant") {
      return routes["merchants"];
    }

    if (segments[2] === "superadmin-integration") {
      const subRouteKey = segments[3];
      return (subRouteKey && routes[subRouteKey]) || null;
    }

    const routeKey = segments[2] ?? segments[0];
    return (routeKey && routes[routeKey]) || null;
  }

  @All("*path")
  async proxyRequest(@Req() req: Request, @Res() res: Response) {
    const path = req.path;

    this.logger.debug(`Incoming request: ${req.method} ${path}`);

    if (path.startsWith("/internal/") || path === "/internal") {
      return res.status(404).json({ error: "Not found" });
    }

    if (req.method === "OPTIONS") {
      res.set({
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Methods":
          "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, Accept, Origin, X-Requested-With, x-organization-id, x-user-id, x-cookie-consent",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
      });
      return res.status(200).end();
    }

    const serviceUrl = this.getServiceUrl(path);

    if (!serviceUrl) {
      this.logger.warn(`No service found for path: ${path}`);
      return res.status(404).json({
        error: "Service not found",
        path,
        message: "The requested endpoint is not mapped to any microservice",
      });
    }

    let pathWithoutPrefix = path.startsWith("/api/v1") ? path.replace("/api/v1", "") : path;
    
    // Support superadmin-integration prefix by stripping it before proxying
    const isSuperAdminIntegration = pathWithoutPrefix.startsWith("/superadmin-integration");
    if (isSuperAdminIntegration) {
      pathWithoutPrefix = pathWithoutPrefix.replace("/superadmin-integration", "");
      this.logger.debug(`[Super Admin Integration] Stripped prefix, new path: ${pathWithoutPrefix}`);
    }

    const targetUrl = `${serviceUrl}${pathWithoutPrefix}`;
    const isSse = path.includes("/sse/");

    this.logger.debug(`Proxying to: ${targetUrl}${isSse ? " (SSE stream)" : ""}`);

    let userId: string | undefined;
    let organizationId: string | undefined;
    let userType: string | undefined;
    let userRole: string | undefined;
    let userPermissions: string[] | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.substring(7);
        const secret = this.configService.get<string>("JWT_SECRET");
        if (!secret) {
          this.logger.error("JWT_SECRET is not configured");
          return res.status(500).json({ error: "Internal Server Error" });
        }

        const decoded = this.jwtService.verify(token, { secret });

        userId = decoded.sub || decoded.userId;
        organizationId = decoded.organizationId || decoded.organization_id;
        userType = decoded.userType;
        userRole = decoded.role;
        userPermissions = decoded.permissions;

        this.logger.debug(
          `Extracted from token - userId: ${userId}, orgId: ${organizationId}${userType ? `, userType: ${userType}` : ""}${userRole ? `, role: ${userRole}` : ""}`,
        );
      } catch (error) {
        this.logger.warn(`Failed to verify JWT token: ${error.message}`);
        return res.status(401).json({ error: "Unauthorized", message: "Invalid or expired token" });
      }
    }

    try {
      const proxyHeaders: Record<string, string> = {
        ...(req.headers as Record<string, string>),
        host: undefined as any,
        "content-length": undefined as any,
      };
      delete proxyHeaders.host;
      delete proxyHeaders["content-length"];
      // Remove any client-sent identity headers so we only send the JWT's claims (data isolation)
      delete proxyHeaders["x-organization-id"];
      delete proxyHeaders["x-user-id"];
      delete proxyHeaders["x-user-type"];
      delete proxyHeaders["x-user-role"];

      if (userId) {
        proxyHeaders["x-user-id"] = userId;
      }
      // Always use JWT's organizationId for data isolation (merchant list, dashboard, etc.)
      // Ignore client-sent x-organization-id so we never return another org's data.
      // For superadmin-integration routes, set to "platform-org-id" so backend
      // skips org filtering and returns cross-org data.
      if (isSuperAdminIntegration) {
        proxyHeaders["x-organization-id"] = "platform-org-id";
        this.logger.debug(`[Super Admin Integration] Overriding x-organization-id to platform-org-id for cross-org access`);
      } else if (organizationId) {
        proxyHeaders["x-organization-id"] = organizationId;
        if (path.includes("merchant") || path.includes("dashboard")) {
          this.logger.debug(`[Data isolation] Forwarding x-organization-id: ${organizationId} for path: ${path}`);
        }
      }
      if (userType) {
        proxyHeaders["x-user-type"] = userType;
      }
      if (userRole) {
        proxyHeaders["x-user-role"] = userRole;
      }
      if (userPermissions && Array.isArray(userPermissions)) {
        proxyHeaders["x-user-permissions"] = JSON.stringify(userPermissions);
      }

      const internalToken = this.configService.get<string>("INTERNAL_TOKEN");
      if (internalToken) {
        proxyHeaders["x-internal-token"] = internalToken;
      }

      if (isSse) {
        // SSE: stream the response (long-lived connection)
        const response = await axios({
          method: req.method as any,
          url: targetUrl,
          headers: proxyHeaders,
          params: req.query,
          responseType: "stream",
          timeout: 0,
          validateStatus: () => true,
        });

        res.status(response.status);
        const forwardHeaders = ["content-type", "cache-control", "connection", "x-accel-buffering"];
        forwardHeaders.forEach((name) => {
          const value = response.headers[name];
          if (value) res.setHeader(name, value);
        });
        if (!res.getHeader("content-type")) {
          res.setHeader("Content-Type", "text/event-stream");
        }
        response.data.pipe(res);
        return;
      }

      const isGpayConnect =
        typeof targetUrl === "string" &&
        targetUrl.includes("/gateway/") &&
        targetUrl.includes("/connect-gpay");

      const response = await axios({
        method: req.method as any,
        url: targetUrl,
        data: req.body,
        headers: proxyHeaders,
        params: req.query,
        // GPay connect may legitimately take >60s (Playwright + Google challenges).
        timeout: isGpayConnect ? 180000 : 60000,
        validateStatus: () => true,
      });

      this.logger.debug(`Response from ${targetUrl}: ${response.status}`);

      if (response.headers) {
        Object.entries(response.headers).forEach(([key, value]) => {
          if (value) {
            res.setHeader(key, value as string | string[]);
          }
        });
      }

      res.status(response.status).send(response.data);
    } catch (error: any) {
      this.logger.error(`Error proxying to ${targetUrl}: ${error.message}`);

      const status = error.response?.status || 500;
      const data = error.response?.data || {
        error: "Proxy error",
        message: process.env.NODE_ENV === "production" ? "Service temporarily unavailable" : error.message,
        ...(process.env.NODE_ENV !== "production" && { service: serviceUrl }),
      };

      res.status(status).json(data);
    }
  }
}

import axios from "axios";
import { Logger } from "@nestjs/common";

const logger = new Logger("AuditUtil");

export async function logAuditActivity(
  action: string,
  entityId: string,
  entityType: string,
  userId: string,
  userType: string,
  organizationId: string,
  ipAddress?: string,
  userAgent?: string,
  metadata?: any
) {
  if (!userId) return;

  const orgServiceUrl = process.env.ORGANIZATION_SERVICE_URL;
  if (!orgServiceUrl) {
    logger.warn("ORGANIZATION_SERVICE_URL is not defined");
    return;
  }

  try {
    await axios.post(
      `${orgServiceUrl}/audit-logs`,
      {
        organizationId: organizationId || null,
        action,
        performedBy: userId,
        performedByType: userType || "USER",
        entityId: entityId,
        entityType: entityType,
        ipAddress: ipAddress || null,
        metadata: {
          ...metadata,
          userAgent: userAgent || null,
        },
      },
      { headers: { "x-internal-token": process.env.INTERNAL_TOKEN } }
    );
  } catch (err: any) {
    logger.warn(`Failed to log audit activity '${action}' for entity ${entityId}: ${err.message}`);
  }
}

import crypto from "crypto";

export function generateChecksum(payload: string, saltKey: string): string {
  return crypto.createHmac("sha256", saltKey).update(payload).digest("hex");
}

export default generateChecksum;

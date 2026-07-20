import crypto from 'crypto';

/**
 * Generate checksum (HMAC SHA256) for PhonePe payload.
 * Ensure this matches PhonePe's expected algorithm.
 */
export function generateChecksum(payload: string, saltKey: string): string {
  return crypto.createHmac('sha256', saltKey).update(payload).digest('hex');
}

export default generateChecksum;

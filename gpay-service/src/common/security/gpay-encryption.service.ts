import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class GpayEncryptionService {
  private readonly logger = new Logger(GpayEncryptionService.name);
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const rawKey =
      this.configService.get<string>('GPAY_ENCRYPTION_KEY') ||
      this.configService.get<string>('INTERNAL_TOKEN') ||
      'default-gpay-secret-key-32-bytes';

    // Derive a consistent 32-byte key using SHA-256
    this.key = crypto.createHash('sha256').update(rawKey).digest();
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString(
      'hex',
    )}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted payload format. Expected iv:authTag:ciphertext');
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, 'hex')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  encryptObject(obj: any): string {
    return this.encrypt(JSON.stringify(obj));
  }

  decryptObject<T = any>(payload: string): T {
    return JSON.parse(this.decrypt(payload));
  }

  encryptSessionState(state: Record<string, any>): string {
    return this.encrypt(JSON.stringify(state));
  }

  decryptSessionState(payload: string): Record<string, any> {
    const decryptedJson = this.decrypt(payload);
    return JSON.parse(decryptedJson);
  }
}

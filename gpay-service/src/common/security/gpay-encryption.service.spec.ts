import { GpayEncryptionService } from './gpay-encryption.service';
import { ConfigService } from '@nestjs/config';

describe('GpayEncryptionService', () => {
  let service: GpayEncryptionService;

  beforeEach(() => {
    const configService = {
      get: jest.fn().mockReturnValue('12345678901234567890123456789012'), // 32 chars
    } as unknown as ConfigService;
    service = new GpayEncryptionService(configService);
  });

  it('should encrypt and decrypt string correctly', () => {
    const plaintext = '{"cookies":[{"name":"SID","value":"test_val"}]}';
    const encrypted = service.encrypt(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':'); // iv:authTag:ciphertext

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('should encrypt and decrypt object correctly', () => {
    const obj = { foo: 'bar', secret: 123 };
    const encrypted = service.encryptObject(obj);
    const decrypted = service.decryptObject(encrypted);

    expect(decrypted).toEqual(obj);
  });

  it('should throw error when decrypting tampered data', () => {
    const plaintext = 'sensitive data';
    const encrypted = service.encrypt(plaintext);
    const parts = encrypted.split(':');
    // Tamper with ciphertext
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}00`;

    expect(() => service.decrypt(tampered)).toThrow();
  });
});

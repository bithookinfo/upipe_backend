import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class HdfcCryptoUtil {
  private readonly logger = new Logger(HdfcCryptoUtil.name);
  private cachedPublicKey: string | null = null;
  private lastFetchTime: number = 0;
  private readonly CACHE_TTL = 3600 * 1000; // 1 hour

  /**
   * Fetches the RSA public key from HDFC.
   * Includes an in-memory cache to prevent fetching on every request.
   */
  async fetchPublicKey(): Promise<string> {
    if (this.cachedPublicKey && Date.now() - this.lastFetchTime < this.CACHE_TTL) {
      return this.cachedPublicKey;
    }

    try {
      this.logger.log('Fetching fresh RSA public key from HDFC...');
      const response = await fetch("https://www.hdfcbankvyapar.com/api/keys", {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch public key. Status: ${response.status}`);
      }

      const json = await response.json();
      if (!json.publicKey) {
        throw new Error('Public key not found in response');
      }

      const pem = `-----BEGIN PUBLIC KEY-----\n${json.publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
      
      this.cachedPublicKey = pem;
      this.lastFetchTime = Date.now();
      
      return pem;
    } catch (error) {
      this.logger.error('Error fetching public key:', error.message);
      throw error;
    }
  }

  /**
   * Encrypts the payload using AES-256-GCM and encrypts the AES key/IV with RSA-OAEP.
   */
  async encryptRequest(payloadObj: Record<string, any>): Promise<{ PAYLOAD: string, KEY: string, IV: string, aesKey: Buffer, iv: Buffer }> {
    const pem = await this.fetchPublicKey();
    
    const aesKey = crypto.randomBytes(32); // 256 bit
    const iv = crypto.randomBytes(12);     // 12 bytes
    
    // Attach uid generated using aesKey to match frontend behavior
    const uid = aesKey.toString('base64') + "_" + Date.now();
    const finalPayload = { ...payloadObj, uid };
    
    const payloadStr = JSON.stringify(finalPayload);
    
    // Encrypt Payload with AES-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    let encryptedPayload = cipher.update(payloadStr, 'utf8');
    encryptedPayload = Buffer.concat([encryptedPayload, cipher.final()]);
    const authTag = cipher.getAuthTag();
    const finalPayloadBase64 = Buffer.concat([encryptedPayload, authTag]).toString('base64');
    
    // Encrypt AES Key and IV with RSA-OAEP
    const encryptedKey = crypto.publicEncrypt({
        key: pem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey).toString('base64');
    
    const encryptedIV = crypto.publicEncrypt({
        key: pem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, iv).toString('base64');

    return {
      PAYLOAD: finalPayloadBase64,
      KEY: encryptedKey,
      IV: encryptedIV,
      aesKey,
      iv
    };
  }

  /**
   * Decrypts the AES-256-GCM encrypted response payload.
   */
  decryptResponse(encryptedBase64: string, aesKey: Buffer, iv: Buffer): Record<string, any> {
    try {
      const resPayloadBuffer = Buffer.from(encryptedBase64, 'base64');
      const resAuthTag = resPayloadBuffer.subarray(resPayloadBuffer.length - 16);
      const resEncData = resPayloadBuffer.subarray(0, resPayloadBuffer.length - 16);
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(resAuthTag);
      let decrypted = decipher.update(resEncData, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (error) {
      this.logger.error('Failed to decrypt response', error.message);
      throw new Error('Failed to decrypt HDFC response');
    }
  }
}

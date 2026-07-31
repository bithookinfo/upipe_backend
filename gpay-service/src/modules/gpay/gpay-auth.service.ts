import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Page } from 'playwright';
import { RedisService } from '../../common/redis/redis.service';

export interface ChallengeOwnerInfo {
  sessionId: string;
  providerId: string;
  ownerId: string;
  expiresAt: number;
}

@Injectable()
export class GpayAuthService {
  private readonly logger = new Logger(GpayAuthService.name);
  private readonly instanceId: string;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.instanceId =
      this.configService.get('GPAY_INSTANCE_ID') ||
      `instance-${Math.random().toString(36).substring(2, 8)}`;
  }

  public getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Sets the session state in Redis (ONBOARDING, CHALLENGE_REQUIRED, ACTIVE).
   */
  async setSessionState(
    providerId: string,
    state: 'ONBOARDING' | 'CHALLENGE_REQUIRED' | 'ACTIVE',
    ttlSeconds = 900,
  ): Promise<void> {
    const key = `gpay:session:state:${providerId}`;
    try {
      await this.redisService.getClient().set(key, state, 'EX', ttlSeconds);
    } catch (e: any) {
      this.logger.warn(`Could not set Redis session state for ${providerId}: ${e.message}`);
    }
  }

  async getSessionState(
    providerId: string,
  ): Promise<'ONBOARDING' | 'CHALLENGE_REQUIRED' | 'ACTIVE' | null> {
    const key = `gpay:session:state:${providerId}`;
    try {
      const val = await this.redisService.getClient().get(key);
      return (val as any) || null;
    } catch (e: any) {
      this.logger.warn(`Could not read Redis session state for ${providerId}: ${e.message}`);
      return null;
    }
  }

  /**
   * Claims challenge ownership for interactive Google challenges or OTP verification.
   * Restricts interactive challenge continuation to the owning gpay-service instance.
   */
  async claimChallengeOwnership(
    sessionId: string,
    providerId: string,
    ttlSeconds = 600,
  ): Promise<ChallengeOwnerInfo> {
    const key = `gpay:challenge:${sessionId}:owner`;
    const client = this.redisService.getClient();
    await client.set(key, `${this.instanceId}:${providerId}`, 'EX', ttlSeconds);

    this.logger.log(
      `Claimed challenge ownership for session ${sessionId} (provider: ${providerId}) on instance ${this.instanceId}`,
    );

    return {
      sessionId,
      providerId,
      ownerId: this.instanceId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  async verifyChallengeOwner(sessionId: string): Promise<boolean> {
    const key = `gpay:challenge:${sessionId}:owner`;
    try {
      const val = await this.redisService.getClient().get(key);
      if (!val) return false;
      const [ownerId] = val.split(':');
      return ownerId === this.instanceId;
    } catch {
      return false;
    }
  }

  async releaseChallengeOwnership(sessionId: string): Promise<void> {
    const key = `gpay:challenge:${sessionId}:owner`;
    try {
      await this.redisService.getClient().del(key);
    } catch {
      // ignore
    }
  }

  /**
   * Performs Google Sign-In on a page. Checks for challenges without persisting sensitive inputs.
   */
  async performSignIn(
    page: Page,
    email: string,
    password?: string,
    otp?: string,
  ): Promise<{ success: boolean; challengeRequired?: boolean; reason?: string }> {
    try {
      if (email) {
        await page.goto('https://accounts.google.com/signin/v2/identifier', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        const emailInput = page.locator('input[type="email"]');
        if (await emailInput.isVisible({ timeout: 5000 })) {
          await emailInput.fill(email);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);
        }
      }

      if (password) {
        const passInput = page.locator('input[type="password"]');
        if (await passInput.isVisible({ timeout: 10000 })) {
          await passInput.fill(password);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3000);
        }
      }

      if (otp) {
        const otpInput = page.locator('input[type="tel"], input[name="totpPin"], input[id*="idv"]');
        if (await otpInput.isVisible({ timeout: 5000 })) {
          await otpInput.fill(otp);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3000);
        }
      }

      const url = page.url();
      if (url.includes('challenge') || url.includes('idv') || url.includes('signin/v2/challenge')) {
        return { success: false, challengeRequired: true, reason: 'GOOGLE_CHALLENGE_DETECTED' };
      }

      return { success: true };
    } catch (error: any) {
      this.logger.warn(`Google sign-in step failed: ${error.message}`);
      return { success: false, reason: error.message };
    }
  }
}

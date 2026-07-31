import { sanitizeLog } from './log-sanitizer';

describe('LogSanitizer', () => {
  it('should redact sensitive object properties by key name', () => {
    const input = {
      user: 'merchant_01',
      password: 'secret-password',
      otp: '123456',
      cookie: '__Secure-3PSID=abc123;',
      sessionState: { cookies: ['abc'] },
      'x-internal-token': 'token123',
    };

    const output = sanitizeLog(input) as Record<string, unknown>;
    expect(output.user).toBe('merchant_01');
    expect(output.password).toBe('[REDACTED]');
    expect(output.otp).toBe('[REDACTED]');
    expect(output.cookie).toBe('[REDACTED]');
    expect(output.sessionState).toBe('[REDACTED]');
    expect(output['x-internal-token']).toBe('[REDACTED]');
  });

  it('should redact sensitive values inside strings using regex patterns', () => {
    const rawString =
      'Request failed with cookie __Secure-3PSID=abc12345; path=/ and SID=xyz987';
    const output = sanitizeLog(rawString) as string;
    expect(output).toContain('__Secure-3PSID=[REDACTED]');
    expect(output).toContain('SID=[REDACTED]');
    expect(output).not.toContain('abc12345');
    expect(output).not.toContain('xyz987');
  });

  it('should recursively sanitize arrays and nested objects', () => {
    const input = [
      {
        id: 1,
        credentials: {
          password: 'my-password',
          apiToken: 'public-key',
        },
      },
    ];

    const output = sanitizeLog(input) as unknown[];
    const firstItem = output[0] as {
      id: number;
      credentials: Record<string, unknown>;
    };
    expect(firstItem.id).toBe(1);
    expect(firstItem.credentials.password).toBe('[REDACTED]');
    expect(firstItem.credentials.apiToken).toBe('public-key');
  });

  it('should handle null and undefined safely', () => {
    expect(sanitizeLog(null)).toBeNull();
    expect(sanitizeLog(undefined)).toBeUndefined();
  });

  it('should redact case variants, hyphenated/normalized headers, and SID tokens', () => {
    const input = {
      PASSWORD: 'sec1',
      xInternalToken: 'sec2',
      xinternaltoken: 'sec3',
      googleVerificationCode: 'sec4',
      localStorage: 'sec5',
      SID: 'sec6',
      HSID: 'sec7',
      SSID: 'sec8',
    };
    const output = sanitizeLog(input) as Record<string, unknown>;
    expect(output.PASSWORD).toBe('[REDACTED]');
    expect(output.xInternalToken).toBe('[REDACTED]');
    expect(output.xinternaltoken).toBe('[REDACTED]');
    expect(output.googleVerificationCode).toBe('[REDACTED]');
    expect(output.localStorage).toBe('[REDACTED]');
    expect(output.SID).toBe('[REDACTED]');
    expect(output.HSID).toBe('[REDACTED]');
    expect(output.SSID).toBe('[REDACTED]');
  });
});

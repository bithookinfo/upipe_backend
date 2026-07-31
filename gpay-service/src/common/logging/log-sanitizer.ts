const SENSITIVE_KEYS = new Set([
  'password',
  'otp',
  'cookie',
  'cookies',
  'localstorage',
  'storage_state',
  'storagestate',
  'sessionstate',
  'session_state',
  'sessionstateencrypted',
  'ciphertext',
  'internal_token',
  'internaltoken',
  'x-internal-token',
  'xinternaltoken',
  'googleverificationcode',
  'recoveryphonenumber',
  'sid',
  'hsid',
  'ssid',
  'apisid',
  'sapisid',
  '__secure-1psid',
  '__secure-3psid',
  'authorization',
  'secret',
  'key',
]);

const SENSITIVE_PATTERNS = [
  /(__Secure-[0-9][A-Za-z]+)=[^;]+/gi,
  /(SID|HSID|SSID|APISID|SAPISID)=[^;]+/gi,
  /(password|otp|token|cookie|secret|ciphertext)["']?\s*[:=]\s*["']?([^"'\s,}]+)/gi,
];

export function sanitizeLog(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    let sanitized = data;
    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, '$1=[REDACTED]');
    }
    return sanitized;
  }

  if (Array.isArray(data)) {
    return (data as unknown[]).map((item) => sanitizeLog(item));
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
      if (SENSITIVE_KEYS.has(normalizedKey)) {
        sanitizedObj[key] = '[REDACTED]';
      } else {
        sanitizedObj[key] = sanitizeLog(value);
      }
    }
    return sanitizedObj;
  }

  return data;
}

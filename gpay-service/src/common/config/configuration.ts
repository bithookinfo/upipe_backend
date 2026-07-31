export default () => ({
  port: parseInt(process.env.PORT || '4007', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  merchantServiceUrl:
    process.env.MERCHANT_SERVICE_URL || 'http://localhost:4002',
  paymentServiceUrl: process.env.PAYMENT_SERVICE_URL || 'http://localhost:4003',
  internalToken: process.env.INTERNAL_TOKEN || '',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  gpayInstanceId:
    process.env.GPAY_INSTANCE_ID ||
    `gpay-${Math.random().toString(36).substring(2, 8)}`,
  headless: process.env.HEADLESS !== 'false',
  playwrightUserDataDir:
    process.env.PLAYWRIGHT_USER_DATA_DIR || '/data/gpay/profiles',
  gpayMaxContextsPerBrowser: parseInt(
    process.env.GPAY_MAX_CONTEXTS_PER_BROWSER || '5',
    10,
  ),
  gpayMaxBrowsersPerInstance: parseInt(
    process.env.GPAY_MAX_BROWSERS_PER_INSTANCE || '3',
    10,
  ),
  gpayMaxPersistentProfilesPerInstance: parseInt(
    process.env.GPAY_MAX_PERSISTENT_PROFILES_PER_INSTANCE || '3',
    10,
  ),
  gpayIdleTimeoutMs: parseInt(process.env.GPAY_IDLE_TIMEOUT_MS || '900000', 10),
  gpayBrowserMaxAgeMs: parseInt(
    process.env.GPAY_BROWSER_MAX_AGE_MS || '21600000',
    10,
  ),
  gpayBrowserMemoryLimitMb: parseInt(
    process.env.GPAY_BROWSER_MEMORY_LIMIT_MB || '2048',
    10,
  ),
  gpayProviderLeaseTtlSeconds: parseInt(
    process.env.GPAY_PROVIDER_LEASE_TTL_SECONDS || '60',
    10,
  ),
  gpayProviderLeaseHeartbeatSeconds: parseInt(
    process.env.GPAY_PROVIDER_LEASE_HEARTBEAT_SECONDS || '20',
    10,
  ),
  gpaySessionEncryptionKeyB64:
    process.env.GPAY_SESSION_ENCRYPTION_KEY_B64 || '',
  gpaySessionEncryptionKeyId:
    process.env.GPAY_SESSION_ENCRYPTION_KEY_ID || 'primary',
  newGpayWorkersEnabled: process.env.NEW_GPAY_WORKERS_ENABLED !== 'false',
});

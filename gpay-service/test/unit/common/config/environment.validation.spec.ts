import { validate } from '../../../../src/common/config/environment.validation';

describe('EnvironmentValidation', () => {
  it('should validate and return default values for a valid configuration', () => {
    const validConfig = {
      INTERNAL_TOKEN: 'secret-token-123',
      REDIS_URL: 'redis://localhost:6379',
    };

    const validated = validate(validConfig);
    expect(validated.INTERNAL_TOKEN).toBe('secret-token-123');
    expect(validated.PORT).toBe(4007);
    expect(validated.MERCHANT_SERVICE_URL).toBe('http://localhost:4002');
    expect(validated.PAYMENT_SERVICE_URL).toBe('http://localhost:4003');
  });

  it('should throw an error when INTERNAL_TOKEN is missing', () => {
    const invalidConfig = {
      REDIS_URL: 'redis://localhost:6379',
    };

    expect(() => validate(invalidConfig)).toThrow(
      /gpay-service environment validation failed/,
    );
  });

  it('should throw an error when PORT is out of range', () => {
    const invalidConfig = {
      INTERNAL_TOKEN: 'secret-token-123',
      PORT: 80,
    };

    expect(() => validate(invalidConfig)).toThrow(
      /gpay-service environment validation failed/,
    );
  });
});

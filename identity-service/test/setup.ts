/**
 * Global Jest setup file
 * This runs before all tests
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'mysql://test:test@localhost:3306/greenpay_payment_test';
process.env.MERCHANT_SERVICE_URL = 'http://localhost:3102';
process.env.JWT_SECRET = 'test-jwt-secret';

// Increase timeout for async operations
jest.setTimeout(30000);

// Suppress console logs during tests (optional - comment out if you want to see logs)
global.console = {
    ...console,
    log: jest.fn(), // Suppress console.log
    debug: jest.fn(), // Suppress console.debug
    info: jest.fn(), // Suppress console.info
    warn: jest.fn(), // Keep warnings visible
    error: jest.fn(), // Keep errors visible
};

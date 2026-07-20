module.exports = {
    // Use ts-jest preset for TypeScript support
    preset: 'ts-jest',

    // Test environment
    testEnvironment: 'node',

    // Root directory
    rootDir: '.',

    // Module paths
    modulePaths: ['<rootDir>'],

    // Module name mapper for path aliases
    moduleNameMapper: {
        '^src/(.*)$': '<rootDir>/src/$1',
    },

    // Test match patterns - only .spec.ts files for unit tests
    testMatch: [
        '**/*.spec.ts',
    ],

    // Files to collect coverage from
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.spec.ts',
        '!src/**/*.interface.ts',
        '!src/main.ts',
        '!src/**/*.module.ts',
    ],

    // Coverage thresholds
    coverageThreshold: {
        global: {
            branches: 70,
            functions: 70,
            lines: 70,
            statements: 70,
        },
    },

    // Coverage reporters
    coverageReporters: [
        'text',
        'text-summary',
        'html',
        'lcov',
    ],

    // Coverage directory
    coverageDirectory: '<rootDir>/coverage',

    // Transform files with ts-jest
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },

    // Module file extensions
    moduleFileExtensions: ['ts', 'js', 'json'],

    // Setup files
    setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],

    // Globals for ts-jest
    globals: {
        'ts-jest': {
            tsconfig: {
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
            },
        },
    },

    // Test timeout (30 seconds)
    testTimeout: 30000,

    // Clear mocks between tests
    clearMocks: true,

    // Restore mocks between tests
    restoreMocks: true,

    // Reset mocks between tests
    resetMocks: true,

    // Verbose output
    verbose: true,
};

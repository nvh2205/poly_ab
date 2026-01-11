/**
 * Jest setup file
 * Runs before all tests
 */

// Suppress console output during tests (optional)
// Uncomment if you want cleaner test output
/*
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
*/

// Set default test timeout
jest.setTimeout(30000);

// Mock environment variables for tests
process.env.NODE_ENV = 'test';
process.env.ARB_MIN_PROFIT_BPS = process.env.ARB_MIN_PROFIT_BPS || '5';
process.env.ARB_MIN_PROFIT_ABS = process.env.ARB_MIN_PROFIT_ABS || '0';
process.env.ARB_SCAN_THROTTLE_MS = process.env.ARB_SCAN_THROTTLE_MS || '50';
process.env.ARB_COOLDOWN_MS = process.env.ARB_COOLDOWN_MS || '200';

// Global test utilities
global.sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Add custom matchers if needed
expect.extend({
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    if (pass) {
      return {
        message: () =>
          `expected ${received} not to be within range ${floor} - ${ceiling}`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be within range ${floor} - ${ceiling}`,
        pass: false,
      };
    }
  },
});

// Extend TypeScript types for custom matchers
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
    }
  }

  function sleep(ms: number): Promise<void>;
}

export {};

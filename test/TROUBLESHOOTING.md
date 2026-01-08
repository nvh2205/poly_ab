# Troubleshooting Guide - Test Suite

## 🔧 Common Issues and Solutions

### Issue 1: "Cannot find name 'describe'" or Jest types not found

**Error:**
```
Cannot find name 'describe'. Do you need to install type definitions for a test runner?
```

**Solution:**
```bash
# Install Jest types
npm install --save-dev @types/jest

# If still not working, add to tsconfig.json
{
  "compilerOptions": {
    "types": ["jest", "node"]
  }
}
```

### Issue 2: Tests fail with "Cannot find module"

**Error:**
```
Cannot find module '../src/modules/strategy/arbitrage-engine.service'
```

**Solution:**
```bash
# Check if source files are compiled
npm run build

# Or ensure ts-jest is configured in jest.config.js
module.exports = {
  preset: 'ts-jest',
  // ...
};

# Clear Jest cache
npx jest --clearCache
```

### Issue 3: Tests timeout

**Error:**
```
Timeout - Async callback was not invoked within the 5000 ms timeout
```

**Solution 1: Increase timeout**
```typescript
// In test file
it('slow test', async () => {
  // ...
}, 30000); // 30 seconds

// Or in jest.config.js
testTimeout: 30000,
```

**Solution 2: Check for missing awaits**
```typescript
// BAD
it('test', () => {
  service.onModuleInit(); // Missing await!
  topOfBookSubject.next(update);
});

// GOOD
it('test', async () => {
  await service.onModuleInit();
  topOfBookSubject.next(update);
  await new Promise(resolve => setTimeout(resolve, 100));
});
```

### Issue 4: Tests are flaky (sometimes pass, sometimes fail)

**Possible Causes:**
1. Race conditions in async code
2. Shared state between tests
3. Timing-dependent assertions

**Solutions:**

```typescript
// 1. Add more wait time
await new Promise(resolve => setTimeout(resolve, 500)); // Increase from 100ms

// 2. Ensure cleanup in afterEach
afterEach(() => {
  service.onModuleDestroy();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  opportunities.length = 0; // Clear array
});

// 3. Use explicit waits instead of fixed timeouts
async function waitForOpportunities(count: number, timeoutMs = 5000) {
  const start = Date.now();
  while (opportunities.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${count} opportunities`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Use it:
await waitForOpportunities(1);
expect(opportunities.length).toBeGreaterThanOrEqual(1);
```

### Issue 5: "ReferenceError: regeneratorRuntime is not defined"

**Error:**
```
ReferenceError: regeneratorRuntime is not defined
```

**Solution:**
```bash
# Install babel runtime
npm install --save-dev @babel/runtime

# Or use ts-jest (already configured)
# Make sure jest.config.js has:
module.exports = {
  preset: 'ts-jest',
  // ...
};
```

### Issue 6: Jest doesn't pick up changes

**Solution:**
```bash
# Clear Jest cache
npx jest --clearCache

# Run without cache
npx jest --no-cache

# Check if watch mode is working
npm run test:watch
# Then change a file and see if it reruns
```

### Issue 7: Coverage is lower than expected

**Check what's not covered:**
```bash
# Generate detailed coverage
npm run test:cov

# Open HTML report
open coverage/index.html

# Look at lcov report in terminal
cat coverage/lcov.info
```

**Increase coverage:**
```typescript
// Test edge cases
it('should handle null values', () => {
  // ...
});

it('should handle empty arrays', () => {
  // ...
});

it('should handle NaN and Infinity', () => {
  // ...
});

// Test error paths
it('should handle errors gracefully', async () => {
  marketStructureService.rebuild.mockRejectedValue(new Error('DB error'));
  await expect(service.onModuleInit()).rejects.toThrow();
});
```

### Issue 8: Memory leaks in tests

**Symptoms:**
- Tests get slower over time
- Out of memory errors
- `--detectOpenHandles` shows open handles

**Solution:**
```typescript
// Ensure cleanup in afterEach
afterEach(async () => {
  // Unsubscribe from observables
  subscription?.unsubscribe();
  
  // Destroy service
  await service.onModuleDestroy();
  
  // Clear timers
  jest.clearAllTimers();
  
  // Restore mocks
  jest.restoreAllMocks();
});

// Use --detectOpenHandles to find leaks
npx jest --detectOpenHandles

// Use --forceExit to exit anyway (temporary fix)
npx jest --forceExit
```

### Issue 9: Mock not working as expected

**Problem:**
```typescript
marketStructureService.rebuild.mockResolvedValue([mockGroup]);
// But service still calls real implementation
```

**Solution:**
```typescript
// Make sure mock is created properly
const marketStructureService = {
  rebuild: jest.fn().mockResolvedValue([mockGroup]),
  getGroup: jest.fn(),
  getAllGroups: jest.fn(),
} as jest.Mocked<MarketStructureService>;

// Or use jest.mock at top of file
jest.mock('../src/modules/strategy/market-structure.service');

// Then in beforeEach:
marketStructureService = new MarketStructureService(null as any) as jest.Mocked<MarketStructureService>;
marketStructureService.rebuild = jest.fn().mockResolvedValue([mockGroup]);
```

### Issue 10: Tests pass locally but fail in CI

**Possible causes:**
1. Different Node.js version
2. Different timezone
3. Different environment variables
4. Timing differences (CI is slower)

**Solutions:**

```yaml
# .github/workflows/test.yml
- name: Setup Node.js
  uses: actions/setup-node@v3
  with:
    node-version: '20' # Match local version

- name: Set timezone
  run: |
    export TZ=UTC
    
- name: Run tests with increased timeout
  run: npm test
  env:
    JEST_TIMEOUT: 60000 # 60 seconds
```

```javascript
// jest.config.js
module.exports = {
  testTimeout: 60000, // Longer timeout for CI
  // ...
};
```

### Issue 11: "Cannot find module 'rxjs'"

**Error:**
```
Cannot find module 'rxjs' or its corresponding type declarations
```

**Solution:**
```bash
# Install missing dependencies
npm install rxjs

# If types are missing
npm install --save-dev @types/node
```

### Issue 12: TypeScript compilation errors in tests

**Error:**
```
Type 'MockedObject<MarketStructureService>' is not assignable to type 'MarketStructureService'
```

**Solution:**
```typescript
// Use 'as any' for mock casting
const mockService = {
  rebuild: jest.fn(),
} as any as MarketStructureService;

// Or create proper mock type
type MockedService = jest.Mocked<Pick<MarketStructureService, 'rebuild' | 'getGroup'>>;
const mockService: MockedService = {
  rebuild: jest.fn(),
  getGroup: jest.fn(),
};
```

### Issue 13: Tests run in wrong order

**Problem:**
Tests depend on execution order

**Solution:**
```typescript
// BAD: Tests depend on each other
let counter = 0;
it('test 1', () => {
  counter = 1;
});
it('test 2', () => {
  expect(counter).toBe(1); // Fails if test 2 runs first
});

// GOOD: Each test is independent
it('test 1', () => {
  let counter = 0;
  counter = 1;
  expect(counter).toBe(1);
});

it('test 2', () => {
  let counter = 0;
  counter = 2;
  expect(counter).toBe(2);
});
```

### Issue 14: Debugging tests is difficult

**Solutions:**

```bash
# 1. Run with verbose output
npx jest --verbose --silent=false

# 2. Use console.log (make sure to not suppress logs)
it('test', () => {
  console.log('Debug:', someVariable);
  expect(someVariable).toBe(expected);
});

# 3. Use Node debugger
node --inspect-brk node_modules/.bin/jest --runInBand

# 4. Use VS Code debugger
# Add launch configuration in .vscode/launch.json

# 5. Run single test only
it.only('debug this test', () => {
  // ...
});
```

### Issue 15: Environment variables not working

**Problem:**
```bash
ARB_MIN_PROFIT_BPS=100 npm test
# But service still uses default value
```

**Solution:**
```typescript
// Read env vars in test, not in service initialization
it('test with custom env', () => {
  const originalValue = process.env.ARB_MIN_PROFIT_BPS;
  process.env.ARB_MIN_PROFIT_BPS = '100';
  
  // Create service AFTER setting env var
  const service = new ArbitrageEngineService(...);
  
  // Test...
  
  // Restore
  process.env.ARB_MIN_PROFIT_BPS = originalValue;
});

// Or use beforeAll/afterAll
let originalEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  originalEnv = { ...process.env };
  process.env.ARB_MIN_PROFIT_BPS = '100';
});

afterAll(() => {
  process.env = originalEnv;
});
```

## 🔍 Diagnostic Commands

```bash
# 1. Check Jest version
npx jest --version

# 2. Show Jest configuration
npx jest --showConfig

# 3. Clear cache
npx jest --clearCache

# 4. List all tests without running
npx jest --listTests

# 5. Run with debug logging
DEBUG=* npm test

# 6. Check for open handles
npx jest --detectOpenHandles

# 7. Run with coverage to see untested code
npm run test:cov

# 8. Profile tests to find slow ones
npx jest --verbose --maxWorkers=1

# 9. Run tests matching pattern
npx jest --testNamePattern="should detect"

# 10. Run tests in specific file
npx jest test/arbitrage-engine.handle-top-of-book.test.ts
```

## 📝 Best Practices to Avoid Issues

1. **Always use async/await properly**
```typescript
// Good
it('test', async () => {
  await service.onModuleInit();
  await waitForSomething();
});

// Bad
it('test', () => {
  service.onModuleInit(); // Missing await
});
```

2. **Clean up after each test**
```typescript
afterEach(() => {
  service.onModuleDestroy();
  jest.restoreAllMocks();
});
```

3. **Use descriptive test names**
```typescript
// Good
it('should detect unbundling arbitrage when parent bid exceeds children sum', () => {});

// Bad
it('test 1', () => {});
```

4. **Test one thing per test**
```typescript
// Good
it('should update child state', () => { /* ... */ });
it('should recalculate prefix sums', () => { /* ... */ });

// Bad
it('should update state and recalculate and emit opportunity', () => {
  // Too much in one test
});
```

5. **Use setup helpers**
```typescript
function createTestService() {
  const mockStructure = { /* ... */ } as any;
  const mockStream = { /* ... */ } as any;
  return new ArbitrageEngineService(mockStructure, mockStream);
}

// Use in tests
it('test', () => {
  const service = createTestService();
  // ...
});
```

## 🆘 Still Having Issues?

1. **Check logs:**
   ```bash
   npm test 2>&1 | tee test.log
   ```

2. **Run smoke test:**
   ```bash
   ./test/smoke-test.sh
   ```

3. **Verify dependencies:**
   ```bash
   npm list jest @types/jest ts-jest
   ```

4. **Reinstall everything:**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   npx jest --clearCache
   npm test
   ```

5. **Check Node.js version:**
   ```bash
   node --version  # Should be 18.x or 20.x
   ```

6. **Ask for help with details:**
   - Node.js version
   - npm version
   - Error message (full stack trace)
   - Test file causing issue
   - Output of `npx jest --showConfig`


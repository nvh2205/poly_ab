# Quick Test Commands Reference

## 🚀 Basic Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage report
npm run test:cov

# Run specific test file
npm run test:handle-top-of-book
npm run test:simulation
npm run test:bootstrap
```

## 🎯 Run Specific Test Scenarios

```bash
# Test unbundling arbitrage
npx jest -t "should detect unbundling arbitrage"

# Test bundling arbitrage
npx jest -t "should detect bundling arbitrage"

# Test market indexing
npx jest -t "Market Indexing and Lookup"

# Test cooldown mechanism
npx jest -t "cooldown"

# Test profit thresholds
npx jest -t "Profit Thresholds"

# Test edge cases
npx jest -t "Edge Cases"

# Run all simulation scenarios
npx jest -t "Scenario"

# Run performance tests
npx jest -t "Performance"
```

## 🔧 Advanced Options

```bash
# Run with verbose output
npx jest --verbose

# Run without cache
npx jest --no-cache

# Run tests serially (one at a time)
npx jest --runInBand

# Update snapshots
npx jest --updateSnapshot

# Show console.log output
npx jest --silent=false

# Run tests matching pattern
npx jest --testNamePattern="BTC Rally"

# Run tests in specific file
npx jest test/arbitrage-engine.handle-top-of-book.test.ts

# Run multiple specific files
npx jest test/arbitrage-engine.handle-top-of-book.test.ts test/arbitrage-engine.simulation.test.ts
```

## 🐛 Debugging

```bash
# Debug with Node inspector
npm run test:debug

# Then open Chrome and go to chrome://inspect

# Debug specific test
node --inspect-brk node_modules/.bin/jest --runInBand -t "should detect unbundling"
```

## 📊 Coverage

```bash
# Generate HTML coverage report
npm run test:cov

# Open coverage report (Mac)
open coverage/index.html

# Open coverage report (Linux)
xdg-open coverage/index.html

# Coverage for specific files
npx jest --coverage --collectCoverageFrom="src/modules/strategy/arbitrage-engine.service.ts"
```

## 🔍 Filtering Tests

```bash
# Run only tests with .only
npx jest

# Run all tests except those with .skip
npx jest

# Run tests matching file pattern
npx jest arbitrage

# Run tests in specific directory
npx jest test/
```

## ⚡ Performance

```bash
# Run tests with timing information
npx jest --verbose --maxWorkers=1

# Profile test execution
node --prof node_modules/.bin/jest

# Measure memory usage
node --expose-gc node_modules/.bin/jest --logHeapUsage
```

## 🎨 Custom Environment Variables

```bash
# Override profit thresholds
ARB_MIN_PROFIT_BPS=100 npm test

# Fast test mode (no throttle/cooldown)
ARB_SCAN_THROTTLE_MS=0 ARB_COOLDOWN_MS=0 npm test

# Strict profit requirements
ARB_MIN_PROFIT_BPS=1000 ARB_MIN_PROFIT_ABS=0.1 npm test

# Multiple environment variables
ARB_MIN_PROFIT_BPS=5 ARB_SCAN_THROTTLE_MS=50 ARB_COOLDOWN_MS=100 npm test
```

## 📝 Watch Mode Commands

When in watch mode (`npm run test:watch`), you can use these commands:

```
› Press f to run only failed tests.
› Press o to only run tests related to changed files.
› Press p to filter by a filename regex pattern.
› Press t to filter by a test name regex pattern.
› Press q to quit watch mode.
› Press Enter to trigger a test run.
```

## 🔥 Quick Start Scenarios

### Test a specific arbitrage strategy
```bash
npx jest -t "Unbundling"
```

### Test real-world scenarios
```bash
npm run test:simulation
```

### Test with custom profit threshold
```bash
ARB_MIN_PROFIT_BPS=50 npx jest -t "should not emit opportunity when profit is below"
```

### Debug failing test
```bash
npm run test:debug
# Then in Chrome DevTools, set breakpoints and step through
```

### Quick smoke test (fast)
```bash
ARB_SCAN_THROTTLE_MS=0 ARB_COOLDOWN_MS=0 npx jest --bail
```

### Full test with coverage
```bash
npm run test:cov && open coverage/index.html
```

## 📱 Using Shell Script

```bash
# Make script executable (first time only)
chmod +x test/run-tests.sh

# Run all tests
./test/run-tests.sh

# Run with watch mode
./test/run-tests.sh --watch

# Run with coverage
./test/run-tests.sh --coverage

# Run with verbose output
./test/run-tests.sh --verbose

# Combine options
./test/run-tests.sh -v -c
```

## 💡 Tips

1. Use `--bail` to stop on first failure:
   ```bash
   npx jest --bail
   ```

2. Use `--onlyFailures` to rerun only failed tests:
   ```bash
   npx jest --onlyFailures
   ```

3. Use `.only` in code to focus on one test:
   ```typescript
   it.only('should test this one', () => { /* ... */ });
   ```

4. Use `.skip` to temporarily disable tests:
   ```typescript
   it.skip('todo: fix this later', () => { /* ... */ });
   ```

5. Clear Jest cache if tests behave strangely:
   ```bash
   npx jest --clearCache
   ```


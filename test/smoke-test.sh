#!/bin/bash

# Simple smoke test to verify test suite is working
# Run this first to check if everything is set up correctly

echo "🔍 Checking test environment..."
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js first."
    exit 1
fi
echo "✅ Node.js: $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm first."
    exit 1
fi
echo "✅ npm: $(npm --version)"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "⚠️  node_modules not found. Running npm install..."
    npm install
fi

# Check if Jest is installed
if [ ! -f "node_modules/.bin/jest" ]; then
    echo "⚠️  Jest not found. Installing test dependencies..."
    npm install --save-dev jest @types/jest ts-jest
fi
echo "✅ Jest installed"

# Check if test files exist
if [ ! -f "test/arbitrage-engine.handle-top-of-book.test.ts" ]; then
    echo "❌ Test files not found. Please ensure test files are in test/ directory."
    exit 1
fi
echo "✅ Test files found"

# Check if jest.config.js exists
if [ ! -f "jest.config.js" ]; then
    echo "❌ jest.config.js not found. Please ensure Jest is configured."
    exit 1
fi
echo "✅ Jest configured"

echo ""
echo "🎯 Running smoke test..."
echo ""

# Set test environment
export NODE_ENV=test
export ARB_SCAN_THROTTLE_MS=10
export ARB_COOLDOWN_MS=50

# Run a single simple test
npx jest -t "should correctly index and lookup markets by token ID" --silent --runInBand

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Smoke test passed!"
    echo ""
    echo "📝 You can now run:"
    echo "   npm test              # Run all tests"
    echo "   npm run test:watch    # Run in watch mode"
    echo "   npm run test:cov      # Run with coverage"
    echo ""
else
    echo ""
    echo "❌ Smoke test failed. Please check the error above."
    echo ""
    echo "💡 Try:"
    echo "   1. npx jest --clearCache"
    echo "   2. rm -rf node_modules && npm install"
    echo "   3. npm run test:debug"
    echo ""
    exit 1
fi


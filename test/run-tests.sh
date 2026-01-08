#!/bin/bash

# Quick start script for running ArbitrageEngine tests
# Usage: ./test/run-tests.sh [options]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}ArbitrageEngine Test Suite${NC}"
echo -e "${GREEN}========================================${NC}\n"

# Check if Jest is installed
if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npx not found. Please install Node.js and npm.${NC}"
    exit 1
fi

# Check if jest is in node_modules
if [ ! -f "node_modules/.bin/jest" ]; then
    echo -e "${YELLOW}Jest not found. Installing test dependencies...${NC}"
    npm install --save-dev jest @types/jest ts-jest
fi

# Parse command line arguments
TEST_FILE=""
WATCH_MODE=false
COVERAGE=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -w|--watch)
            WATCH_MODE=true
            shift
            ;;
        -c|--coverage)
            COVERAGE=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            echo "Usage: ./test/run-tests.sh [options]"
            echo ""
            echo "Options:"
            echo "  -w, --watch      Run tests in watch mode"
            echo "  -c, --coverage   Generate coverage report"
            echo "  -v, --verbose    Verbose output"
            echo "  -h, --help       Show this help message"
            echo ""
            echo "Examples:"
            echo "  ./test/run-tests.sh                    # Run all tests"
            echo "  ./test/run-tests.sh --watch            # Run in watch mode"
            echo "  ./test/run-tests.sh --coverage         # Run with coverage"
            echo "  ./test/run-tests.sh -v -c              # Verbose with coverage"
            exit 0
            ;;
        *)
            TEST_FILE="$1"
            shift
            ;;
    esac
done

# Build jest command
JEST_CMD="npx jest"

if [ "$WATCH_MODE" = true ]; then
    JEST_CMD="$JEST_CMD --watch"
fi

if [ "$COVERAGE" = true ]; then
    JEST_CMD="$JEST_CMD --coverage"
fi

if [ "$VERBOSE" = true ]; then
    JEST_CMD="$JEST_CMD --verbose --silent=false"
fi

if [ -n "$TEST_FILE" ]; then
    JEST_CMD="$JEST_CMD $TEST_FILE"
fi

# Set environment variables for testing
export NODE_ENV=test
export ARB_MIN_PROFIT_BPS=${ARB_MIN_PROFIT_BPS:-5}
export ARB_MIN_PROFIT_ABS=${ARB_MIN_PROFIT_ABS:-0}
export ARB_SCAN_THROTTLE_MS=${ARB_SCAN_THROTTLE_MS:-50}
export ARB_COOLDOWN_MS=${ARB_COOLDOWN_MS:-200}

echo -e "${YELLOW}Environment:${NC}"
echo "  NODE_ENV: $NODE_ENV"
echo "  ARB_MIN_PROFIT_BPS: $ARB_MIN_PROFIT_BPS"
echo "  ARB_MIN_PROFIT_ABS: $ARB_MIN_PROFIT_ABS"
echo "  ARB_SCAN_THROTTLE_MS: $ARB_SCAN_THROTTLE_MS"
echo "  ARB_COOLDOWN_MS: $ARB_COOLDOWN_MS"
echo ""

echo -e "${YELLOW}Running:${NC} $JEST_CMD\n"

# Run tests
eval $JEST_CMD

# Check exit code
if [ $? -eq 0 ]; then
    echo -e "\n${GREEN}✓ All tests passed!${NC}"
    
    if [ "$COVERAGE" = true ]; then
        echo -e "${GREEN}Coverage report generated in: coverage/index.html${NC}"
        echo -e "${YELLOW}Open in browser: file://$(pwd)/coverage/index.html${NC}"
    fi
else
    echo -e "\n${RED}✗ Some tests failed.${NC}"
    exit 1
fi


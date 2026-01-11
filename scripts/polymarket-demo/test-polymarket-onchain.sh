#!/bin/bash

# Script to test Polymarket Onchain Service
# Usage: ./test-polymarket-onchain.sh [workflow]

set -e

echo "╔═══════════════════════════════════════════╗"
echo "║  Testing Polymarket Onchain Service      ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# Configuration
API_URL="http://localhost:3000/polymarket-onchain"
WORKFLOW=${1:-"health"}

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test health endpoint
test_health() {
    echo -e "${YELLOW}Testing health endpoint...${NC}"
    response=$(curl -s "${API_URL}/health")
    
    if echo "$response" | grep -q '"status":"ok"'; then
        echo -e "${GREEN}✅ Health check passed${NC}"
        echo "$response" | jq '.'
        return 0
    else
        echo -e "${RED}❌ Health check failed${NC}"
        return 1
    fi
}

# Test balances endpoint
test_balances() {
    echo -e "\n${YELLOW}Testing balances endpoint...${NC}"
    
    # Replace with your actual config
    cat > /tmp/balance_request.json <<EOF
{
  "config": {
    "polygonRpc": "${POLYGON_RPC}",
    "chainId": 137,
    "clobUrl": "https://clob.polymarket.com",
    "privateKey": "${PRIVATE_KEY}",
    "proxyAddress": "0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5"
  },
  "conditionId": "${CONDITION_ID}"
}
EOF

    response=$(curl -s -X POST "${API_URL}/balances" \
        -H "Content-Type: application/json" \
        -d @/tmp/balance_request.json)
    
    if echo "$response" | grep -q '"success":true'; then
        echo -e "${GREEN}✅ Balances retrieved successfully${NC}"
        echo "$response" | jq '.'
        return 0
    else
        echo -e "${RED}❌ Failed to get balances${NC}"
        echo "$response" | jq '.'
        return 1
    fi
}

# Test mint endpoint
test_mint() {
    echo -e "\n${YELLOW}Testing mint endpoint...${NC}"
    
    cat > /tmp/mint_request.json <<EOF
{
  "config": {
    "polygonRpc": "${POLYGON_RPC}",
    "chainId": 137,
    "clobUrl": "https://clob.polymarket.com",
    "privateKey": "${PRIVATE_KEY}",
    "proxyAddress": "0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5"
  },
  "marketCondition": {
    "conditionId": "${CONDITION_ID}"
  },
  "amountUSDC": 1
}
EOF

    response=$(curl -s -X POST "${API_URL}/mint" \
        -H "Content-Type: application/json" \
        -d @/tmp/mint_request.json)
    
    if echo "$response" | grep -q '"success":true'; then
        echo -e "${GREEN}✅ Mint successful${NC}"
        echo "$response" | jq '.'
        return 0
    else
        echo -e "${RED}❌ Mint failed${NC}"
        echo "$response" | jq '.'
        return 1
    fi
}

# Test merge endpoint
test_merge() {
    echo -e "\n${YELLOW}Testing merge endpoint...${NC}"
    
    cat > /tmp/merge_request.json <<EOF
{
  "config": {
    "polygonRpc": "${POLYGON_RPC}",
    "chainId": 137,
    "clobUrl": "https://clob.polymarket.com",
    "privateKey": "${PRIVATE_KEY}",
    "proxyAddress": "0xb9b5cde0d64a06f5315be41a3ef2bbb530990fa5"
  },
  "marketCondition": {
    "conditionId": "${CONDITION_ID}"
  }
}
EOF

    response=$(curl -s -X POST "${API_URL}/merge" \
        -H "Content-Type: application/json" \
        -d @/tmp/merge_request.json)
    
    if echo "$response" | grep -q '"success":true'; then
        echo -e "${GREEN}✅ Merge successful${NC}"
        echo "$response" | jq '.'
        return 0
    else
        echo -e "${RED}❌ Merge failed${NC}"
        echo "$response" | jq '.'
        return 1
    fi
}

# Main test execution
case "$WORKFLOW" in
    health)
        test_health
        ;;
    balances)
        if [ -z "$POLYGON_RPC" ] || [ -z "$PRIVATE_KEY" ]; then
            echo -e "${RED}❌ Please set POLYGON_RPC and PRIVATE_KEY environment variables${NC}"
            exit 1
        fi
        test_balances
        ;;
    mint)
        if [ -z "$POLYGON_RPC" ] || [ -z "$PRIVATE_KEY" ] || [ -z "$CONDITION_ID" ]; then
            echo -e "${RED}❌ Please set POLYGON_RPC, PRIVATE_KEY, and CONDITION_ID environment variables${NC}"
            exit 1
        fi
        test_mint
        ;;
    merge)
        if [ -z "$POLYGON_RPC" ] || [ -z "$PRIVATE_KEY" ] || [ -z "$CONDITION_ID" ]; then
            echo -e "${RED}❌ Please set POLYGON_RPC, PRIVATE_KEY, and CONDITION_ID environment variables${NC}"
            exit 1
        fi
        test_merge
        ;;
    all)
        test_health && test_balances && test_mint && test_merge
        ;;
    *)
        echo "Usage: $0 [health|balances|mint|merge|all]"
        echo ""
        echo "Examples:"
        echo "  $0 health                    # Test health endpoint only"
        echo "  $0 balances                  # Test balances endpoint"
        echo "  $0 mint                      # Test mint endpoint"
        echo "  $0 merge                     # Test merge endpoint"
        echo "  $0 all                       # Run all tests"
        echo ""
        echo "For tests requiring credentials, set these environment variables:"
        echo "  export POLYGON_RPC='https://polygon-rpc.com'"
        echo "  export PRIVATE_KEY='0x...'"
        echo "  export CONDITION_ID='0x...'"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Test completed!                          ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════╝${NC}"

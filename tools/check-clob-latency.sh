#!/bin/bash
# =============================================================================
# Phase 1 Profiling: CLOB Network Latency Checker
# =============================================================================
# Usage: ./tools/check-clob-latency.sh [count]
#   count: number of iterations (default: 10)
#
# Measures DNS, TCP, TLS, TTFB and total time to clob.polymarket.com
# Run this alongside the app to correlate network spikes with engine spikes.
# =============================================================================

COUNT=${1:-10}
TARGET="https://clob.polymarket.com/markets"
FORMAT_FILE="$(dirname "$0")/curl-format.txt"

echo "=== CLOB Network Latency Check ==="
echo "Target: $TARGET"
echo "Iterations: $COUNT"
echo ""

for i in $(seq 1 $COUNT); do
    echo "--- Request $i ---"
    curl -s -o /dev/null \
        -w "     DNS Lookup:  %{time_namelookup}s\n  TCP Connect:  %{time_connect}s\nTLS Handshake:  %{time_appconnect}s\n   TTFB:  %{time_starttransfer}s\n        Total:  %{time_total}s\n   HTTP Code:  %{http_code}\n" \
        --connect-timeout 10 \
        "$TARGET"
    echo ""
    sleep 1
done

echo "=== Summary ==="
echo "Run 'mtr --report clob.polymarket.com' for full network path analysis"

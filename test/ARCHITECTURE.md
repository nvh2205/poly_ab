# Test Architecture Overview

## 📐 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Test Suite Architecture                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         Test Files                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  arbitrage-engine.handle-top-of-book.test.ts                   │
│  ├─ Range Market Arbitrage Tests                               │
│  ├─ Market Indexing Tests                                      │
│  ├─ Prefix Sum Tests                                           │
│  ├─ Cooldown/Throttling Tests                                  │
│  └─ Edge Cases Tests                                           │
│                                                                  │
│  arbitrage-engine.simulation.test.ts                           │
│  ├─ Market Scenario Simulations                                │
│  ├─ Stress Tests                                               │
│  ├─ Performance Tests                                          │
│  └─ Real-world Pricing Tests                                   │
│                                                                  │
│  arbitrage-engine.bootstrap.test.ts                            │
│  └─ Initialization Tests                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Service Under Test                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│              ArbitrageEngineService                             │
│                                                                  │
│    ┌──────────────────────────────────────────┐               │
│    │      handleTopOfBook(update)             │               │
│    │                                           │               │
│    │  1. Lookup market (token/slug/id)        │               │
│    │  2. Update child/parent state            │               │
│    │  3. Recalculate prefix sums              │               │
│    │  4. Schedule group scan                   │               │
│    │  5. Evaluate arbitrage opportunities     │               │
│    │  6. Emit opportunities (with cooldown)   │               │
│    └──────────────────────────────────────────┘               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Mocked Dependencies                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  MarketStructureService (Mocked)                                │
│  └─ rebuild() → Returns mock RangeGroups                        │
│                                                                  │
│  MarketDataStreamService (Mocked)                               │
│  └─ onTopOfBook() → Returns Subject<TopOfBookUpdate>           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 🔄 Test Flow Diagram

```
┌──────────────┐
│ Test Starts  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────┐
│ beforeEach Setup         │
│ - Create mock services   │
│ - Initialize service     │
│ - Subscribe to opps      │
└──────┬───────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ Test Case Execution                  │
│                                      │
│  1. Setup mock RangeGroup            │
│     ├─ Parents (>80k, >90k)         │
│     └─ Children (ranges)            │
│                                      │
│  2. Initialize service               │
│     └─ Builds internal state        │
│                                      │
│  3. Simulate price updates           │
│     ├─ Parent prices                │
│     └─ Child prices                 │
│                                      │
│  4. Wait for processing              │
│     ├─ Throttle delay               │
│     ├─ Scan execution               │
│     └─ Opportunity emission         │
│                                      │
│  5. Assert results                   │
│     ├─ Opportunity count            │
│     ├─ Strategy type                │
│     ├─ Profit calculations          │
│     └─ Market data                  │
└──────┬───────────────────────────────┘
       │
       ▼
┌──────────────────────────┐
│ afterEach Cleanup        │
│ - Destroy service        │
│ - Restore mocks          │
└──────┬───────────────────┘
       │
       ▼
┌──────────────┐
│  Test Ends   │
└──────────────┘
```

## 🎭 Mock Data Flow

```
Test File
   │
   └─▶ createMockRangeGroup()
        │
        ├─▶ Parent Markets
        │    ├─ marketId: 'parent-market-1'
        │    ├─ slug: 'will-btc-price-above-80000'
        │    ├─ clobTokenIds: ['parent-token-yes', 'parent-token-no']
        │    └─ bounds: { lower: 80000 }
        │
        └─▶ Child Markets (Ranges)
             ├─ marketId: 'child-market-1'
             ├─ slug: 'btc-price-80000-82000'
             ├─ clobTokenIds: ['child-token-1']
             └─ bounds: { lower: 80000, upper: 82000 }

   └─▶ createTopOfBookUpdate()
        │
        └─▶ TopOfBookUpdate
             ├─ assetId: 'parent-token-yes'
             ├─ marketId: 'parent-market-1'
             ├─ bestBid: 0.75
             ├─ bestAsk: 0.76
             └─ timestampMs: Date.now()

   └─▶ topOfBookSubject.next(update)
        │
        └─▶ ArbitrageEngineService.handleTopOfBook(update)
             │
             ├─▶ Lookup market in index
             ├─▶ Update state
             ├─▶ Recalculate prefixes
             ├─▶ Schedule scan
             └─▶ Emit opportunity
                  │
                  └─▶ opportunity$.next(opp)
                       │
                       └─▶ Test subscribes and captures
```

## 🧪 Test Scenarios

### Scenario 1: Unbundling Arbitrage
```
Parent >80k        [BID: 0.75]  ◀── Sell (receive $0.75)
                                     │
┌────────────────────────────────────┼────────────────────┐
│                                    │                    │
│  Range 80-82k    [ASK: 0.20]  ◀───┼─ Buy ($0.20)      │
│  Range 82-84k    [ASK: 0.20]  ◀───┼─ Buy ($0.20)      │
│  Range 84-86k    [ASK: 0.20]  ◀───┼─ Buy ($0.20)      │
│                                    │                    │
└────────────────────────────────────┼────────────────────┘
                                     │
Parent >86k        [ASK: 0.05]  ◀───┘  Buy ($0.05)

Total Cost: $0.65 (0.20 + 0.20 + 0.20 + 0.05)
Revenue:    $0.75 (parent bid)
Profit:     $0.10 ✅
```

### Scenario 2: Bundling Arbitrage
```
Parent >80k        [ASK: 0.65]  ──▶ Buy (pay $0.65)
                                     │
┌────────────────────────────────────┼────────────────────┐
│                                    │                    │
│  Range 80-82k    [BID: 0.20]  ────┼▶ Sell (get $0.20) │
│  Range 82-84k    [BID: 0.20]  ────┼▶ Sell (get $0.20) │
│  Range 84-86k    [BID: 0.20]  ────┼▶ Sell (get $0.20) │
│                                    │                    │
└────────────────────────────────────┼────────────────────┘
                                     │
Parent >86k        [BID: 0.15]  ────┘▶ Sell (get $0.15)

Total Revenue: $0.75 (0.20 + 0.20 + 0.20 + 0.15)
Cost:          $0.65 (parent ask)
Profit:        $0.10 ✅
```

## 📊 State Management

```
GroupState
├─ group: RangeGroup
│   ├─ groupKey: "BTC-2026-01-31"
│   ├─ crypto: "BTC"
│   ├─ parents: MarketRangeDescriptor[]
│   └─ children: MarketRangeDescriptor[]
│
├─ childStates: MarketSnapshot[]
│   ├─ [0]: { bestBid: 0.19, bestAsk: 0.20, ... }
│   ├─ [1]: { bestBid: 0.19, bestAsk: 0.20, ... }
│   └─ [2]: { bestBid: 0.19, bestAsk: 0.20, ... }
│
├─ parentStates: ParentState[]
│   ├─ [0]: { bestBid: 0.75, bestAsk: 0.76, coverage: {...} }
│   └─ [1]: { bestBid: 0.04, bestAsk: 0.05, coverage: {...} }
│
├─ askPrefix: [0, 0.20, 0.40, 0.60]
│   └─ Cumulative ask prices for prefix sum queries
│
├─ bidPrefix: [0, 0.19, 0.38, 0.57]
│   └─ Cumulative bid prices for prefix sum queries
│
├─ cooldowns: Map<string, number>
│   └─ Tracks last emission time per opportunity key
│
└─ scanTimer: NodeJS.Timeout | undefined
    └─ Throttles scan execution
```

## 🔍 Index Structures

```
ArbitrageEngineService Indexes

tokenIndex: Map<string, MarketLocator>
├─ "parent-token-yes"  → { groupKey: "BTC-...", role: "parent", index: 0 }
├─ "parent-token-no"   → { groupKey: "BTC-...", role: "parent", index: 0 }
├─ "child-token-1"     → { groupKey: "BTC-...", role: "child", index: 0 }
├─ "child-token-2"     → { groupKey: "BTC-...", role: "child", index: 1 }
└─ "child-token-3"     → { groupKey: "BTC-...", role: "child", index: 2 }

slugIndex: Map<string, MarketLocator>
├─ "will-btc-above-80000"  → { groupKey: "BTC-...", role: "parent", index: 0 }
├─ "btc-80000-82000"       → { groupKey: "BTC-...", role: "child", index: 0 }
└─ ...

marketIdIndex: Map<string, MarketLocator>
├─ "parent-market-1"  → { groupKey: "BTC-...", role: "parent", index: 0 }
├─ "child-market-1"   → { groupKey: "BTC-...", role: "child", index: 0 }
└─ ...
```

## ⏱️ Timing Diagram

```
Time →
0ms     100ms   150ms   200ms   250ms   300ms   350ms
│       │       │       │       │       │       │
│ Update Parent >80k
│       │       │       │
│       │ Update Child 1
│       │       │       │
│       │       │ Update Child 2
│       │       │       │
│       │       │       │ Update Child 3
│       │       │       │       │
│       │       │       │       │ Update Parent >90k
│       │       │       │       │       │
│       │       │       │       │       │ SCAN TRIGGERED
│       │       │       │       │       │ (after throttle)
│       │       │       │       │       │       │
│       │       │       │       │       │       │ Opportunity Emitted ✅
│       │       │       │       │       │       │
└───────┴───────┴───────┴───────┴───────┴───────┴─────

Throttle Window: 50ms (ARB_SCAN_THROTTLE_MS)
Cooldown Period: 200ms (ARB_COOLDOWN_MS)
```

## 🎯 Test Assertions

```typescript
// Example assertions in tests

expect(opportunities.length).toBeGreaterThan(0);
// ✓ At least one opportunity detected

expect(opp.strategy).toBe('SELL_PARENT_BUY_CHILDREN');
// ✓ Correct arbitrage strategy identified

expect(opp.profitAbs).toBeCloseTo(0.10, 2);
// ✓ Profit calculation is accurate

expect(opp.profitBps).toBeGreaterThan(1500);
// ✓ Profit meets minimum threshold

expect(opp.isExecutable).toBe(true);
// ✓ Opportunity is marked as executable

expect(opp.children.length).toBe(3);
// ✓ Correct number of child markets

expect(opp.parentBestBid).toBe(0.75);
// ✓ Parent price tracked correctly
```

## 📈 Coverage Goals

```
Target Coverage:
├─ Statements:   > 80%
├─ Branches:     > 75%
├─ Functions:    > 85%
└─ Lines:        > 80%

Key Areas to Cover:
├─ handleTopOfBook()           [Priority: HIGH]
├─ updateChild()               [Priority: HIGH]
├─ updateParent()              [Priority: HIGH]
├─ recalculatePrefixes()       [Priority: HIGH]
├─ scheduleScan()              [Priority: MEDIUM]
├─ scanGroup()                 [Priority: HIGH]
├─ evaluateUnbundling()        [Priority: HIGH]
├─ evaluateBundling()          [Priority: HIGH]
└─ maybeEmitOpportunity()      [Priority: HIGH]
```

## 🔄 Continuous Testing

```
Development Workflow:

1. Write/Modify Code
   │
   ▼
2. Save File
   │
   ▼
3. Jest Watch Detects Change
   │
   ▼
4. Run Relevant Tests
   │
   ├─▶ PASS ✓ → Continue coding
   │
   └─▶ FAIL ✗ → Fix code → Repeat
```


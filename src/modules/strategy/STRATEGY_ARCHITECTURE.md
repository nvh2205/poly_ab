# Strategy Module - Kiến Trúc & Luồng Hoạt Động Chi Tiết

## Tổng Quan

Strategy Module là hệ thống arbitrage tự động phát hiện và thực thi các cơ hội chênh lệch giá giữa các market liên quan trên Polymarket. Module này hoạt động theo thời gian thực, lắng nghe dữ liệu market từ WebSocket và tự động tính toán các cơ hội arbitrage có lợi nhuận.

## Kiến Trúc Tổng Thể

```
┌─────────────────────────────────────────────────────────────────┐
│                        INGESTION LAYER                           │
│  ┌──────────────┐      ┌──────────────────┐                    │
│  │   WebSocket  │ ───> │  BufferService   │                    │
│  │   (Polymarket)│      │  - Process data  │                    │
│  └──────────────┘      │  - Enrich metadata│                    │
│                        └────────┬─────────┘                     │
│                                 │                                │
│                        ┌────────▼─────────┐                     │
│                        │ MarketDataStream │                     │
│                        │     Service      │                     │
│                        │  (RxJS Subject)  │                     │
│                        └────────┬─────────┘                     │
└─────────────────────────────────┼──────────────────────────────┘
                                  │ TopOfBookUpdate Events
                                  │
┌─────────────────────────────────▼──────────────────────────────┐
│                        STRATEGY LAYER                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           MarketStructureService                          │  │
│  │  - Parse market ranges from questions/slugs              │  │
│  │  - Group related markets (parent/child)                  │  │
│  │  - Apply overrides for edge cases                        │  │
│  │  - Cache market groups                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            │                                     │
│                            │ RangeGroup[]                        │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           ArbitrageEngineService                          │  │
│  │  - Subscribe to TopOfBook updates                        │  │
│  │  - Maintain market state (bids/asks)                     │  │
│  │  - Calculate prefix sums for fast range queries         │  │
│  │  - Detect arbitrage opportunities                        │  │
│  │  - Emit ArbOpportunity events                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            │                                     │
│                            │ ArbOpportunity Events               │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           PaperExecutionService                           │  │
│  │  - Subscribe to arbitrage opportunities                  │  │
│  │  - Simulate trade execution                              │  │
│  │  - Calculate PnL                                         │  │
│  │  - Save signals & trades to database                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           RetentionCleanupService                         │  │
│  │  - Daily cleanup of old records                          │  │
│  │  - Prevent database bloat                                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │   PostgreSQL Database   │
                    │  - arb_signals          │
                    │  - arb_paper_trades     │
                    └─────────────────────────┘
```

---

## Luồng Dữ Liệu Chi Tiết

### 1. Thu Thập Dữ Liệu (Data Ingestion)

#### 1.1 WebSocket → BufferService

**File**: `src/modules/ingestion/buffer.service.ts`

```typescript
// WebSocket nhận price change events
{
  asset_id: "123456",
  market: "0xabc...",
  best_bid: 0.52,
  best_ask: 0.54,
  price: 0.53,
  timestamp: 1703845200000
}
```

**Xử lý**:
- `pushPriceChange()`: Nhận dữ liệu từ WebSocket
- Normalize timestamp (seconds → milliseconds)
- Tính toán mid price và spread
- Enrich metadata (market slug, market ID từ Redis/DB)
- Tạo `TopOfBookUpdate` object

#### 1.2 BufferService → MarketDataStreamService

**File**: `src/modules/ingestion/market-data-stream.service.ts`

```typescript
interface TopOfBookUpdate {
  assetId: string;
  marketHash: string;
  marketId?: string;
  marketSlug?: string;
  bestBid: number;
  bestAsk: number;
  midPrice?: number;
  spread?: number;
  timestampMs: number;
}
```

**Cơ chế**: RxJS Subject pattern
- `emitTopOfBook()`: Phát sự kiện mới
- `onTopOfBook()`: Observable cho subscribers
- Decoupling giữa ingestion và strategy layers

---

### 2. Phân Tích Cấu Trúc Market (Market Structure Analysis)

#### 2.1 MarketStructureService

**File**: `src/modules/strategy/market-structure.service.ts`

**Mục đích**: Phân loại và nhóm các market liên quan để phát hiện arbitrage

##### A. Parse Range từ Market Questions/Slugs

**Ví dụ**:
```
Question: "Will Bitcoin be between $90,000 and $92,000 on Dec 31?"
→ Parsed: { lower: 90000, upper: 92000, kind: 'range', role: 'child' }

Question: "Will Bitcoin be above $100,000 on Dec 31?"
→ Parsed: { lower: 100000, kind: 'above', role: 'parent' }
```

**Logic**:
1. Normalize text (remove $, _, lowercase)
2. Extract numbers (support k/m/b suffixes: "90k" → 90000)
3. Detect range hints: "between", "to", "-"
4. Detect boundary hints: "above", "below", "greater than"
5. Classify role:
   - `range` → **child** (specific range)
   - `above`/`below` → **parent** (boundary market)

##### B. Group Markets

**RangeGroup Structure**:
```typescript
{
  groupKey: "bitcoin-price-dec-31",
  eventSlug: "bitcoin-price-dec-31",
  crypto: "BTC",
  step: 2000,  // Derived from child intervals
  
  children: [
    { bounds: { lower: 88000, upper: 90000 }, kind: 'range', ... },
    { bounds: { lower: 90000, upper: 92000 }, kind: 'range', ... },
    { bounds: { lower: 92000, upper: 94000 }, kind: 'range', ... },
    // ... more ranges
  ],
  
  parents: [
    { bounds: { lower: 100000 }, kind: 'above', ... },
    { bounds: { upper: 85000 }, kind: 'below', ... }
  ]
}
```

##### C. Compute Coverage

**Mục đích**: Xác định parent market "cover" những child markets nào

```typescript
// Parent: "Above $100k" covers children with lower >= 100k
Parent: { lower: 100000 }
Children: [
  { lower: 100000, upper: 102000 },  // ✓ Covered (index 5)
  { lower: 102000, upper: 104000 },  // ✓ Covered (index 6)
  { lower: 104000, upper: 106000 },  // ✓ Covered (index 7)
]
→ Coverage: { startIndex: 5, endIndex: 7 }
```

##### D. Override System

**File**: `src/modules/strategy/config/range-group.overrides.ts`

Cho phép override thủ công cho các market khó parse:

```typescript
RANGE_GROUP_OVERRIDES = {
  'bitcoin-price-dec-31': {
    crypto: 'BTC',
    step: 2000,
    rules: [
      {
        slugContains: 'above-100k',
        role: 'parent',
        lower: 100000,
        kind: 'above'
      }
    ]
  }
}
```

---

### 3. Phát Hiện Arbitrage (Arbitrage Detection)

#### 3.1 ArbitrageEngineService

**File**: `src/modules/strategy/arbitrage-engine.service.ts`

**Khởi tạo** (`onModuleInit`):
1. Bootstrap groups từ `MarketStructureService`
2. Build indices (tokenId → market, slug → market)
3. Initialize state cho mỗi group
4. Subscribe to TopOfBook stream

##### A. Group State Management

```typescript
interface GroupState {
  group: RangeGroup;
  
  // Market snapshots
  childStates: MarketSnapshot[];      // [child0, child1, ...]
  parentStates: MarketSnapshot[];     // [parent0, parent1, ...]
  
  // Prefix sums for O(1) range queries
  askPrefix: number[];                // Cumulative ask prices
  bidPrefix: number[];                // Cumulative bid prices
  missingAskPrefix: number[];         // Count of missing asks
  missingBidPrefix: number[];         // Count of missing bids
  
  // Throttling & cooldown
  cooldowns: Map<string, number>;     // Last emit time per strategy
  lastScanAt: number;
  scanTimer?: NodeJS.Timeout;
}
```

**Ví dụ State**:
```typescript
childStates = [
  { bestBid: 0.10, bestAsk: 0.12, bounds: { lower: 88k, upper: 90k } },
  { bestBid: 0.15, bestAsk: 0.17, bounds: { lower: 90k, upper: 92k } },
  { bestBid: 0.20, bestAsk: 0.22, bounds: { lower: 92k, upper: 94k } },
]

// Prefix sums (index 0 = 0, index i = sum of first i elements)
askPrefix = [0, 0.12, 0.29, 0.51]
bidPrefix = [0, 0.10, 0.25, 0.45]
```

##### B. Update Flow

**Khi nhận TopOfBookUpdate**:

```typescript
handleTopOfBook(update: TopOfBookUpdate) {
  // 1. Lookup market location
  const locator = tokenIndex.get(update.assetId);
  // → { groupKey: "btc-dec-31", role: "child", index: 2 }
  
  // 2. Get group state
  const state = groups.get(locator.groupKey);
  
  // 3. Update snapshot
  if (locator.role === 'child') {
    updateChild(state, locator.index, update);
    // → Update childStates[2].bestBid/bestAsk
    // → Recalculate prefix sums from index 2
  } else {
    updateParent(state, locator.index, update);
    // → Update parentStates[0].bestBid/bestAsk
  }
  
  // 4. Schedule scan (throttled)
  scheduleScan(state);
}
```

##### C. Prefix Sum Optimization

**Tại sao?**: Tính tổng giá của nhiều child markets trong O(1) thay vì O(n)

```typescript
// Tính tổng ask price từ child[i] đến child[j]
function sumRange(state, 'ask', i, j) {
  // Check if any child is missing data
  const missingCount = missingAskPrefix[j+1] - missingAskPrefix[i];
  if (missingCount > 0) return null;  // Incomplete data
  
  // O(1) range sum
  return askPrefix[j+1] - askPrefix[i];
}

// Example: Sum ask prices from child[1] to child[3]
// askPrefix = [0, 0.12, 0.29, 0.51, 0.75]
// sum(1, 3) = askPrefix[4] - askPrefix[1] = 0.75 - 0.12 = 0.63
```

##### D. Arbitrage Strategies

**Strategy 1: SELL_PARENT_BUY_CHILDREN**

```
Parent: "Above $100k" → bestBid = 0.65
Children (covering $100k-$106k):
  - $100k-$102k → bestAsk = 0.20
  - $102k-$104k → bestAsk = 0.22
  - $104k-$106k → bestAsk = 0.21
  Total children ask = 0.63

Profit = 0.65 - 0.63 = 0.02 (2 cents)
Profit BPS = (0.02 / 0.63) * 10000 = 317 bps

Action:
  1. Sell parent at 0.65 (receive $65)
  2. Buy children at 0.63 total (pay $63)
  3. Net profit: $2
```

**Strategy 2: BUY_PARENT_SELL_CHILDREN**

```
Parent: "Above $100k" → bestAsk = 0.60
Children (covering $100k-$106k):
  - $100k-$102k → bestBid = 0.21
  - $102k-$104k → bestBid = 0.23
  - $104k-$106k → bestBid = 0.22
  Total children bid = 0.66

Profit = 0.66 - 0.60 = 0.06 (6 cents)
Profit BPS = (0.06 / 0.60) * 10000 = 1000 bps

Action:
  1. Buy parent at 0.60 (pay $60)
  2. Sell children at 0.66 total (receive $66)
  3. Net profit: $6
```

##### E. Opportunity Evaluation

```typescript
evaluateParent(state, parent) {
  const { startIndex, endIndex } = parent.coverage;
  
  // Calculate sums using prefix arrays
  const childrenSumAsk = sumRange(state, 'ask', startIndex, endIndex);
  const childrenSumBid = sumRange(state, 'bid', startIndex, endIndex);
  
  // Check Strategy 1: SELL_PARENT_BUY_CHILDREN
  if (parent.bestBid && childrenSumAsk) {
    const profitAbs = parent.bestBid - childrenSumAsk;
    const profitBps = (profitAbs / childrenSumAsk) * 10000;
    
    if (profitAbs > 0 && profitBps >= minProfitBps) {
      maybeEmitOpportunity(...);
    }
  }
  
  // Check Strategy 2: BUY_PARENT_SELL_CHILDREN
  if (parent.bestAsk && childrenSumBid) {
    const profitAbs = childrenSumBid - parent.bestAsk;
    const profitBps = (profitAbs / parent.bestAsk) * 10000;
    
    if (profitAbs > 0 && profitBps >= minProfitBps) {
      maybeEmitOpportunity(...);
    }
  }
}
```

##### F. Throttling & Cooldown

**Mục đích**: Tránh spam quá nhiều signals cho cùng một opportunity

```typescript
// Throttle: Scan group tối đa mỗi 200ms
scheduleScan(state) {
  if (state.scanTimer) return;  // Already scheduled
  
  const elapsed = now - state.lastScanAt;
  const delay = Math.max(0, throttleMs - elapsed);
  
  state.scanTimer = setTimeout(() => {
    scanGroup(state);
  }, delay);
}

// Cooldown: Emit cùng một opportunity tối đa mỗi 1000ms
maybeEmitOpportunity(...) {
  const key = `${parent.marketId}:${strategy}`;
  const lastEmitted = cooldowns.get(key) || 0;
  
  if (now - lastEmitted < cooldownMs) {
    return;  // Too soon
  }
  
  cooldowns.set(key, now);
  opportunity$.next(opportunity);
}
```

##### G. Configuration

**Environment Variables**:
```bash
ARB_MIN_PROFIT_BPS=5          # Minimum 5 bps profit
ARB_MIN_PROFIT_ABS=0          # Minimum absolute profit (optional)
ARB_SCAN_THROTTLE_MS=200      # Scan interval
ARB_COOLDOWN_MS=1000          # Cooldown between same opportunities
```

---

### 4. Thực Thi Paper Trading (Paper Execution)

#### 4.1 PaperExecutionService

**File**: `src/modules/strategy/paper-execution.service.ts`

**Mục đích**: Simulate việc thực thi trade để đánh giá performance

##### A. Execution Flow

```typescript
handleOpportunity(opportunity: ArbOpportunity) {
  // 1. Save signal to database
  const signal = await saveSignal(opportunity);
  // → Insert into arb_signals table
  
  // 2. Simulate trade execution
  const tradeResult = await simulateTrade(opportunity, signal.id);
  // → Simulate latency (50ms default)
  // → Build fills for parent + children
  // → Calculate actual PnL
  
  // 3. Save paper trade result
  await savePaperTrade(tradeResult);
  // → Insert into arb_paper_trades table
}
```

##### B. Trade Simulation

**SELL_PARENT_BUY_CHILDREN Example**:

```typescript
simulateTrade(opportunity, signalId) {
  await sleep(50);  // Simulate network latency
  
  const fills = [];
  const size = 100;  // $100 position
  
  // Sell parent at bid
  fills.push({
    assetId: parent.assetId,
    side: 'sell',
    price: parent.bestBid,  // 0.65
    size: 100
  });
  
  // Buy children at ask
  for (const child of children) {
    fills.push({
      assetId: child.assetId,
      side: 'buy',
      price: child.bestAsk,  // 0.20, 0.22, 0.21
      size: 100
    });
  }
  
  // Calculate PnL
  const parentCost = 0.65 * 100 = 65  (received)
  const childrenCost = (0.20 + 0.22 + 0.21) * 100 = 63  (paid)
  const pnlAbs = 65 - 63 = 2
  const pnlBps = (2 / 63) * 10000 = 317 bps
  
  return { fills, pnlAbs, pnlBps, ... };
}
```

##### C. Database Schema

**arb_signals Table**:
```sql
CREATE TABLE arb_signals (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP,
  group_key VARCHAR(255),
  event_slug VARCHAR(255),
  crypto VARCHAR(50),
  strategy ENUM('SELL_PARENT_BUY_CHILDREN', 'BUY_PARENT_SELL_CHILDREN'),
  parent_market_id VARCHAR(255),
  parent_asset_id VARCHAR(255),
  range_i INT,  -- Coverage start index
  range_j INT,  -- Coverage end index
  parent_best_bid DECIMAL(18,8),
  parent_best_ask DECIMAL(18,8),
  children_sum_ask DECIMAL(18,8),
  children_sum_bid DECIMAL(18,8),
  profit_abs DECIMAL(18,8),
  profit_bps DECIMAL(18,4),
  is_executable BOOLEAN,
  snapshot JSONB,  -- Full market snapshot
  timestamp_ms BIGINT
);
```

**arb_paper_trades Table**:
```sql
CREATE TABLE arb_paper_trades (
  id UUID PRIMARY KEY,
  created_at TIMESTAMP,
  signal_id UUID REFERENCES arb_signals(id) ON DELETE CASCADE,
  filled_size DECIMAL(18,8),
  entry JSONB,  -- Strategy details
  fills JSONB,  -- Array of fill objects
  pnl_abs DECIMAL(18,8),
  pnl_bps DECIMAL(18,4),
  latency_ms INT,
  timestamp_ms BIGINT
);
```

##### D. Statistics & Analytics

```typescript
async getStats() {
  const trades = await arbPaperTradeRepository.find();
  
  return {
    totalTrades: trades.length,
    totalPnlAbs: sum(trades.map(t => t.pnlAbs)),
    avgPnlBps: average(trades.map(t => t.pnlBps)),
    winRate: trades.filter(t => t.pnlAbs > 0).length / trades.length,
    avgLatencyMs: average(trades.map(t => t.latencyMs))
  };
}
```

---

### 5. Quản Lý Dữ Liệu (Data Management)

#### 5.1 RetentionCleanupService

**File**: `src/modules/strategy/retention-cleanup.service.ts`

**Mục đích**: Tự động dọn dẹp dữ liệu cũ để tránh database bloat

##### A. Cleanup Strategies

**1. Age-based Cleanup**:
```typescript
@Cron(CronExpression.EVERY_DAY_AT_3AM)
async cleanupByAge() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  
  // Delete paper trades first (foreign key)
  await arbPaperTradeRepository.delete({
    createdAt: LessThan(cutoffDate)
  });
  
  // Delete signals
  await arbSignalRepository.delete({
    createdAt: LessThan(cutoffDate)
  });
}
```

**2. Count-based Cleanup**:
```typescript
async cleanupByCount() {
  // Keep only top N records per group
  for (const groupKey of allGroupKeys) {
    const count = await arbSignalRepository.count({ groupKey });
    
    if (count > maxRecordsPerGroup) {
      const toDelete = count - maxRecordsPerGroup;
      
      // Delete oldest signals
      const oldestSignals = await arbSignalRepository.find({
        where: { groupKey },
        order: { createdAt: 'ASC' },
        take: toDelete
      });
      
      await arbSignalRepository.delete(oldestSignals.map(s => s.id));
    }
  }
}
```

##### B. Configuration

```bash
ARB_RETENTION_DAYS=7              # Keep data for 7 days
ARB_MAX_RECORDS_PER_GROUP=10000   # Max 10k records per group
ARB_CLEANUP_ENABLED=true          # Enable auto cleanup
```

---

### 6. API Endpoints (Strategy Controller)

**File**: `src/modules/strategy/strategy.controller.ts`

#### Available Endpoints

**1. Get Overall Statistics**
```http
GET /strategy/stats

Response:
{
  "signals": {
    "total": 15234,
    "executable": 8921,
    "recent": [...]
  },
  "paperTrades": {
    "totalTrades": 8921,
    "totalPnlAbs": 456.78,
    "avgPnlBps": 125.5,
    "winRate": 0.87,
    "avgLatencyMs": 52
  }
}
```

**2. Get Market Groups**
```http
GET /strategy/groups

Response:
{
  "total": 45,
  "groups": [
    {
      "groupKey": "bitcoin-price-dec-31",
      "eventSlug": "bitcoin-price-dec-31",
      "crypto": "BTC",
      "childrenCount": 12,
      "parentsCount": 2,
      "signalCount": 234
    },
    ...
  ]
}
```

**3. Get Arbitrage Signals**
```http
GET /strategy/signals?limit=100&groupKey=bitcoin-price-dec-31

Response:
{
  "total": 234,
  "limit": 100,
  "groupKey": "bitcoin-price-dec-31",
  "signals": [
    {
      "id": "uuid",
      "strategy": "SELL_PARENT_BUY_CHILDREN",
      "profitAbs": 0.02,
      "profitBps": 317,
      "createdAt": "2024-12-30T10:30:00Z",
      ...
    },
    ...
  ]
}
```

**4. Get Paper Trades**
```http
GET /strategy/paper-trades?limit=100&groupKey=bitcoin-price-dec-31

Response:
{
  "total": 150,
  "limit": 100,
  "groupKey": "bitcoin-price-dec-31",
  "trades": [
    {
      "id": "uuid",
      "pnlAbs": 0.02,
      "pnlBps": 317,
      "fills": [...],
      "createdAt": "2024-12-30T10:30:00Z"
    },
    ...
  ]
}
```

**5. Get Group Summary**
```http
GET /strategy/signals/:groupKey/summary

Response:
{
  "groupKey": "bitcoin-price-dec-31",
  "signalCount": 234,
  "avgProfitBps": 145.5,
  "maxProfitBps": 850,
  "strategies": [
    {
      "name": "SELL_PARENT_BUY_CHILDREN",
      "count": 120,
      "avgProfitBps": 135.2
    },
    {
      "name": "BUY_PARENT_SELL_CHILDREN",
      "count": 114,
      "avgProfitBps": 156.3
    }
  ]
}
```

**6. Retention Management**
```http
GET /strategy/retention/stats
POST /strategy/retention/cleanup
```

---

## Ví Dụ Thực Tế End-to-End

### Scenario: Bitcoin Price Arbitrage

**Setup**:
```
Event: "Bitcoin Price on Dec 31, 2024"

Markets:
- Parent: "Will Bitcoin be above $100,000?" 
  → bestBid: 0.65, bestAsk: 0.60
  
- Child 1: "Will Bitcoin be between $100k-$102k?"
  → bestBid: 0.21, bestAsk: 0.20
  
- Child 2: "Will Bitcoin be between $102k-$104k?"
  → bestBid: 0.23, bestAsk: 0.22
  
- Child 3: "Will Bitcoin be between $104k-$106k?"
  → bestBid: 0.22, bestAsk: 0.21
```

### Step-by-Step Flow

**1. Market Structure Analysis** (Initialization)
```typescript
// MarketStructureService.rebuild()
RangeGroup {
  groupKey: "bitcoin-price-dec-31",
  crypto: "BTC",
  
  parents: [
    {
      marketId: "parent-1",
      bounds: { lower: 100000 },
      kind: "above",
      role: "parent",
      clobTokenIds: ["token-parent"]
    }
  ],
  
  children: [
    {
      marketId: "child-1",
      bounds: { lower: 100000, upper: 102000 },
      kind: "range",
      role: "child",
      clobTokenIds: ["token-child-1"]
    },
    {
      marketId: "child-2",
      bounds: { lower: 102000, upper: 104000 },
      kind: "range",
      role: "child",
      clobTokenIds: ["token-child-2"]
    },
    {
      marketId: "child-3",
      bounds: { lower: 104000, upper: 106000 },
      kind: "range",
      role: "child",
      clobTokenIds: ["token-child-3"]
    }
  ]
}

// Compute coverage
parent.coverage = { startIndex: 0, endIndex: 2 }
// Parent covers all 3 children
```

**2. Arbitrage Engine Initialization**
```typescript
// ArbitrageEngineService.bootstrapGroups()
GroupState {
  group: <RangeGroup above>,
  
  childStates: [
    { bestBid: undefined, bestAsk: undefined, ... },
    { bestBid: undefined, bestAsk: undefined, ... },
    { bestBid: undefined, bestAsk: undefined, ... }
  ],
  
  parentStates: [
    { bestBid: undefined, bestAsk: undefined, coverage: {0, 2}, ... }
  ],
  
  askPrefix: [0, 0, 0, 0],
  bidPrefix: [0, 0, 0, 0],
  missingAskPrefix: [0, 1, 2, 3],  // All missing
  missingBidPrefix: [0, 1, 2, 3]
}

// Build indices
tokenIndex = {
  "token-parent": { groupKey: "bitcoin-price-dec-31", role: "parent", index: 0 },
  "token-child-1": { groupKey: "bitcoin-price-dec-31", role: "child", index: 0 },
  "token-child-2": { groupKey: "bitcoin-price-dec-31", role: "child", index: 1 },
  "token-child-3": { groupKey: "bitcoin-price-dec-31", role: "child", index: 2 }
}
```

**3. Receive WebSocket Updates**

**Update 1: Child 1 price change**
```typescript
// BufferService.pushPriceChange()
TopOfBookUpdate {
  assetId: "token-child-1",
  bestBid: 0.21,
  bestAsk: 0.20,
  timestampMs: 1703845200000
}

// ArbitrageEngineService.handleTopOfBook()
// → Lookup: tokenIndex["token-child-1"] = { groupKey: "...", role: "child", index: 0 }
// → Update childStates[0]
childStates[0] = { bestBid: 0.21, bestAsk: 0.20, ... }

// → Recalculate prefix sums
askPrefix = [0, 0.20, 0, 0]
bidPrefix = [0, 0.21, 0, 0]
missingAskPrefix = [0, 0, 1, 2]
missingBidPrefix = [0, 0, 1, 2]

// → scheduleScan() → Wait (incomplete data)
```

**Update 2: Child 2 price change**
```typescript
TopOfBookUpdate {
  assetId: "token-child-2",
  bestBid: 0.23,
  bestAsk: 0.22,
  timestampMs: 1703845201000
}

// Update childStates[1]
childStates[1] = { bestBid: 0.23, bestAsk: 0.22, ... }

// Recalculate prefix sums from index 1
askPrefix = [0, 0.20, 0.42, 0]
bidPrefix = [0, 0.21, 0.44, 0]
missingAskPrefix = [0, 0, 0, 1]
missingBidPrefix = [0, 0, 0, 1]

// scheduleScan() → Wait (still incomplete)
```

**Update 3: Child 3 price change**
```typescript
TopOfBookUpdate {
  assetId: "token-child-3",
  bestBid: 0.22,
  bestAsk: 0.21,
  timestampMs: 1703845202000
}

// Update childStates[2]
childStates[2] = { bestBid: 0.22, bestAsk: 0.21, ... }

// Recalculate prefix sums from index 2
askPrefix = [0, 0.20, 0.42, 0.63]
bidPrefix = [0, 0.21, 0.44, 0.66]
missingAskPrefix = [0, 0, 0, 0]  // All complete!
missingBidPrefix = [0, 0, 0, 0]

// scheduleScan() → Schedule scan after 200ms
```

**Update 4: Parent price change**
```typescript
TopOfBookUpdate {
  assetId: "token-parent",
  bestBid: 0.65,
  bestAsk: 0.60,
  timestampMs: 1703845203000
}

// Update parentStates[0]
parentStates[0] = { bestBid: 0.65, bestAsk: 0.60, coverage: {0, 2}, ... }

// scheduleScan() → Trigger scan immediately (already scheduled)
```

**4. Arbitrage Detection**

```typescript
// scanGroup() triggered after 200ms
evaluateParent(state, parentStates[0])

// Calculate sums using prefix arrays
childrenSumAsk = sumRange(state, 'ask', 0, 2)
  = askPrefix[3] - askPrefix[0]
  = 0.63 - 0 = 0.63

childrenSumBid = sumRange(state, 'bid', 0, 2)
  = bidPrefix[3] - bidPrefix[0]
  = 0.66 - 0 = 0.66

// Strategy 1: SELL_PARENT_BUY_CHILDREN
parentBestBid = 0.65
profitAbs = 0.65 - 0.63 = 0.02
profitBps = (0.02 / 0.63) * 10000 = 317 bps

// Check thresholds
if (profitAbs > 0 && profitBps >= 5) {  // ✓ Pass
  // Check cooldown
  const key = "parent-1:SELL_PARENT_BUY_CHILDREN";
  if (now - cooldowns.get(key) >= 1000) {  // ✓ Pass
    // Emit opportunity!
    opportunity$.next({
      groupKey: "bitcoin-price-dec-31",
      strategy: "SELL_PARENT_BUY_CHILDREN",
      parent: { bestBid: 0.65, bestAsk: 0.60, coverage: {0, 2}, ... },
      children: [
        { bestBid: 0.21, bestAsk: 0.20, index: 0, ... },
        { bestBid: 0.23, bestAsk: 0.22, index: 1, ... },
        { bestBid: 0.22, bestAsk: 0.21, index: 2, ... }
      ],
      childrenSumAsk: 0.63,
      childrenSumBid: 0.66,
      profitAbs: 0.02,
      profitBps: 317,
      isExecutable: true,
      timestampMs: 1703845203000
    });
    
    cooldowns.set(key, now);
  }
}

// Strategy 2: BUY_PARENT_SELL_CHILDREN
parentBestAsk = 0.60
profitAbs = 0.66 - 0.60 = 0.06
profitBps = (0.06 / 0.60) * 10000 = 1000 bps

// Check thresholds
if (profitAbs > 0 && profitBps >= 5) {  // ✓ Pass
  // Emit opportunity!
  opportunity$.next({
    strategy: "BUY_PARENT_SELL_CHILDREN",
    profitAbs: 0.06,
    profitBps: 1000,
    ...
  });
}
```

**5. Paper Execution**

```typescript
// PaperExecutionService receives opportunity
handleOpportunity(opportunity)

// 1. Save signal
const signal = await arbSignalRepository.save({
  groupKey: "bitcoin-price-dec-31",
  strategy: "BUY_PARENT_SELL_CHILDREN",
  parentMarketId: "parent-1",
  parentAssetId: "token-parent",
  rangeI: 0,
  rangeJ: 2,
  parentBestBid: 0.65,
  parentBestAsk: 0.60,
  childrenSumAsk: 0.63,
  childrenSumBid: 0.66,
  profitAbs: 0.06,
  profitBps: 1000,
  isExecutable: true,
  snapshot: { parent: {...}, children: [...] },
  timestampMs: 1703845203000
});
// → signal.id = "abc-123"

// 2. Simulate trade
await sleep(50);  // Simulate latency

const fills = [
  // Buy parent at ask
  { assetId: "token-parent", side: "buy", price: 0.60, size: 100 },
  
  // Sell children at bid
  { assetId: "token-child-1", side: "sell", price: 0.21, size: 100, index: 0 },
  { assetId: "token-child-2", side: "sell", price: 0.23, size: 100, index: 1 },
  { assetId: "token-child-3", side: "sell", price: 0.22, size: 100, index: 2 }
];

// Calculate PnL
parentCost = -0.60 * 100 = -60  (paid)
childrenCost = (0.21 + 0.23 + 0.22) * 100 = 66  (received)
pnlAbs = -60 + 66 = 6
pnlBps = (6 / 60) * 10000 = 1000 bps

// 3. Save paper trade
await arbPaperTradeRepository.save({
  signalId: "abc-123",
  filledSize: 100,
  entry: {
    strategy: "BUY_PARENT_SELL_CHILDREN",
    parentAssetId: "token-parent",
    childrenAssetIds: ["token-child-1", "token-child-2", "token-child-3"],
    timestampMs: 1703845203000
  },
  fills: fills,
  pnlAbs: 6,
  pnlBps: 1000,
  latencyMs: 52,
  timestampMs: 1703845203052
});

// Log success
logger.log("Paper trade executed: BUY_PARENT_SELL_CHILDREN on bitcoin-price-dec-31, profit: 6.0000 (1000.00 bps)");
```

**6. Query Results via API**

```bash
# Get stats
curl http://localhost:3000/strategy/stats

# Get signals for this group
curl http://localhost:3000/strategy/signals?groupKey=bitcoin-price-dec-31&limit=10

# Get paper trades
curl http://localhost:3000/strategy/paper-trades?groupKey=bitcoin-price-dec-31&limit=10
```

---

## Performance Optimizations

### 1. Prefix Sum Arrays
- **Problem**: Tính tổng giá của N child markets mỗi lần scan → O(N)
- **Solution**: Prefix sums → O(1) range queries
- **Impact**: Giảm complexity từ O(N*M) xuống O(M) cho M parent markets

### 2. Index Lookups
- **Problem**: Tìm market trong group từ assetId/slug → O(N)
- **Solution**: Hash maps (tokenIndex, slugIndex, marketIdIndex) → O(1)
- **Impact**: Instant market lookup

### 3. Throttling & Cooldown
- **Problem**: Quá nhiều signals cho cùng opportunity
- **Solution**: 
  - Throttle: Scan group tối đa mỗi 200ms
  - Cooldown: Emit opportunity tối đa mỗi 1000ms
- **Impact**: Giảm database writes, tránh spam

### 4. Incremental Prefix Updates
- **Problem**: Recalculate toàn bộ prefix array mỗi update → O(N)
- **Solution**: Chỉ update từ index thay đổi → O(N-i)
- **Impact**: Faster updates cho markets đầu array

### 5. RxJS Reactive Streams
- **Problem**: Polling hoặc tight coupling giữa modules
- **Solution**: Event-driven architecture với RxJS Observables
- **Impact**: Loose coupling, better scalability

---

## Configuration Reference

### Environment Variables

```bash
# Arbitrage Engine
ARB_MIN_PROFIT_BPS=5              # Minimum profit in basis points (default: 5)
ARB_MIN_PROFIT_ABS=0              # Minimum absolute profit (default: 0)
ARB_SCAN_THROTTLE_MS=200          # Scan throttle interval (default: 200ms)
ARB_COOLDOWN_MS=1000              # Cooldown between same opportunities (default: 1000ms)

# Paper Trading
PAPER_TRADE_SIZE=100              # Position size for paper trades (default: $100)
PAPER_TRADE_LATENCY_MS=50         # Simulated execution latency (default: 50ms)

# Retention & Cleanup
ARB_RETENTION_DAYS=7              # Keep data for N days (default: 7)
ARB_MAX_RECORDS_PER_GROUP=10000   # Max records per group (default: 10000)
ARB_CLEANUP_ENABLED=true          # Enable auto cleanup (default: true)
```

---

## Monitoring & Debugging

### Logs

**Key Log Messages**:
```
[MarketStructureService] Rebuilt 45 market groups
[ArbitrageEngineService] Arbitrage engine initialized for 45 groups
[ArbitrageEngineService] Opportunity detected: SELL_PARENT_BUY_CHILDREN on bitcoin-price-dec-31, profit: 317 bps
[PaperExecutionService] Paper trade executed: BUY_PARENT_SELL_CHILDREN on bitcoin-price-dec-31, profit: 6.0000 (1000.00 bps)
[RetentionCleanupService] Deleted 1234 old paper trades
[RetentionCleanupService] Deleted 567 old signals
```

### Metrics to Monitor

1. **Signal Rate**: Số signals phát hiện per minute
2. **Win Rate**: % paper trades có profit > 0
3. **Average Profit BPS**: Trung bình profit theo basis points
4. **Latency**: Thời gian từ price update → signal emission
5. **Database Size**: Số records trong arb_signals & arb_paper_trades

### Common Issues

**Issue 1: No opportunities detected**
- Check: Market groups có được build đúng không? (`GET /strategy/groups`)
- Check: TopOfBook updates có đến không? (check logs)
- Check: Thresholds có quá cao không? (ARB_MIN_PROFIT_BPS)

**Issue 2: Too many signals**
- Increase: ARB_MIN_PROFIT_BPS
- Increase: ARB_COOLDOWN_MS
- Check: Market data có bị stale không?

**Issue 3: Database growing too fast**
- Decrease: ARB_RETENTION_DAYS
- Decrease: ARB_MAX_RECORDS_PER_GROUP
- Enable: ARB_CLEANUP_ENABLED

---

## Future Enhancements

### 1. Real Execution
- Integrate với Polymarket API để thực thi trades thật
- Implement risk management (position limits, max loss)
- Add order routing & execution algorithms

### 2. Advanced Strategies
- Multi-leg arbitrage (3+ markets)
- Cross-event arbitrage
- Time-based arbitrage (expiry mismatch)

### 3. Machine Learning
- Predict optimal entry/exit timing
- Learn market microstructure patterns
- Optimize position sizing

### 4. Performance
- Distributed processing với Redis Streams
- Parallel group scanning
- GPU acceleration cho large-scale calculations

---

## Kết Luận

Strategy Module là một hệ thống arbitrage hoàn chỉnh với:

✅ **Real-time Processing**: Xử lý WebSocket events trong milliseconds
✅ **Smart Grouping**: Tự động phân loại và nhóm markets liên quan
✅ **Efficient Detection**: O(1) arbitrage detection với prefix sums
✅ **Paper Trading**: Simulate execution để đánh giá performance
✅ **Data Management**: Auto cleanup để tránh database bloat
✅ **RESTful API**: Query signals, trades, stats dễ dàng

Hệ thống có thể scale để xử lý hàng trăm market groups và hàng nghìn price updates mỗi giây.


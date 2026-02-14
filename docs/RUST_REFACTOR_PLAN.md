# 🦀 RUST REFACTOR PLAN — Hybrid HFT Architecture

> **Tài liệu kiến trúc**: Chuyển đổi hệ thống bot arbitrage Polymarket từ NestJS thuần sang kiến trúc Hybrid (Node.js Shell + Rust Core).
>
> **Ngày tạo**: 2026-02-08
> **Phiên bản**: 1.0

---

## Mục lục

1. [Mục tiêu](#1-mục-tiêu)
2. [Kiến trúc hiện tại (AS-IS)](#2-kiến-trúc-hiện-tại-as-is)
3. [Kiến trúc đề xuất (TO-BE)](#3-kiến-trúc-đề-xuất-to-be)
4. [Phạm vi công việc](#4-phạm-vi-công-việc)
5. [Thiết kế kỹ thuật chi tiết](#5-thiết-kế-kỹ-thuật-chi-tiết)
6. [Bridge — Giao tiếp Node.js ↔ Rust](#6-bridge--giao-tiếp-nodejs--rust)
7. [Concurrency Model trong Rust](#7-concurrency-model-trong-rust)
8. [Memory Layout tối ưu](#8-memory-layout-tối-ưu)
9. [Kế hoạch triển khai (Phasing)](#9-kế-hoạch-triển-khai-phasing)
10. [Risk Assessment & Rollback Plan](#10-risk-assessment--rollback-plan)
11. [Benchmark & KPI](#11-benchmark--kpi)

---

## 1. Mục tiêu

### Vấn đề hiện tại

Hệ thống NestJS hiện tại đã được tối ưu ở mức JavaScript tốt nhất có thể (O(1) jump-table, zero-await hot path, dirty checking, two-phase evaluation). Tuy nhiên, **giới hạn cốt lõi của V8 runtime** vẫn còn:

| Bottleneck | Ảnh hưởng | Thời gian hiện tại |
|---|---|---|
| **GC Pauses** (V8 Minor/Major GC) | Jitter 2–50ms không kiểm soát được | Không dự đoán được |
| **JSON.parse()** trên WebSocket message | Blocking event loop | ~0.1–0.5ms/message |
| **Object allocation** trong `buildOpportunity` | GC pressure, Phase 2 mất ~1–2.5ms | ~1–2.5ms |
| **RxJS Subject overhead** | Subscription dispatch, closure creation | ~0.05–0.1ms |
| **Single-threaded Event Loop** | Socket I/O và Strategy tính toán chia sẻ cùng 1 thread | Tổng latency cộng dồn |
| **EIP-712 signing** (đã có native-core) | Đã tối ưu bằng Rust N-API | ~0.5ms (đã tối ưu) |

### Mục tiêu sau refactor

| Metric | Hiện tại (Node.js) | Mục tiêu (Rust Core) |
|---|---|---|
| **Socket → Signal latency** | ~3–10ms (bao gồm GC jitter) | **< 50µs** (deterministic) |
| **GC Pauses** | 2–50ms random | **0ms** (no GC) |
| **Message parse + Orderbook update** | ~0.1–0.5ms | **< 10µs** |
| **Trio profit calculation** | ~0.05ms | **< 1µs** |
| **Opportunity object build** | ~1–2.5ms | **< 5µs** (flat struct, zero alloc) |
| **End-to-end (Socket → API submit)** | ~5–50ms | **< 1ms** (excluding network) |

### Triết lý chuyển đổi

```
┌─────────────────────────────────────────────────────────────────────┐
│  GIỮ LẠI NODE.JS (Cold Path)     │   CHUYỂN SANG RUST (Hot Path)  │
│                                    │                                │
│  ✅ NestJS DI, Module system       │   🦀 WebSocket recv/parse      │
│  ✅ TypeORM + PostgreSQL           │   🦀 Orderbook state machine   │
│  ✅ Telegram notifications         │   🦀 Arbitrage calculation     │
│  ✅ Cron jobs (balance, market)    │   🦀 Order signing (mở rộng)   │
│  ✅ Redis read/write (background)  │   🦀 API submit (batchOrder)   │
│  ✅ REST API controllers           │   🦀 Memory-managed structs    │
│  ✅ ClickHouse logging             │                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Kiến trúc hiện tại (AS-IS)

### Data Flow Pipeline

```
Polymarket WS ──┐
                 ▼
     ┌──────────────────────┐
     │  SocketManagerService │  ← Node.js `ws` library
     │  (handleMessage)      │  ← JSON.parse() trên event loop
     └──────────┬───────────┘
                │ MarketData / PriceChangeData
                ▼
     ┌──────────────────────┐
     │    BufferService      │  ← findBestBidAsk(), emitTopOfBook()
     │    (push/pushPC)      │  ← Object allocation cho TopOfBookUpdate
     └──────────┬───────────┘
                │ TopOfBookUpdate (RxJS Subject)
                ▼
     ┌──────────────────────┐
     │ MarketDataStreamService│  ← RxJS Subject.next() dispatch
     └──────────┬───────────┘
                │
                ▼
     ┌──────────────────────┐
     │ ArbitrageEngineTrioSvc│  ← handleTopOfBook()
     │  - Dirty checking     │  ← O(1) jump-table via trioTokenIndex
     │  - TrioState update   │  ← calcTrioProfitOnly() (math-only)
     │  - Profit evaluation  │  ← buildOpportunity() (heavy alloc)
     └──────────┬───────────┘
                │ ArbOpportunity (RxJS Subject)
                ▼
     ┌──────────────────────┐
     │ RealExecutionService  │  ← handleOpportunity() (zero-await)
     │  - shouldSkip check   │  ← Sync validation, balance check
     │  - prepareBatchOrders │  ← Slippage, min order adjustment
     │  - Fire & Forget      │  ← placeBatchOrdersNative() (async)
     └──────────┬───────────┘
                │ BatchOrderParams[]
                ▼
     ┌──────────────────────┐
     │ PolymarketOnchainSvc  │  ← native-core (Rust N-API signing)
     │  - signClobOrdersBatch│  ← client.postOrders() (HTTP to CLOB)
     └──────────────────────┘
```

### Cấu trúc dữ liệu chính hiện tại

```typescript
// In-memory state: ~6 Maps, nested objects
ArbitrageEngineTrioService {
  groups: Map<string, GroupState>           // groupKey → state
  tokenIndex: Map<string, MarketLocator>    // assetId → locator
  trioTokenIndex: Map<string, TrioLocator>  // assetId → trio locator
  lastPriceCache: Map<string, PriceEntry>   // assetId → last price
  // ...
}

// Mỗi GroupState chứa:
GroupState {
  group: RangeGroup                    // Metadata (descriptors, slugs, bounds)
  childStates: MarketSnapshot[]        // Range market snapshots
  parentStates: ParentState[]          // Parent market snapshots
  trioStates: TrioState[]              // Flat trio structures
  cooldowns: Map<string, number>       // Cooldown tracking
  trioLookupByAsset: Map<string, number[]>  // Asset → trio indices
}

// TrioState (đã flat, nhưng vẫn là JS object):
TrioState {
  parentLowerIndex: number
  parentUpperIndex: number
  rangeIndex: number
  lowerYes: TrioLegSnapshot   // { assetId, bestBid, bestAsk, bestBidSize, bestAskSize, timestampMs }
  upperNo: TrioLegSnapshot
  rangeNo: TrioLegSnapshot
}
```

**Vấn đề memory của JS objects:**
- Mỗi JS object có hidden class + property map → overhead ~64–128 bytes/object
- `Map<string, ...>` dùng hash table với string keys → pointer chasing, cache miss
- Nested objects (`TrioState.lowerYes.bestBid`) → nhiều indirection levels
- `ArbOpportunity` object build: ~20+ properties, nested children array → GC pressure cao

---

## 3. Kiến trúc đề xuất (TO-BE)

### Sơ đồ tổng quan

```
                    ┌─────────────────────────────────────────────────┐
                    │              RUST CORE (Background Threads)      │
                    │                                                  │
  Polymarket WS ──► │  [Thread 1: Socket]  ──► [Thread 2: Engine]     │
                    │   tungstenite recv        Orderbook update       │
                    │   simd_json parse         Trio evaluation        │
                    │   lock-free channel        Profit calc            │
                    │                                  │                │
                    │                          Signal found?            │
                    │                              │ YES                │
                    │                              ▼                    │
                    │                     [Thread 3: Executor]         │
                    │                      Sign (EIP-712)              │
                    │                      HTTP POST batchOrder         │
                    │                              │                    │
                    │                    ──────────┴──────────          │
                    │                   │ N-API callback │              │
                    └───────────────────┼────────────────┼──────────────┘
                                        │                │
                                        ▼                ▼
                    ┌─────────────────────────────────────────────────┐
                    │         NODE.JS SHELL (NestJS, Event Loop)       │
                    │                                                  │
                    │   onTradeResult(result) ──► Save to DB (TypeORM)│
                    │                         ──► Telegram notify      │
                    │                         ──► Update balance cache │
                    │                                                  │
                    │   Cron Jobs:                                      │
                    │     - crawlMarkets (20 min)                      │
                    │     - refreshBalance (5s, qua Redis)             │
                    │     - cleanupExpiredGroups                        │
                    │                                                  │
                    │   REST API:                                       │
                    │     - enable/disable trading                     │
                    │     - get status/metrics                         │
                    └─────────────────────────────────────────────────┘
```

### Ưu điểm so với kiến trúc hiện tại

| Aspect | Hiện tại (Node.js) | Đề xuất (Rust Core) |
|---|---|---|
| GC | V8 GC gây jitter | Zero GC, deterministic latency |
| Threading | Single-threaded event loop | Multi-threaded (Socket / Engine / Executor) |
| Memory | JS objects + Maps (fragmented) | Flat structs, arena allocation, cache-aligned |
| JSON parse | `JSON.parse()` blocking | `simd_json` SIMD-accelerated |
| WebSocket | `ws` (JS lib, event loop) | `tungstenite` (native, direct TCP) |
| Network | Axios/fetch (JS → libuv) | `reqwest` + `hyper` (native HTTP) |

---

## 4. Phạm vi công việc

### 4.1. Rust Core — Hot Path (chuyển sang Rust)

#### A. Socket & Data Ingestion

| Component | Hiện tại (Node.js) | Mục tiêu (Rust) |
|---|---|---|
| WebSocket client | `ws` library | `tokio-tungstenite` |
| Message parse | `JSON.parse()` | `simd_json` |
| Top-of-book extract | `findBestBidAsk()` in BufferService | Inline parser, zero-copy |
| Subscription management | `SocketManagerService` (Map-based) | `HashMap<ConnectionId, WsStream>` |
| Reconnection | JS setTimeout + exponential backoff | Tokio timer + backoff |

**Hiện tại trong `socket-manager.service.ts`:**
```typescript
// 453 lines — quản lý WS connections, parse message, push to buffer
handleMessage(connectionId, data) {
  const message = data.toString();        // Buffer → String copy
  const parsed = JSON.parse(message);     // Full JSON parse
  // ... extract bids/asks ...
  this.bufferService.push(marketData);    // Object allocation
}
```

**Mục tiêu Rust:**
```rust
// Zero-copy parse, streaming directly to orderbook state
fn on_ws_message(raw: &[u8], state: &mut EngineState) {
    // simd_json: parse in-place, no allocation
    let msg: WsMessage = simd_json::from_slice(raw)?;
    match msg.event_type {
        EventType::Book => update_orderbook(msg, state),
        EventType::PriceChange => update_top_of_book(msg, state),
    }
}
```

#### B. Arbitrage Engine (Strategy)

| Component | Hiện tại | Mục tiêu |
|---|---|---|
| State management | `Map<string, GroupState>` | `Vec<GroupState>` + index arrays |
| Token lookup | `Map<string, TrioLocator>` | `HashMap<u64, TrioLocator>` (hashed token ID) |
| Dirty checking | `lastPriceCache` Map | Inline `prev_bid/prev_ask` fields in struct |
| Trio evaluation | `calcTrioProfitOnly()` JS function | Inline arithmetic, SIMD potential |
| Cooldown tracking | `Map<string, number>` | `Vec<u64>` indexed by trio_id |
| Opportunity emit | RxJS Subject + subscriber dispatch | Crossbeam channel (lock-free) |

**Hiện tại trong `arbitrage-engine-trio.service.ts`:**
```typescript
// 1018 lines — O(1) jump-table, nhưng vẫn có JS overhead
evaluateSingleTrio(state, trio) {
  const result = this.calcTrioProfitOnly(trio);  // Math-only
  if (!result) return;
  const now = Date.now();                        // Syscall
  const lastEmitted = state.cooldowns.get(key);  // Map lookup (string hash)
  if (!lastEmitted || now - lastEmitted >= cooldownMs) {
    state.cooldowns.set(key, now);
    this.opportunity$.next(result.opportunity);   // RxJS dispatch + alloc
  }
}
```

**Mục tiêu Rust:**
```rust
#[inline(always)]
fn evaluate_trio(trio: &TrioState, config: &Config) -> Option<Signal> {
    let ask_sum = trio.lower_yes.best_ask + trio.upper_no.best_ask + trio.range_no.best_ask;
    let profit = PAYOUT - ask_sum;
    let profit_bps = (profit / ask_sum) * 10000.0;

    if profit < config.min_profit_abs || profit_bps < config.min_profit_bps {
        return None;
    }

    // Cooldown check: indexed by trio_id, no string hashing
    let now = Instant::now();
    if now.duration_since(trio.last_emitted) < config.cooldown {
        return None;
    }

    Some(Signal { trio_id: trio.id, profit, profit_bps, ask_sum, .. })
}
```

#### C. Execution (Order Signing + API Submit)

| Component | Hiện tại | Mục tiêu |
|---|---|---|
| Order validation | `shouldSkipOpportunity()` JS sync | Rust inline validation |
| Slippage calculation | `applySlippage()` JS function | Rust const fn |
| Batch order build | `prepareBatchOrdersSync()` JS | Rust struct, zero alloc |
| EIP-712 signing | `native-core` N-API (đã Rust) | Integrated, cùng process |
| HTTP POST | `axios` → `client.postOrders()` | `reqwest` native HTTP |
| Balance check | `localUsdcBalance` (JS number) | `AtomicU64` hoặc shared state |

**Quan trọng:** Hiện tại `PolymarketOnchainService.placeBatchOrdersNative()` đã dùng Rust N-API cho signing (`this.nativeModule.signClobOrdersBatch`), nhưng:
- Vẫn phải serialize/deserialize qua N-API boundary (JS ↔ Rust)
- Vẫn dùng `axios` JS cho HTTP POST
- Vẫn chạy trên event loop (Promise-based)

**Mục tiêu:** Signing + HTTP POST + Response handling **hoàn toàn trong Rust**, chỉ callback về Node khi có kết quả cuối cùng.

#### D. Memory Optimization

**Vấn đề hiện tại:**
- `ArbOpportunity` interface có ~30 fields, nested objects (`parent`, `parentUpper`, `children[]`, `polymarketTriangleContext`)
- `MarketSnapshot` chứa `descriptor: MarketRangeDescriptor` — đầy đủ metadata (slug, bounds, marketId, clobTokenIds[], negRisk, ...)
- Mỗi lần emit opportunity: clone toàn bộ descriptors → GC pressure
- `GroupState.cooldowns`: `Map<string, number>` — string concat cho key → allocation

### 4.2. Node.js Shell — Cold Path (giữ lại)

| Component | Service | Lý do giữ lại |
|---|---|---|
| Database ORM | TypeORM + PostgreSQL | NestJS ecosystem, migration tools |
| Telegram | TelegramService | Low frequency, async OK |
| Market crawl | MarketService | Cron job 20 phút/lần |
| Balance check | Worker (Redis read) | Background, 5s interval |
| REST API | Controllers | Low latency not critical |
| ClickHouse logging | BufferService.flush() | Batch write, not hot path |
| Position management | ManagePositionQueueService | Async queue processing |
| Minting queue | MintQueueService | Async, low frequency |

---

## 5. Thiết kế kỹ thuật chi tiết

### 5.1. Rust Crate Structure

```
rust-core/
├── Cargo.toml
├── src/
│   ├── lib.rs                  # N-API entry point (neon bindings)
│   ├── engine/
│   │   ├── mod.rs
│   │   ├── state.rs            # EngineState, GroupState, TrioState
│   │   ├── orderbook.rs        # Top-of-book update logic
│   │   ├── trio_evaluator.rs   # Profit calculation, signal detection
│   │   └── range_evaluator.rs  # Bundling/Unbundling arbitrage
│   ├── socket/
│   │   ├── mod.rs
│   │   ├── ws_client.rs        # WebSocket client (tungstenite)
│   │   ├── parser.rs           # simd_json message parser
│   │   └── manager.rs          # Connection pool, reconnection
│   ├── executor/
│   │   ├── mod.rs
│   │   ├── signer.rs           # EIP-712 signing (from native-core)
│   │   ├── api_client.rs       # HTTP POST to Polymarket CLOB
│   │   ├── slippage.rs         # Price adjustment logic
│   │   └── validator.rs        # Order validation (balance, cooldown)
│   ├── bridge/
│   │   ├── mod.rs
│   │   ├── napi_exports.rs     # Exported functions to Node.js
│   │   └── callbacks.rs        # Callback mechanism to Node.js
│   └── types/
│       ├── mod.rs
│       ├── market.rs           # MarketDescriptor, TokenId
│       ├── signal.rs           # Signal, ArbOpportunity (flat)
│       └── order.rs            # BatchOrderParams, OrderResult
```

### 5.2. Rust Dependencies (Cargo.toml)

```toml
[dependencies]
# N-API Bridge
neon = "1.0"

# Async Runtime
tokio = { version = "1", features = ["full"] }

# WebSocket
tokio-tungstenite = { version = "0.24", features = ["native-tls"] }

# JSON Parse (SIMD-accelerated)
simd-json = "0.14"
serde = { version = "1", features = ["derive"] }
serde_json = "1"  # fallback

# HTTP Client
reqwest = { version = "0.12", features = ["json", "native-tls"] }

# Crypto (EIP-712)
ethers-core = "2.0"  # hoặc alloy
k256 = "0.13"
tiny-keccak = { version = "2", features = ["keccak"] }

# Concurrency
crossbeam-channel = "0.5"
parking_lot = "0.12"

# Utilities
tracing = "0.1"
tracing-subscriber = "0.3"
```

---

## 6. Bridge — Giao tiếp Node.js ↔ Rust

### 6.1. Phương án lựa chọn: **N-API (Neon Bindings)**

| Phương án | Ưu điểm | Nhược điểm | Latency |
|---|---|---|---|
| **N-API (Neon)** ✅ | In-process, shared memory, no serialization overhead | Phải quản lý thread safety | **< 1µs** per call |
| Redis Pub/Sub | Simple, decoupled | Serialize/deserialize, network hop | ~100–500µs |
| Unix Socket | Process isolation | IPC overhead, serialization | ~50–200µs |
| gRPC | Strong typing, language-agnostic | Heavy framework, latency | ~200–1000µs |

**Lý do chọn N-API:**
1. **Zero-copy**: Rust threads chạy trong cùng process với Node.js, có thể share memory trực tiếp
2. **Đã có tiền lệ**: `native-core` module hiện tại đã dùng N-API cho EIP-712 signing
3. **Callback mechanism**: Neon hỗ trợ `Channel` để gọi JS callback từ Rust thread mà không block event loop
4. **Không cần serialize**: Signal data có thể pass qua N-API boundary bằng JsObject construction trực tiếp

### 6.2. Bridge API Design

```rust
// === Rust → Node.js (Callbacks) ===

/// Gọi khi phát hiện arbitrage signal
/// Node.js sẽ nhận callback với TradeResult để log DB + Telegram
fn on_trade_result(callback: JsFunction) -> NeonResult<()>;

/// Gọi khi có lỗi cần Node.js xử lý
fn on_error(callback: JsFunction) -> NeonResult<()>;

/// Gọi khi cần metrics/logging
fn on_metrics(callback: JsFunction) -> NeonResult<()>;

// === Node.js → Rust (Control) ===

/// Khởi tạo Rust engine với config
fn init_engine(config: EngineConfig) -> NeonResult<()>;

/// Cập nhật market structure (sau khi Node.js crawl markets)
fn update_market_structure(groups: Vec<RangeGroup>) -> NeonResult<()>;

/// Cập nhật balance (sau khi Node.js read Redis)
fn update_balance(usdc_balance: f64, minted_assets: HashMap<String, f64>) -> NeonResult<()>;

/// Enable/Disable trading (runtime control)
fn set_trading_enabled(enabled: bool) -> NeonResult<()>;

/// Cập nhật config (slippage, thresholds)
fn update_config(config: RuntimeConfig) -> NeonResult<()>;

/// Shutdown gracefully
fn shutdown() -> NeonResult<()>;
```

### 6.3. Communication Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        RUST PROCESS                              │
│                                                                  │
│  [Socket Thread] ─── crossbeam channel ───► [Engine Thread]     │
│       ▲                                          │               │
│       │                                     Signal found?        │
│       │                                     ┌─── YES            │
│       │                                     ▼                    │
│       │                              [Executor Thread]           │
│       │                               Sign + POST               │
│       │                                     │                    │
│       │                              TradeResult                 │
│       │                                     │                    │
│       │                              Neon Channel                │
│       │                                     │                    │
└───────┼─────────────────────────────────────┼────────────────────┘
        │                                     │
        │  update_market_structure()          │  on_trade_result(callback)
        │  update_balance()                   │
        │                                     ▼
┌───────┴─────────────────────────────────────────────────────────┐
│                    NODE.JS EVENT LOOP                             │
│                                                                  │
│   NestJS Services:                                               │
│   - MarketService.crawlMarkets() → update_market_structure()    │
│   - refreshBalancesBackground() → update_balance()              │
│   - onTradeResult() → saveTradeResultAsync() + telegramNotify() │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Concurrency Model trong Rust

### 7.1. Thread Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                    TOKIO RUNTIME (multi-threaded)                  │
│                                                                    │
│  ┌─────────────────┐    mpsc channel    ┌──────────────────────┐  │
│  │ Task: WS Pool   │ ─────────────────► │ Task: Engine Loop    │  │
│  │                  │   TopOfBookMsg     │                      │  │
│  │ for each conn:   │                   │ 1. Lookup TrioState  │  │
│  │  - recv frame    │                   │ 2. Dirty check       │  │
│  │  - simd_json     │                   │ 3. Update snapshot   │  │
│  │  - extract TOB   │                   │ 4. Evaluate profit   │  │
│  │  - send to chan   │                   │ 5. Cooldown check    │  │
│  │                  │                   │ 6. Send signal       │  │
│  └─────────────────┘                   └──────────┬───────────┘  │
│                                                    │               │
│                                              Signal channel        │
│                                                    │               │
│                                        ┌───────────▼───────────┐  │
│                                        │ Task: Executor        │  │
│                                        │                       │  │
│                                        │ 1. Validate balance   │  │
│                                        │ 2. Build orders       │  │
│                                        │ 3. Apply slippage     │  │
│                                        │ 4. EIP-712 sign       │  │
│                                        │ 5. HTTP POST          │  │
│                                        │ 6. Callback to Node   │  │
│                                        └───────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 7.2. Channel Design

```rust
// WS Task → Engine: unbounded, high throughput
let (ws_tx, ws_rx) = tokio::sync::mpsc::unbounded_channel::<TopOfBookMsg>();

// Engine → Executor: bounded, backpressure
let (signal_tx, signal_rx) = tokio::sync::mpsc::channel::<Signal>(16);

// Node.js → Rust: control commands
let (control_tx, control_rx) = tokio::sync::mpsc::channel::<ControlCmd>(64);
```

### 7.3. Shared State Strategy

```rust
/// Engine state — owned by Engine task, read-only shared via Arc<RwLock>
struct SharedState {
    // Updated by Node.js via control channel
    usdc_balance: AtomicU64,          // f64 as u64 bits (no lock needed)
    trading_enabled: AtomicBool,
    config: RwLock<RuntimeConfig>,

    // Updated by Engine, read by Executor
    minted_assets: RwLock<HashMap<u64, f64>>,
}

/// Engine-exclusive state (no sharing needed)
struct EngineState {
    groups: Vec<GroupState>,
    token_index: HashMap<u64, TokenLocator>,
    trio_states: Vec<TrioState>,
    // ... all hot-path data
}
```

---

## 8. Memory Layout tối ưu

### 8.1. Thiết kế lại cấu trúc dữ liệu

**Nguyên tắc:**
1. **Struct-of-Arrays (SoA)** thay vì Array-of-Structs cho data được scan tuần tự
2. **Flat indices** thay vì nested pointers/references
3. **Fixed-size types** để tránh heap allocation
4. **Cache-line alignment** (64 bytes) cho hot data

```rust
/// Compact representation of a single leg snapshot
/// Total size: 40 bytes (fits in cache line with partner)
#[repr(C, align(8))]
#[derive(Clone, Copy, Default)]
struct LegSnapshot {
    best_bid: f32,          // 4 bytes (f32 đủ chính xác cho price 0.00–1.00)
    best_ask: f32,          // 4 bytes
    best_bid_size: f32,     // 4 bytes
    best_ask_size: f32,     // 4 bytes
    timestamp_ms: u64,      // 8 bytes
    asset_id_hash: u64,     // 8 bytes (hash of token ID string, dùng cho lookup)
    _padding: [u8; 8],      // cache alignment
}

/// Flat TrioState — all 3 legs inline, no pointers
/// Total size: 128 bytes = 2 cache lines → excellent locality
#[repr(C, align(64))]
#[derive(Clone, Copy)]
struct TrioState {
    lower_yes: LegSnapshot,    // 40 bytes
    upper_no: LegSnapshot,     // 40 bytes
    range_no: LegSnapshot,     // 40 bytes
    last_emitted_ns: u64,      // 8 bytes (cooldown tracking, inline!)
}

/// GroupState — flat arrays, no Maps
struct GroupState {
    group_key_hash: u64,
    event_slug: CompactString,    // stack-allocated small string
    crypto: CompactString,

    // SoA layout for sequential scan
    trio_states: Vec<TrioState>,          // Contiguous memory
    child_snapshots: Vec<LegSnapshot>,    // Contiguous
    parent_snapshots: Vec<LegSnapshot>,   // Contiguous

    // Metadata (cold, not accessed in hot path)
    descriptors: Vec<MarketDescriptor>,   // Separated from hot data
}

/// Token lookup: hash(assetId) → (group_index, trio_index, role)
/// Using a flat HashMap with u64 keys (pre-hashed token IDs)
struct TokenLocator {
    group_idx: u16,
    trio_idx: u16,
    role: TrioRole,     // enum: LowerYes, UpperNo, RangeNo (1 byte)
}
```

### 8.2. So sánh Memory Footprint

| Structure | JavaScript | Rust | Tiết kiệm |
|---|---|---|---|
| TrioState (3 legs) | ~384 bytes (3 objects + hidden classes) | **128 bytes** | **3x** |
| LegSnapshot | ~128 bytes (object + properties) | **40 bytes** | **3.2x** |
| Token lookup entry | ~96 bytes (Map entry + string key) | **13 bytes** | **7.4x** |
| Cooldown entry | ~72 bytes (Map entry + string key + number) | **8 bytes (inline)** | **9x** |
| 100 Trios total | ~38.4 KB | **~12.8 KB** | **3x** |

### 8.3. Signal Output (Rust → Node.js)

```rust
/// Compact signal — only essential execution data
/// No descriptors, no metadata — Node.js sẽ lookup từ cached state nếu cần
#[derive(Clone)]
struct Signal {
    trio_id: u32,              // Index to resolve group + trio
    strategy: Strategy,        // enum: TriangleBuy, Unbundle, Bundle
    profit_abs: f64,
    profit_bps: f64,
    // 3 legs: (asset_id_hash, price, side)
    legs: [(u64, f32, Side); 3],
    timestamp_ns: u64,
}

/// Trade result — sent back from Executor to Node.js
struct TradeResult {
    signal: Signal,
    success: bool,
    order_ids: Vec<String>,     // Polymarket order IDs
    failed_orders: Vec<FailedOrder>,
    total_cost: f64,
    expected_pnl: f64,
    latency_us: u64,           // Microseconds!
}
```

---

## 9. Kế hoạch triển khai (Phasing)

### Phase 1: Rust Core Foundation + Socket (Ước tính: 2–3 tuần)

**Mục tiêu:** Dựng khung Rust, kết nối WebSocket, parse message, và emit `TopOfBookUpdate` về Node.js qua N-API.

**Deliverables:**

- [ ] Khởi tạo Rust crate (`rust-core/`) với Neon bindings
- [ ] Implement WebSocket client (`tokio-tungstenite`)
  - Kết nối tới `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - Subscription management (add/remove tokens)
  - Auto-reconnection với exponential backoff
  - Ping/pong handling
- [ ] Implement message parser (`simd_json`)
  - Parse `event_type: "book"` → extract bids/asks → compute best bid/ask
  - Parse `event_type: "price_change"` → extract best_bid/best_ask
  - Benchmark vs current `JSON.parse()` implementation
- [ ] N-API Bridge: `init_socket()`, `subscribe_tokens()`, `on_top_of_book(callback)`
- [ ] Integration test: Rust WS → parse → callback vào Node.js `MarketDataStreamService`
- [ ] Unit tests cho parser, reconnection logic

**Sơ đồ Phase 1:**
```
Polymarket WS ──► [RUST: tungstenite + simd_json] ──► N-API callback ──► Node.js
                   (new)                                                    │
                                                          MarketDataStreamService
                                                                    │
                                                   (existing) ArbitrageEngineTrioService
```

**Song song chạy:** Giữ nguyên hệ thống JS hiện tại làm fallback. Có thể toggle giữa Rust socket và JS socket qua environment variable.

---

### Phase 2: Arbitrage Engine Migration (Ước tính: 2–3 tuần)

**Mục tiêu:** Chuyển toàn bộ logic `ArbitrageEngineTrioService` sang Rust. Node.js chỉ nhận signal khi có opportunity.

**Deliverables:**

- [ ] Implement `EngineState` với flat memory layout (Section 8)
- [ ] Port `handleTopOfBook()`: dirty checking, timestamp validation
- [ ] Port `handleTrioTopOfBook()`: O(1) jump-table lookup, snapshot update
- [ ] Port `calcTrioProfitOnly()`: trio profit calculation
- [ ] Port `handleRangeArbitrage()`: bundling/unbundling evaluation
- [ ] Implement cooldown tracking (inline `last_emitted_ns`)
- [ ] Implement `update_market_structure()` N-API endpoint
  - Node.js `MarketService.crawlMarkets()` → gọi Rust để rebuild state
- [ ] Integration test: Rust engine detect signal → callback Node.js → log DB
- [ ] Benchmark: latency comparison (Rust vs JS engine)

**Sơ đồ Phase 2:**
```
Polymarket WS ──► [RUST: Socket + Engine] ──► Signal channel ──► N-API callback
                   (Phase 1)   (Phase 2)                              │
                                                          Node.js: handleOpportunity()
                                                                      │
                                                    RealExecutionService (existing)
```

---

### Phase 3: Execution Integration (Ước tính: 2–3 tuần)

**Mục tiêu:** Chuyển toàn bộ execution flow sang Rust: validation → order build → signing → HTTP POST. Node.js chỉ nhận `TradeResult`.

**Deliverables:**

- [ ] Port `shouldSkipOpportunity()`: balance check, cooldown, PnL threshold
- [ ] Port `prepareBatchOrdersSync()`: slippage calculation, min order adjustment
- [ ] Integrate existing `native-core` EIP-712 signing vào Rust core
  - Merge `signClobOrdersBatch` logic trực tiếp vào engine
  - Loại bỏ N-API serialization overhead cho signing
- [ ] Implement HTTP client (`reqwest`) cho Polymarket CLOB API
  - `POST /orders` endpoint
  - Authentication (HMAC signing)
  - Response parsing
- [ ] Implement `update_balance()` N-API endpoint
  - Node.js background refresh → push balance vào Rust `AtomicU64`
- [ ] N-API: `on_trade_result(callback)` — Rust → Node.js với full trade result
- [ ] Integration test: end-to-end (WS → Signal → Sign → POST → Result → Node.js DB)
- [ ] Stress test: concurrent signals, rapid balance changes

**Sơ đồ Phase 3 (Final):**
```
Polymarket WS ──► [RUST: Socket → Engine → Executor] ──► Trade Result
                   ▲                                          │
                   │ update_balance()                         │ on_trade_result()
                   │ update_market_structure()                ▼
                   │                                    Node.js Event Loop
              Node.js Cron Jobs                        - saveTradeResultAsync()
              - crawlMarkets (20min)                   - telegramNotify()
              - refreshBalance (5s)                    - queueMintReplenish()
              - cleanupExpired                         - adjustMintedCache()
```

---

### Phase 4: Production Hardening (Ước tính: 1–2 tuần)

**Mục tiêu:** Production-grade reliability, monitoring, và gradual rollout.

**Deliverables:**

- [ ] Error handling + recovery
  - Rust panic handler (catch_unwind)
  - Graceful degradation: nếu Rust crash → fallback về JS engine
  - Circuit breaker cho HTTP failures
- [ ] Observability
  - Latency histograms (Socket → Signal, Signal → API, total)
  - Throughput counters (messages/sec, signals/sec)
  - Memory usage tracking
  - Export metrics tới Node.js cho Telegram reporting
- [ ] Configuration hot-reload
  - Runtime toggle: Rust engine vs JS engine
  - Tunable parameters: cooldown, thresholds, slippage
- [ ] Deployment
  - Build script cho Rust native module (cross-platform)
  - CI/CD pipeline integration
  - PM2 ecosystem config update
- [ ] Load testing với production-like data
- [ ] Documentation cập nhật

---

## 10. Risk Assessment & Rollback Plan

### Rủi ro và Giải pháp

| Risk | Severity | Mitigation |
|---|---|---|
| Rust engine bug gây miss opportunities | **HIGH** | Feature flag toggle, shadow mode (cả 2 chạy song song, compare results) |
| N-API crash gây process crash | **HIGH** | `catch_unwind` + monitoring, automatic restart via PM2 |
| WebSocket reconnection khác biệt hành vi | **MEDIUM** | Integration test suite, A/B comparison mode |
| Polymarket API thay đổi format | **MEDIUM** | Versioned parser, fallback to JS parser |
| Build complexity tăng (Rust toolchain) | **LOW** | Docker build, pre-built binaries |
| Team learning curve cho Rust | **MEDIUM** | Tài liệu chi tiết, pair programming sessions |

### Rollback Strategy

```
Phase 1: Toggle env SOCKET_MODE=rust|js
Phase 2: Toggle env ENGINE_MODE=rust|js
Phase 3: Toggle env EXECUTION_MODE=rust|js
Phase 4: Remove JS fallback code (sau 2 tuần stable)
```

Mỗi Phase đều có **dual-mode**: feature flag cho phép chạy song song và so sánh kết quả trước khi commit chuyển hoàn toàn.

---

## 11. Benchmark & KPI

### Metrics cần đo

```
┌─────────────────────────────────────────────────────────────────┐
│ Metric                          │ Tool           │ Target       │
├─────────────────────────────────┼────────────────┼──────────────┤
│ WS message → Parsed             │ Rust tracing   │ < 10µs       │
│ Parsed → Engine state updated   │ Rust tracing   │ < 5µs        │
│ State updated → Signal emitted  │ Rust tracing   │ < 1µs        │
│ Signal → Orders signed          │ Rust tracing   │ < 100µs      │
│ Orders signed → API response    │ Rust tracing   │ < 500µs *    │
│ Total: WS → API response        │ End-to-end     │ < 1ms **     │
│ GC Pauses                       │ --trace_gc     │ 0            │
│ Memory usage                    │ RSS monitoring │ < 50MB       │
│ Message throughput               │ Counter        │ > 10K/sec    │
│ P99 latency                     │ Histogram      │ < 2ms        │
└─────────────────────────────────────────────────────────────────┘

* Excluding network round-trip to Polymarket servers
** Excluding network round-trip
```

### Shadow Mode Comparison

Trong quá trình migration, chạy cả 2 engine song song:

```
WS Message ──┬──► JS Engine ──► JS Signal (log only)
             │
             └──► Rust Engine ──► Rust Signal (execute)

Compare: profit_abs, profit_bps, signal timing, order candidates
Alert if: |JS.profit - Rust.profit| > 0.001 hoặc signal count khác biệt > 5%
```

---

## Phụ lục: File Mapping (Current → Rust)

| Current File (Node.js) | Rust Module | Phase |
|---|---|---|
| `socket-manager.service.ts` (453 lines) | `socket/ws_client.rs` + `socket/manager.rs` | Phase 1 |
| `buffer.service.ts` — parse logic (558 lines) | `socket/parser.rs` | Phase 1 |
| `market-data-stream.service.ts` (21 lines) | Internal channel (eliminated) | Phase 1 |
| `arbitrage-engine-trio.service.ts` (1018 lines) | `engine/state.rs` + `engine/trio_evaluator.rs` + `engine/range_evaluator.rs` | Phase 2 |
| `real-execution.service.ts` — hot path (lines 304–565) | `executor/validator.rs` + `executor/signer.rs` | Phase 3 |
| `polymarket-onchain.service.ts` — signing + POST | `executor/signer.rs` + `executor/api_client.rs` | Phase 3 |
| `real-execution.service.ts` — DB/Telegram (remaining) | Keep in Node.js | N/A |
| `market.service.ts` (289 lines) | Keep in Node.js (cold path) | N/A |

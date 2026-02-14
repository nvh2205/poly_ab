# Phase 1 — Socket Architecture

## Data Flow: Current (JS) vs New (Rust)

### Current (JS) Pipeline

```
Polymarket WS
      │ ws library (Node.js event loop)
      ▼
SocketManagerService.handleMessage()
      │ JSON.parse() ← blocking event loop ~0.1-0.5ms
      │ Object allocation (MarketData) ← GC pressure
      ▼
BufferService.push() / pushPriceChange()
      │ findBestBidAsk() ← scan bids/asks
      │ Object allocation (TopOfBookUpdate)
      ▼
MarketDataStreamService.emitTopOfBook()
      │ RxJS Subject.next() ← dispatch to subscribers
      ▼
ArbitrageEngineTrioService.handleTopOfBook()
```

### New (Rust) Pipeline

```
Polymarket WS
      │ tokio-tungstenite (dedicated thread)
      ▼
WsClient.connect_and_run()
      │ raw bytes (zero-copy receive)
      ▼ mpsc::unbounded_channel
SocketManager::spawn_connection() parser task
      │ simd_json parse ← SIMD-accelerated ~10µs
      │ find_best_bid_ask() ← inline, no allocation
      │ TopOfBookUpdate struct ← stack-allocated
      ▼ mpsc::unbounded_channel
Callback Dispatcher
      │ ThreadsafeFunction::call() ← zero-copy to event loop
      ▼
RustSocketBridgeService (Node.js)
      │ MarketDataStreamService.emitTopOfBook()
      ▼
ArbitrageEngineTrioService.handleTopOfBook()
      (unchanged downstream)
```

## Threading Model

```
┌────────────────────────────────────┐
│  TOKIO RUNTIME (2 worker threads)  │
│                                     │
│  Task 1: WsClient::run()           │
│  ├── recv WS frames                │
│  ├── handle ping/pong              │
│  └── send raw bytes to channel     │
│                                     │
│  Task 2: Parser Loop               │
│  ├── recv from channel             │
│  ├── parse_ws_message()            │
│  ├── extract_top_of_book()         │
│  └── send TopOfBookUpdate          │
│                                     │
│  Task 3: Callback Dispatcher       │
│  ├── recv TopOfBookUpdate          │
│  └── ThreadsafeFunction::call()    │
│       (invokes Node.js callback)   │
└────────────────────────────────────┘
```

## Dual-Mode Architecture

```
             ┌────────────────────────┐
             │  SOCKET_MODE env var   │
             └───┬───────────────┬────┘
                 │               │
          "js" (default)     "rust"
                 │               │
                 ▼               ▼
    SocketManagerService   RustSocketBridgeService
    (existing JS socket)   (Rust native module)
                 │               │
                 └───────┬───────┘
                         │
                         ▼
              MarketDataStreamService
              (RxJS Subject — shared)
                         │
                         ▼
            ArbitrageEngineTrioService
            (unchanged downstream)
```

## Connection Management

- Tokens batched into connections (default: 50 tokens/connection)
- Each connection runs as a separate tokio task
- Auto-reconnection with exponential backoff (1s → 2s → 4s → max 30s)
- Ping/pong heartbeat every 15 seconds
- Graceful shutdown via `tokio::sync::watch` channel

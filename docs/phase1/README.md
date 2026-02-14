# Phase 1: Rust Core Foundation + WebSocket Socket

## Overview

Phase 1 replaces the Node.js WebSocket data ingestion pipeline (`socket-manager.service.ts` → `buffer.service.ts` → `market-data-stream.service.ts`) with a high-performance Rust native module (`rust-core`).

### Key Changes

- **New crate**: `rust-core/` — native N-API module built with `napi-rs` v2
- **WebSocket**: `tokio-tungstenite` replaces `ws` library
- **JSON parsing**: `simd_json` replaces `JSON.parse()`
- **Threading**: Multi-threaded tokio runtime (socket + parser threads)
- **Feature flag**: `SOCKET_MODE=rust|js` toggle (JS is default)

## Architecture

```
Polymarket WS
      │
      ▼
┌─────────────────────────────────┐
│  RUST CORE (tokio runtime)      │
│                                  │
│  [WsClient] ─── raw bytes ───►  │
│  [Parser]   ─── TopOfBookUpdate │
│  [Manager]  ─── connection pool │
└──────────┬──────────────────────┘
           │ N-API ThreadsafeFunction
           ▼
┌─────────────────────────────────┐
│  NODE.JS (NestJS)               │
│                                  │
│  RustSocketBridgeService        │
│       │                          │
│       ▼                          │
│  MarketDataStreamService        │
│  (existing RxJS Subject)        │
│       │                          │
│       ▼                          │
│  ArbitrageEngineTrioService     │
│  (unchanged)                     │
└─────────────────────────────────┘
```

## Prerequisites

- **Rust toolchain**: `rustup` with stable Rust ≥1.70
- **napi-rs CLI**: `npm install -g @napi-rs/cli` (or use npx)

## Build

```bash
cd rust-core
npm install
npm run build        # Release build
npm run build:debug  # Debug build
```

## Run

```bash
# Default: JS socket (no Rust needed)
npm run start:dev

# Rust socket mode
SOCKET_MODE=rust npm run start:dev

# Rust socket with verbose logging
SOCKET_MODE=rust RUST_SOCKET_VERBOSE=true npm run start:dev
```

## Testing

```bash
# Rust unit tests
cd rust-core && cargo test

# Node.js integration (when implemented)
SOCKET_MODE=rust npx jest test/rust-socket-integration.test.ts
```

## File Map

| File | Purpose |
|---|---|
| `rust-core/src/lib.rs` | N-API entry point |
| `rust-core/src/types/market.rs` | TopOfBookUpdate, WsEvent, serde structs |
| `rust-core/src/types/config.rs` | SocketConfig with defaults |
| `rust-core/src/socket/parser.rs` | simd_json message parser + findBestBidAsk |
| `rust-core/src/socket/ws_client.rs` | tokio-tungstenite WS client |
| `rust-core/src/socket/manager.rs` | Connection pool manager |
| `rust-core/src/bridge/napi_exports.rs` | 6 N-API exported functions |
| `rust-core/src/bridge/callbacks.rs` | ThreadsafeFunction callback registry |
| `src/modules/ingestion/rust-socket-bridge.service.ts` | NestJS bridge service |

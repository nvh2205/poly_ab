//! # rust-core — High-Performance Trading Engine for Polymarket HFT
//!
//! This crate provides a native N-API module for Node.js that handles
//! the full trading pipeline:
//!
//! - **WebSocket data ingestion** via `tokio-tungstenite`
//! - **Arbitrage engine** with O(1) trio/range evaluation
//! - **Order execution** with EIP-712 signing and HMAC-authenticated CLOB API
//! - **Multi-threaded async runtime** via `tokio`
//!
//! ## Architecture
//!
//! ```text
//! Polymarket WS → [Socket Manager] → [Engine] → [Executor] → CLOB API
//!                                                     ↓
//!                                              onTradeResult → Node.js
//! ```
//!
//! ## Usage from Node.js
//!
//! ```javascript
//! const rustCore = require('./rust-core');
//!
//! // Initialize socket + engine
//! rustCore.initSocket({ wsUrl: 'wss://...' });
//! rustCore.updateMarketStructure(groups);
//!
//! // Initialize executor
//! rustCore.initExecutor({ privateKey: '...', ... });
//! rustCore.onTradeResult((result) => console.log(result));
//!
//! // Subscribe to tokens
//! rustCore.subscribeTokens(['token_id_1', 'token_id_2']);
//! ```

pub mod bridge;
pub mod engine;
pub mod executor;
pub mod socket;
pub mod types;

// Re-export N-API functions — napi_derive will auto-register them.
// The actual exports are in bridge/napi_exports.rs.

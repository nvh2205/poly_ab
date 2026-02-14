use napi_derive::napi;
use serde::Deserialize;

// =============================================================================
// N-API EXPORTED STRUCTS (Node.js ↔ Rust boundary)
// =============================================================================

/// Top-of-book update emitted to Node.js callback.
/// Mirrors `TopOfBookUpdate` from `top-of-book.interface.ts`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct TopOfBookUpdate {
    pub asset_id: String,
    pub market_hash: String,
    pub best_bid: f64,
    pub best_ask: f64,
    pub best_bid_size: Option<f64>,
    pub best_ask_size: Option<f64>,
    pub last_price: Option<f64>,
    pub timestamp_ms: i64,
}

/// Socket connection status exported to Node.js.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct SocketStatus {
    pub total_connections: i32,
    pub active_connections: i32,
    pub subscribed_tokens: i32,
    pub messages_received: i64,
    pub last_message_at_ms: Option<i64>,
}

// =============================================================================
// INTERNAL STRUCTS (Rust-only, for parsing WebSocket messages)
// =============================================================================

/// Orderbook level: { price, size } pair.
#[derive(Debug, Clone)]
pub struct Level {
    pub price: f64,
    pub size: f64,
}

/// A single price change item within a `price_change` event.
#[derive(Debug, Clone)]
pub struct PriceChangeItem {
    pub asset_id: String,
    pub best_bid: f64,
    pub best_ask: f64,
}

/// Parsed WebSocket event, dispatched internally from parser → engine.
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// Full orderbook snapshot (`event_type: "book"`).
    Book {
        market: String,
        asset_id: String,
        timestamp: i64,
        bids: Vec<Level>,
        asks: Vec<Level>,
        last_trade_price: Option<f64>,
    },
    /// Price change event (`event_type: "price_change"`).
    PriceChange {
        market: String,
        timestamp: i64,
        changes: Vec<PriceChangeItem>,
    },
}

// =============================================================================
// SERDE STRUCTS (for simd_json / serde_json deserialization)
// =============================================================================

/// Raw WebSocket message as received from Polymarket.
/// Supports both single objects and arrays.
#[derive(Debug, Deserialize)]
pub(crate) struct RawWsMessage {
    pub event_type: Option<String>,
    pub market: Option<String>,
    pub asset_id: Option<String>,
    pub timestamp: Option<serde_json::Value>,
    pub bids: Option<Vec<RawLevel>>,
    pub asks: Option<Vec<RawLevel>>,
    pub last_trade_price: Option<String>,
    pub price_changes: Option<Vec<RawPriceChange>>,
}

/// Raw orderbook level — price and size as strings from JSON.
#[derive(Debug, Deserialize)]
pub(crate) struct RawLevel {
    pub price: Option<String>,
    pub size: Option<String>,
}

/// Raw price change item from `price_changes` array.
#[derive(Debug, Deserialize)]
pub(crate) struct RawPriceChange {
    pub asset_id: Option<String>,
    pub best_bid: Option<String>,
    pub best_ask: Option<String>,
}

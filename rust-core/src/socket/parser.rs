//! WebSocket message parser using simd_json / serde_json.
//!
//! Parses raw WebSocket bytes into `WsEvent` variants and extracts
//! `TopOfBookUpdate` data. Port of `buffer.service.ts` parsing logic.

use crate::types::market::{
    Level, PriceChangeItem, RawWsMessage, TopOfBookUpdate, WsEvent,
};

// =============================================================================
// PUBLIC API
// =============================================================================

/// Parse a raw WebSocket message (bytes) into a list of `WsEvent`.
///
/// The Polymarket WS can send either a single JSON object or an array of objects.
/// This function handles both cases.
pub fn parse_ws_message(raw: &[u8]) -> Result<Vec<WsEvent>, ParseError> {
    // Skip ping/pong text messages
    if raw == b"PONG" || raw == b"PING" {
        return Ok(vec![]);
    }

    // Try to parse with serde_json (simd_json requires mutable buffer)
    // For production, we can switch to simd_json with owned copies
    let value: serde_json::Value =
        serde_json::from_slice(raw).map_err(|e| ParseError::InvalidJson(e.to_string()))?;

    let raw_messages: Vec<RawWsMessage> = if value.is_array() {
        serde_json::from_value(value)
            .map_err(|e| ParseError::InvalidStructure(e.to_string()))?
    } else {
        let single: RawWsMessage = serde_json::from_value(value)
            .map_err(|e| ParseError::InvalidStructure(e.to_string()))?;
        vec![single]
    };

    let mut events = Vec::with_capacity(raw_messages.len());
    for msg in raw_messages {
        if let Some(event) = convert_raw_message(msg)? {
            events.push(event);
        }
    }

    Ok(events)
}



/// Extract `TopOfBookUpdate` from a `WsEvent`.
///
/// Port of `BufferService.push()` and `BufferService.pushPriceChange()`.
pub fn extract_top_of_book(event: &WsEvent) -> Vec<TopOfBookUpdate> {
    match event {
        WsEvent::Book {
            market,
            asset_id,
            timestamp,
            bids,
            asks,
            last_trade_price,
        } => {
            let (best_bid, best_ask, best_bid_size, best_ask_size) =
                find_best_bid_ask(bids, asks);

            let ts_ms = normalize_timestamp_ms(*timestamp);

            vec![TopOfBookUpdate {
                asset_id: asset_id.clone(),
                market_hash: market.clone(),
                best_bid,
                best_ask,
                best_bid_size: if best_bid_size.is_finite() {
                    Some(best_bid_size)
                } else {
                    None
                },
                best_ask_size: if best_ask_size.is_finite() {
                    Some(best_ask_size)
                } else {
                    None
                },
                last_price: *last_trade_price,
                timestamp_ms: ts_ms,
            }]
        }
        WsEvent::PriceChange {
            market,
            timestamp,
            changes,
        } => {
            let ts_ms = normalize_timestamp_ms(*timestamp);
            changes
                .iter()
                .map(|change| TopOfBookUpdate {
                    asset_id: change.asset_id.clone(),
                    market_hash: market.clone(),
                    best_bid: change.best_bid,
                    best_ask: change.best_ask,
                    best_bid_size: None,
                    best_ask_size: None,
                    last_price: None,
                    timestamp_ms: ts_ms,
                })
                .collect()
        }
    }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/// Convert a raw deserialized message to a `WsEvent`.
fn convert_raw_message(msg: RawWsMessage) -> Result<Option<WsEvent>, ParseError> {
    let event_type = match &msg.event_type {
        Some(t) => t.as_str(),
        None => return Ok(None),
    };

    match event_type {
        "book" => {
            let market = msg.market.unwrap_or_default();
            let asset_id = msg.asset_id.unwrap_or_default();
            let timestamp = parse_timestamp(&msg.timestamp);

            let bids = msg
                .bids
                .unwrap_or_default()
                .into_iter()
                .filter_map(|l| {
                    let price = l.price.as_deref().and_then(parse_f64)?;
                    let size = l.size.as_deref().and_then(parse_f64).unwrap_or(0.0);
                    Some(Level { price, size })
                })
                .collect();

            let asks = msg
                .asks
                .unwrap_or_default()
                .into_iter()
                .filter_map(|l| {
                    let price = l.price.as_deref().and_then(parse_f64)?;
                    let size = l.size.as_deref().and_then(parse_f64).unwrap_or(0.0);
                    Some(Level { price, size })
                })
                .collect();

            let last_trade_price = msg
                .last_trade_price
                .as_deref()
                .and_then(parse_f64);

            Ok(Some(WsEvent::Book {
                market,
                asset_id,
                timestamp,
                bids,
                asks,
                last_trade_price,
            }))
        }
        "price_change" => {
            let market = msg.market.unwrap_or_default();
            let timestamp = parse_timestamp(&msg.timestamp);

            let changes = msg
                .price_changes
                .unwrap_or_default()
                .into_iter()
                .filter_map(|pc| {
                    let asset_id = pc.asset_id?;
                    let best_bid = pc.best_bid.as_deref().and_then(parse_f64)?;
                    let best_ask = pc.best_ask.as_deref().and_then(parse_f64)?;
                    Some(PriceChangeItem {
                        asset_id,
                        best_bid,
                        best_ask,
                    })
                })
                .collect();

            Ok(Some(WsEvent::PriceChange {
                market,
                timestamp,
                changes,
            }))
        }
        _ => Ok(None), // Unknown event types are silently ignored
    }
}

/// Find best bid (highest price) and best ask (lowest price).
///
/// Port of `BufferService.findBestBidAsk()`.
/// Assumes bids sorted ascending, asks sorted descending.
/// Best bid = last element of bids, best ask = last element of asks.
fn find_best_bid_ask(bids: &[Level], asks: &[Level]) -> (f64, f64, f64, f64) {
    let (best_bid, best_bid_size) = bids
        .last()
        .map(|l| (l.price, l.size))
        .unwrap_or((f64::NAN, f64::NAN));

    let (best_ask, best_ask_size) = asks
        .last()
        .map(|l| (l.price, l.size))
        .unwrap_or((f64::NAN, f64::NAN));

    (best_bid, best_ask, best_bid_size, best_ask_size)
}

/// Parse timestamp from various JSON formats (string or number).
///
/// Port of `handleMessage()` timestamp parsing logic.
fn parse_timestamp(value: &Option<serde_json::Value>) -> i64 {
    match value {
        Some(serde_json::Value::Number(n)) => {
            n.as_i64().unwrap_or_else(|| {
                n.as_f64().map(|f| f as i64).unwrap_or(0)
            })
        }
        Some(serde_json::Value::String(s)) => s.parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// Normalize timestamp to milliseconds.
///
/// Port of `BufferService.normalizeTimestampMs()`.
/// If timestamp appears to be in seconds (< 1e12), convert to ms.
fn normalize_timestamp_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 1_000_000_000_000 {
        ts * 1000 // seconds → milliseconds
    } else {
        ts
    }
}

/// Parse a string to f64, returns None for unparseable values.
fn parse_f64(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

// =============================================================================
// ERROR TYPES
// =============================================================================

#[derive(Debug)]
pub enum ParseError {
    InvalidJson(String),
    InvalidStructure(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::InvalidJson(msg) => write!(f, "Invalid JSON: {}", msg),
            ParseError::InvalidStructure(msg) => write!(f, "Invalid structure: {}", msg),
        }
    }
}

impl std::error::Error for ParseError {}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_book_message() {
        let msg = r#"{
            "event_type": "book",
            "market": "0xabc123",
            "asset_id": "token123",
            "timestamp": 1700000000000,
            "bids": [
                {"price": "0.30", "size": "100"},
                {"price": "0.40", "size": "200"},
                {"price": "0.50", "size": "150"}
            ],
            "asks": [
                {"price": "0.80", "size": "300"},
                {"price": "0.70", "size": "250"},
                {"price": "0.60", "size": "180"}
            ],
            "last_trade_price": "0.55"
        }"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        assert_eq!(events.len(), 1);

        let updates = extract_top_of_book(&events[0]);
        assert_eq!(updates.len(), 1);

        let u = &updates[0];
        assert_eq!(u.asset_id, "token123");
        assert_eq!(u.market_hash, "0xabc123");
        // Best bid = last element (highest in ascending order)
        assert!((u.best_bid - 0.50).abs() < 1e-10);
        // Best ask = last element (lowest in descending order)
        assert!((u.best_ask - 0.60).abs() < 1e-10);
        assert_eq!(u.best_bid_size, Some(150.0));
        assert_eq!(u.best_ask_size, Some(180.0));
        assert_eq!(u.last_price, Some(0.55));
        assert_eq!(u.timestamp_ms, 1700000000000);
    }

    #[test]
    fn test_parse_price_change_message() {
        let msg = r#"{
            "event_type": "price_change",
            "market": "0xdef456",
            "timestamp": "1700000001000",
            "price_changes": [
                {"asset_id": "tokenA", "best_bid": "0.45", "best_ask": "0.55"},
                {"asset_id": "tokenB", "best_bid": "0.30", "best_ask": "0.70"}
            ]
        }"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        assert_eq!(events.len(), 1);

        let updates = extract_top_of_book(&events[0]);
        assert_eq!(updates.len(), 2);

        assert_eq!(updates[0].asset_id, "tokenA");
        assert!((updates[0].best_bid - 0.45).abs() < 1e-10);
        assert!((updates[0].best_ask - 0.55).abs() < 1e-10);
        assert_eq!(updates[0].best_bid_size, None);

        assert_eq!(updates[1].asset_id, "tokenB");
        assert!((updates[1].best_bid - 0.30).abs() < 1e-10);
    }

    #[test]
    fn test_parse_array_message() {
        let msg = r#"[
            {"event_type": "book", "market": "m1", "asset_id": "t1", "timestamp": 1700000000, "bids": [{"price": "0.5", "size": "100"}], "asks": [{"price": "0.6", "size": "50"}]},
            {"event_type": "price_change", "market": "m2", "timestamp": 1700000001, "price_changes": [{"asset_id": "t2", "best_bid": "0.4", "best_ask": "0.6"}]}
        ]"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn test_parse_ping_pong() {
        let events = parse_ws_message(b"PING").unwrap();
        assert!(events.is_empty());

        let events = parse_ws_message(b"PONG").unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn test_parse_malformed_json() {
        let result = parse_ws_message(b"not json at all");
        assert!(result.is_err());
    }

    #[test]
    fn test_timestamp_normalization_seconds() {
        // Timestamp in seconds should be converted to ms
        let msg = r#"{"event_type": "book", "market": "m1", "asset_id": "t1", "timestamp": 1700000000, "bids": [{"price": "0.5", "size": "100"}], "asks": []}"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        let updates = extract_top_of_book(&events[0]);
        // 1700000000 < 1e12, so it's treated as seconds → * 1000
        assert_eq!(updates[0].timestamp_ms, 1700000000000);
    }

    #[test]
    fn test_empty_bids_asks() {
        let msg = r#"{"event_type": "book", "market": "m1", "asset_id": "t1", "timestamp": 1700000000000, "bids": [], "asks": []}"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        let updates = extract_top_of_book(&events[0]);
        assert!(updates[0].best_bid.is_nan());
        assert!(updates[0].best_ask.is_nan());
        assert_eq!(updates[0].best_bid_size, None);
        assert_eq!(updates[0].best_ask_size, None);
    }

    #[test]
    fn test_unknown_event_type_ignored() {
        let msg = r#"{"event_type": "ticker", "market": "m1"}"#;

        let events = parse_ws_message(msg.as_bytes()).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn test_find_best_bid_ask() {
        let bids = vec![
            Level { price: 0.30, size: 100.0 },
            Level { price: 0.40, size: 200.0 },
            Level { price: 0.50, size: 150.0 },
        ];
        let asks = vec![
            Level { price: 0.80, size: 300.0 },
            Level { price: 0.70, size: 250.0 },
            Level { price: 0.60, size: 180.0 },
        ];

        let (bb, ba, bbs, bas) = find_best_bid_ask(&bids, &asks);
        assert!((bb - 0.50).abs() < 1e-10);
        assert!((ba - 0.60).abs() < 1e-10);
        assert!((bbs - 150.0).abs() < 1e-10);
        assert!((bas - 180.0).abs() < 1e-10);
    }
}

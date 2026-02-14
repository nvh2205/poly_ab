//! ArbSignal — flat N-API struct emitted from Rust engine to Node.js.
//!
//! `RustEngineBridgeService` on the Node.js side converts this flat struct
//! into the nested `ArbOpportunity` format that `RealExecutionService` expects.

use napi_derive::napi;

/// Arbitrage signal emitted to Node.js via callback.
///
/// Flat layout for optimal N-API serialization.
/// Contains all fields needed by `RealExecutionService.buildOrderCandidates()`
/// and `calculateTotalCost()`.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ArbSignal {
    // ── Group metadata ──
    pub group_key: String,
    pub event_slug: String,
    pub crypto: String,
    pub strategy: String, // "POLYMARKET_TRIANGLE_BUY" | "SELL_PARENT_BUY_CHILDREN" | "BUY_PARENT_SELL_CHILDREN"

    // ── Profit ──
    pub profit_abs: f64,
    pub profit_bps: f64,
    pub timestamp_ms: i64,

    // ── Parent Lower (YES token — all strategies) ──
    pub parent_asset_id: String,
    pub parent_market_slug: String,
    pub parent_best_bid: Option<f64>,
    pub parent_best_ask: Option<f64>,
    pub parent_best_bid_size: Option<f64>,
    pub parent_best_ask_size: Option<f64>,
    pub parent_neg_risk: bool,

    // ── Parent Upper ──
    // For Triangle: NO token prices; For Range arb: YES token prices
    pub parent_upper_asset_id: String,
    pub parent_upper_market_slug: String,
    pub parent_upper_best_bid: Option<f64>,
    pub parent_upper_best_ask: Option<f64>,
    pub parent_upper_best_bid_size: Option<f64>,
    pub parent_upper_best_ask_size: Option<f64>,
    pub parent_upper_neg_risk: bool,

    // ── Range Child ──
    // For Triangle: NO token prices; For Range arb: YES token prices
    pub child_asset_id: String,
    pub child_market_slug: String,
    pub child_best_bid: Option<f64>,
    pub child_best_ask: Option<f64>,
    pub child_best_bid_size: Option<f64>,
    pub child_best_ask_size: Option<f64>,
    pub child_neg_risk: bool,
    pub child_index: i32,

    // ── Aggregates for RealExecutionService.calculateTotalCost() ──
    pub children_sum_ask: f64,
    pub children_sum_bid: f64,
    pub parent_best_bid_flat: Option<f64>,
    pub parent_best_ask_flat: Option<f64>,
    pub parent_upper_best_bid_flat: Option<f64>,
    pub parent_upper_best_ask_flat: Option<f64>,

    // ── Triangle context ──
    pub triangle_total_cost: Option<f64>,
    pub triangle_total_bid: Option<f64>,
    pub triangle_payout: Option<f64>,
    pub triangle_mode: Option<String>,

    pub reason: String,
}

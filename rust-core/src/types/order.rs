//! Order types for the executor module.
//!
//! Defines internal order structs, signed order output,
//! trade result (N-API output to Node.js), and executor config input.

use napi_derive::napi;

// =============================================================================
// INTERNAL TYPES (Rust-only, no N-API overhead)
// =============================================================================

/// Internal order struct for signing — no N-API overhead.
/// Built by `validator::prepare_batch_orders()`.
#[derive(Debug, Clone)]
pub struct OrderToSign {
    pub salt: String,
    pub token_id: String,
    pub maker_amount: String,
    pub taker_amount: String,
    pub side: u8, // 0=BUY, 1=SELL
    pub neg_risk: bool,
    pub fee_rate_bps: u32,
}

/// Signed order ready for CLOB API payload.
/// Output of `signer::sign_batch_orders()`.
#[derive(Debug, Clone)]
pub struct SignedClobOrder {
    pub salt: i64,
    pub maker: String,
    pub signer: String,
    pub taker: String,
    pub token_id: String,
    pub maker_amount: String,
    pub taker_amount: String,
    pub side: String, // "BUY" | "SELL"
    pub expiration: String,
    pub nonce: String,
    pub fee_rate_bps: String,
    pub signature_type: u8,
    pub signature: String,
}

/// Order candidate from signal — intermediate for validation.
#[derive(Debug, Clone)]
pub struct OrderCandidate {
    pub token_id: String,
    pub market_slug: String,
    pub price: f64,
    pub side: OrderSide,
    pub orderbook_size: Option<f64>,
    pub neg_risk: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderSide::Buy => "BUY",
            OrderSide::Sell => "SELL",
        }
    }

    pub fn as_u8(&self) -> u8 {
        match self {
            OrderSide::Buy => 0,
            OrderSide::Sell => 1,
        }
    }
}

// =============================================================================
// N-API TYPES (Rust ↔ Node.js)
// =============================================================================

/// Successful order detail — part of TradeResult.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiSuccessOrder {
    pub token_id: String,
    pub market_slug: String,
    pub side: String,
    pub price: f64,
    pub size: f64,
    pub neg_risk: bool,
}

/// Failed order detail — part of TradeResult.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiFailedOrder {
    pub token_id: String,
    pub market_slug: String,
    pub side: String,
    pub price: f64,
    pub error_msg: String,
}

/// Trade result — emitted to Node.js via on_trade_result callback.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct TradeResult {
    pub success: bool,
    pub order_ids: Vec<String>,
    pub successful_orders: Vec<NapiSuccessOrder>,
    pub failed_orders: Vec<NapiFailedOrder>,
    pub total_cost: f64,
    pub expected_pnl: f64,
    pub latency_us: i64, // Microseconds
    pub signal_group_key: String,
    pub signal_event_slug: String,
    pub signal_crypto: String,
    pub signal_strategy: String,
    pub signal_profit_abs: f64,
    pub signal_profit_bps: f64,
    pub signal_timestamp_ms: i64,

    // ── Signal snapshot: Parent ──
    pub signal_parent_asset_id: String,
    pub signal_parent_market_slug: String,
    pub signal_parent_best_bid: Option<f64>,
    pub signal_parent_best_ask: Option<f64>,
    pub signal_parent_best_bid_size: Option<f64>,
    pub signal_parent_best_ask_size: Option<f64>,
    pub signal_parent_neg_risk: bool,

    // ── Signal snapshot: Parent Upper ──
    pub signal_parent_upper_asset_id: String,
    pub signal_parent_upper_market_slug: String,
    pub signal_parent_upper_best_bid: Option<f64>,
    pub signal_parent_upper_best_ask: Option<f64>,
    pub signal_parent_upper_best_bid_size: Option<f64>,
    pub signal_parent_upper_best_ask_size: Option<f64>,
    pub signal_parent_upper_neg_risk: bool,

    // ── Signal snapshot: Child ──
    pub signal_child_asset_id: String,
    pub signal_child_market_slug: String,
    pub signal_child_best_bid: Option<f64>,
    pub signal_child_best_ask: Option<f64>,
    pub signal_child_best_bid_size: Option<f64>,
    pub signal_child_best_ask_size: Option<f64>,
    pub signal_child_neg_risk: bool,
    pub signal_child_index: i32,

    // ── Signal snapshot: Aggregates ──
    pub signal_children_sum_ask: f64,
    pub signal_children_sum_bid: f64,

    // ── Signal snapshot: Triangle context ──
    pub signal_triangle_total_cost: Option<f64>,
    pub signal_triangle_total_bid: Option<f64>,
    pub signal_triangle_payout: Option<f64>,
    pub signal_triangle_mode: Option<String>,

    pub signal_reason: String,
}

/// Executor config input from Node.js (init_executor / update_executor_config).
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiExecutorConfigInput {
    pub private_key: String,
    pub proxy_address: String,
    pub signer_address: String,
    pub api_key: String,
    pub api_secret: String,
    pub api_passphrase: String,
    pub clob_url: Option<String>,
    pub min_pnl_threshold_percent: f64,
    pub default_size: f64,
    pub slippage_enabled: bool,
    pub opportunity_timeout_ms: Option<i64>,
}

// =============================================================================
// BATCH ORDER API TYPES (for place-batch-orders-rust N-API endpoint)
// =============================================================================

/// Input order from Node.js for the manual place-batch-orders-rust API.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchOrderInput {
    pub token_id: String,
    pub price: f64,
    pub size: f64,
    pub side: String,              // "BUY" | "SELL"
    pub fee_rate_bps: Option<i32>,
    pub neg_risk: Option<bool>,
    pub order_type: Option<String>, // "GTC" | "GTD" | "FOK" | "FAK"
}

/// Single order result from the batch API.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchOrderResultItem {
    pub success: bool,
    pub order_id: Option<String>,
    pub status: Option<String>,
    pub error_msg: Option<String>,
}

/// Batch order result from the manual place-batch-orders-rust API.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchOrderResult {
    pub success: bool,
    pub results: Vec<NapiBatchOrderResultItem>,
    pub error: Option<String>,
    pub latency_ms: f64,
}

/// API credentials + config for the batch order API.
/// Passed from Node.js because the executor's stored credentials may be empty
/// (the JS service dynamically creates them via createOrDeriveApiKey).
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NapiBatchOrderConfig {
    pub api_key: String,
    pub api_secret: String,
    pub api_passphrase: String,
    pub signer_address: String,
    pub clob_url: Option<String>,
}


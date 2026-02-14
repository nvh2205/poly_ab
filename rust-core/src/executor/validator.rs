//! Order validation and preparation — port of RealExecutionService logic.
//!
//! Handles:
//! - `should_skip()`: balance, cooldown, PnL threshold checks
//! - `apply_slippage()`: price adjustment for BUY/SELL
//! - `prepare_batch_orders()`: build OrderToSign from signal candidates

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::order::{OrderCandidate, OrderSide, OrderToSign};
use crate::types::signal::ArbSignal;

// =============================================================================
// CONSTANTS (ported from real-execution.service.ts)
// =============================================================================


const MAX_PRICE: f64 = 0.99;
const MIN_PRICE: f64 = 0.01;

// Slippage thresholds
const SLIPPAGE_EXTREME_THRESHOLD_HIGH: f64 = 0.96;
const SLIPPAGE_EXTREME_THRESHOLD_LOW: f64 = 0.04;
const NORMAL_SPREAD: f64 = 0.01;
const EXTREME_SPREAD: f64 = 0.001;

// USDC decimals
const DECIMALS: f64 = 1_000_000.0;

// =============================================================================
// EXECUTOR CONFIG
// =============================================================================

/// Runtime configuration for the executor.
#[derive(Debug, Clone)]
pub struct ExecutorConfig {
    pub min_pnl_threshold_percent: f64,
    pub default_size: f64,
    pub slippage_enabled: bool,
    pub opportunity_timeout_ms: u64,
    pub maker_address: String,
    pub signer_address: String,
}

// =============================================================================
// VALIDATION
// =============================================================================

/// Validation state — shared atomics for hot path, Mutex for minted cache.
pub struct ValidationState {
    pub usdc_balance: AtomicU64,   // f64 bits stored as u64
    pub trading_enabled: AtomicBool,
    pub is_submitting: AtomicBool,
    pub last_executed_at: AtomicU64, // epoch ms
    /// Minted asset cache: groupKey → (tokenId → mintedAmount)
    /// Used to cap SELL leg size — can't sell more than minted.
    /// Updated by Node.js via `update_minted_assets()` N-API call.
    minted_assets: Mutex<HashMap<String, HashMap<String, f64>>>,
}

impl ValidationState {
    pub fn new() -> Self {
        Self {
            usdc_balance: AtomicU64::new(0),
            trading_enabled: AtomicBool::new(false),
            is_submitting: AtomicBool::new(false),
            last_executed_at: AtomicU64::new(0),
            minted_assets: Mutex::new(HashMap::new()),
        }
    }

    pub fn get_balance(&self) -> f64 {
        f64::from_bits(self.usdc_balance.load(Ordering::Relaxed))
    }

    pub fn set_balance(&self, balance: f64) {
        self.usdc_balance
            .store(balance.to_bits(), Ordering::Relaxed);
    }

    /// Atomically deduct balance. Returns true if sufficient balance.
    pub fn try_deduct_balance(&self, amount: f64) -> bool {
        loop {
            let current_bits = self.usdc_balance.load(Ordering::Relaxed);
            let current = f64::from_bits(current_bits);
            if current < amount {
                return false;
            }
            let new_balance = current - amount;
            match self.usdc_balance.compare_exchange_weak(
                current_bits,
                new_balance.to_bits(),
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return true,
                Err(_) => continue, // Retry on contention
            }
        }
    }

    /// Set minted assets for a group (called from Node.js via N-API).
    pub fn set_minted_assets(&self, group_key: &str, assets: HashMap<String, f64>) {
        let mut cache = self.minted_assets.lock().unwrap();
        cache.insert(group_key.to_string(), assets);
    }

    /// Get minted amount for a specific token in a group.
    pub fn get_minted_amount(&self, group_key: &str, token_id: &str) -> f64 {
        let cache = self.minted_assets.lock().unwrap();
        cache
            .get(group_key)
            .and_then(|group| group.get(token_id))
            .copied()
            .unwrap_or(0.0)
    }

    /// Deduct minted amount after successful SELL (best-effort).
    pub fn deduct_minted(&self, group_key: &str, token_id: &str, amount: f64) {
        let mut cache = self.minted_assets.lock().unwrap();
        if let Some(group) = cache.get_mut(group_key) {
            if let Some(current) = group.get_mut(token_id) {
                *current = (*current - amount).max(0.0);
            }
        }
    }
}

/// Skip reason for logging.
#[derive(Debug)]
pub enum SkipReason {
    TradingDisabled,
    AlreadySubmitting,
    CooldownActive,
    PnlBelowThreshold,
    InsufficientBalance,
    InvalidSize,
    NoCandidates,
    InsufficientOrderbookSize,
    InsufficientMintedAssets,
}

/// Validation result.
pub struct ValidationResult {
    pub candidates: Vec<OrderCandidate>,
    pub size: f64,
    pub required_cost: f64,
    pub total_cost: f64,
}

/// Check if signal should be skipped. Returns Ok(ValidationResult) if valid.
pub fn should_skip(
    signal: &ArbSignal,
    state: &ValidationState,
    config: &ExecutorConfig,
) -> Result<ValidationResult, SkipReason> {
    // 1. Trading enabled?
    if !state.trading_enabled.load(Ordering::Relaxed) {
        return Err(SkipReason::TradingDisabled);
    }

    // 2. Already submitting?
    if state.is_submitting.load(Ordering::Relaxed) {
        return Err(SkipReason::AlreadySubmitting);
    }

    // 3. Cooldown check
    let now_ms = get_epoch_ms();
    let last = state.last_executed_at.load(Ordering::Relaxed);
    if last > 0 && now_ms.saturating_sub(last) < config.opportunity_timeout_ms {
        return Err(SkipReason::CooldownActive);
    }

    // 4. Build candidates from signal
    let candidates = build_order_candidates(signal);
    if candidates.is_empty() {
        return Err(SkipReason::NoCandidates);
    }

    // 4b. Check orderbook size — skip if any candidate's size < default_size
    let default_size = config.default_size;
    for c in &candidates {
        if let Some(ob_size) = c.orderbook_size {
            if ob_size < default_size {
                return Err(SkipReason::InsufficientOrderbookSize);
            }
        }
    }

    // 5. Calculate total cost and PnL
    let total_cost = calculate_total_cost(signal);
    let pnl_percent = if total_cost > 0.0 {
        (signal.profit_abs / total_cost) * 100.0
    } else {
        0.0
    };

    if pnl_percent < config.min_pnl_threshold_percent {
        tracing::debug!("PnL {}% below threshold {}%", pnl_percent, config.min_pnl_threshold_percent);
        return Err(SkipReason::PnlBelowThreshold);
    }


    // return Err(SkipReason::PnlBelowThreshold);

    // 6. Calculate size
    let size = config.default_size;
    if !size.is_finite() || size < 5.0 {
        return Err(SkipReason::InvalidSize);
    }

    // 6b. Check minted assets for SELL legs — can't sell more than minted
    let sell_legs: Vec<&OrderCandidate> = candidates.iter()
        .filter(|c| c.side == OrderSide::Sell)
        .collect();
    if !sell_legs.is_empty() {
        for leg in &sell_legs {
            let minted = state.get_minted_amount(&signal.group_key, &leg.token_id);
            if minted < size {
                return Err(SkipReason::InsufficientMintedAssets);
            }
        }
    }

    // 7. Balance check
    let required_cost = estimate_required_cost(&candidates, size);
    let balance = state.get_balance();
    if balance < required_cost {
        return Err(SkipReason::InsufficientBalance);
    }

    Ok(ValidationResult {
        candidates,
        size,
        required_cost,
        total_cost,
    })
}

// =============================================================================
// ORDER PREPARATION
// =============================================================================

/// Build order candidates from ArbSignal.
fn build_order_candidates(signal: &ArbSignal) -> Vec<OrderCandidate> {
    let strategy = signal.strategy.as_str();
    let mut candidates = Vec::with_capacity(3);

    match strategy {
        "POLYMARKET_TRIANGLE_BUY" => {
            // BUY all 3 legs: parent YES, parent_upper NO, child NO
            if let Some(ask) = signal.parent_best_ask {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.parent_best_ask_size,
                    neg_risk: signal.parent_neg_risk,
                });
            }
            if let Some(ask) = signal.parent_upper_best_ask {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_upper_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.parent_upper_best_ask_size,
                    neg_risk: signal.parent_upper_neg_risk,
                });
            }
            if let Some(ask) = signal.child_best_ask {
                candidates.push(OrderCandidate {
                    token_id: signal.child_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.child_best_ask_size,
                    neg_risk: signal.child_neg_risk,
                });
            }
        }
        "SELL_PARENT_BUY_CHILDREN" => {
            // Unbundle: SELL parent, BUY children
            if let Some(bid) = signal.parent_best_bid_flat {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_asset_id.clone(),
                    price: bid,
                    side: OrderSide::Sell,
                    orderbook_size: signal.parent_best_bid_size,
                    neg_risk: signal.parent_neg_risk,
                });
            }
            if let Some(ask) = signal.parent_upper_best_ask {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_upper_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.parent_upper_best_ask_size,
                    neg_risk: signal.parent_upper_neg_risk,
                });
            }
            if let Some(ask) = signal.child_best_ask {
                candidates.push(OrderCandidate {
                    token_id: signal.child_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.child_best_ask_size,
                    neg_risk: signal.child_neg_risk,
                });
            }
        }
        "BUY_PARENT_SELL_CHILDREN" => {
            // Bundle: BUY parent, SELL children
            if let Some(ask) = signal.parent_best_ask_flat {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_asset_id.clone(),
                    price: ask,
                    side: OrderSide::Buy,
                    orderbook_size: signal.parent_best_ask_size,
                    neg_risk: signal.parent_neg_risk,
                });
            }
            if let Some(bid) = signal.parent_upper_best_bid {
                candidates.push(OrderCandidate {
                    token_id: signal.parent_upper_asset_id.clone(),
                    price: bid,
                    side: OrderSide::Sell,
                    orderbook_size: signal.parent_upper_best_bid_size,
                    neg_risk: signal.parent_upper_neg_risk,
                });
            }
            if let Some(bid) = signal.child_best_bid {
                candidates.push(OrderCandidate {
                    token_id: signal.child_asset_id.clone(),
                    price: bid,
                    side: OrderSide::Sell,
                    orderbook_size: signal.child_best_bid_size,
                    neg_risk: signal.child_neg_risk,
                });
            }
        }
        _ => {}
    }

    candidates
}

/// Calculate total cost for a signal (matches RealExecutionService.calculateTotalCost).
///
/// For SELL legs, cost = `1 - bid` (minting/collateral cost).
/// For BUY legs, cost = `ask`.
fn calculate_total_cost(signal: &ArbSignal) -> f64 {
    match signal.strategy.as_str() {
        "POLYMARKET_TRIANGLE_BUY" => signal.triangle_total_cost.unwrap_or(0.0),

        // Unbundling: SELL parent lower, BUY range child + BUY parent upper
        // Cost = childrenSumAsk + parentUpperAsk + (1 - parentBid)
        "SELL_PARENT_BUY_CHILDREN" => {
            let children_buy_cost = signal.children_sum_ask;
            let parent_upper_buy_cost = signal.parent_upper_best_ask.unwrap_or(0.0);
            let parent_bid = signal.parent_best_bid.unwrap_or(0.0);
            let parent_sell_cost = 1.0 - parent_bid;
            children_buy_cost + parent_upper_buy_cost + parent_sell_cost
        }

        // Bundling: BUY parent lower, SELL range child + SELL parent upper
        // Cost = parentAsk + (1 - childBid) + (1 - parentUpperBid)
        "BUY_PARENT_SELL_CHILDREN" => {
            let parent_buy_cost = signal.parent_best_ask_flat.unwrap_or(0.0);
            let child_bid = signal.child_best_bid.unwrap_or(0.0);
            let children_sell_cost = 1.0 - child_bid;
            let parent_upper_bid = signal.parent_upper_best_bid.unwrap_or(0.0);
            let parent_upper_sell_cost = 1.0 - parent_upper_bid;
            parent_buy_cost + children_sell_cost + parent_upper_sell_cost
        }

        _ => 0.0,
    }
}

/// Estimate required cost for candidates at given size.
fn estimate_required_cost(candidates: &[OrderCandidate], size: f64) -> f64 {
    candidates
        .iter()
        .filter(|c| c.side == OrderSide::Buy)
        .map(|c| c.price * size)
        .sum()
}

/// Prepare batch orders from candidates (port of prepareBatchOrdersSync).
pub fn prepare_batch_orders(
    candidates: &[OrderCandidate],
    size: f64,
    config: &ExecutorConfig,
) -> Vec<OrderToSign> {
    candidates
        .iter()
        .map(|candidate| {
            let price = if config.slippage_enabled {
                apply_slippage(candidate.price, candidate.side)
            } else {
                candidate.price
            };

            // Calculate maker/taker amounts (USDC 6 decimals)
            let size_rounded = round_to_decimals(size, 2);
            let usdc_raw = price * size_rounded;
            let usdc_rounded = round_to_decimals(usdc_raw, 4);

            let (maker_amount, taker_amount) = match candidate.side {
                OrderSide::Buy => {
                    // BUY: Maker = USDC, Taker = Asset
                    let maker = (usdc_rounded * DECIMALS).round() as u64;
                    let taker = (size_rounded * DECIMALS).round() as u64;
                    (maker.to_string(), taker.to_string())
                }
                OrderSide::Sell => {
                    // SELL: Maker = Asset, Taker = USDC
                    let maker = (size_rounded * DECIMALS).round() as u64;
                    let taker = (usdc_rounded * DECIMALS).round() as u64;
                    (maker.to_string(), taker.to_string())
                }
            };

            // Generate salt
            let salt = generate_salt();

            OrderToSign {
                salt,
                token_id: candidate.token_id.clone(),
                maker_amount,
                taker_amount,
                side: candidate.side.as_u8(),
                neg_risk: candidate.neg_risk,
                fee_rate_bps: 0,
            }
        })
        .collect()
}

// =============================================================================
// SLIPPAGE (ported from RealExecutionService)
// =============================================================================

/// Get spread/tick size based on price (Polymarket tick size mechanism).
fn get_spread_for_price(price: f64) -> f64 {
    if price >= SLIPPAGE_EXTREME_THRESHOLD_HIGH || price <= SLIPPAGE_EXTREME_THRESHOLD_LOW {
        EXTREME_SPREAD
    } else {
        NORMAL_SPREAD
    }
}

/// Apply slippage to order price based on side.
/// BUY: Add spread (pay higher to ensure fill).
/// SELL: Subtract spread (accept lower to ensure fill).
pub fn apply_slippage(price: f64, side: OrderSide) -> f64 {
    let spread = get_spread_for_price(price);

    match side {
        OrderSide::Buy => {
            let with_slippage = (price + spread).min(MAX_PRICE);
            price.max(with_slippage)
        }
        OrderSide::Sell => {
            let with_slippage = (price - spread).max(MIN_PRICE);
            price.min(with_slippage)
        }
    }
}

// =============================================================================
// HELPERS
// =============================================================================

fn round_to_decimals(value: f64, decimals: u32) -> f64 {
    let multiplier = 10_f64.powi(decimals as i32);
    (value * multiplier).round() / multiplier
}

fn generate_salt() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let now_ms = get_epoch_ms();
    let random: u64 = rng.gen_range(0..now_ms.max(1));
    random.to_string()
}

fn get_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_millis() as u64
}

// =============================================================================
// TESTS
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_slippage_buy_normal() {
        let result = apply_slippage(0.50, OrderSide::Buy);
        assert!((result - 0.51).abs() < 1e-10);
    }

    #[test]
    fn test_apply_slippage_sell_normal() {
        let result = apply_slippage(0.50, OrderSide::Sell);
        assert!((result - 0.49).abs() < 1e-10);
    }

    #[test]
    fn test_apply_slippage_buy_extreme_high() {
        let result = apply_slippage(0.97, OrderSide::Buy);
        assert!((result - 0.971).abs() < 1e-10);
    }

    #[test]
    fn test_apply_slippage_sell_extreme_low() {
        let result = apply_slippage(0.03, OrderSide::Sell);
        assert!((result - 0.029).abs() < 1e-10);
    }

    #[test]
    fn test_apply_slippage_buy_capped_at_max() {
        let result = apply_slippage(0.99, OrderSide::Buy);
        assert!(result <= MAX_PRICE);
    }

    #[test]
    fn test_apply_slippage_sell_floored_at_min() {
        let result = apply_slippage(0.01, OrderSide::Sell);
        assert!(result >= MIN_PRICE);
    }

    #[test]
    fn test_round_to_decimals() {
        assert!((round_to_decimals(1.23456, 2) - 1.23).abs() < 1e-10);
        assert!((round_to_decimals(1.23456, 4) - 1.2346).abs() < 1e-10);
    }

    #[test]
    fn test_get_spread_for_price() {
        assert_eq!(get_spread_for_price(0.50), NORMAL_SPREAD);
        assert_eq!(get_spread_for_price(0.04), EXTREME_SPREAD);
        assert_eq!(get_spread_for_price(0.96), EXTREME_SPREAD);
        assert_eq!(get_spread_for_price(0.05), NORMAL_SPREAD);
        assert_eq!(get_spread_for_price(0.95), NORMAL_SPREAD);
    }

    #[test]
    fn test_validation_state_balance() {
        let state = ValidationState::new();
        state.set_balance(1000.0);
        assert!((state.get_balance() - 1000.0).abs() < 1e-10);

        assert!(state.try_deduct_balance(500.0));
        assert!((state.get_balance() - 500.0).abs() < 1e-10);

        assert!(!state.try_deduct_balance(600.0)); // insufficient
        assert!((state.get_balance() - 500.0).abs() < 1e-10); // unchanged
    }

    // =========================================================================
    // CROSS-VALIDATION: Executor flow vs Test API flow
    // =========================================================================
    //
    // The Executor (Flow A) builds OrderToSign via prepare_batch_orders().
    // The Test API (Flow B) builds OrderToSign inline in napi_exports.rs.
    // Both must produce identical maker_amount/taker_amount for the same inputs.

    /// Simulate the Test API's inline OrderToSign construction
    /// (exact replica of napi_exports.rs:741-785)
    fn build_order_to_sign_test_api_style(
        token_id: &str,
        price: f64,
        size: f64,
        side_str: &str,
        neg_risk: bool,
        fee_rate_bps: u32,
    ) -> OrderToSign {
        let side: u8 = if side_str == "SELL" { 1 } else { 0 };
        let decimals: f64 = 1_000_000.0;

        // Round size to 2 decimals (same as napi_exports.rs:748)
        let size_rounded = (size * 100.0).round() / 100.0;
        // Calculate USDC amount, round to 4 decimals (same as napi_exports.rs:750-751)
        let usdc_raw = price * size_rounded;
        let usdc_rounded = (usdc_raw * 10000.0).round() / 10000.0;

        let (maker_amount, taker_amount) = if side == 0 {
            let maker = (usdc_rounded * decimals).round() as u64;
            let taker = (size_rounded * decimals).round() as u64;
            (maker.to_string(), taker.to_string())
        } else {
            let maker = (size_rounded * decimals).round() as u64;
            let taker = (usdc_rounded * decimals).round() as u64;
            (maker.to_string(), taker.to_string())
        };

        OrderToSign {
            salt: "fixed_salt_for_test".to_string(),
            token_id: token_id.to_string(),
            maker_amount,
            taker_amount,
            side,
            neg_risk,
            fee_rate_bps,
        }
    }

    /// Build OrderToSign using the Executor's prepare_batch_orders path
    /// with slippage disabled (to match raw price).
    fn build_order_to_sign_executor_style(
        token_id: &str,
        price: f64,
        size: f64,
        side: OrderSide,
        neg_risk: bool,
    ) -> OrderToSign {
        let candidate = OrderCandidate {
            token_id: token_id.to_string(),
            price,
            side,
            orderbook_size: Some(100.0),
            neg_risk,
        };

        let config = ExecutorConfig {
            min_pnl_threshold_percent: 0.0,
            default_size: size,
            slippage_enabled: false, // disabled to match Test API (no slippage)
            opportunity_timeout_ms: 5000,
            maker_address: "0x0000000000000000000000000000000000000000".to_string(),
            signer_address: "0x0000000000000000000000000000000000000000".to_string(),
        };

        let mut orders = prepare_batch_orders(&[candidate], size, &config);
        let mut order = orders.remove(0);
        order.salt = "fixed_salt_for_test".to_string(); // fix salt for comparison
        order
    }

    #[test]
    fn test_cross_validate_buy_order_amounts() {
        // Test BUY order: both flows should produce identical maker/taker amounts
        let token_id = "12345678901234567890";
        let price = 0.65;
        let size = 10.0;

        let api_order = build_order_to_sign_test_api_style(
            token_id, price, size, "BUY", true, 0,
        );
        let exec_order = build_order_to_sign_executor_style(
            token_id, price, size, OrderSide::Buy, true,
        );

        assert_eq!(api_order.maker_amount, exec_order.maker_amount,
            "BUY maker_amount mismatch: API={} vs Executor={}",
            api_order.maker_amount, exec_order.maker_amount);
        assert_eq!(api_order.taker_amount, exec_order.taker_amount,
            "BUY taker_amount mismatch: API={} vs Executor={}",
            api_order.taker_amount, exec_order.taker_amount);
        assert_eq!(api_order.side, exec_order.side);
        assert_eq!(api_order.neg_risk, exec_order.neg_risk);
        assert_eq!(api_order.fee_rate_bps, exec_order.fee_rate_bps);
        assert_eq!(api_order.token_id, exec_order.token_id);

        println!("✅ BUY order: maker_amount={}, taker_amount={}", api_order.maker_amount, api_order.taker_amount);
    }

    #[test]
    fn test_cross_validate_sell_order_amounts() {
        // Test SELL order: both flows should produce identical maker/taker amounts
        let token_id = "99887766554433221100";
        let price = 0.42;
        let size = 15.0;

        let api_order = build_order_to_sign_test_api_style(
            token_id, price, size, "SELL", false, 0,
        );
        let exec_order = build_order_to_sign_executor_style(
            token_id, price, size, OrderSide::Sell, false,
        );

        assert_eq!(api_order.maker_amount, exec_order.maker_amount,
            "SELL maker_amount mismatch: API={} vs Executor={}",
            api_order.maker_amount, exec_order.maker_amount);
        assert_eq!(api_order.taker_amount, exec_order.taker_amount,
            "SELL taker_amount mismatch: API={} vs Executor={}",
            api_order.taker_amount, exec_order.taker_amount);
        assert_eq!(api_order.side, exec_order.side);

        println!("✅ SELL order: maker_amount={}, taker_amount={}", api_order.maker_amount, api_order.taker_amount);
    }

    #[test]
    fn test_cross_validate_fractional_size() {
        // Test with fractional size that needs rounding (e.g., 7.777 → 7.78)
        let token_id = "fractional_test_token";
        let price = 0.335;
        let size = 7.777;

        let api_order = build_order_to_sign_test_api_style(
            token_id, price, size, "BUY", true, 0,
        );
        let exec_order = build_order_to_sign_executor_style(
            token_id, price, size, OrderSide::Buy, true,
        );

        assert_eq!(api_order.maker_amount, exec_order.maker_amount,
            "Fractional BUY maker_amount mismatch: API={} vs Executor={}",
            api_order.maker_amount, exec_order.maker_amount);
        assert_eq!(api_order.taker_amount, exec_order.taker_amount,
            "Fractional BUY taker_amount mismatch: API={} vs Executor={}",
            api_order.taker_amount, exec_order.taker_amount);

        println!("✅ Fractional: size=7.777, maker_amount={}, taker_amount={}", api_order.maker_amount, api_order.taker_amount);
    }

    #[test]
    fn test_cross_validate_extreme_price() {
        // Test extreme prices (near 0 and near 1) — these trigger different tick sizes
        let token_id = "extreme_price_token";

        // Near zero
        let api_low = build_order_to_sign_test_api_style(
            token_id, 0.03, 20.0, "BUY", true, 0,
        );
        let exec_low = build_order_to_sign_executor_style(
            token_id, 0.03, 20.0, OrderSide::Buy, true,
        );
        assert_eq!(api_low.maker_amount, exec_low.maker_amount, "Low price mismatch");
        assert_eq!(api_low.taker_amount, exec_low.taker_amount, "Low price mismatch");

        // Near one
        let api_high = build_order_to_sign_test_api_style(
            token_id, 0.97, 20.0, "BUY", false, 0,
        );
        let exec_high = build_order_to_sign_executor_style(
            token_id, 0.97, 20.0, OrderSide::Buy, false,
        );
        assert_eq!(api_high.maker_amount, exec_high.maker_amount, "High price mismatch");
        assert_eq!(api_high.taker_amount, exec_high.taker_amount, "High price mismatch");

        println!("✅ Extreme prices: low maker={}, high maker={}", api_low.maker_amount, api_high.maker_amount);
    }

    #[test]
    fn test_slippage_changes_price_but_not_signing_logic() {
        // With slippage enabled, Executor adjusts price → different amounts.
        // This is EXPECTED and intentional (not a bug).
        let token_id = "slippage_test_token";
        let price = 0.50;
        let size = 10.0;

        // Test API: no slippage
        let api_order = build_order_to_sign_test_api_style(
            token_id, price, size, "BUY", true, 0,
        );

        // Executor with slippage ENABLED
        let candidate = OrderCandidate {
            token_id: token_id.to_string(),
            price,
            side: OrderSide::Buy,
            orderbook_size: Some(100.0),
            neg_risk: true,
        };
        let config_slippage = ExecutorConfig {
            min_pnl_threshold_percent: 0.0,
            default_size: size,
            slippage_enabled: true,
            opportunity_timeout_ms: 5000,
            maker_address: String::new(),
            signer_address: String::new(),
        };
        let mut exec_orders = prepare_batch_orders(&[candidate], size, &config_slippage);
        let exec_order = &mut exec_orders[0];
        exec_order.salt = "fixed_salt_for_test".to_string();

        // Price 0.50 + 0.01 spread = 0.51 → different maker_amount
        let slipped_price = apply_slippage(price, OrderSide::Buy);
        assert!((slipped_price - 0.51).abs() < 1e-10, "Expected slipped price 0.51");

        // maker_amount should be DIFFERENT (higher for BUY with slippage)
        assert_ne!(api_order.maker_amount, exec_order.maker_amount,
            "Expected different maker_amounts when slippage is enabled");
        // taker_amount (size) should be the SAME
        assert_eq!(api_order.taker_amount, exec_order.taker_amount,
            "taker_amount (size) should be identical regardless of slippage");

        println!("✅ Slippage: API maker={} vs Executor maker={} (expected different)",
            api_order.maker_amount, exec_order.maker_amount);
    }
}

//! Trio evaluator — Triangle Arbitrage (BUY) + Complement Triangle Arbitrage.
//!
//! Triangle BUY:  Reads parent_lower YES + parent_upper NO + range NO. Payout = 2.
//! Complement BUY: Reads parent_lower NO  + range YES + parent_upper YES. Payout = 1.
//! Emits `POLYMARKET_TRIANGLE_BUY` and `POLYMARKET_COMPLEMENT_BUY` signals.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::state::{EngineConfig, GroupState, PriceTable, TrioState};
use crate::types::signal::ArbSignal;

/// Internal profit result from trio calculation.
pub struct TrioProfit {
    pub total_ask: f64,
    pub total_bid: f64,
    pub profit_abs: f64,
    pub profit_bps: f64,
    pub payout: f64,
}

/// Pure profit calculation — reads 3 slots from PriceTable.
#[inline(always)]
pub fn calc_trio_profit_only(trio: &TrioState, pt: &PriceTable, cfg: &EngineConfig) -> Option<TrioProfit> {
    let ly = pt.get(trio.lower_yes_slot);
    let un = pt.get(trio.upper_no_slot);
    let rn = pt.get(trio.range_no_slot);

    // Any NaN → not enough data
    if ly.best_ask.is_nan()
        || un.best_ask.is_nan()
        || rn.best_ask.is_nan()
        || ly.best_bid.is_nan()
        || un.best_bid.is_nan()
        || rn.best_bid.is_nan()
    {
        return None;
    }

    let payout = 2.0_f64;
    let total_ask = ly.best_ask + un.best_ask + rn.best_ask;
    let total_bid = ly.best_bid + un.best_bid + rn.best_bid;

    let profit_buy = payout - total_ask;
    let profit_bps_buy = (profit_buy / total_ask) * 10000.0;

    let meets_buy =
        profit_buy >= cfg.min_profit_abs && profit_bps_buy >= cfg.min_profit_bps;

    if !meets_buy {
        return None;
    }

    Some(TrioProfit {
        total_ask,
        total_bid,
        profit_abs: profit_buy,
        profit_bps: profit_bps_buy,
        payout,
    })
}

/// Evaluate a single trio: calc profit → check cooldown → build signal.
pub fn evaluate_single_trio(
    group: &mut GroupState,
    trio_idx: usize,
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Option<ArbSignal> {
    let trio = &group.trio_states[trio_idx];

    let calc = calc_trio_profit_only(trio, pt, cfg)?;

    // Cooldown check
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if group.trio_states[trio_idx].last_emitted_buy_ms > 0
        && now_ms - group.trio_states[trio_idx].last_emitted_buy_ms < cfg.cooldown_ms
    {
        return None;
    }

    // Build signal from trio legs (YES/NO/NO)
    let trio = &group.trio_states[trio_idx];
    let ly = pt.get(trio.lower_yes_slot);
    let un = pt.get(trio.upper_no_slot);
    let rn = pt.get(trio.range_no_slot);

    let parent_lower_meta = &group.parent_metas[trio.parent_lower_idx as usize];
    let parent_upper_meta = &group.parent_metas[trio.parent_upper_idx as usize];
    let range_child_meta = &group.child_metas[trio.range_idx as usize];

    let signal = ArbSignal {
        group_key: group.group_key.clone(),
        event_slug: group.event_slug.clone(),
        crypto: group.crypto.clone(),
        strategy: "POLYMARKET_TRIANGLE_BUY".to_string(),

        profit_abs: calc.profit_abs,
        profit_bps: calc.profit_bps,
        timestamp_ms: now_ms,

        // Parent Lower — YES token
        parent_asset_id: trio.lower_yes_token.clone(),
        parent_market_slug: parent_lower_meta.slug.clone(),
        parent_best_bid: Some(ly.best_bid),
        parent_best_ask: Some(ly.best_ask),
        parent_best_bid_size: Some(ly.best_bid_size),
        parent_best_ask_size: Some(ly.best_ask_size),
        parent_neg_risk: parent_lower_meta.neg_risk,


        // Parent Upper — NO token
        parent_upper_asset_id: trio.upper_no_token.clone(),
        parent_upper_market_slug: parent_upper_meta.slug.clone(),
        parent_upper_best_bid: Some(un.best_bid),
        parent_upper_best_ask: Some(un.best_ask),
        parent_upper_best_bid_size: Some(un.best_bid_size),
        parent_upper_best_ask_size: Some(un.best_ask_size),
        parent_upper_neg_risk: parent_upper_meta.neg_risk,

        // Range Child — NO token
        child_asset_id: trio.range_no_token.clone(),
        child_market_slug: range_child_meta.slug.clone(),
        child_best_bid: Some(rn.best_bid),
        child_best_ask: Some(rn.best_ask),
        child_best_bid_size: Some(rn.best_bid_size),
        child_best_ask_size: Some(rn.best_ask_size),
        child_neg_risk: range_child_meta.neg_risk,
        child_index: trio.range_idx as i32,

        // Aggregates
        children_sum_ask: rn.best_ask,
        children_sum_bid: rn.best_bid,
        parent_best_bid_flat: Some(ly.best_bid),
        parent_best_ask_flat: Some(ly.best_ask),
        parent_upper_best_bid_flat: Some(un.best_bid),
        parent_upper_best_ask_flat: Some(un.best_ask),

        // Triangle context
        triangle_total_cost: Some(calc.total_ask),
        triangle_total_bid: Some(calc.total_bid),
        triangle_payout: Some(calc.payout),
        triangle_mode: Some("BUY".to_string()),

        reason: "POLYMARKET_TRIANGLE_BUY_COST_LT_PAYOUT".to_string(),
    };

    // Mark cooldown
    group.trio_states[trio_idx].last_emitted_buy_ms = now_ms;

    Some(signal)
}

// =============================================================================
// COMPLEMENT TRIANGLE: Parent Lower NO + Range YES + Parent Upper YES
// =============================================================================

/// Complement profit result.
pub struct ComplementProfit {
    pub total_ask: f64,
    pub total_bid: f64,
    pub profit_abs: f64,
    pub profit_bps: f64,
    pub payout: f64,
}

/// Pure profit calculation for complement triangle.
/// Reads 3 slots: lower_no + range_yes + upper_yes.
/// Payout = 1.0 (exactly one of the 3 complement outcomes is true).
#[inline(always)]
pub fn calc_complement_profit_only(
    trio: &TrioState,
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Option<ComplementProfit> {
    let ln = pt.get(trio.lower_no_slot);
    let ry = pt.get(trio.range_yes_slot);
    let uy = pt.get(trio.upper_yes_slot);

    // Any NaN → not enough data
    if ln.best_ask.is_nan()
        || ry.best_ask.is_nan()
        || uy.best_ask.is_nan()
        || ln.best_bid.is_nan()
        || ry.best_bid.is_nan()
        || uy.best_bid.is_nan()
    {
        return None;
    }

    let payout = 1.0_f64;
    let total_ask = ln.best_ask + ry.best_ask + uy.best_ask;
    let total_bid = ln.best_bid + ry.best_bid + uy.best_bid;

    let profit_buy = payout - total_ask;
    let profit_bps_buy = (profit_buy / total_ask) * 10000.0;

    let meets_buy =
        profit_buy >= cfg.min_profit_abs && profit_bps_buy >= cfg.min_profit_bps;

    if !meets_buy {
        return None;
    }

    Some(ComplementProfit {
        total_ask,
        total_bid,
        profit_abs: profit_buy,
        profit_bps: profit_bps_buy,
        payout,
    })
}

/// Evaluate complement triangle: calc profit → check cooldown → build signal.
pub fn evaluate_complement_trio(
    group: &mut GroupState,
    trio_idx: usize,
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Option<ArbSignal> {
    let trio = &group.trio_states[trio_idx];

    let calc = calc_complement_profit_only(trio, pt, cfg)?;

    // Cooldown check
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if group.trio_states[trio_idx].last_emitted_complement_ms > 0
        && now_ms - group.trio_states[trio_idx].last_emitted_complement_ms < cfg.cooldown_ms
    {
        return None;
    }

    // Build signal from complement legs (NO/YES/YES)
    let trio = &group.trio_states[trio_idx];
    let ln = pt.get(trio.lower_no_slot);
    let ry = pt.get(trio.range_yes_slot);
    let uy = pt.get(trio.upper_yes_slot);

    let parent_lower_meta = &group.parent_metas[trio.parent_lower_idx as usize];
    let parent_upper_meta = &group.parent_metas[trio.parent_upper_idx as usize];
    let range_child_meta = &group.child_metas[trio.range_idx as usize];

    let signal = ArbSignal {
        group_key: group.group_key.clone(),
        event_slug: group.event_slug.clone(),
        crypto: group.crypto.clone(),
        strategy: "POLYMARKET_COMPLEMENT_BUY".to_string(),

        profit_abs: calc.profit_abs,
        profit_bps: calc.profit_bps,
        timestamp_ms: now_ms,

        // Parent Lower — NO token
        parent_asset_id: trio.lower_no_token.clone(),
        parent_market_slug: parent_lower_meta.slug.clone(),
        parent_best_bid: Some(ln.best_bid),
        parent_best_ask: Some(ln.best_ask),
        parent_best_bid_size: Some(ln.best_bid_size),
        parent_best_ask_size: Some(ln.best_ask_size),
        parent_neg_risk: parent_lower_meta.neg_risk,

        // Parent Upper — YES token
        parent_upper_asset_id: trio.upper_yes_token.clone(),
        parent_upper_market_slug: parent_upper_meta.slug.clone(),
        parent_upper_best_bid: Some(uy.best_bid),
        parent_upper_best_ask: Some(uy.best_ask),
        parent_upper_best_bid_size: Some(uy.best_bid_size),
        parent_upper_best_ask_size: Some(uy.best_ask_size),
        parent_upper_neg_risk: parent_upper_meta.neg_risk,

        // Range Child — YES token
        child_asset_id: trio.range_yes_token.clone(),
        child_market_slug: range_child_meta.slug.clone(),
        child_best_bid: Some(ry.best_bid),
        child_best_ask: Some(ry.best_ask),
        child_best_bid_size: Some(ry.best_bid_size),
        child_best_ask_size: Some(ry.best_ask_size),
        child_neg_risk: range_child_meta.neg_risk,
        child_index: trio.range_idx as i32,

        // Aggregates
        children_sum_ask: ry.best_ask,
        children_sum_bid: ry.best_bid,
        parent_best_bid_flat: Some(ln.best_bid),
        parent_best_ask_flat: Some(ln.best_ask),
        parent_upper_best_bid_flat: Some(uy.best_bid),
        parent_upper_best_ask_flat: Some(uy.best_ask),

        // Triangle context
        triangle_total_cost: Some(calc.total_ask),
        triangle_total_bid: Some(calc.total_bid),
        triangle_payout: Some(calc.payout),
        triangle_mode: Some("COMPLEMENT_BUY".to_string()),

        reason: "POLYMARKET_COMPLEMENT_BUY_COST_LT_PAYOUT".to_string(),
    };

    // Mark cooldown
    group.trio_states[trio_idx].last_emitted_complement_ms = now_ms;

    Some(signal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::state::PriceSlot;

    fn make_price_table(ly: (f64, f64), un: (f64, f64), rn: (f64, f64)) -> PriceTable {
        let mut pt = PriceTable::new();
        pt.slots.push(PriceSlot { best_bid: ly.0, best_ask: ly.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: un.0, best_ask: un.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: rn.0, best_ask: rn.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt
    }

    fn make_trio() -> TrioState {
        TrioState {
            parent_lower_idx: 0,
            parent_upper_idx: 1,
            range_idx: 0,
            lower_yes_slot: 0,
            upper_no_slot: 1,
            range_no_slot: 2,
            lower_yes_token: "ly_token".to_string(),
            upper_no_token: "un_token".to_string(),
            range_no_token: "rn_token".to_string(),
            // Complement slots (not used in triangle tests, set to 0)
            lower_no_slot: 0,
            range_yes_slot: 0,
            upper_yes_slot: 0,
            lower_no_token: "ln_token".to_string(),
            range_yes_token: "ry_token".to_string(),
            upper_yes_token: "uy_token".to_string(),
            last_emitted_buy_ms: 0,
            last_emitted_complement_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        }
    }

    #[test]
    fn test_calc_trio_profit_meets_threshold() {
        // Payout = 2.0
        // totalAsk = 0.60 + 0.50 + 0.80 = 1.90
        // profit = 2.0 - 1.90 = 0.10
        // bps = (0.10 / 1.90) * 10000 ≈ 526
        let pt = make_price_table((0.62, 0.60), (0.52, 0.50), (0.82, 0.80));
        let trio = make_trio();
        let cfg = EngineConfig {
            min_profit_abs: 0.005,
            min_profit_bps: 30.0,
            cooldown_ms: 3000,
        };

        let result = calc_trio_profit_only(&trio, &pt, &cfg);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!((r.profit_abs - 0.10).abs() < 1e-10);
        assert!((r.total_ask - 1.90).abs() < 1e-10);
        assert!(r.profit_bps > 500.0);
    }

    #[test]
    fn test_calc_trio_profit_below_threshold() {
        // totalAsk = 0.67 + 0.67 + 0.67 = 2.01 > payout
        let pt = make_price_table((0.66, 0.67), (0.66, 0.67), (0.66, 0.67));
        let trio = make_trio();
        let cfg = EngineConfig::default();

        let result = calc_trio_profit_only(&trio, &pt, &cfg);
        assert!(result.is_none());
    }

    #[test]
    fn test_calc_trio_profit_nan_input() {
        let mut pt = PriceTable::new();
        pt.slots.push(PriceSlot::default()); // NaN
        pt.slots.push(PriceSlot { best_bid: 0.50, best_ask: 0.50, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: 0.50, best_ask: 0.50, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        let trio = make_trio();
        let cfg = EngineConfig::default();

        assert!(calc_trio_profit_only(&trio, &pt, &cfg).is_none());
    }

    // =========================================================================
    // Complement triangle tests
    // =========================================================================

    fn make_complement_price_table(
        ln: (f64, f64),
        ry: (f64, f64),
        uy: (f64, f64),
    ) -> PriceTable {
        let mut pt = PriceTable::new();
        pt.slots.push(PriceSlot { best_bid: ln.0, best_ask: ln.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: ry.0, best_ask: ry.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: uy.0, best_ask: uy.1, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt
    }

    fn make_complement_trio() -> TrioState {
        TrioState {
            parent_lower_idx: 0,
            parent_upper_idx: 1,
            range_idx: 0,
            // Triangle slots (not used in complement tests)
            lower_yes_slot: 0,
            upper_no_slot: 0,
            range_no_slot: 0,
            lower_yes_token: "ly_token".to_string(),
            upper_no_token: "un_token".to_string(),
            range_no_token: "rn_token".to_string(),
            // Complement slots
            lower_no_slot: 0,
            range_yes_slot: 1,
            upper_yes_slot: 2,
            lower_no_token: "ln_token".to_string(),
            range_yes_token: "ry_token".to_string(),
            upper_yes_token: "uy_token".to_string(),
            last_emitted_buy_ms: 0,
            last_emitted_complement_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        }
    }

    #[test]
    fn test_complement_profit_meets_threshold() {
        // Payout = 1.0
        // BTC (>80K) NO ask = 0.40, BTC (80k-82k) YES ask = 0.20, BTC (>82K) YES ask = 0.15
        // totalAsk = 0.40 + 0.20 + 0.15 = 0.75
        // profit = 1.0 - 0.75 = 0.25
        // bps = (0.25 / 0.75) * 10000 ≈ 3333
        let pt = make_complement_price_table((0.38, 0.40), (0.18, 0.20), (0.13, 0.15));
        let trio = make_complement_trio();
        let cfg = EngineConfig {
            min_profit_abs: 0.005,
            min_profit_bps: 30.0,
            cooldown_ms: 3000,
        };

        let result = calc_complement_profit_only(&trio, &pt, &cfg);
        assert!(result.is_some());
        let r = result.unwrap();
        assert!((r.profit_abs - 0.25).abs() < 1e-10);
        assert!((r.total_ask - 0.75).abs() < 1e-10);
        assert!((r.payout - 1.0).abs() < 1e-10);
        assert!(r.profit_bps > 3000.0);
    }

    #[test]
    fn test_complement_profit_below_threshold() {
        // totalAsk = 0.40 + 0.35 + 0.30 = 1.05 > payout 1.0
        let pt = make_complement_price_table((0.38, 0.40), (0.33, 0.35), (0.28, 0.30));
        let trio = make_complement_trio();
        let cfg = EngineConfig::default();

        let result = calc_complement_profit_only(&trio, &pt, &cfg);
        assert!(result.is_none());
    }

    #[test]
    fn test_complement_profit_nan_input() {
        let mut pt = PriceTable::new();
        pt.slots.push(PriceSlot::default()); // NaN
        pt.slots.push(PriceSlot { best_bid: 0.20, best_ask: 0.20, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        pt.slots.push(PriceSlot { best_bid: 0.15, best_ask: 0.15, best_bid_size: 100.0, best_ask_size: 100.0, timestamp_ms: 1 });
        let trio = make_complement_trio();
        let cfg = EngineConfig::default();

        assert!(calc_complement_profit_only(&trio, &pt, &cfg).is_none());
    }
}

//! Trio evaluator — Triangle Arbitrage (BUY only).
//!
//! Reads from PriceTable: parent_lower YES + parent_upper NO + range NO.
//! Emits `POLYMARKET_TRIANGLE_BUY` signals.

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
            last_emitted_buy_ms: 0,
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
}

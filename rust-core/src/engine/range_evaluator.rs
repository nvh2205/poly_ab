//! Range evaluator — Unbundling + Bundling arbitrage.
//!
//! Reads from PriceTable: parent_lower YES + parent_upper YES + range YES.
//! NOTE: These are YES token slots — different from Trio which uses NO for upper/range!

use std::time::{SystemTime, UNIX_EPOCH};

use crate::engine::state::{EngineConfig, GroupState, PriceTable};
use crate::types::signal::ArbSignal;

/// Evaluate all trios affected by a token update for range arbitrage.
/// Called after updating a token that is in `trio_lookup_by_asset`.
pub fn evaluate_trios_for_range_arbitrage(
    group: &mut GroupState,
    trio_indices: &[u16],
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Vec<ArbSignal> {
    let mut signals = Vec::new();

    for &idx in trio_indices {
        let trio_idx = idx as usize;
        if trio_idx >= group.trio_states.len() {
            continue;
        }

        // Unbundling: Sell Parent Lower YES, Buy Range YES + Parent Upper YES
        if let Some(sig) = evaluate_unbundling(group, trio_idx, pt, cfg) {
            signals.push(sig);
        }

        // Bundling: Buy Parent Lower YES, Sell Range YES + Parent Upper YES
        if let Some(sig) = evaluate_bundling(group, trio_idx, pt, cfg) {
            signals.push(sig);
        }
    }

    signals
}

/// Unbundling: Sell Parent Lower YES, Buy Range YES + Parent Upper YES
///
/// Profit = Bid(ParentLower YES) - (Ask(Range YES) + Ask(ParentUpper YES))
/// Strategy: SELL_PARENT_BUY_CHILDREN
fn evaluate_unbundling(
    group: &mut GroupState,
    trio_idx: usize,
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Option<ArbSignal> {
    let trio = &group.trio_states[trio_idx];

    // Read YES slots for all 3 markets
    let parent_lower = pt.get(group.parent_metas[trio.parent_lower_idx as usize].yes_slot);
    let parent_upper = pt.get(group.parent_metas[trio.parent_upper_idx as usize].yes_slot);
    let range_child = pt.get(group.child_metas[trio.range_idx as usize].yes_slot);

    if parent_lower.best_bid.is_nan()
        || range_child.best_ask.is_nan()
        || parent_upper.best_ask.is_nan()
    {
        return None;
    }

    let cost = range_child.best_ask + parent_upper.best_ask;
    let profit_abs = parent_lower.best_bid - cost;
    let profit_bps = if cost > 0.0 {
        (profit_abs / cost) * 10000.0
    } else {
        0.0
    };

    if profit_abs < cfg.min_profit_abs || profit_bps < cfg.min_profit_bps {
        return None;
    }

    // Cooldown check
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if group.trio_states[trio_idx].last_emitted_unbundle_ms > 0
        && now_ms - group.trio_states[trio_idx].last_emitted_unbundle_ms < cfg.cooldown_ms
    {
        return None;
    }

    // Build signal using YES token data
    let trio = &group.trio_states[trio_idx];
    let parent_lower_meta = &group.parent_metas[trio.parent_lower_idx as usize];
    let parent_upper_meta = &group.parent_metas[trio.parent_upper_idx as usize];
    let range_child_meta = &group.child_metas[trio.range_idx as usize];

    let signal = build_range_signal(
        group,
        "SELL_PARENT_BUY_CHILDREN",
        profit_abs,
        profit_bps,
        now_ms,
        parent_lower_meta,
        parent_upper_meta,
        range_child_meta,
        parent_lower,
        parent_upper,
        range_child,
        trio.range_idx as i32,
    );

    // Mark cooldown
    group.trio_states[trio_idx].last_emitted_unbundle_ms = now_ms;

    Some(signal)
}

/// Bundling: Buy Parent Lower YES, Sell Range YES + Parent Upper YES
///
/// Profit = (Bid(Range YES) + Bid(ParentUpper YES)) - Ask(ParentLower YES)
/// Strategy: BUY_PARENT_SELL_CHILDREN
fn evaluate_bundling(
    group: &mut GroupState,
    trio_idx: usize,
    pt: &PriceTable,
    cfg: &EngineConfig,
) -> Option<ArbSignal> {
    let trio = &group.trio_states[trio_idx];

    // Read YES slots for all 3 markets
    let parent_lower = pt.get(group.parent_metas[trio.parent_lower_idx as usize].yes_slot);
    let parent_upper = pt.get(group.parent_metas[trio.parent_upper_idx as usize].yes_slot);
    let range_child = pt.get(group.child_metas[trio.range_idx as usize].yes_slot);

    if parent_lower.best_ask.is_nan()
        || range_child.best_bid.is_nan()
        || parent_upper.best_bid.is_nan()
    {
        return None;
    }

    let revenue = range_child.best_bid + parent_upper.best_bid;
    let profit_abs = revenue - parent_lower.best_ask;
    let profit_bps = if parent_lower.best_ask > 0.0 {
        (profit_abs / parent_lower.best_ask) * 10000.0
    } else {
        0.0
    };

    if profit_abs < cfg.min_profit_abs || profit_bps < cfg.min_profit_bps {
        return None;
    }

    // Cooldown check
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    if group.trio_states[trio_idx].last_emitted_bundle_ms > 0
        && now_ms - group.trio_states[trio_idx].last_emitted_bundle_ms < cfg.cooldown_ms
    {
        return None;
    }

    let trio = &group.trio_states[trio_idx];
    let parent_lower_meta = &group.parent_metas[trio.parent_lower_idx as usize];
    let parent_upper_meta = &group.parent_metas[trio.parent_upper_idx as usize];
    let range_child_meta = &group.child_metas[trio.range_idx as usize];

    let signal = build_range_signal(
        group,
        "BUY_PARENT_SELL_CHILDREN",
        profit_abs,
        profit_bps,
        now_ms,
        parent_lower_meta,
        parent_upper_meta,
        range_child_meta,
        parent_lower,
        parent_upper,
        range_child,
        trio.range_idx as i32,
    );

    // Mark cooldown
    group.trio_states[trio_idx].last_emitted_bundle_ms = now_ms;

    Some(signal)
}

/// Build an ArbSignal for range arbitrage (unbundling or bundling).
/// All prices come from YES token slots.
#[allow(clippy::too_many_arguments)]
fn build_range_signal(
    group: &GroupState,
    strategy: &str,
    profit_abs: f64,
    profit_bps: f64,
    now_ms: i64,
    parent_lower_meta: &crate::engine::state::MarketMeta,
    parent_upper_meta: &crate::engine::state::MarketMeta,
    range_child_meta: &crate::engine::state::MarketMeta,
    parent_lower: &crate::engine::state::PriceSlot,
    parent_upper: &crate::engine::state::PriceSlot,
    range_child: &crate::engine::state::PriceSlot,
    range_index: i32,
) -> ArbSignal {
    ArbSignal {
        group_key: group.group_key.clone(),
        event_slug: group.event_slug.clone(),
        crypto: group.crypto.clone(),
        strategy: strategy.to_string(),

        profit_abs,
        profit_bps,
        timestamp_ms: now_ms,

        // Parent Lower — YES token
        parent_asset_id: parent_lower_meta.clob_token_ids[0].clone(),
        parent_market_slug: parent_lower_meta.slug.clone(),
        parent_best_bid: Some(parent_lower.best_bid),
        parent_best_ask: Some(parent_lower.best_ask),
        parent_best_bid_size: Some(parent_lower.best_bid_size),
        parent_best_ask_size: Some(parent_lower.best_ask_size),
        parent_neg_risk: parent_lower_meta.neg_risk,

        // Parent Upper — YES token (NOT no_slot!)
        parent_upper_asset_id: parent_upper_meta.clob_token_ids[0].clone(),
        parent_upper_market_slug: parent_upper_meta.slug.clone(),
        parent_upper_best_bid: Some(parent_upper.best_bid),
        parent_upper_best_ask: Some(parent_upper.best_ask),
        parent_upper_best_bid_size: Some(parent_upper.best_bid_size),
        parent_upper_best_ask_size: Some(parent_upper.best_ask_size),
        parent_upper_neg_risk: parent_upper_meta.neg_risk,

        // Range Child — YES token
        child_asset_id: range_child_meta.clob_token_ids[0].clone(),
        child_market_slug: range_child_meta.slug.clone(),
        child_best_bid: Some(range_child.best_bid),
        child_best_ask: Some(range_child.best_ask),
        child_best_bid_size: Some(range_child.best_bid_size),
        child_best_ask_size: Some(range_child.best_ask_size),
        child_neg_risk: range_child_meta.neg_risk,
        child_index: range_index,

        // Aggregates
        children_sum_ask: if range_child.best_ask.is_nan() { 0.0 } else { range_child.best_ask },
        children_sum_bid: if range_child.best_bid.is_nan() { 0.0 } else { range_child.best_bid },
        parent_best_bid_flat: Some(parent_lower.best_bid),
        parent_best_ask_flat: Some(parent_lower.best_ask),
        parent_upper_best_bid_flat: Some(parent_upper.best_bid),
        parent_upper_best_ask_flat: Some(parent_upper.best_ask),

        // No triangle context for range arb
        triangle_total_cost: None,
        triangle_total_bid: None,
        triangle_payout: None,
        triangle_mode: None,

        reason: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::state::{MarketKind, MarketMeta, PriceTable, TrioState};

    fn make_yes_price_table(
        pl: (f64, f64),
        pu: (f64, f64),
        rc: (f64, f64),
    ) -> (PriceTable, MarketMeta, MarketMeta, MarketMeta) {
        let mut pt = PriceTable::new();
        // Parent lower: slot 0 = YES
        let pl_yes = pt.alloc_slot("pl_yes");
        let pl_no = pt.alloc_slot("pl_no");
        pt.update(pl_yes, pl.0, pl.1, Some(100.0), Some(100.0), 1);

        // Parent upper: slot 2 = YES
        let pu_yes = pt.alloc_slot("pu_yes");
        let pu_no = pt.alloc_slot("pu_no");
        pt.update(pu_yes, pu.0, pu.1, Some(100.0), Some(100.0), 1);

        // Range child: slot 4 = YES
        let rc_yes = pt.alloc_slot("rc_yes");
        let rc_no = pt.alloc_slot("rc_no");
        pt.update(rc_yes, rc.0, rc.1, Some(100.0), Some(100.0), 1);

        let pl_meta = MarketMeta {
            market_id: "pl".to_string(),
            slug: "pl-slug".to_string(),
            clob_token_ids: ["pl_yes".to_string(), "pl_no".to_string()],
            bounds_lower: Some(2800.0),
            bounds_upper: None,
            kind: MarketKind::Above,
            neg_risk: false,
            yes_slot: pl_yes,
            no_slot: pl_no,
        };

        let pu_meta = MarketMeta {
            market_id: "pu".to_string(),
            slug: "pu-slug".to_string(),
            clob_token_ids: ["pu_yes".to_string(), "pu_no".to_string()],
            bounds_lower: Some(2900.0),
            bounds_upper: None,
            kind: MarketKind::Above,
            neg_risk: false,
            yes_slot: pu_yes,
            no_slot: pu_no,
        };

        let rc_meta = MarketMeta {
            market_id: "rc".to_string(),
            slug: "rc-slug".to_string(),
            clob_token_ids: ["rc_yes".to_string(), "rc_no".to_string()],
            bounds_lower: Some(2800.0),
            bounds_upper: Some(2900.0),
            kind: MarketKind::Range,
            neg_risk: false,
            yes_slot: rc_yes,
            no_slot: rc_no,
        };

        (pt, pl_meta, pu_meta, rc_meta)
    }

    #[test]
    fn test_unbundling_profit() {
        // Unbundling: profit = Bid(PL_YES) - (Ask(RC_YES) + Ask(PU_YES))
        // = 0.80 - (0.30 + 0.40) = 0.80 - 0.70 = 0.10
        let (pt, pl_meta, pu_meta, rc_meta) =
            make_yes_price_table((0.80, 0.82), (0.38, 0.40), (0.28, 0.30));

        let trio = TrioState {
            parent_lower_idx: 0,
            parent_upper_idx: 1,
            range_idx: 0,
            lower_yes_slot: pl_meta.yes_slot,
            upper_no_slot: pu_meta.no_slot,
            range_no_slot: rc_meta.no_slot,
            lower_yes_token: "pl_yes".to_string(),
            upper_no_token: "pu_no".to_string(),
            range_no_token: "rc_no".to_string(),
            lower_no_slot: pl_meta.no_slot,
            range_yes_slot: rc_meta.yes_slot,
            upper_yes_slot: pu_meta.yes_slot,
            lower_no_token: "pl_no".to_string(),
            range_yes_token: "rc_yes".to_string(),
            upper_yes_token: "pu_yes".to_string(),
            last_emitted_buy_ms: 0,
            last_emitted_complement_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        };

        let mut group = GroupState {
            group_key: "test".to_string(),
            event_slug: "test-slug".to_string(),
            crypto: "ETH".to_string(),
            child_metas: vec![rc_meta],
            parent_metas: vec![pl_meta, pu_meta],
            trio_states: vec![trio],
            trio_lookup_by_asset: std::collections::HashMap::new(),
        };

        let cfg = EngineConfig {
            min_profit_abs: 0.005,
            min_profit_bps: 30.0,
            cooldown_ms: 3000,
        };

        let result = evaluate_unbundling(&mut group, 0, &pt, &cfg);
        assert!(result.is_some());
        let sig = result.unwrap();
        assert!((sig.profit_abs - 0.10).abs() < 1e-10);
        assert_eq!(sig.strategy, "SELL_PARENT_BUY_CHILDREN");
        // Verify YES tokens are used (not NO)
        assert_eq!(sig.parent_asset_id, "pl_yes");
        assert_eq!(sig.parent_upper_asset_id, "pu_yes");
        assert_eq!(sig.child_asset_id, "rc_yes");
    }

    #[test]
    fn test_bundling_profit() {
        // Bundling: profit = (Bid(RC_YES) + Bid(PU_YES)) - Ask(PL_YES)
        // = (0.40 + 0.30) - 0.60 = 0.70 - 0.60 = 0.10
        let (pt, pl_meta, pu_meta, rc_meta) =
            make_yes_price_table((0.58, 0.60), (0.30, 0.32), (0.40, 0.42));

        let trio = TrioState {
            parent_lower_idx: 0,
            parent_upper_idx: 1,
            range_idx: 0,
            lower_yes_slot: pl_meta.yes_slot,
            upper_no_slot: pu_meta.no_slot,
            range_no_slot: rc_meta.no_slot,
            lower_yes_token: "pl_yes".to_string(),
            upper_no_token: "pu_no".to_string(),
            range_no_token: "rc_no".to_string(),
            lower_no_slot: pl_meta.no_slot,
            range_yes_slot: rc_meta.yes_slot,
            upper_yes_slot: pu_meta.yes_slot,
            lower_no_token: "pl_no".to_string(),
            range_yes_token: "rc_yes".to_string(),
            upper_yes_token: "pu_yes".to_string(),
            last_emitted_buy_ms: 0,
            last_emitted_complement_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        };

        let mut group = GroupState {
            group_key: "test".to_string(),
            event_slug: "test-slug".to_string(),
            crypto: "ETH".to_string(),
            child_metas: vec![rc_meta],
            parent_metas: vec![pl_meta, pu_meta],
            trio_states: vec![trio],
            trio_lookup_by_asset: std::collections::HashMap::new(),
        };

        let cfg = EngineConfig {
            min_profit_abs: 0.005,
            min_profit_bps: 30.0,
            cooldown_ms: 3000,
        };

        let result = evaluate_bundling(&mut group, 0, &pt, &cfg);
        assert!(result.is_some());
        let sig = result.unwrap();
        assert!((sig.profit_abs - 0.10).abs() < 1e-10);
        assert_eq!(sig.strategy, "BUY_PARENT_SELL_CHILDREN");
        assert_eq!(sig.parent_asset_id, "pl_yes");
        assert_eq!(sig.parent_upper_asset_id, "pu_yes");
        assert_eq!(sig.child_asset_id, "rc_yes");
    }

    #[test]
    fn test_unbundling_below_threshold() {
        // No profit: 0.50 - (0.30 + 0.25) = -0.05
        let (pt, pl_meta, pu_meta, rc_meta) =
            make_yes_price_table((0.50, 0.52), (0.23, 0.25), (0.28, 0.30));

        let trio = TrioState {
            parent_lower_idx: 0,
            parent_upper_idx: 1,
            range_idx: 0,
            lower_yes_slot: pl_meta.yes_slot,
            upper_no_slot: pu_meta.no_slot,
            range_no_slot: rc_meta.no_slot,
            lower_yes_token: "pl_yes".to_string(),
            upper_no_token: "pu_no".to_string(),
            range_no_token: "rc_no".to_string(),
            lower_no_slot: pl_meta.no_slot,
            range_yes_slot: rc_meta.yes_slot,
            upper_yes_slot: pu_meta.yes_slot,
            lower_no_token: "pl_no".to_string(),
            range_yes_token: "rc_yes".to_string(),
            upper_yes_token: "pu_yes".to_string(),
            last_emitted_buy_ms: 0,
            last_emitted_complement_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        };

        let mut group = GroupState {
            group_key: "test".to_string(),
            event_slug: "test-slug".to_string(),
            crypto: "ETH".to_string(),
            child_metas: vec![rc_meta],
            parent_metas: vec![pl_meta, pu_meta],
            trio_states: vec![trio],
            trio_lookup_by_asset: std::collections::HashMap::new(),
        };

        let cfg = EngineConfig::default();
        assert!(evaluate_unbundling(&mut group, 0, &pt, &cfg).is_none());
    }
}

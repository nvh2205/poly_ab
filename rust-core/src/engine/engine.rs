//! Main engine — handle_top_of_book dispatch + market structure builder.
//!
//! Receives TopOfBookUpdate from socket, dispatches to trio and range evaluators.
//! Also builds groups/trios from RangeGroupInput.

use std::collections::HashMap;

// range_evaluator will be used when range arb is enabled
use crate::engine::state::*;
use crate::engine::trio_evaluator;
use crate::types::signal::ArbSignal;

// =============================================================================
// MARKET STRUCTURE BUILDER — Called from update_market_structure()
// =============================================================================

/// Input from Node.js for a single market descriptor.
pub struct MarketDescriptorInput {
    pub market_id: String,
    pub slug: String,
    pub clob_token_ids: Vec<String>,
    pub bounds_lower: Option<f64>,
    pub bounds_upper: Option<f64>,
    pub kind: String,
    pub neg_risk: bool,
}

/// Input from Node.js for a group.
pub struct RangeGroupInput {
    pub group_key: String,
    pub event_slug: String,
    pub crypto: String,
    pub children: Vec<MarketDescriptorInput>,
    pub parents: Vec<MarketDescriptorInput>,
}

impl EngineState {
    /// Rebuild all groups from market structure (called by N-API).
    /// Clears previous state and recreates PriceTable, groups, trios, indices.
    pub fn update_market_structure(&mut self, groups_input: Vec<RangeGroupInput>) -> i32 {
        // Clear old state
        self.groups.clear();
        self.group_key_index.clear();
        self.token_index.clear();
        self.last_price_cache.clear();
        self.price_table = PriceTable::new();

        let mut total_trios = 0i32;

        for (group_raw_idx, g) in groups_input.into_iter().enumerate() {
            let group_idx = group_raw_idx as u16;

            // Build child metas (range markets)
            let child_metas: Vec<MarketMeta> = g
                .children
                .into_iter()
                .filter(|c| c.clob_token_ids.len() >= 2)
                .map(|c| {
                    let yes_slot = self.price_table.alloc_slot(&c.clob_token_ids[0]);
                    let no_slot = self.price_table.alloc_slot(&c.clob_token_ids[1]);
                    MarketMeta {
                        market_id: c.market_id,
                        slug: c.slug,
                        clob_token_ids: [
                            c.clob_token_ids[0].clone(),
                            c.clob_token_ids[1].clone(),
                        ],
                        bounds_lower: c.bounds_lower,
                        bounds_upper: c.bounds_upper,
                        kind: MarketKind::from_str(&c.kind),
                        neg_risk: c.neg_risk,
                        yes_slot,
                        no_slot,
                    }
                })
                .collect();

            // Build parent metas
            let parent_metas: Vec<MarketMeta> = g
                .parents
                .into_iter()
                .filter(|p| p.clob_token_ids.len() >= 2)
                .map(|p| {
                    let yes_slot = self.price_table.alloc_slot(&p.clob_token_ids[0]);
                    let no_slot = self.price_table.alloc_slot(&p.clob_token_ids[1]);
                    MarketMeta {
                        market_id: p.market_id,
                        slug: p.slug,
                        clob_token_ids: [
                            p.clob_token_ids[0].clone(),
                            p.clob_token_ids[1].clone(),
                        ],
                        bounds_lower: p.bounds_lower,
                        bounds_upper: p.bounds_upper,
                        kind: MarketKind::from_str(&p.kind),
                        neg_risk: p.neg_risk,
                        yes_slot,
                        no_slot,
                    }
                })
                .collect();

            // Initialize trios (adjacent parent pairs)
            let (trio_states, trio_lookup) =
                initialize_trio_states(&child_metas, &parent_metas);
            total_trios += trio_states.len() as i32;

            // Index tokens for dispatch
            // Child tokens — YES only (range evaluator reads yes_slot)
            for (child_idx, meta) in child_metas.iter().enumerate() {
                let yes_token = &meta.clob_token_ids[0];
                self.token_index
                    .entry(yes_token.clone())
                    .or_default()
                    .push(TokenRole::RangeChild {
                        group_idx,
                        child_idx: child_idx as u16,
                    });
            }

            // Parent tokens — YES only (range evaluator reads yes_slot)
            for (parent_idx, meta) in parent_metas.iter().enumerate() {
                let yes_token = &meta.clob_token_ids[0];
                self.token_index
                    .entry(yes_token.clone())
                    .or_default()
                    .push(TokenRole::Parent {
                        group_idx,
                        parent_idx: parent_idx as u16,
                    });
            }

            // Trio leg tokens (for trio-specific dispatch)
            for (trio_idx, trio) in trio_states.iter().enumerate() {
                let roles = [
                    (&trio.lower_yes_token, TrioLegRole::ParentLowerYes),
                    (&trio.upper_no_token, TrioLegRole::ParentUpperNo),
                    (&trio.range_no_token, TrioLegRole::RangeNo),
                ];
                for (token_id, role) in roles {
                    self.token_index
                        .entry(token_id.clone())
                        .or_default()
                        .push(TokenRole::TrioLeg {
                            group_idx,
                            trio_idx: trio_idx as u16,
                            role,
                        });
                }
            }

            self.group_key_index.insert(g.group_key.clone(), group_idx);

            self.groups.push(GroupState {
                group_key: g.group_key,
                event_slug: g.event_slug,
                crypto: g.crypto,
                child_metas,
                parent_metas,
                trio_states,
                trio_lookup_by_asset: trio_lookup,
            });
        }

        total_trios
    }

    // =========================================================================
    // HOT PATH — handle_top_of_book
    // =========================================================================

    /// Process a single TopOfBook update. Returns any emitted signals.
    pub fn handle_top_of_book(
        &mut self,
        asset_id: &str,
        bid: f64,
        ask: f64,
        bid_size: Option<f64>,
        ask_size: Option<f64>,
        timestamp_ms: i64,
    ) -> Vec<ArbSignal> {
        // 1. Dirty check
        if !self.is_price_changed(asset_id, bid, ask, timestamp_ms) {
            return vec![];
        }
        
        // 2. Lookup slot → single write
        let slot = match self.price_table.token_to_slot.get(asset_id) {
            Some(&s) => s,
            None => return vec![],
        };
        self.price_table
            .update(slot, bid, ask, bid_size, ask_size, timestamp_ms);

        // 3. Dispatch to evaluators
        let roles = match self.token_index.get(asset_id) {
            Some(r) => r.clone(), // clone to avoid borrow issues
            None => return vec![],
        };

        let mut signals = Vec::new();
        let config = self.config.clone();

        for role in &roles {
            match role {
                TokenRole::TrioLeg {
                    group_idx,
                    trio_idx,
                    ..
                } => {
                    let gi = *group_idx as usize;
                    let ti = *trio_idx as usize;
                    if gi < self.groups.len() {
                        if let Some(sig) = trio_evaluator::evaluate_single_trio(
                            &mut self.groups[gi],
                            ti,
                            &self.price_table,
                            &config,
                        ) {
                            signals.push(sig);
                        }
                    }
                }
                // RangeChild/Parent dispatch — currently disabled (range arb not yet active)
                _ => {}
            }
        }

        signals
    }
}

// =============================================================================
// TRIO INITIALIZATION — Adjacent parent pairs + connecting range
// =============================================================================

/// Build TrioStates from adjacent parent pairs.
///
/// Structure: Parent[i] YES + Range(i→i+1) NO + Parent[i+1] NO
fn initialize_trio_states(
    child_metas: &[MarketMeta],
    parent_metas: &[MarketMeta],
) -> (Vec<TrioState>, HashMap<String, Vec<u16>>) {
    let mut trios = Vec::new();
    let mut trio_lookup: HashMap<String, Vec<u16>> = HashMap::new();

    // O(1) lookup: lower_bound → child index (range markets only)
    let mut range_lower_map: HashMap<i64, usize> = HashMap::new();
    for (i, meta) in child_metas.iter().enumerate() {
        if meta.kind == MarketKind::Range {
            if let (Some(lower), Some(_upper)) = (meta.bounds_lower, meta.bounds_upper) {
                if lower.is_finite() {
                    range_lower_map.insert(lower.to_bits() as i64, i);
                }
            }
        }
    }

    // Adjacent parent pairs
    for lower_idx in 0..parent_metas.len().saturating_sub(1) {
        let lower = &parent_metas[lower_idx];
        let upper = &parent_metas[lower_idx + 1];

        if lower.kind != MarketKind::Above || upper.kind != MarketKind::Above {
            continue;
        }

        let lower_bound = match lower.bounds_lower {
            Some(v) if v.is_finite() => v,
            _ => continue,
        };
        let upper_bound = match upper.bounds_lower {
            Some(v) if v.is_finite() => v,
            _ => continue,
        };

        // Find connecting range child
        let range_idx = match range_lower_map.get(&(lower_bound.to_bits() as i64)) {
            Some(&idx) => idx,
            None => continue,
        };

        let range_child = &child_metas[range_idx];
        if range_child.bounds_upper != Some(upper_bound) {
            continue;
        }

        // Extract tokens
        let lower_yes_token = &lower.clob_token_ids[0];
        let upper_no_token = &upper.clob_token_ids[1];
        let range_no_token = &range_child.clob_token_ids[1];
        let upper_yes_token = &upper.clob_token_ids[0];
        let range_yes_token = &range_child.clob_token_ids[0];

        if lower_yes_token.is_empty() || upper_no_token.is_empty() || range_no_token.is_empty() {
            continue;
        }

        let trio = TrioState {
            parent_lower_idx: lower_idx as u16,
            parent_upper_idx: (lower_idx + 1) as u16,
            range_idx: range_idx as u16,
            lower_yes_slot: lower.yes_slot,
            upper_no_slot: upper.no_slot,
            range_no_slot: range_child.no_slot,
            lower_yes_token: lower_yes_token.clone(),
            upper_no_token: upper_no_token.clone(),
            range_no_token: range_no_token.clone(),
            last_emitted_buy_ms: 0,
            last_emitted_unbundle_ms: 0,
            last_emitted_bundle_ms: 0,
        };

        let trio_idx = trios.len() as u16;
        trios.push(trio);

        // Index ALL 5 tokens (matches TS behavior)
        for token in [
            lower_yes_token,
            upper_no_token,
            range_no_token,
            upper_yes_token,
            range_yes_token,
        ] {
            trio_lookup.entry(token.clone()).or_default().push(trio_idx);
        }
    }

    (trios, trio_lookup)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn make_engine() -> EngineState {
        EngineState::new(EngineConfig {
            min_profit_abs: 0.005,
            min_profit_bps: 30.0,
            cooldown_ms: 0, // disable cooldown for tests
        })
    }

    fn make_group_input() -> RangeGroupInput {
        RangeGroupInput {
            group_key: "eth-2026-01-20T17:00:00.000Z".to_string(),
            event_slug: "eth-price".to_string(),
            crypto: "ETH".to_string(),
            children: vec![MarketDescriptorInput {
                market_id: "range-2800-2900".to_string(),
                slug: "eth-2800-2900".to_string(),
                clob_token_ids: vec![
                    "range_yes_token".to_string(),
                    "range_no_token".to_string(),
                ],
                bounds_lower: Some(2800.0),
                bounds_upper: Some(2900.0),
                kind: "range".to_string(),
                neg_risk: false,
            }],
            parents: vec![
                MarketDescriptorInput {
                    market_id: "above-2800".to_string(),
                    slug: "eth-above-2800".to_string(),
                    clob_token_ids: vec![
                        "parent_lower_yes".to_string(),
                        "parent_lower_no".to_string(),
                    ],
                    bounds_lower: Some(2800.0),
                    bounds_upper: None,
                    kind: "above".to_string(),
                    neg_risk: false,
                },
                MarketDescriptorInput {
                    market_id: "above-2900".to_string(),
                    slug: "eth-above-2900".to_string(),
                    clob_token_ids: vec![
                        "parent_upper_yes".to_string(),
                        "parent_upper_no".to_string(),
                    ],
                    bounds_lower: Some(2900.0),
                    bounds_upper: None,
                    kind: "above".to_string(),
                    neg_risk: false,
                },
            ],
        }
    }

    #[test]
    fn test_market_structure_build() {
        let mut engine = make_engine();
        let trio_count = engine.update_market_structure(vec![make_group_input()]);

        assert_eq!(trio_count, 1);
        assert_eq!(engine.groups.len(), 1);
        assert_eq!(engine.groups[0].trio_states.len(), 1);
        assert_eq!(engine.groups[0].child_metas.len(), 1);
        assert_eq!(engine.groups[0].parent_metas.len(), 2);

        // Verify trio token assignment
        let trio = &engine.groups[0].trio_states[0];
        assert_eq!(trio.lower_yes_token, "parent_lower_yes");
        assert_eq!(trio.upper_no_token, "parent_upper_no");
        assert_eq!(trio.range_no_token, "range_no_token");

        // Verify PriceTable has 6 slots (2 per market × 3 markets)
        assert_eq!(engine.price_table.slots.len(), 6);

        // Verify all 5 tokens are in trio_lookup
        let lookup = &engine.groups[0].trio_lookup_by_asset;
        assert!(lookup.contains_key("parent_lower_yes"));
        assert!(lookup.contains_key("parent_upper_no"));
        assert!(lookup.contains_key("range_no_token"));
        assert!(lookup.contains_key("parent_upper_yes"));
        assert!(lookup.contains_key("range_yes_token"));
    }

    #[test]
    fn test_dirty_check() {
        let mut engine = make_engine();
        engine.update_market_structure(vec![make_group_input()]);

        // First update — should process
        assert!(engine.is_price_changed("parent_lower_yes", 0.60, 0.62, 100));

        // Same price — should skip
        assert!(!engine.is_price_changed("parent_lower_yes", 0.60, 0.62, 101));

        // Price changed — should process
        assert!(engine.is_price_changed("parent_lower_yes", 0.61, 0.63, 102));
    }

    #[test]
    fn test_handle_top_of_book_triangle_buy() {
        let mut engine = make_engine();
        engine.update_market_structure(vec![make_group_input()]);

        // Set prices: totalAsk = 0.60 + 0.50 + 0.80 = 1.90, profit = 0.10
        engine.handle_top_of_book("parent_lower_yes", 0.62, 0.60, Some(100.0), Some(100.0), 1);
        engine.handle_top_of_book("parent_upper_no", 0.52, 0.50, Some(100.0), Some(100.0), 2);

        // This update should trigger trio evaluation and emit a signal
        let signals =
            engine.handle_top_of_book("range_no_token", 0.82, 0.80, Some(100.0), Some(100.0), 3);

        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].strategy, "POLYMARKET_TRIANGLE_BUY");
        assert!((signals[0].profit_abs - 0.10).abs() < 1e-10);
    }

    #[test]
    fn test_handle_top_of_book_unbundling() {
        let mut engine = make_engine();
        engine.update_market_structure(vec![make_group_input()]);

        // Set YES token prices for range arb
        // Unbundling: profit = Bid(PL_YES) - (Ask(RC_YES) + Ask(PU_YES))
        // = 0.80 - (0.30 + 0.40) = 0.10
        engine.handle_top_of_book("parent_lower_yes", 0.80, 0.82, Some(100.0), Some(100.0), 1);
        engine.handle_top_of_book("parent_upper_yes", 0.38, 0.40, Some(100.0), Some(100.0), 2);

        let signals = engine.handle_top_of_book(
            "range_yes_token",
            0.28,
            0.30,
            Some(100.0),
            Some(100.0),
            3,
        );

        // Should have unbundling signal
        let unbundle_sigs: Vec<_> = signals
            .iter()
            .filter(|s| s.strategy == "SELL_PARENT_BUY_CHILDREN")
            .collect();
        assert!(
            !unbundle_sigs.is_empty(),
            "Expected unbundling signal, got: {:?}",
            signals.iter().map(|s| &s.strategy).collect::<Vec<_>>()
        );
        assert!((unbundle_sigs[0].profit_abs - 0.10).abs() < 1e-10);
    }
}

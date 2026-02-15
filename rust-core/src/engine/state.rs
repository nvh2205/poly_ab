//! Engine state types — flat memory layout with centralized PriceTable.
//!
//! Key design: Every token gets exactly ONE slot in the PriceTable.
//! Both Trio and Range evaluators read from the same PriceTable — zero duplication.
//!
//! Token mapping per evaluator:
//!   Trio:  parent_lower YES + parent_upper NO + range NO
//!   Range: parent_lower YES + parent_upper YES + range YES

use std::collections::HashMap;

// =============================================================================
// PRICE TABLE — Single source of truth for all token prices
// =============================================================================

/// Single price snapshot per token — 40 bytes, cache-line friendly.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct PriceSlot {
    pub best_bid: f64,
    pub best_ask: f64,
    pub best_bid_size: f64,
    pub best_ask_size: f64,
    pub timestamp_ms: i64,
}

impl Default for PriceSlot {
    fn default() -> Self {
        Self {
            best_bid: f64::NAN,
            best_ask: f64::NAN,
            best_bid_size: 0.0,
            best_ask_size: 0.0,
            timestamp_ms: 0,
        }
    }
}

/// Central price table — one slot per unique token ID.
/// Allocated at `update_market_structure()` time, mutated on each TopOfBook update.
pub struct PriceTable {
    pub slots: Vec<PriceSlot>,
    pub token_to_slot: HashMap<String, u32>,
}

impl PriceTable {
    pub fn new() -> Self {
        Self {
            slots: Vec::new(),
            token_to_slot: HashMap::new(),
        }
    }

    /// Allocate or return existing slot for a token ID.
    pub fn alloc_slot(&mut self, token_id: &str) -> u32 {
        if let Some(&slot) = self.token_to_slot.get(token_id) {
            return slot;
        }
        let slot = self.slots.len() as u32;
        self.slots.push(PriceSlot::default());
        self.token_to_slot.insert(token_id.to_string(), slot);
        slot
    }

    /// Update a price slot — called once per TopOfBook arrival.
    #[inline(always)]
    pub fn update(
        &mut self,
        slot: u32,
        bid: f64,
        ask: f64,
        bid_size: Option<f64>,
        ask_size: Option<f64>,
        ts: i64,
    ) {
        let s = &mut self.slots[slot as usize];
        s.best_bid = bid;
        s.best_ask = ask;
        if let Some(bs) = bid_size {
            s.best_bid_size = bs;
        }
        if let Some(a) = ask_size {
            s.best_ask_size = a;
        }
        s.timestamp_ms = ts;
    }

    /// Read a price slot — zero-copy reference.
    #[inline(always)]
    pub fn get(&self, slot: u32) -> &PriceSlot {
        &self.slots[slot as usize]
    }

    /// Clear all prices (keep slot allocations).
    pub fn clear_prices(&mut self) {
        for slot in &mut self.slots {
            *slot = PriceSlot::default();
        }
    }
}

// =============================================================================
// MARKET METADATA — Per-market descriptor with YES/NO slots
// =============================================================================

/// Market kind (maps from TS `MarketRangeDescriptor.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketKind {
    Range,
    Above,
    Below,
}

impl MarketKind {
    pub fn from_str(s: &str) -> Self {
        match s {
            "above" => MarketKind::Above,
            "below" => MarketKind::Below,
            _ => MarketKind::Range,
        }
    }
}

/// Compact market descriptor — only fields needed for computation.
/// Each market has 2 PriceTable slots: one for YES, one for NO.
#[derive(Debug, Clone)]
pub struct MarketMeta {
    pub market_id: String,
    pub slug: String,
    pub clob_token_ids: [String; 2], // [YES, NO]
    pub bounds_lower: Option<f64>,
    pub bounds_upper: Option<f64>,
    pub kind: MarketKind,
    pub neg_risk: bool,
    pub yes_slot: u32, // PriceTable slot for YES token (clobTokenIds[0])
    pub no_slot: u32,  // PriceTable slot for NO token  (clobTokenIds[1])
}


// =============================================================================
// TRIO STATE — References PriceTable slots, NOT prices
// =============================================================================

/// Trio: adjacent parent pair + connecting range child.
///
/// Triangle BUY:  Parent[lower] YES + Parent[upper] NO + Range NO  (payout = 2)
/// Complement BUY: Parent[lower] NO  + Range YES + Parent[upper] YES  (payout = 1)
/// Reads from PriceTable by slot index — never stores prices inline.
#[derive(Debug, Clone)]
pub struct TrioState {
    // Indices into GroupState.parent_metas / child_metas
    pub parent_lower_idx: u16,
    pub parent_upper_idx: u16,
    pub range_idx: u16,

    // === Triangle BUY slots (YES/NO/NO) ===
    pub lower_yes_slot: u32, // parent_metas[lower].yes_slot
    pub upper_no_slot: u32,  // parent_metas[upper].no_slot
    pub range_no_slot: u32,  // child_metas[range].no_slot

    // Triangle BUY token IDs
    pub lower_yes_token: String, // parent_lower.clobTokenIds[0]
    pub upper_no_token: String,  // parent_upper.clobTokenIds[1]
    pub range_no_token: String,  // range_child.clobTokenIds[1]

    // === Complement BUY slots (NO/YES/YES) ===
    pub lower_no_slot: u32,  // parent_metas[lower].no_slot
    pub range_yes_slot: u32, // child_metas[range].yes_slot
    pub upper_yes_slot: u32, // parent_metas[upper].yes_slot

    // Complement BUY token IDs
    pub lower_no_token: String,  // parent_lower.clobTokenIds[1]
    pub range_yes_token: String, // range_child.clobTokenIds[0]
    pub upper_yes_token: String, // parent_upper.clobTokenIds[0]

    // Cooldown timestamps (inline — no HashMap overhead)
    pub last_emitted_buy_ms: i64,
    pub last_emitted_complement_ms: i64,
    pub last_emitted_unbundle_ms: i64,
    pub last_emitted_bundle_ms: i64,
}

// =============================================================================
// GROUP STATE — Flat arrays with slot references
// =============================================================================

/// Group state — flat arrays of markets + trios.
#[derive(Debug)]
pub struct GroupState {
    pub group_key: String,
    pub event_slug: String,
    pub crypto: String,

    // Market metadata (with PriceTable slot refs)
    pub child_metas: Vec<MarketMeta>,  // range children
    pub parent_metas: Vec<MarketMeta>, // parent markets (sorted by bounds)


    // Trio states for triangle/range arbitrage
    pub trio_states: Vec<TrioState>,

    // Lookup: token_id → Vec<trio_index>  (all 5 tokens per trio)
    pub trio_lookup_by_asset: HashMap<String, Vec<u16>>,
}

// =============================================================================
// TOKEN DISPATCH — Routing TopOfBook to correct evaluators
// =============================================================================

/// Role of a token in the engine — for dispatch routing.
#[derive(Debug, Clone)]
pub enum TrioLegRole {
    ParentLowerYes,
    ParentUpperNo,
    RangeNo,
    // Complement triangle legs
    ParentLowerNo,
    RangeYes,
    ParentUpperYes,
}

/// Where a token is used — for TopOfBook dispatch.
#[derive(Debug, Clone)]
pub enum TokenRole {
    /// Token is a trio leg (for triangle arbitrage)
    TrioLeg {
        group_idx: u16,
        trio_idx: u16,
        role: TrioLegRole,
    },
    /// Token is a range child (YES token used in range arb)
    RangeChild {
        group_idx: u16,
        child_idx: u16,
    },
    /// Token is a parent market (YES token used in range arb)
    Parent {
        group_idx: u16,
        parent_idx: u16,
    },
}

// =============================================================================
// ENGINE CONFIG
// =============================================================================

/// Engine configuration — profit thresholds + cooldown.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub min_profit_bps: f64,
    pub min_profit_abs: f64,
    pub cooldown_ms: i64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            min_profit_bps: 30.0,
            min_profit_abs: 0.005,
            cooldown_ms: 3000,
        }
    }
}

// =============================================================================
// DIRTY CHECK CACHE
// =============================================================================

/// Cached last-seen price for dirty checking.
#[derive(Debug, Clone, Copy)]
pub struct LastPrice {
    pub bid: f64,
    pub ask: f64,
    pub timestamp_ms: i64,
}

// =============================================================================
// ENGINE STATE — Top-level state container
// =============================================================================

/// Main engine state — owns PriceTable and all groups.
pub struct EngineState {
    /// Single source of truth for all token prices.
    pub price_table: PriceTable,

    /// All groups (indexed by position).
    pub groups: Vec<GroupState>,

    /// group_key → group index.
    pub group_key_index: HashMap<String, u16>,

    /// token_id → Vec<TokenRole> (one token can have multiple roles).
    pub token_index: HashMap<String, Vec<TokenRole>>,

    /// Dirty checking — last seen price per token.
    pub last_price_cache: HashMap<String, LastPrice>,

    /// Engine configuration.
    pub config: EngineConfig,
}

impl EngineState {
    pub fn new(config: EngineConfig) -> Self {
        Self {
            price_table: PriceTable::new(),
            groups: Vec::new(),
            group_key_index: HashMap::new(),
            token_index: HashMap::new(),
            last_price_cache: HashMap::new(),
            config,
        }
    }

    /// Check if price actually changed (dirty check).
    /// Returns true if the update should be processed.
    pub fn is_price_changed(&mut self, asset_id: &str, bid: f64, ask: f64, ts: i64) -> bool {
        if let Some(cached) = self.last_price_cache.get(asset_id) {
            // Skip if timestamp is older or equal
            if cached.timestamp_ms > 0 && ts > 0 && ts <= cached.timestamp_ms {
                return false;
            }
            // Skip if price unchanged
            if cached.bid == bid && cached.ask == ask {
                // Update timestamp only
                if let Some(c) = self.last_price_cache.get_mut(asset_id) {
                    if ts > 0 {
                        c.timestamp_ms = ts;
                    }
                }
                return false;
            }
        }
        self.last_price_cache.insert(
            asset_id.to_string(),
            LastPrice {
                bid,
                ask,
                timestamp_ms: ts,
            },
        );
        true
    }
}

/**
 * ============================================================================
 * Rust Engine State Variables — Full Internal State Dump
 * ============================================================================
 *
 * Loads rust-core, feeds market structure from bootstrap data,
 * then calls dumpEngineState() to serialize ALL Rust internal variables:
 *
 *   EngineState {
 *     config:           EngineConfig { min_profit_bps, min_profit_abs, cooldown_ms }
 *     price_table:      PriceTable { slots: PriceSlot[], token_to_slot: HashMap }
 *     groups:           GroupState[] {
 *       group_key, event_slug, crypto,
 *       child_metas:         MarketMeta[] { market_id, slug, clob_token_ids, bounds, kind, neg_risk, yes_slot, no_slot }
 *       parent_metas:        MarketMeta[]
 *       trio_states:         TrioState[] { parent_lower_idx, parent_upper_idx, range_idx, slots, tokens, cooldowns }
 *       trio_lookup_by_asset: HashMap<token_id, Vec<trio_idx>>
 *     }
 *     group_key_index:  HashMap<group_key, group_idx>
 *     token_index:      HashMap<token_id, Vec<TokenRole>> (TrioLeg | RangeChild | Parent)
 *     last_price_cache: HashMap<token_id, LastPrice { bid, ask, timestamp_ms }>
 *   }
 *
 * Usage:
 *   npx tsx test/rust-engine-state-variables.ts
 *
 * Output:
 *   test/artifacts/rust-engine-state-variables.json
 */

import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// LOAD MODULES
// ============================================================================

const rustCorePath = path.join(__dirname, '..', 'rust-core');
let rustCore: any;

try {
    rustCore = require(rustCorePath);
    console.log('✅ rust-core loaded');
    console.log('   Exports:', Object.keys(rustCore).sort().join(', '));

    if (typeof rustCore.dumpEngineState !== 'function') {
        console.error('❌ dumpEngineState is not available. Rebuild rust-core first.');
        process.exit(1);
    }
} catch (err: any) {
    console.error('❌ Failed to load rust-core:', err.message);
    process.exit(1);
}

// ============================================================================
// LOAD BOOTSTRAP DATA
// ============================================================================

const bootstrapPath = path.join(__dirname, 'artifacts', 'arbitrage-engine.bootstrap.json');
let bootstrapData: any;

try {
    bootstrapData = JSON.parse(fs.readFileSync(bootstrapPath, 'utf-8'));
    console.log('✅ Bootstrap data loaded');
} catch (err: any) {
    console.error('❌ Failed to load bootstrap:', err.message);
    process.exit(1);
}

// ============================================================================
// HELPERS
// ============================================================================

function convertGroupToNapi(group: any): any {
    return {
        groupKey: group.groupKey,
        eventSlug: group.eventSlug || '',
        crypto: group.crypto || '',
        children: (group.children || [])
            .filter((c: any) => c.clobTokenIds?.length >= 2)
            .map((c: any) => ({
                marketId: c.marketId,
                slug: c.slug,
                clobTokenIds: c.clobTokenIds,
                boundsLower: c.bounds?.lower ?? undefined,
                boundsUpper: c.bounds?.upper ?? undefined,
                kind: c.kind || 'unknown',
                negRisk: c.negRisk ?? false,
            })),
        parents: (group.parents || [])
            .filter((p: any) => p.clobTokenIds?.length >= 2)
            .map((p: any) => ({
                marketId: p.marketId,
                slug: p.slug,
                clobTokenIds: p.clobTokenIds,
                boundsLower: p.bounds?.lower ?? undefined,
                boundsUpper: p.bounds?.upper ?? undefined,
                kind: p.kind || 'unknown',
                negRisk: p.negRisk ?? false,
            })),
    };
}

// ============================================================================
// STEP 1: Configure engine
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log(' STEP 1: Configure Engine');
console.log('═'.repeat(80));

const config = {
    minProfitBps: 5.0,
    minProfitAbs: 0.0,
    cooldownMs: 0,
};

rustCore.updateEngineConfig(config);
console.log('  Config:', JSON.stringify(config));

// Dump EMPTY state first
console.log('\n  📸 State BEFORE market structure (empty engine):');
const emptyState = JSON.parse(rustCore.dumpEngineState());
console.log(`     Groups: ${emptyState.summary.total_groups}`);
console.log(`     Price Slots: ${emptyState.summary.total_price_slots}`);
console.log(`     Tokens Indexed: ${emptyState.summary.total_tokens_indexed}`);

// ============================================================================
// STEP 2: Feed market structure
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log(' STEP 2: Feed Market Structure');
console.log('═'.repeat(80));

const groups: any[] = [];
if (bootstrapData.sampleGroup) {
    groups.push(bootstrapData.sampleGroup.value.group);
}
if (bootstrapData.allGroups) {
    for (const gData of bootstrapData.allGroups) {
        const g = gData.value?.group || gData.group;
        if (g && !groups.find((x: any) => x.groupKey === g.groupKey)) {
            groups.push(g);
        }
    }
}

const napiGroups = groups.map(convertGroupToNapi);
const trioCount = rustCore.updateMarketStructure(napiGroups);
console.log(`  Groups fed: ${groups.length}`);
console.log(`  Trios created: ${trioCount}`);

// ============================================================================
// STEP 3: Dump full state AFTER market structure
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log(' STEP 3: Dump Full Engine State');
console.log('═'.repeat(80));

const rawJson = rustCore.dumpEngineState();
const fullState = JSON.parse(rawJson);

// Print summary
console.log('\n  📊 ENGINE STATE SUMMARY:');
console.log(`     Total Groups:           ${fullState.summary.total_groups}`);
console.log(`     Total Price Slots:      ${fullState.summary.total_price_slots}`);
console.log(`     Total Tokens Indexed:   ${fullState.summary.total_tokens_indexed}`);
console.log(`     Total Last-Price Cache: ${fullState.summary.total_last_price_entries}`);

// EngineConfig
console.log('\n  ⚙️  ENGINE CONFIG:');
console.log(`     min_profit_bps: ${fullState.engine_config.min_profit_bps}`);
console.log(`     min_profit_abs: ${fullState.engine_config.min_profit_abs}`);
console.log(`     cooldown_ms:    ${fullState.engine_config.cooldown_ms}`);

// PriceTable
console.log('\n  📈 PRICE TABLE:');
console.log(`     Allocated Slots: ${fullState.price_table.total_slots}`);
console.log(`     token_to_slot entries: ${Object.keys(fullState.price_table.token_to_slot).length}`);

const nonEmptySlots = fullState.price_table.slots.filter(
    (s: any) => s.best_bid !== null || s.best_ask !== null,
);
console.log(`     Non-empty slots (has data): ${nonEmptySlots.length}`);
console.log(`     Empty slots (NaN/null):     ${fullState.price_table.total_slots - nonEmptySlots.length}`);

// Print first few slots
console.log('\n     Sample Price Slots (first 6):');
fullState.price_table.slots.slice(0, 6).forEach((s: any) => {
    const bidStr = s.best_bid !== null ? s.best_bid.toFixed(4) : 'NaN';
    const askStr = s.best_ask !== null ? s.best_ask.toFixed(4) : 'NaN';
    console.log(`       [${s.slot_index}] bid=${bidStr} ask=${askStr} ts=${s.timestamp_ms}`);
});

// Groups detail
console.log('\n  📂 GROUPS:');
for (const group of fullState.groups) {
    console.log(`\n     ── Group: ${group.group_key} ──`);
    console.log(`     Event: ${group.event_slug}`);
    console.log(`     Crypto: ${group.crypto}`);
    console.log(`     Children: ${group.summary.child_count}`);
    console.log(`     Parents: ${group.summary.parent_count}`);
    console.log(`     Trios: ${group.summary.trio_count}`);
    console.log(`     Trio Lookup Tokens: ${group.summary.trio_lookup_tokens}`);

    // Children
    console.log('\n     CHILD METAS:');
    for (const child of group.child_metas) {
        console.log(
            `       [${child.index}] ${child.slug} | kind=${child.kind} | bounds=[${child.bounds_lower ?? '∅'}, ${child.bounds_upper ?? '∅'}] | negRisk=${child.neg_risk} | yesSlot=${child.yes_slot} noSlot=${child.no_slot}`,
        );
    }

    // Parents
    console.log('\n     PARENT METAS:');
    for (const parent of group.parent_metas) {
        console.log(
            `       [${parent.index}] ${parent.slug} | kind=${parent.kind} | bounds=[${parent.bounds_lower ?? '∅'}, ${parent.bounds_upper ?? '∅'}] | negRisk=${parent.neg_risk} | yesSlot=${parent.yes_slot} noSlot=${parent.no_slot}`,
        );
    }


    // Trio states
    console.log('\n     TRIO STATES:');
    for (const trio of group.trio_states) {
        const parentLower = group.parent_metas[trio.parent_lower_idx];
        const parentUpper = group.parent_metas[trio.parent_upper_idx];
        const rangeChild = group.child_metas[trio.range_idx];
        console.log(
            `       [${trio.trio_index}] ParentLower[${trio.parent_lower_idx}]=${parentLower?.slug ?? '?'} ↔ ParentUpper[${trio.parent_upper_idx}]=${parentUpper?.slug ?? '?'} → Range[${trio.range_idx}]=${rangeChild?.slug ?? '?'}`,
        );
        console.log(
            `              Slots: lowerYes=${trio.lower_yes_slot}, upperNo=${trio.upper_no_slot}, rangeNo=${trio.range_no_slot}`,
        );
        console.log(
            `              Cooldowns: buy=${trio.last_emitted_buy_ms}, unbundle=${trio.last_emitted_unbundle_ms}, bundle=${trio.last_emitted_bundle_ms}`,
        );
    }

    // Trio lookup
    console.log('\n     TRIO LOOKUP BY ASSET (sample — first 6):');
    const lookupEntries = Object.entries(group.trio_lookup_by_asset);
    lookupEntries.slice(0, 6).forEach(([token, indices]: [string, any]) => {
        const shortTok = token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
        console.log(`       ${shortTok} → trio indices: [${indices}]`);
    });
    if (lookupEntries.length > 6) {
        console.log(`       ... and ${lookupEntries.length - 6} more`);
    }
}

// Token Index
console.log('\n  🔗 TOKEN INDEX (sample — first 6):');
const tokenEntries = Object.entries(fullState.token_index);
tokenEntries.slice(0, 6).forEach(([token, roles]: [string, any]) => {
    const shortTok = token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
    const roleSummary = roles.map((r: any) => {
        if (r.type === 'TrioLeg') return `TrioLeg(g${r.group_idx},t${r.trio_idx},${r.role})`;
        if (r.type === 'RangeChild') return `RangeChild(g${r.group_idx},c${r.child_idx})`;
        if (r.type === 'Parent') return `Parent(g${r.group_idx},p${r.parent_idx})`;
        return JSON.stringify(r);
    });
    console.log(`     ${shortTok} → [${roleSummary.join(', ')}]`);
});
if (tokenEntries.length > 6) {
    console.log(`     ... and ${tokenEntries.length - 6} more`);
}

// Group key index
console.log('\n  🗝️  GROUP KEY INDEX:');
for (const [key, idx] of Object.entries(fullState.group_key_index)) {
    console.log(`     ${key} → group[${idx}]`);
}

// Last price cache
console.log('\n  💾 LAST PRICE CACHE:');
const cacheEntries = Object.entries(fullState.last_price_cache);
if (cacheEntries.length === 0) {
    console.log('     (empty — no prices received yet)');
} else {
    cacheEntries.slice(0, 6).forEach(([token, lp]: [string, any]) => {
        const shortTok = token.length > 12 ? `${token.slice(0, 6)}...${token.slice(-6)}` : token;
        console.log(`     ${shortTok} → bid=${lp.bid} ask=${lp.ask} ts=${lp.timestamp_ms}`);
    });
    if (cacheEntries.length > 6) {
        console.log(`     ... and ${cacheEntries.length - 6} more`);
    }
}

// ============================================================================
// STEP 4: Cross-reference verification
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log(' STEP 4: Cross-Reference Verification');
console.log('═'.repeat(80));

let issues = 0;

// Verify: each trio's slot indices are valid
for (const group of fullState.groups) {
    for (const trio of group.trio_states) {
        if (trio.lower_yes_slot >= fullState.price_table.total_slots) {
            console.log(`  ❌ Trio[${trio.trio_index}] lower_yes_slot=${trio.lower_yes_slot} out of range`);
            issues++;
        }
        if (trio.upper_no_slot >= fullState.price_table.total_slots) {
            console.log(`  ❌ Trio[${trio.trio_index}] upper_no_slot=${trio.upper_no_slot} out of range`);
            issues++;
        }
        if (trio.range_no_slot >= fullState.price_table.total_slots) {
            console.log(`  ❌ Trio[${trio.trio_index}] range_no_slot=${trio.range_no_slot} out of range`);
            issues++;
        }
    }

    // Verify: each MarketMeta slot index is valid
    for (const meta of [...group.child_metas, ...group.parent_metas]) {
        if (meta.yes_slot >= fullState.price_table.total_slots) {
            console.log(`  ❌ Meta[${meta.slug}] yes_slot=${meta.yes_slot} out of range`);
            issues++;
        }
        if (meta.no_slot >= fullState.price_table.total_slots) {
            console.log(`  ❌ Meta[${meta.slug}] no_slot=${meta.no_slot} out of range`);
            issues++;
        }
    }

    // Verify: token_to_slot has mapping for each market's tokens
    for (const meta of [...group.child_metas, ...group.parent_metas]) {
        for (const tok of meta.clob_token_ids) {
            if (fullState.price_table.token_to_slot[tok] === undefined) {
                console.log(`  ❌ Token ${tok.slice(0, 12)}... not in token_to_slot`);
                issues++;
            }
        }
    }

    // Verify: trio tokens match expected tokens from their parent/child metas
    for (const trio of group.trio_states) {
        const parentLower = group.parent_metas[trio.parent_lower_idx];
        const parentUpper = group.parent_metas[trio.parent_upper_idx];
        const rangeChild = group.child_metas[trio.range_idx];

        if (parentLower && trio.lower_yes_token !== parentLower.clob_token_ids[0]) {
            console.log(`  ❌ Trio[${trio.trio_index}] lower_yes_token mismatch: expected ${parentLower.clob_token_ids[0].slice(0, 12)}...`);
            issues++;
        }
        if (parentUpper && trio.upper_no_token !== parentUpper.clob_token_ids[1]) {
            console.log(`  ❌ Trio[${trio.trio_index}] upper_no_token mismatch: expected ${parentUpper.clob_token_ids[1].slice(0, 12)}...`);
            issues++;
        }
        if (rangeChild && trio.range_no_token !== rangeChild.clob_token_ids[1]) {
            console.log(`  ❌ Trio[${trio.trio_index}] range_no_token mismatch: expected ${rangeChild.clob_token_ids[1].slice(0, 12)}...`);
            issues++;
        }
    }
}

if (issues === 0) {
    console.log('  ✅ All cross-references valid — no issues found');
} else {
    console.log(`\n  ⚠️  Found ${issues} issue(s)`);
}

// ============================================================================
// SAVE OUTPUT
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log(' OUTPUT');
console.log('═'.repeat(80));

const output = {
    generatedAt: new Date().toISOString(),
    description: 'Full Rust EngineState variable dump — maps 1:1 to state.rs structs',
    stateStructMap: {
        'engine_config': 'EngineConfig { min_profit_bps, min_profit_abs, cooldown_ms }',
        'price_table.slots[]': 'PriceSlot { best_bid, best_ask, best_bid_size, best_ask_size, timestamp_ms }',
        'price_table.token_to_slot': 'HashMap<String, usize> — token_id → slot_index',
        'groups[]': 'GroupState { group_key, event_slug, crypto, child_metas, parent_metas, trio_states, trio_lookup_by_asset }',
        'groups[].child_metas[]': 'MarketMeta { market_id, slug, clob_token_ids, bounds_lower, bounds_upper, kind, neg_risk, yes_slot, no_slot }',
        'groups[].parent_metas[]': 'MarketMeta (same as child_metas)',
        'groups[].trio_states[]': 'TrioState { parent_lower_idx, parent_upper_idx, range_idx, lower_yes_slot, upper_no_slot, range_no_slot, lower_yes_token, upper_no_token, range_no_token, last_emitted_buy_ms, last_emitted_unbundle_ms, last_emitted_bundle_ms }',
        'groups[].trio_lookup_by_asset': 'HashMap<String, Vec<u16>> — token_id → [trio_indices]',
        'group_key_index': 'HashMap<String, u16> — group_key → group_idx',
        'token_index': 'HashMap<String, Vec<TokenRole>> — token_id → roles (TrioLeg | RangeChild | Parent)',
        'last_price_cache': 'HashMap<String, LastPrice { bid, ask, timestamp_ms }>',
    },
    crossReferenceResult: issues === 0 ? 'ALL_VALID' : `${issues}_ISSUES`,
    emptyState,
    fullState,
};

const outputPath = path.join(__dirname, 'artifacts', 'rust-engine-state-variables.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

const fileSizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
console.log(`\n  ✅ Saved to: ${outputPath}`);
console.log(`     Size: ${fileSizeKB} KB`);

// Cleanup
try { rustCore.shutdownSocket(); } catch { }

console.log('\n🏁 Done!');
process.exit(0);

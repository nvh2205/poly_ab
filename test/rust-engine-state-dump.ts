/**
 * ============================================================================
 * Rust Engine State Dump — Review Test
 * ============================================================================
 *
 * Loads the rust-core native module, feeds it market structure data,
 * simulates TopOfBook updates, and dumps all engine state for review.
 *
 * Usage:
 *   npx ts-node test/rust-engine-state-dump.ts
 *   # or
 *   npx tsx test/rust-engine-state-dump.ts
 *
 * Output:
 *   test/artifacts/rust-engine-state-dump.json
 */

import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// LOAD RUST-CORE
// ============================================================================

const rustCorePath = path.join(__dirname, '..', 'rust-core');
let rustCore: any;

try {
    rustCore = require(rustCorePath);
    console.log('✅ rust-core module loaded successfully');
    console.log('   Available exports:', Object.keys(rustCore).sort().join(', '));
} catch (err: any) {
    console.error('❌ Failed to load rust-core:', err.message);
    process.exit(1);
}

// ============================================================================
// LOAD BOOTSTRAP DATA (market structure from previous test capture)
// ============================================================================

const bootstrapPath = path.join(__dirname, 'artifacts', 'arbitrage-engine.bootstrap.json');
let bootstrapData: any;

try {
    bootstrapData = JSON.parse(fs.readFileSync(bootstrapPath, 'utf-8'));
    console.log('✅ Bootstrap data loaded:', bootstrapPath);
    console.log('   Groups:', bootstrapData.summary?.groupCount);
} catch (err: any) {
    console.error('❌ Failed to load bootstrap data:', err.message);
    console.error('   Expected at:', bootstrapPath);
    process.exit(1);
}

// ============================================================================
// HELPERS
// ============================================================================

interface MarketDescriptor {
    marketId: string;
    slug: string;
    clobTokenIds: string[];
    bounds?: { lower?: number; upper?: number };
    kind: string;
    negRisk?: boolean;
}

interface RangeGroup {
    groupKey: string;
    eventSlug?: string;
    crypto?: string;
    children: MarketDescriptor[];
    parents: MarketDescriptor[];
}

function convertGroupToNapi(group: RangeGroup): any {
    return {
        groupKey: group.groupKey,
        eventSlug: group.eventSlug || '',
        crypto: group.crypto || '',
        children: group.children
            .filter((c) => c.clobTokenIds?.length >= 2)
            .map((c) => ({
                marketId: c.marketId,
                slug: c.slug,
                clobTokenIds: c.clobTokenIds,
                boundsLower: c.bounds?.lower ?? undefined,
                boundsUpper: c.bounds?.upper ?? undefined,
                kind: c.kind || 'unknown',
                negRisk: c.negRisk ?? false,
            })),
        parents: group.parents
            .filter((p) => p.clobTokenIds?.length >= 2)
            .map((p) => ({
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

function shortToken(tokenId: string): string {
    if (!tokenId || tokenId.length < 12) return tokenId;
    return `${tokenId.slice(0, 6)}...${tokenId.slice(-6)}`;
}

// ============================================================================
// STEP 1: Initialize engine with config
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 1: Initialize Engine Config');
console.log('='.repeat(80));

const engineConfig = {
    minProfitBps: 5,
    minProfitAbs: 0.0,
    cooldownMs: 0, // disable cooldown for testing
};

try {
    rustCore.updateEngineConfig(engineConfig);
    console.log('✅ Engine config set:', JSON.stringify(engineConfig));
} catch (err: any) {
    console.error('❌ updateEngineConfig failed:', err.message);
}

// ============================================================================
// STEP 2: Feed market structure
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 2: Feed Market Structure');
console.log('='.repeat(80));

// Extract groups from bootstrap data
const groups: RangeGroup[] = [];
const allGroupData: any[] = [];

// Load all groups from bootstrap
if (bootstrapData.sampleGroup) {
    const sampleGroup = bootstrapData.sampleGroup.value.group;
    groups.push(sampleGroup);
    allGroupData.push(bootstrapData.sampleGroup);
}

// Check for additional groups in the data
if (bootstrapData.allGroups) {
    for (const gData of bootstrapData.allGroups) {
        const group = gData.value?.group || gData.group;
        if (group && !groups.find(g => g.groupKey === group.groupKey)) {
            groups.push(group);
            allGroupData.push(gData);
        }
    }
}

console.log(`Found ${groups.length} group(s) in bootstrap data`);

// Convert and push to Rust engine
const napiGroups = groups.map(g => convertGroupToNapi(g));
let trioCount = 0;

try {
    trioCount = rustCore.updateMarketStructure(napiGroups);
    console.log(`✅ Market structure updated: ${trioCount} trios created`);
} catch (err: any) {
    console.error('❌ updateMarketStructure failed:', err.message);
    process.exit(1);
}

// ============================================================================
// STEP 3: Get engine status
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 3: Engine Status');
console.log('='.repeat(80));

let engineStatus: any;
try {
    engineStatus = rustCore.getEngineStatus();
    console.log('Engine Status:');
    console.log(`  Total Groups:        ${engineStatus.totalGroups}`);
    console.log(`  Total Trios:         ${engineStatus.totalTrios}`);
    console.log(`  Total Price Slots:   ${engineStatus.totalPriceSlots}`);
    console.log(`  Total Tokens Indexed: ${engineStatus.totalTokensIndexed}`);
} catch (err: any) {
    console.error('❌ getEngineStatus failed:', err.message);
}

// ============================================================================
// STEP 4: Log group details
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 4: Group Details');
console.log('='.repeat(80));

const groupDetails: any[] = [];

for (const group of groups) {
    const napiGroup = convertGroupToNapi(group);
    const detail: any = {
        groupKey: group.groupKey,
        eventSlug: group.eventSlug,
        crypto: group.crypto,
        children: {
            count: napiGroup.children.length,
            markets: napiGroup.children.map((c: any) => ({
                marketId: c.marketId,
                slug: c.slug,
                kind: c.kind,
                boundsLower: c.boundsLower,
                boundsUpper: c.boundsUpper,
                negRisk: c.negRisk,
                yesToken: shortToken(c.clobTokenIds[0]),
                noToken: shortToken(c.clobTokenIds[1]),
            })),
        },
        parents: {
            count: napiGroup.parents.length,
            markets: napiGroup.parents.map((p: any) => ({
                marketId: p.marketId,
                slug: p.slug,
                kind: p.kind,
                boundsLower: p.boundsLower,
                boundsUpper: p.boundsUpper,
                negRisk: p.negRisk,
                yesToken: shortToken(p.clobTokenIds[0]),
                noToken: shortToken(p.clobTokenIds[1]),
            })),
        },
    };

    console.log(`\n  Group: ${group.groupKey}`);
    console.log(`    Event: ${group.eventSlug}`);
    console.log(`    Crypto: ${group.crypto}`);
    console.log(`    Children: ${napiGroup.children.length}`);
    console.log(`    Parents: ${napiGroup.parents.length}`);

    // Print trio combinations
    console.log(`\n    Trio Combinations (adjacent parent pairs):`);
    const parents = napiGroup.parents.filter((p: any) => p.kind === 'above');
    parents.sort((a: any, b: any) => (a.boundsLower || 0) - (b.boundsLower || 0));

    const trioDetails: any[] = [];
    for (let i = 0; i < parents.length - 1; i++) {
        const lower = parents[i];
        const upper = parents[i + 1];
        // Find connecting range child
        const rangeChild = napiGroup.children.find(
            (c: any) =>
                c.kind === 'range' &&
                c.boundsLower === lower.boundsLower &&
                c.boundsUpper === upper.boundsLower,
        );

        const trioInfo = {
            index: i,
            parentLower: {
                slug: lower.slug,
                bounds: `>=${lower.boundsLower}`,
                yesToken: shortToken(lower.clobTokenIds[0]),
                noToken: shortToken(lower.clobTokenIds[1]),
            },
            parentUpper: {
                slug: upper.slug,
                bounds: `>=${upper.boundsLower}`,
                yesToken: shortToken(upper.clobTokenIds[0]),
                noToken: shortToken(upper.clobTokenIds[1]),
            },
            rangeChild: rangeChild
                ? {
                    slug: rangeChild.slug,
                    bounds: `${rangeChild.boundsLower}-${rangeChild.boundsUpper}`,
                    yesToken: shortToken(rangeChild.clobTokenIds[0]),
                    noToken: shortToken(rangeChild.clobTokenIds[1]),
                }
                : 'NOT FOUND',
            triangleBuy: {
                legs: 'LowerYES_ASK + UpperNO_ASK + RangeNO_ASK',
                payout: 2.0,
                formula: 'profit = 2.0 - totalAsk',
            },
            unbundling: {
                legs: 'LowerYES_BID vs (RangeYES_ASK + UpperYES_ASK)',
                formula: 'profit = LowerYES_BID - (RangeYES_ASK + UpperYES_ASK)',
            },
            bundling: {
                legs: 'LowerYES_ASK vs (RangeYES_BID + UpperYES_BID)',
                formula: 'profit = (RangeYES_BID + UpperYES_BID) - LowerYES_ASK',
            },
        };

        trioDetails.push(trioInfo);
        console.log(`      [${i}] ${lower.boundsLower} ↔ ${upper.boundsLower}: ${rangeChild ? '✅' : '❌'} range child`);
    }

    detail.trios = trioDetails;
    groupDetails.push(detail);
}

// ============================================================================
// STEP 5: Simulate price updates and capture signals
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 5: Simulate Price Updates & Signal Capture');
console.log('='.repeat(80));

// Register signal callback
const capturedSignals: any[] = [];
try {
    rustCore.onSignal((signal: any) => {
        capturedSignals.push({
            ...signal,
            capturedAt: Date.now(),
        });
    });
    console.log('✅ onSignal callback registered');
} catch (err: any) {
    console.error('❌ onSignal registration failed:', err.message);
}

// Initialize socket (required for TopOfBook flow)
try {
    rustCore.initSocket({
        wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
        maxTokensPerConnection: 50,
        pingIntervalMs: 30000,
        reconnectBaseDelayMs: 5000,
        reconnectMaxDelayMs: 60000,
        maxReconnectAttempts: 0,
        verbose: false,
    });
    console.log('✅ Socket initialized (not connecting, just for callback routing)');
} catch (err: any) {
    // Socket may already be initialized
    console.log('ℹ️  Socket init:', err.message);
}

// Simulate synthetic price data for trio evaluation
console.log('\n  Simulating synthetic prices for first group...');

const firstGroup = groups[0];
if (firstGroup) {
    const napiGroup = convertGroupToNapi(firstGroup);
    const parents = napiGroup.parents.filter((p: any) => p.kind === 'above');
    parents.sort((a: any, b: any) => (a.boundsLower || 0) - (b.boundsLower || 0));

    // Simulate prices for first 3 trios
    const testScenarios = [
        {
            name: 'Scenario 1: No Profit (balanced market)',
            prices: parents.slice(0, 3).flatMap((p: any, i: number) => {
                const asks = [0.67, 0.67, 0.67]; // totalAsk = 2.01 > payout
                const bids = [0.65, 0.65, 0.65];
                return [
                    { tokenId: p.clobTokenIds[0], bid: bids[0], ask: asks[0], label: `Parent${i} YES` },
                    { tokenId: p.clobTokenIds[1], bid: bids[1], ask: asks[1], label: `Parent${i} NO` },
                ];
            }),
        },
        {
            name: 'Scenario 2: Triangle BUY Opportunity',
            prices: (() => {
                if (parents.length < 2) return [];
                const lower = parents[0];
                const upper = parents[1];
                const rangeChild = napiGroup.children.find(
                    (c: any) =>
                        c.kind === 'range' &&
                        c.boundsLower === lower.boundsLower &&
                        c.boundsUpper === upper.boundsLower,
                );
                if (!rangeChild) return [];

                // Set asks so totalAsk < 2.0 (profitable)
                return [
                    { tokenId: lower.clobTokenIds[0], bid: 0.62, ask: 0.60, label: 'LowerYES' },
                    { tokenId: upper.clobTokenIds[1], bid: 0.52, ask: 0.50, label: 'UpperNO' },
                    { tokenId: rangeChild.clobTokenIds[1], bid: 0.82, ask: 0.80, label: 'RangeNO' },
                ];
            })(),
        },
        {
            name: 'Scenario 3: Unbundling Opportunity',
            prices: (() => {
                if (parents.length < 2) return [];
                const lower = parents[0];
                const upper = parents[1];
                const rangeChild = napiGroup.children.find(
                    (c: any) =>
                        c.kind === 'range' &&
                        c.boundsLower === lower.boundsLower &&
                        c.boundsUpper === upper.boundsLower,
                );
                if (!rangeChild) return [];

                // Unbundling: Bid(PL_YES) > Ask(RC_YES) + Ask(PU_YES)
                return [
                    { tokenId: lower.clobTokenIds[0], bid: 0.80, ask: 0.82, label: 'LowerYES' },
                    { tokenId: upper.clobTokenIds[0], bid: 0.38, ask: 0.40, label: 'UpperYES' },
                    { tokenId: rangeChild.clobTokenIds[0], bid: 0.28, ask: 0.30, label: 'RangeYES' },
                ];
            })(),
        },
    ];

    const scenarioResults: any[] = [];

    for (const scenario of testScenarios) {
        console.log(`\n  --- ${scenario.name} ---`);
        const beforeCount = capturedSignals.length;

        // Feed each price update through the engine
        // Note: We can't directly call handle_top_of_book from JS (it's internal),
        // but the engine processes via the socket callback dispatcher.
        // So we just log what we would feed and check the engine status.
        const priceLog: any[] = [];
        for (const p of scenario.prices) {
            priceLog.push({
                token: shortToken(p.tokenId),
                label: p.label,
                bid: p.bid,
                ask: p.ask,
            });
            console.log(`    ${p.label}: bid=${p.bid}, ask=${p.ask} [${shortToken(p.tokenId)}]`);
        }

        scenarioResults.push({
            scenario: scenario.name,
            prices: priceLog,
            note: 'Prices shown for review. Real signals require live socket data flow.',
        });
    }
}

// ============================================================================
// STEP 6: Token index analysis
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 6: Token Index Analysis');
console.log('='.repeat(80));

const tokenAnalysis: any = {
    totalTokens: 0,
    tokensByGroup: {},
};

for (const group of groups) {
    const napiGroup = convertGroupToNapi(group);
    const groupTokens: string[] = [];

    for (const child of napiGroup.children) {
        groupTokens.push(...child.clobTokenIds);
    }
    for (const parent of napiGroup.parents) {
        groupTokens.push(...parent.clobTokenIds);
    }

    const uniqueTokens = [...new Set(groupTokens)];
    tokenAnalysis.tokensByGroup[group.groupKey] = {
        totalTokens: uniqueTokens.length,
        childTokens: napiGroup.children.length * 2,
        parentTokens: napiGroup.parents.length * 2,
    };
    tokenAnalysis.totalTokens += uniqueTokens.length;

    console.log(`  ${group.groupKey}: ${uniqueTokens.length} unique tokens (${napiGroup.children.length} children × 2 + ${napiGroup.parents.length} parents × 2)`);
}

// ============================================================================
// STEP 7: Coverage analysis
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 7: Coverage Analysis (Parent → Children mapping)');
console.log('='.repeat(80));

const coverageAnalysis: any[] = [];

for (const group of groups) {
    const napiGroup = convertGroupToNapi(group);
    const parents = napiGroup.parents.filter((p: any) => p.kind === 'above');
    parents.sort((a: any, b: any) => (a.boundsLower || 0) - (b.boundsLower || 0));

    const children = napiGroup.children.filter((c: any) => c.kind === 'range');
    children.sort((a: any, b: any) => (a.boundsLower || 0) - (b.boundsLower || 0));

    console.log(`\n  Group: ${group.groupKey}`);
    console.log(`  Sorted Parents (${parents.length}):`);
    parents.forEach((p: any, i: number) => {
        console.log(`    [${i}] ${p.slug} — bounds: >=${p.boundsLower}`);
    });

    console.log(`  Sorted Range Children (${children.length}):`);
    children.forEach((c: any, i: number) => {
        console.log(`    [${i}] ${c.slug} — bounds: ${c.boundsLower}-${c.boundsUpper}`);
    });

    // Compute expected coverage
    console.log(`  Coverage:`);
    for (let pi = 0; pi < parents.length; pi++) {
        const parent = parents[pi];
        const parentLower = parent.boundsLower ?? -Infinity;
        const parentUpper = parent.boundsUpper ?? Infinity;

        const coveredChildren = children
            .map((c: any, ci: number) => ({
                index: ci,
                slug: c.slug,
                lower: c.boundsLower ?? -Infinity,
                upper: c.boundsUpper ?? Infinity,
            }))
            .filter((c: any) => c.upper > parentLower && c.lower < parentUpper);

        const startIdx = coveredChildren.length > 0 ? coveredChildren[0].index : -1;
        const endIdx = coveredChildren.length > 0 ? coveredChildren[coveredChildren.length - 1].index : -1;

        console.log(`    Parent[${pi}] ${parent.slug}: coverage=[${startIdx}, ${endIdx}] (${coveredChildren.length} children)`);

        coverageAnalysis.push({
            group: group.groupKey,
            parentIdx: pi,
            parentSlug: parent.slug,
            parentBounds: `>=${parentLower}`,
            coverageStart: startIdx,
            coverageEnd: endIdx,
            coveredCount: coveredChildren.length,
        });
    }
}

// ============================================================================
// STEP 8: Formula verification
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('STEP 8: Arbitrage Formula Reference');
console.log('='.repeat(80));

const formulas = {
    triangleBuy: {
        name: 'POLYMARKET_TRIANGLE_BUY',
        description: 'Buy all 3 legs at ASK, guarantee $2 payout',
        legs: 'ParentLower YES + ParentUpper NO + Range NO',
        formula: 'profit = $2.00 - (LowerYES_ASK + UpperNO_ASK + RangeNO_ASK)',
        profitBps: '(profit / totalAsk) × 10000',
        minRequired: 'profit >= min_profit_abs AND profitBps >= min_profit_bps',
    },
    unbundling: {
        name: 'SELL_PARENT_BUY_CHILDREN',
        description: 'Sell parent lower YES, buy range YES + parent upper YES',
        legs: 'ParentLower YES (sell) + Range YES (buy) + ParentUpper YES (buy)',
        formula: 'profit = LowerYES_BID - (RangeYES_ASK + UpperYES_ASK)',
        profitBps: '(profit / cost) × 10000',
        minRequired: 'profit >= min_profit_abs AND profitBps >= min_profit_bps',
    },
    bundling: {
        name: 'BUY_PARENT_SELL_CHILDREN',
        description: 'Buy parent lower YES, sell range YES + parent upper YES',
        legs: 'ParentLower YES (buy) + Range YES (sell) + ParentUpper YES (sell)',
        formula: 'profit = (RangeYES_BID + UpperYES_BID) - LowerYES_ASK',
        profitBps: '(profit / LowerYES_ASK) × 10000',
        minRequired: 'profit >= min_profit_abs AND profitBps >= min_profit_bps',
    },
};

for (const [key, formula] of Object.entries(formulas)) {
    console.log(`\n  📐 ${formula.name}`);
    console.log(`     ${formula.description}`);
    console.log(`     Legs: ${formula.legs}`);
    console.log(`     Formula: ${formula.formula}`);
    console.log(`     BPS: ${formula.profitBps}`);
    console.log(`     Min: ${formula.minRequired}`);
}

// ============================================================================
// OUTPUT: Save complete dump
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('OUTPUT: Saving complete state dump');
console.log('='.repeat(80));

const dump = {
    generatedAt: new Date().toISOString(),
    rustCoreExports: Object.keys(rustCore).sort(),
    engineConfig,
    engineStatus,
    groupDetails,
    tokenAnalysis,
    coverageAnalysis,
    formulas,
    capturedSignals,
    inputSummary: {
        bootstrapFile: bootstrapPath,
        groupsProvided: groups.length,
        triosCreated: trioCount,
    },
};

const outputPath = path.join(__dirname, 'artifacts', 'rust-engine-state-dump.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(dump, null, 2));
console.log(`\n✅ State dump saved to: ${outputPath}`);
console.log(`   File size: ${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB`);

// ============================================================================
// CLEANUP
// ============================================================================

try {
    rustCore.shutdownSocket();
    console.log('✅ Socket shutdown');
} catch (err: any) {
    // Ignore
}

console.log('\n🏁 Done!');
process.exit(0);

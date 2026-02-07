import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { Subscription, Subject, Observable, merge } from 'rxjs';
import { MarketStructureService } from './market-structure.service';
import { MarketDataStreamService } from '../ingestion/market-data-stream.service';
// import { BinaryChillManager } from './binary-chill-manager.service';
import { TopOfBookUpdate } from './interfaces/top-of-book.interface';
import {
    MarketRangeDescriptor,
    RangeGroup,
} from './interfaces/range-group.interface';
import {
    ArbOpportunity,
    ArbStrategy,
    MarketSnapshot,
    RangeCoverage,
} from './interfaces/arbitrage.interface';

// ============================================================================
// TRIO MODEL - Optimized for 3-market arbitrage ONLY
// Structure: Parent[i] + Range[i] + Parent[i+1] (adjacent pairs)
// ============================================================================

type MarketRole = 'parent' | 'child';

interface MarketLocator {
    groupKey: string;
    role: MarketRole;
    index: number;
}

// Trio-specific types
type TrioLegRole = 'parentLowerYes' | 'parentUpperNo' | 'rangeNo';

interface TrioLocator {
    groupKey: string;
    trioIndex: number;
    role: TrioLegRole;
}

interface TrioLegSnapshot {
    assetId?: string;
    marketSlug?: string;
    bestBid?: number | null;
    bestAsk?: number | null;
    bestBidSize?: number;
    bestAskSize?: number;
    timestampMs?: number;
}

// Flat structure for O(1) access - NO arrays!
interface TrioState {
    parentLowerIndex: number;
    parentUpperIndex: number;
    rangeIndex: number;

    // Direct snapshots
    lowerYes: TrioLegSnapshot;  // Parent lower YES token
    upperNo: TrioLegSnapshot;   // Parent upper NO token
    rangeNo: TrioLegSnapshot;   // Range NO token
}

interface TokenSnapshot {
    assetId?: string;
    marketSlug?: string;
    bestBid?: number | null;
    bestAsk?: number | null;
    bestBidSize?: number;
    bestAskSize?: number;
    timestampMs?: number;
}

type ParentState = MarketSnapshot & { coverage?: RangeCoverage };

// Simplified GroupState for Trio Model only
interface GroupState {
    group: RangeGroup;
    childStates: MarketSnapshot[];
    parentStates: ParentState[];
    trioStates: TrioState[];
    cooldowns: Map<string, number>;
    trioLookupByAsset: Map<string, number[]>; // Asset -> trio indices
}

// Threshold for dirty checking
const SIZE_CHANGE_THRESHOLD = 0.01;
const SLOW_SCAN_THRESHOLD_MS = 2;

@Injectable()
export class ArbitrageEngineTrioService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ArbitrageEngineTrioService.name);
    private readonly groups = new Map<string, GroupState>();
    private readonly tokenIndex = new Map<string, MarketLocator>();
    private readonly slugIndex = new Map<string, MarketLocator>();
    private readonly marketIdIndex = new Map<string, MarketLocator>();
    private readonly trioTokenIndex = new Map<string, TrioLocator>();
    private readonly allTokenIndex = new Map<string, TokenSnapshot>();
    private readonly opportunity$ = new Subject<ArbOpportunity>();
    // private readonly binaryChillManager: BinaryChillManager;
    private topOfBookSub?: Subscription;

    private readonly lastPriceCache = new Map<
        string,
        {
            bid: number | null;
            ask: number | null;
            bidSize?: number;
            askSize?: number;
            timestampMs?: number;
        }
    >();

    private readonly minProfitBps = this.numFromEnv('ARB_MIN_PROFIT_BPS', 5);
    private readonly minProfitAbs = this.numFromEnv('ARB_MIN_PROFIT_ABS', 0);
    private readonly cooldownMs = this.numFromEnv('ARB_COOLDOWN_MS', 1000);

    constructor(
        private readonly marketStructureService: MarketStructureService,
        private readonly marketDataStreamService: MarketDataStreamService,
    ) {
        // this.binaryChillManager = new BinaryChillManager(
        //     this.minProfitBps,
        //     this.minProfitAbs,
        //     this.cooldownMs,
        // );
    }

    async onModuleInit(): Promise<void> {
        await this.bootstrapGroups();
        this.topOfBookSub = this.marketDataStreamService
            .onTopOfBook()
            .subscribe((update) => this.handleTopOfBook(update));
    }

    onModuleDestroy(): void {
        if (this.topOfBookSub) {
            this.topOfBookSub.unsubscribe();
        }
        // this.binaryChillManager.clear();
        this.opportunity$.complete();
    }

    onOpportunity(): Observable<ArbOpportunity> {
        return this.opportunity$.asObservable();
        // return merge(
        //     this.opportunity$.asObservable(),
        //     this.binaryChillManager.onOpportunity(),
        // );
    }

    hasGroups(): boolean {
        return this.groups.size > 0;
    }

    getGroupKeys(): string[] {
        return Array.from(this.groups.keys());
    }

    async ensureBootstrapped(): Promise<void> {
        if (this.hasGroups()) {
            this.logger.debug('Trio engine already has groups, skipping bootstrap');
            return;
        }
        this.logger.log('Trio engine has no groups, triggering bootstrap...');
        await this.bootstrapGroups();
    }

    // ============================================================================
    // BOOTSTRAP
    // ============================================================================

    private async bootstrapGroups(): Promise<void> {
        try {
            const groups = await this.marketStructureService.rebuild();
            this.groups.clear();
            this.tokenIndex.clear();
            this.slugIndex.clear();
            this.marketIdIndex.clear();
            this.trioTokenIndex.clear();
            this.allTokenIndex.clear();

            let totalTrios = 0;
            for (const group of groups) {
                const state = this.buildGroupState(group);
                this.groups.set(group.groupKey, state);
                this.indexGroup(state);
                totalTrios += state.trioStates.length;
            }

            this.logger.log(
                `Trio engine initialized: ${groups.length} groups, ${totalTrios} trios`,
            );
        } catch (error) {
            this.logger.error(`Failed to bootstrap trio engine: ${error.message}`);
        }
    }

    private buildGroupState(group: RangeGroup): GroupState {
        const rangeChildren = group.children.filter(
            (child) => child.kind === 'range',
        );

        const childStates = rangeChildren.map<MarketSnapshot>((descriptor) => ({
            descriptor,
            bestAsk: undefined,
            bestBid: undefined,
            assetId: descriptor.clobTokenIds?.[0],
            marketSlug: descriptor.slug,
        }));

        const parentStates = group.parents.map<ParentState>((descriptor) => {
            const coverage = this.computeCoverage(rangeChildren, descriptor);
            return {
                descriptor,
                coverage: coverage ?? undefined,
                bestAsk: undefined,
                bestBid: undefined,
                assetId: descriptor.clobTokenIds?.[0],
                marketSlug: descriptor.slug,
            };
        });

        const state: GroupState = {
            group,
            childStates,
            parentStates,
            trioStates: [],
            cooldowns: new Map(),
            trioLookupByAsset: new Map(),
        };

        this.initializeTrioStates(state);
        return state;
    }

    // ============================================================================
    // TRIO INITIALIZATION - Adjacent parent pairs + single range
    // ============================================================================

    private addTrioLocator(
        tokenId: string,
        groupKey: string,
        trioIndex: number,
        role: TrioLegRole,
    ): void {
        // Each token maps to exactly one trio (no duplicates)
        this.trioTokenIndex.set(tokenId, { groupKey, trioIndex, role });
    }

    /**
     * Initialize TrioStates - ADJACENT parent pairs only (i, i+1)
     * with a single connecting range child.
     * 
     * Structure: Parent[i] YES + Range[i] NO + Parent[i+1] NO
     * Example: ETH>2800 YES + Range(2800-2900) NO + ETH>2900 NO
     */
    private initializeTrioStates(state: GroupState): void {
        const trios: TrioState[] = [];

        // O(1) lookup: lowerBound -> child index
        const rangeLowerMap = new Map<number, number>();
        for (let i = 0; i < state.childStates.length; i++) {
            const child = state.childStates[i];
            if (
                child.descriptor.kind === 'range' &&
                Number.isFinite(child.descriptor.bounds.lower) &&
                Number.isFinite(child.descriptor.bounds.upper)
            ) {
                rangeLowerMap.set(child.descriptor.bounds.lower as number, i);
            }
        }

        // ADJACENT parent pairs only
        for (let lowerIdx = 0; lowerIdx < state.parentStates.length - 1; lowerIdx++) {
            const lower = state.parentStates[lowerIdx];
            const upper = state.parentStates[lowerIdx + 1];

            const lowerDescriptor = lower.descriptor;
            const upperDescriptor = upper.descriptor;

            if (
                lowerDescriptor.kind !== 'above' ||
                !Number.isFinite(lowerDescriptor.bounds.lower) ||
                upperDescriptor.kind !== 'above' ||
                !Number.isFinite(upperDescriptor.bounds.lower)
            ) {
                continue;
            }

            const lowerBound = lowerDescriptor.bounds.lower as number;
            const upperBound = upperDescriptor.bounds.lower as number;

            // Find connecting range
            const rangeIdx = rangeLowerMap.get(lowerBound);
            if (rangeIdx === undefined) continue;

            const rangeChild = state.childStates[rangeIdx];
            if (rangeChild.descriptor.bounds.upper !== upperBound) continue;

            // Get all required tokens
            const lowerYesToken = lowerDescriptor.clobTokenIds?.[0];
            const upperYesToken = upperDescriptor.clobTokenIds?.[0];
            const upperNoToken = upperDescriptor.clobTokenIds?.[1];
            const rangeYesToken = rangeChild.descriptor.clobTokenIds?.[0];
            const rangeNoToken = rangeChild.descriptor.clobTokenIds?.[1];

            if (!lowerYesToken || !upperNoToken || !rangeNoToken) continue;

            const trio: TrioState = {
                parentLowerIndex: lowerIdx,
                parentUpperIndex: lowerIdx + 1,
                rangeIndex: rangeIdx,
                lowerYes: {
                    assetId: lowerYesToken,
                    marketSlug: lowerDescriptor.slug,
                    bestAsk: this.toFinite(lower.bestAsk),
                    bestBid: this.toFinite(lower.bestBid),
                    bestAskSize: lower.bestAskSize,
                    bestBidSize: lower.bestBidSize,
                    timestampMs: lower.timestampMs,
                },
                upperNo: {
                    assetId: upperNoToken,
                    marketSlug: upperDescriptor.slug,
                    bestBid: undefined,
                    bestAsk: undefined,
                    bestBidSize: undefined,
                    bestAskSize: undefined,
                    timestampMs: undefined,
                },
                rangeNo: {
                    assetId: rangeNoToken,
                    marketSlug: rangeChild.descriptor.slug,
                    bestBid: undefined,
                    bestAsk: undefined,
                    bestBidSize: undefined,
                    bestAskSize: undefined,
                    timestampMs: undefined,
                },
            };

            const trioIndex = trios.length;
            trios.push(trio);

            // Index for O(1) jump-table updates
            this.addTrioLocator(lowerYesToken, state.group.groupKey, trioIndex, 'parentLowerYes');
            this.addTrioLocator(upperNoToken, state.group.groupKey, trioIndex, 'parentUpperNo');
            this.addTrioLocator(rangeNoToken, state.group.groupKey, trioIndex, 'rangeNo');

            // Local lookup - include ALL 5 tokens
            const addToLookup = (assetId: string | undefined) => {
                if (!assetId) return;
                const existing = state.trioLookupByAsset.get(assetId) || [];
                existing.push(trioIndex);
                state.trioLookupByAsset.set(assetId, existing);
            };
            addToLookup(lowerYesToken);
            addToLookup(upperNoToken);
            addToLookup(rangeNoToken);
            addToLookup(upperYesToken);
            addToLookup(rangeYesToken);
        }

        state.trioStates = trios;
    }

    // ============================================================================
    // INDEXING
    // ============================================================================

    private indexGroup(state: GroupState): void {
        const { groupKey } = state.group;

        state.childStates.forEach((child, index) => {
            this.addLocator(groupKey, 'child', index, child.descriptor);
        });

        state.parentStates.forEach((parent, index) => {
            this.addLocator(groupKey, 'parent', index, parent.descriptor);
        });
    }

    private addLocator(
        groupKey: string,
        role: MarketRole,
        index: number,
        descriptor: MarketRangeDescriptor,
    ): void {
        const locator: MarketLocator = { groupKey, role, index };

        for (const tokenId of descriptor.clobTokenIds || []) {
            this.tokenIndex.set(tokenId, locator);
        }

        if (descriptor.slug) {
            this.slugIndex.set(descriptor.slug, locator);
        }

        if (descriptor.marketId) {
            this.marketIdIndex.set(descriptor.marketId, locator);
        }
    }

    private computeCoverage(
        children: MarketRangeDescriptor[],
        parent: MarketRangeDescriptor,
    ): RangeCoverage | null {
        if (!children.length) return null;

        const parentLower = Number.isFinite(parent.bounds.lower)
            ? (parent.bounds.lower as number)
            : Number.NEGATIVE_INFINITY;
        const parentUpper = Number.isFinite(parent.bounds.upper)
            ? (parent.bounds.upper as number)
            : Number.POSITIVE_INFINITY;

        let start = -1;
        let end = -1;

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const childLower = Number.isFinite(child.bounds.lower)
                ? (child.bounds.lower as number)
                : Number.NEGATIVE_INFINITY;
            const childUpper = Number.isFinite(child.bounds.upper)
                ? (child.bounds.upper as number)
                : Number.POSITIVE_INFINITY;

            const overlaps = childUpper > parentLower && childLower < parentUpper;
            if (overlaps) {
                if (start === -1) start = i;
                end = i;
            }
        }

        if (start === -1 || end === -1) return null;
        return { startIndex: start, endIndex: end };
    }

    // ============================================================================
    // HOT PATH - handleTopOfBook
    // ============================================================================

    private handleTopOfBook(update: TopOfBookUpdate): void {
        if (update.bestBid === 0 || update.bestAsk === 0) return;

        // Dirty checking
        const cacheKey = update.assetId;
        if (cacheKey) {
            const cached = this.lastPriceCache.get(cacheKey);
            if (cached) {
                if (cached.timestampMs && update.timestampMs && update.timestampMs <= cached.timestampMs) {
                    return;
                }
                const priceUnchanged = cached.bid === update.bestBid && cached.ask === update.bestAsk;
                if (priceUnchanged) {
                    if (update.timestampMs) cached.timestampMs = update.timestampMs;
                    return;
                }
            }
            this.lastPriceCache.set(cacheKey, {
                bid: update.bestBid,
                ask: update.bestAsk,
                timestampMs: update.timestampMs,
            });
        }

        // Handle Trio Arbitrage (replaces Triangle)
        this.handleTrioTopOfBook(update);

        // Handle Range Arbitrage
        // this.handleRangeArbitrage(update);
    }

    // ============================================================================
    // TRIO ARBITRAGE (Triangle BUY)
    // ============================================================================

    private handleTrioTopOfBook(update: TopOfBookUpdate): boolean {
        const locator = this.trioTokenIndex.get(update.assetId || '');
        if (!locator) return false;

        const state = this.groups.get(locator.groupKey);
        if (!state) return false;

        const trio = state.trioStates[locator.trioIndex];
        if (!trio) return false;

        // Update the specific leg - O(1) direct access
        let target: TrioLegSnapshot | undefined;
        if (locator.role === 'parentLowerYes') {
            target = trio.lowerYes;
        } else if (locator.role === 'parentUpperNo') {
            target = trio.upperNo;
        } else if (locator.role === 'rangeNo') {
            target = trio.rangeNo;
        }

        if (!target) return false;

        // Update snapshot
        target.bestBid = this.toFinite(update.bestBid);
        target.bestAsk = this.toFinite(update.bestAsk);
        target.bestBidSize = update.bestBidSize ?? target.bestBidSize;
        target.bestAskSize = update.bestAskSize ?? target.bestAskSize;
        target.timestampMs = update.timestampMs;

        // Evaluate single trio directly - no Map/Set overhead
        this.evaluateSingleTrio(state, trio);
        return true;
    }

    private evaluateSingleTrio(state: GroupState, trio: TrioState): void {
        const result = this.calculateTrioProfit(state, trio);
        if (!result) return;

        const now = Date.now();
        const lastEmitted = state.cooldowns.get(result.emitKey);
        if (!lastEmitted || now - lastEmitted >= this.cooldownMs) {
            state.cooldowns.set(result.emitKey, now);
            this.opportunity$.next(result.opportunity);
        }
    }

    // ============================================================================
    // TRIO PROFIT CALCULATION (O(1) - flat structure)
    // ============================================================================

    private calcTrioProfitOnly(trio: TrioState): {
        totalAsk: number;
        totalBid: number;
        meetsBuy: boolean;
        meetsSell: boolean;
        payout: number;
    } | null {
        const askLowerYes = trio.lowerYes.bestAsk;
        const askUpperNo = trio.upperNo.bestAsk;
        const askRangeNo = trio.rangeNo.bestAsk;
        const bidLowerYes = trio.lowerYes.bestBid;
        const bidUpperNo = trio.upperNo.bestBid;
        const bidRangeNo = trio.rangeNo.bestBid;

        if (
            askLowerYes == null || askUpperNo == null || askRangeNo == null ||
            bidLowerYes == null || bidUpperNo == null || bidRangeNo == null
        ) {
            return null;
        }

        const payout = 2; // Triangle payout = $2
        const totalAsk = askLowerYes + askUpperNo + askRangeNo;
        const totalBid = bidLowerYes + bidUpperNo + bidRangeNo;

        const profitBuy = payout - totalAsk;
        const profitSell = totalBid - payout;

        const profitBpsBuy = (profitBuy / totalAsk) * 10000;
        const profitBpsSell = (profitSell / payout) * 10000;

        const meetsBuy = profitBuy >= this.minProfitAbs && profitBpsBuy >= this.minProfitBps;
        const meetsSell = profitSell >= this.minProfitAbs && profitBpsSell >= this.minProfitBps;

        if (!meetsBuy && !meetsSell) return null;

        return { totalAsk, totalBid, meetsBuy, meetsSell, payout };
    }

    private calculateTrioProfit(
        state: GroupState,
        trio: TrioState,
    ): { profitAbs: number; profitBps: number; opportunity: ArbOpportunity; emitKey: string } | null {
        const calc = this.calcTrioProfitOnly(trio);
        if (!calc) return null;

        const { totalAsk, totalBid, meetsBuy, meetsSell, payout } = calc;

        const buildOpportunity = (
            mode: 'BUY' | 'SELL',
            profitAbs: number,
            profitBps: number,
        ): ArbOpportunity => {
            const parentLower = state.parentStates[trio.parentLowerIndex];
            const parentUpper = state.parentStates[trio.parentUpperIndex];
            const rangeChild = state.childStates[trio.rangeIndex];

            const rangeNoAsk = trio.rangeNo.bestAsk ?? 0;
            const rangeNoBid = trio.rangeNo.bestBid ?? 0;

            return {
                groupKey: state.group.groupKey,
                eventSlug: state.group.eventSlug,
                crypto: state.group.crypto,
                strategy: mode === 'BUY'
                    ? 'POLYMARKET_TRIANGLE_BUY' as const
                    : 'POLYMARKET_TRIANGLE_SELL' as const,
                parent: {
                    descriptor: parentLower.descriptor,
                    coverage: parentLower.coverage ?? { startIndex: 0, endIndex: 0 },
                    bestBid: trio.lowerYes.bestBid ?? undefined,
                    bestAsk: trio.lowerYes.bestAsk ?? undefined,
                    bestBidSize: trio.lowerYes.bestBidSize,
                    bestAskSize: trio.lowerYes.bestAskSize,
                    assetId: trio.lowerYes.assetId,
                    marketSlug: trio.lowerYes.marketSlug,
                    timestampMs: trio.lowerYes.timestampMs,
                },
                parentUpper: {
                    descriptor: parentUpper.descriptor,
                    bestBid: trio.upperNo.bestBid ?? undefined,
                    bestAsk: trio.upperNo.bestAsk ?? undefined,
                    bestBidSize: trio.upperNo.bestBidSize,
                    bestAskSize: trio.upperNo.bestAskSize,
                    assetId: trio.upperNo.assetId,
                    marketSlug: trio.upperNo.marketSlug,
                    timestampMs: trio.upperNo.timestampMs,
                },
                children: [{
                    index: trio.rangeIndex,
                    descriptor: rangeChild.descriptor,
                    bestBid: trio.rangeNo.bestBid ?? undefined,
                    bestAsk: trio.rangeNo.bestAsk ?? undefined,
                    bestBidSize: trio.rangeNo.bestBidSize,
                    bestAskSize: trio.rangeNo.bestAskSize,
                    assetId: trio.rangeNo.assetId,
                    marketSlug: trio.rangeNo.marketSlug,
                    timestampMs: trio.rangeNo.timestampMs,
                }],
                childrenSumAsk: rangeNoAsk,
                childrenSumBid: rangeNoBid,

                // Add missing legacy fields for compatibility
                parentBestBid: trio.lowerYes.bestBid,
                parentBestAsk: trio.lowerYes.bestAsk,
                parentUpperBestBid: trio.upperNo.bestBid,
                parentUpperBestAsk: trio.upperNo.bestAsk,

                profitAbs,
                profitBps,
                timestampMs: Date.now(),
                isExecutable: true,

                // Context for execution/logging
                polymarketTriangleContext: {
                    parentLowerYesAsk: trio.lowerYes.bestAsk ?? 0,
                    parentLowerYesBid: trio.lowerYes.bestBid ?? 0,
                    parentUpperNoAsk: trio.upperNo.bestAsk ?? 0,
                    parentUpperNoBid: trio.upperNo.bestBid ?? 0,
                    rangeNoAsk: rangeNoAsk,
                    rangeNoBid: rangeNoBid,
                    totalCost: mode === 'BUY' ? totalAsk : undefined,
                    totalBid: mode === 'SELL' ? totalBid : undefined,
                    payout: payout,
                    mode,
                    rangesCount: 1, // Trio always has 1 range
                },

                reason: mode === 'BUY'
                    ? 'POLYMARKET_TRIANGLE_BUY_COST_LT_PAYOUT'
                    : 'POLYMARKET_TRIANGLE_SELL_BID_GT_PAYOUT',
            };
        };

        if (meetsBuy) {
            const profitAbs = payout - totalAsk;
            const profitBps = (profitAbs / totalAsk) * 10000;
            const opportunity = buildOpportunity('BUY', profitAbs, profitBps);
            const emitKey = `trio_buy_${trio.lowerYes.assetId}_${trio.upperNo.assetId}_${trio.rangeNo.assetId}`;
            return { profitAbs, profitBps, opportunity, emitKey };
        }

        // if (meetsSell) {
        //     const profitAbs = totalBid - payout;
        //     const profitBps = (profitAbs / payout) * 10000;
        //     const opportunity = buildOpportunity('SELL', profitAbs, profitBps);
        //     const emitKey = `trio_sell_${trio.lowerYes.assetId}_${trio.upperNo.assetId}_${trio.rangeNo.assetId}`;
        //     return { profitAbs, profitBps, opportunity, emitKey };
        // }

        return null;
    }

    // ============================================================================
    // RANGE ARBITRAGE (Bundling / Unbundling) - Uses Trio structure
    // ============================================================================

    private handleRangeArbitrage(update: TopOfBookUpdate): void {
        const locator =
            (update.assetId && this.tokenIndex.get(update.assetId)) ||
            (update.marketSlug && this.slugIndex.get(update.marketSlug)) ||
            (update.marketId && this.marketIdIndex.get(update.marketId.toString()));

        if (!locator) return;

        const state = this.groups.get(locator.groupKey);
        if (!state) return;

        // Update state
        if (locator.role === 'child') {
            this.updateChild(state, locator.index, update);
        } else if (locator.role === 'parent') {
            this.updateParent(state, locator.index, update);
        }

        // Evaluate trios affected by this update
        const trioIndices = state.trioLookupByAsset.get(update.assetId || '');
        if (trioIndices && trioIndices.length > 0) {
            this.evaluateTriosForRangeArbitrage(state, trioIndices);
        }
    }

    private updateChild(state: GroupState, index: number, update: TopOfBookUpdate): void {
        const snapshot = state.childStates[index];
        snapshot.bestBid = this.toFinite(update.bestBid);
        snapshot.bestAsk = this.toFinite(update.bestAsk);
        snapshot.bestBidSize = update.bestBidSize ?? snapshot.bestBidSize;
        snapshot.bestAskSize = update.bestAskSize ?? snapshot.bestAskSize;
        snapshot.assetId = update.assetId ?? snapshot.assetId;
        snapshot.marketSlug = update.marketSlug ?? snapshot.marketSlug;
        snapshot.timestampMs = update.timestampMs;
    }

    private updateParent(state: GroupState, index: number, update: TopOfBookUpdate): void {
        const snapshot = state.parentStates[index];
        snapshot.bestBid = this.toFinite(update.bestBid);
        snapshot.bestAsk = this.toFinite(update.bestAsk);
        snapshot.bestBidSize = update.bestBidSize ?? snapshot.bestBidSize;
        snapshot.bestAskSize = update.bestAskSize ?? snapshot.bestAskSize;
        snapshot.assetId = update.assetId ?? snapshot.assetId;
        snapshot.marketSlug = update.marketSlug ?? snapshot.marketSlug;
        snapshot.timestampMs = update.timestampMs;
    }

    private evaluateTriosForRangeArbitrage(state: GroupState, trioIndices: number[]): void {
        for (const idx of trioIndices) {
            const trio = state.trioStates[idx];
            if (!trio) continue;

            // Get market states
            const parentLower = state.parentStates[trio.parentLowerIndex];
            const parentUpper = state.parentStates[trio.parentUpperIndex];
            const rangeChild = state.childStates[trio.rangeIndex];

            // Unbundling: Sell Parent Lower, Buy Range + Parent Upper
            // Profit = Bid(ParentLower) - (Ask(Range) + Ask(ParentUpper))
            const unbundlingResult = this.evaluateUnbundling(state, trio, parentLower, parentUpper, rangeChild);
            if (unbundlingResult) {
                const lastEmitted = state.cooldowns.get(unbundlingResult.emitKey);
                const now = Date.now();
                if (!lastEmitted || now - lastEmitted >= this.cooldownMs) {
                    state.cooldowns.set(unbundlingResult.emitKey, now);
                    this.opportunity$.next(unbundlingResult.opportunity);
                }
            }

            // Bundling: Buy Parent Lower, Sell Range + Parent Upper
            // Profit = (Bid(Range) + Bid(ParentUpper)) - Ask(ParentLower)
            const bundlingResult = this.evaluateBundling(state, trio, parentLower, parentUpper, rangeChild);
            if (bundlingResult) {
                const lastEmitted = state.cooldowns.get(bundlingResult.emitKey);
                const now = Date.now();
                if (!lastEmitted || now - lastEmitted >= this.cooldownMs) {
                    state.cooldowns.set(bundlingResult.emitKey, now);
                    this.opportunity$.next(bundlingResult.opportunity);
                }
            }
        }
    }

    private evaluateUnbundling(
        state: GroupState,
        trio: TrioState,
        parentLower: ParentState,
        parentUpper: ParentState,
        rangeChild: MarketSnapshot,
    ): { profitAbs: number; emitKey: string; opportunity: ArbOpportunity } | null {
        const bidLower = parentLower.bestBid;
        const askRange = rangeChild.bestAsk;
        const askUpper = parentUpper.bestAsk;

        if (bidLower == null || askRange == null || askUpper == null) return null;

        const cost = askRange + askUpper;
        const profitAbs = bidLower - cost;
        const profitBps = cost > 0 ? (profitAbs / cost) * 10000 : 0;

        if (profitAbs < this.minProfitAbs || profitBps < this.minProfitBps) return null;

        const opportunity: ArbOpportunity = {
            groupKey: state.group.groupKey,
            eventSlug: state.group.eventSlug,
            crypto: state.group.crypto,
            strategy: 'SELL_PARENT_BUY_CHILDREN' as const,
            parent: {
                ...parentLower,
                coverage: parentLower.coverage ?? { startIndex: 0, endIndex: 0 },
            },
            parentUpper: { ...parentUpper },
            children: [{ ...rangeChild, index: trio.rangeIndex }],
            childrenSumAsk: rangeChild.bestAsk ?? 0,
            childrenSumBid: rangeChild.bestBid ?? 0,
            parentBestBid: bidLower,
            parentBestAsk: parentLower.bestAsk ?? undefined,
            parentUpperBestBid: parentUpper.bestBid ?? undefined,
            parentUpperBestAsk: parentUpper.bestAsk ?? undefined,
            profitAbs,
            profitBps,
            timestampMs: Date.now(),
            isExecutable: true,
        };

        const emitKey = `unbundle_${parentLower.assetId}_${rangeChild.assetId}_${parentUpper.assetId}`;
        return { profitAbs, emitKey, opportunity };
    }

    private evaluateBundling(
        state: GroupState,
        trio: TrioState,
        parentLower: ParentState,
        parentUpper: ParentState,
        rangeChild: MarketSnapshot,
    ): { profitAbs: number; emitKey: string; opportunity: ArbOpportunity } | null {
        const askLower = parentLower.bestAsk;
        const bidRange = rangeChild.bestBid;
        const bidUpper = parentUpper.bestBid;

        if (askLower == null || bidRange == null || bidUpper == null) return null;

        const revenue = bidRange + bidUpper;
        const profitAbs = revenue - askLower;
        const profitBps = askLower > 0 ? (profitAbs / askLower) * 10000 : 0;

        if (profitAbs < this.minProfitAbs || profitBps < this.minProfitBps) return null;

        const opportunity: ArbOpportunity = {
            groupKey: state.group.groupKey,
            eventSlug: state.group.eventSlug,
            crypto: state.group.crypto,
            strategy: 'BUY_PARENT_SELL_CHILDREN' as const,
            parent: {
                ...parentLower,
                coverage: parentLower.coverage ?? { startIndex: 0, endIndex: 0 },
            },
            parentUpper: { ...parentUpper },
            children: [{ ...rangeChild, index: trio.rangeIndex }],
            childrenSumAsk: rangeChild.bestAsk ?? 0,
            childrenSumBid: rangeChild.bestBid ?? 0,
            parentBestBid: parentLower.bestBid ?? undefined,
            parentBestAsk: askLower,
            parentUpperBestBid: parentUpper.bestBid ?? undefined,
            parentUpperBestAsk: parentUpper.bestAsk ?? undefined,
            profitAbs,
            profitBps,
            timestampMs: Date.now(),
            isExecutable: true,
        };

        const emitKey = `bundle_${parentLower.assetId}_${rangeChild.assetId}_${parentUpper.assetId}`;
        return { profitAbs, emitKey, opportunity };
    }

    // ============================================================================
    // UTILITIES
    // ============================================================================

    private toFinite(value: number | undefined): number | null {
        if (value === undefined) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    private numFromEnv(key: string, defaultValue: number): number {
        const raw = process.env[key];
        if (!raw) return defaultValue;
        const num = Number(raw);
        return Number.isFinite(num) ? num : defaultValue;
    }

    cleanupExpiredGroups(groupKeys: string[]): number {
        if (groupKeys.length === 0) return 0;

        const removedCount = this.groups.size;

        this.groups.clear();
        this.tokenIndex.clear();
        this.slugIndex.clear();
        this.marketIdIndex.clear();
        this.trioTokenIndex.clear();
        this.allTokenIndex.clear();
        // this.binaryChillManager.clear();

        if (removedCount > 0) {
            this.logger.log(`Cleaned up ${removedCount} groups from trio engine`);
        }

        return removedCount;
    }

    getLatestSnapshot(opportunity: ArbOpportunity): ArbOpportunity | null {
        const parentTokenSnapshot = opportunity.parent.assetId
            ? this.allTokenIndex.get(opportunity.parent.assetId)
            : null;

        const updatedParent = parentTokenSnapshot
            ? {
                ...opportunity.parent,
                bestBid: parentTokenSnapshot.bestBid ?? opportunity.parent.bestBid,
                bestAsk: parentTokenSnapshot.bestAsk ?? opportunity.parent.bestAsk,
                bestBidSize: parentTokenSnapshot.bestBidSize ?? opportunity.parent.bestBidSize,
                bestAskSize: parentTokenSnapshot.bestAskSize ?? opportunity.parent.bestAskSize,
                timestampMs: parentTokenSnapshot.timestampMs ?? opportunity.parent.timestampMs,
            }
            : opportunity.parent;

        const updatedChildren = opportunity.children.map((child) => {
            const childSnapshot = child.assetId
                ? this.allTokenIndex.get(child.assetId)
                : null;
            return childSnapshot
                ? {
                    ...child,
                    bestBid: childSnapshot.bestBid ?? child.bestBid,
                    bestAsk: childSnapshot.bestAsk ?? child.bestAsk,
                    bestBidSize: childSnapshot.bestBidSize ?? child.bestBidSize,
                    bestAskSize: childSnapshot.bestAskSize ?? child.bestAskSize,
                    timestampMs: childSnapshot.timestampMs ?? child.timestampMs,
                }
                : child;
        });

        let updatedParentUpper = opportunity.parentUpper;
        if (opportunity.parentUpper?.assetId) {
            const upperSnapshot = this.allTokenIndex.get(opportunity.parentUpper.assetId);
            if (upperSnapshot) {
                updatedParentUpper = {
                    ...opportunity.parentUpper,
                    bestBid: upperSnapshot.bestBid ?? opportunity.parentUpper.bestBid,
                    bestAsk: upperSnapshot.bestAsk ?? opportunity.parentUpper.bestAsk,
                    bestBidSize: upperSnapshot.bestBidSize ?? opportunity.parentUpper.bestBidSize,
                    bestAskSize: upperSnapshot.bestAskSize ?? opportunity.parentUpper.bestAskSize,
                    timestampMs: upperSnapshot.timestampMs ?? opportunity.parentUpper.timestampMs,
                };
            }
        }

        return {
            ...opportunity,
            parent: updatedParent,
            children: updatedChildren,
            parentUpper: updatedParentUpper,
        };
    }
}

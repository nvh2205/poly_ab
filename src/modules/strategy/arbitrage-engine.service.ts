import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subscription, Subject, Observable, merge } from 'rxjs';
import { MarketStructureService } from './market-structure.service';
import { MarketDataStreamService } from '../ingestion/market-data-stream.service';
import { BinaryChillManager } from './binary-chill-manager.service';
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

type MarketRole = 'parent' | 'child';

interface MarketLocator {
  groupKey: string;
  role: MarketRole;
  index: number;
}

type TriangleLegRole = 'parentLowerYes' | 'parentUpperNo' | 'rangeNo';

interface TriangleLocator {
  groupKey: string;
  triangleIndex: number;
  role: TriangleLegRole;
  rangeIndex?: number;
}

interface TriangleLegSnapshot {
  assetId?: string;
  marketSlug?: string;
  bestBid?: number | null;
  bestAsk?: number | null;
  bestBidSize?: number;
  bestAskSize?: number;
  timestampMs?: number;
}

interface TriangleState {
  parentLowerIndex: number;
  parentUpperIndex: number;
  rangeIndices: number[];
  lowerYes: TriangleLegSnapshot;
  upperNo: TriangleLegSnapshot;
  ranges: Array<{
    index: number;
    snapshot: TriangleLegSnapshot;
  }>;
}

type ParentState = MarketSnapshot & { coverage?: RangeCoverage };

interface GroupState {
  group: RangeGroup;
  childStates: MarketSnapshot[]; // range children only
  parentStates: ParentState[];
  triangleStates: TriangleState[];
  askPrefix: number[];
  bidPrefix: number[];
  missingAskPrefix: number[];
  missingBidPrefix: number[];
  cooldowns: Map<string, number>;
  lastScanAt: number;
  scanTimer?: NodeJS.Timeout;
}

@Injectable()
export class ArbitrageEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArbitrageEngineService.name);
  private readonly groups = new Map<string, GroupState>();
  private readonly tokenIndex = new Map<string, MarketLocator>();
  private readonly slugIndex = new Map<string, MarketLocator>();
  private readonly marketIdIndex = new Map<string, MarketLocator>();
  private readonly triangleTokenIndex = new Map<string, TriangleLocator[]>();
  private readonly opportunity$ = new Subject<ArbOpportunity>();
  private readonly binaryChillManager: BinaryChillManager; // Tách riêng binary chill
  private topOfBookSub?: Subscription;

  private readonly minProfitBps = this.numFromEnv('ARB_MIN_PROFIT_BPS', 5);
  private readonly minProfitAbs = this.numFromEnv('ARB_MIN_PROFIT_ABS', 0);
  private readonly throttleMs = this.numFromEnv('ARB_SCAN_THROTTLE_MS', 50);
  private readonly cooldownMs = this.numFromEnv('ARB_COOLDOWN_MS', 1000);

  constructor(
    private readonly marketStructureService: MarketStructureService,
    private readonly marketDataStreamService: MarketDataStreamService,
  ) {
    // Initialize binary chill manager with same config
    this.binaryChillManager = new BinaryChillManager(
      this.minProfitBps,
      this.minProfitAbs,
      this.cooldownMs,
    );
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
    this.groups.forEach((state) => {
      if (state.scanTimer) {
        clearTimeout(state.scanTimer);
      }
    });
    this.binaryChillManager.clear();
    this.opportunity$.complete();
  }

  onOpportunity(): Observable<ArbOpportunity> {
    // Merge opportunities from both range arbitrage and binary chill
    return merge(
      this.opportunity$.asObservable(),
      this.binaryChillManager.onOpportunity(),
    );
  }

  private async bootstrapGroups(): Promise<void> {
    try {
      const groups = await this.marketStructureService.rebuild();
      this.groups.clear();
      this.tokenIndex.clear();
      this.slugIndex.clear();
      this.marketIdIndex.clear();
      this.triangleTokenIndex.clear();

      for (const group of groups) {
        const state = this.buildGroupState(group);
        this.groups.set(group.groupKey, state);
        this.indexGroup(state);
      }

      this.logger.log(
        `Arbitrage engine initialized for ${groups.length} groups`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to bootstrap arbitrage engine: ${error.message}`,
      );
    }
  }

  private buildGroupState(group: RangeGroup): GroupState {
    const rangeChildren = group.children.filter(
      (child) => child.kind === 'range',
    );
    const binaryChildren = group.children.filter(
      (child) => child.kind !== 'range',
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

    // Initialize binary chill pairs in separate manager
    if (binaryChildren.length > 0) {
      this.binaryChillManager.initializePairs(
        group.groupKey,
        group.eventSlug,
        group.crypto,
        parentStates.map((p, idx) => ({
          descriptor: p.descriptor,
          index: idx,
        })),
        binaryChildren.map((child, idx) => ({ descriptor: child, index: idx })),
      );
    }

    const length = childStates.length;
    const askPrefix = new Array<number>(length + 1).fill(0);
    const bidPrefix = new Array<number>(length + 1).fill(0);
    const missingAskPrefix = new Array<number>(length + 1).fill(0);
    const missingBidPrefix = new Array<number>(length + 1).fill(0);

    const state: GroupState = {
      group,
      childStates,
      parentStates,
      triangleStates: [],
      askPrefix,
      bidPrefix,
      missingAskPrefix,
      missingBidPrefix,
      cooldowns: new Map(),
      lastScanAt: 0,
    };

    this.recalculatePrefixes(state, 0);
    this.initializeTriangleStates(state);
    return state;
  }

  private indexGroup(state: GroupState): void {
    const { groupKey } = state.group;

    state.childStates.forEach((child, index) => {
      this.addLocator(groupKey, 'child', index, child.descriptor);
    });

    state.parentStates.forEach((parent, index) => {
      this.addLocator(groupKey, 'parent', index, parent.descriptor);
    });

    // Binary chill tokens are indexed separately in BinaryChillManager
  }

  private addLocator(
    groupKey: string,
    role: MarketRole,
    index: number,
    descriptor: MarketRangeDescriptor,
  ): void {
    const locator: MarketLocator = { groupKey, role, index };

    this.tokenIndex.set(descriptor.clobTokenIds?.[0], locator);

    if (descriptor.slug) {
      this.slugIndex.set(descriptor.slug, locator);
    }

    if (descriptor.marketId) {
      this.marketIdIndex.set(descriptor.marketId, locator);
    }
  }

  private addTriangleLocator(
    tokenId: string,
    groupKey: string,
    triangleIndex: number,
    role: TriangleLegRole,
    rangeIndex?: number,
  ): void {
    const existing = this.triangleTokenIndex.get(tokenId) || [];
    existing.push({ groupKey, triangleIndex, role, rangeIndex });
    this.triangleTokenIndex.set(tokenId, existing);
  }

  private initializeTriangleStates(state: GroupState): void {
    const triangles: TriangleState[] = [];

    // Build O(1) lookup map: lowerBound -> child index (for range markets only)
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

    for (let lowerIdx = 0; lowerIdx < state.parentStates.length; lowerIdx++) {
      const lower = state.parentStates[lowerIdx];
      const lowerDescriptor = lower.descriptor;

      if (
        lowerDescriptor.kind !== 'above' ||
        !Number.isFinite(lowerDescriptor.bounds.lower)
      ) {
        continue;
      }

      const lowerBound = lowerDescriptor.bounds.lower as number;

      for (
        let upperIdx = lowerIdx + 1;
        upperIdx < state.parentStates.length;
        upperIdx++
      ) {
        const upper = state.parentStates[upperIdx];
        const upperDescriptor = upper.descriptor;

        if (
          upperDescriptor.kind !== 'above' ||
          !Number.isFinite(upperDescriptor.bounds.lower)
        ) {
          continue;
        }

        const upperBound = upperDescriptor.bounds.lower as number;

        // Find contiguous range markets using O(1) lookup
        const chain: number[] = [];
        let currentLower = lowerBound;
        while (currentLower < upperBound) {
          const idx = rangeLowerMap.get(currentLower);
          if (idx === undefined) break;

          const child = state.childStates[idx];
          const childUpper = child.descriptor.bounds.upper as number;
          chain.push(idx);

          if (childUpper === upperBound) break;
          if (childUpper > upperBound) {
            chain.length = 0;
            break;
          }
          currentLower = childUpper;
        }

        if (chain.length === 0) continue;
        const lastRangeUpper =
          state.childStates[chain[chain.length - 1]].descriptor.bounds.upper;
        if (!Number.isFinite(lastRangeUpper) || lastRangeUpper !== upperBound) {
          continue;
        }

        const lowerYesToken = lowerDescriptor.clobTokenIds?.[0];
        const upperNoToken = upperDescriptor.clobTokenIds?.[1];
        if (!lowerYesToken || !upperNoToken) {
          continue;
        }

        // Pre-allocate ranges array with exact size
        const ranges: Array<{ index: number; snapshot: TriangleLegSnapshot }> =
          [];
        let validRanges = true;
        for (let i = 0; i < chain.length; i++) {
          const idx = chain[i];
          const descriptor = state.childStates[idx].descriptor;
          const rangeNoToken = descriptor.clobTokenIds?.[1];
          if (!rangeNoToken) {
            validRanges = false;
            break;
          }
          ranges.push({
            index: idx,
            snapshot: {
              assetId: rangeNoToken,
              marketSlug: descriptor.slug,
              // NO token prices will be populated via handleTriangleTopOfBook
              bestBid: undefined,
              bestAsk: undefined,
              bestBidSize: undefined,
              bestAskSize: undefined,
              timestampMs: undefined,
            } as TriangleLegSnapshot,
          });
        }

        if (!validRanges) continue;

        const triangle: TriangleState = {
          parentLowerIndex: lowerIdx,
          parentUpperIndex: upperIdx,
          rangeIndices: chain,
          lowerYes: {
            assetId: lowerYesToken,
            marketSlug: lowerDescriptor.slug,
            // Init with current prices, will be updated via handleTriangleTopOfBook
            bestAsk: this.toFinite(lower.bestAsk),
            bestBid: this.toFinite(lower.bestBid),
            bestAskSize: lower.bestAskSize,
            bestBidSize: lower.bestBidSize,
            timestampMs: lower.timestampMs,
          },
          upperNo: {
            assetId: upperNoToken,
            marketSlug: upperDescriptor.slug,
            // NO token prices will be populated via handleTriangleTopOfBook
            // Init with undefined, will be set on first update
            bestBid: undefined,
            bestAsk: undefined,
            bestBidSize: undefined,
            bestAskSize: undefined,
            timestampMs: undefined,
          },
          ranges,
        };

        const triangleIndex = triangles.length;
        triangles.push(triangle);

        this.addTriangleLocator(
          lowerYesToken,
          state.group.groupKey,
          triangleIndex,
          'parentLowerYes',
        );
        this.addTriangleLocator(
          upperNoToken,
          state.group.groupKey,
          triangleIndex,
          'parentUpperNo',
        );
        // Use for loop instead of forEach for better performance
        for (let i = 0; i < ranges.length; i++) {
          const range = ranges[i];
          if (range.snapshot.assetId) {
            this.addTriangleLocator(
              range.snapshot.assetId,
              state.group.groupKey,
              triangleIndex,
              'rangeNo',
              range.index,
            );
          }
        }
      }
    }

    state.triangleStates = triangles;
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

    if (start === -1 || end === -1) {
      return null;
    }

    return { startIndex: start, endIndex: end };
  }

  private handleTopOfBook(update: TopOfBookUpdate): void {
    // Ignore updates with zero bid/ask to avoid invalid spreads
    if (update.bestBid === 0 || update.bestAsk === 0) return;

    // ALWAYS forward to binary chill manager first
    // Binary chill needs parent token updates too, and it has its own tokenIndex
    this.binaryChillManager.handleTopOfBook(update);

    // Handle polymarket triangle arbitrage tokens (YES/NO mix)
    this.handleTriangleTopOfBook(update);

    // Then handle range arbitrage
    const locator =
      (update.assetId && this.tokenIndex.get(update.assetId)) ||
      (update.marketSlug && this.slugIndex.get(update.marketSlug)) ||
      (update.marketId && this.marketIdIndex.get(update.marketId.toString()));

    if (!locator) return;

    const state = this.groups.get(locator.groupKey);
    if (!state) return;

    if (locator.role === 'child') {
      this.updateChild(state, locator.index, update);
    } else if (locator.role === 'parent') {
      this.updateParent(state, locator.index, update);
    }

    this.scheduleScan(state);
  }

  private updateChild(
    state: GroupState,
    index: number,
    update: TopOfBookUpdate,
  ): void {
    const snapshot = state.childStates[index];
    snapshot.bestBid = this.toFinite(update.bestBid);
    snapshot.bestAsk = this.toFinite(update.bestAsk);
    // Preserve last known sizes when updates omit them (e.g., price_change)
    snapshot.bestBidSize = update.bestBidSize ?? snapshot.bestBidSize;
    snapshot.bestAskSize = update.bestAskSize ?? snapshot.bestAskSize;
    snapshot.assetId = update.assetId ?? snapshot.assetId;
    snapshot.marketSlug = update.marketSlug ?? snapshot.marketSlug;
    snapshot.timestampMs = update.timestampMs;

    this.recalculatePrefixes(state, index);
  }

  private updateParent(
    state: GroupState,
    index: number,
    update: TopOfBookUpdate,
  ): void {
    const snapshot = state.parentStates[index];
    snapshot.bestBid = this.toFinite(update.bestBid);
    snapshot.bestAsk = this.toFinite(update.bestAsk);
    snapshot.bestBidSize = update.bestBidSize ?? snapshot.bestBidSize;
    snapshot.bestAskSize = update.bestAskSize ?? snapshot.bestAskSize;
    snapshot.assetId = update.assetId ?? snapshot.assetId;
    snapshot.marketSlug = update.marketSlug ?? snapshot.marketSlug;
    snapshot.timestampMs = update.timestampMs;
  }

  private handleTriangleTopOfBook(update: TopOfBookUpdate): boolean {
    const locators = this.triangleTokenIndex.get(update.assetId || '');
    if (!locators || locators.length === 0) return false;

    // Track triangles that need evaluation per group
    const trianglesToEvaluate = new Map<string, Set<number>>();

    // Use for loop for better performance
    for (let i = 0; i < locators.length; i++) {
      const locator = locators[i];
      const state = this.groups.get(locator.groupKey);
      if (!state) continue;

      const triangle = state.triangleStates[locator.triangleIndex];
      if (!triangle) continue;

      let target: TriangleLegSnapshot | undefined;

      if (locator.role === 'parentLowerYes') {
        target = triangle.lowerYes;
      } else if (locator.role === 'parentUpperNo') {
        target = triangle.upperNo;
      } else {
        // rangeNo: use direct index lookup instead of find()
        for (let j = 0; j < triangle.ranges.length; j++) {
          if (triangle.ranges[j].index === locator.rangeIndex) {
            target = triangle.ranges[j].snapshot;
            break;
          }
        }
      }

      if (!target) continue;

      target.bestBid = this.toFinite(update.bestBid);
      target.bestAsk = this.toFinite(update.bestAsk);
      target.bestBidSize = update.bestBidSize ?? target.bestBidSize;
      target.bestAskSize = update.bestAskSize ?? target.bestAskSize;
      target.assetId = update.assetId ?? target.assetId;
      target.marketSlug = update.marketSlug ?? target.marketSlug;
      target.timestampMs = update.timestampMs;

      // Mark this triangle for evaluation
      if (!trianglesToEvaluate.has(locator.groupKey)) {
        trianglesToEvaluate.set(locator.groupKey, new Set());
      }
      trianglesToEvaluate.get(locator.groupKey)!.add(locator.triangleIndex);
    }

    // Evaluate all affected triangles and emit only the best one per group
    trianglesToEvaluate.forEach((triangleIndices, groupKey) => {
      const state = this.groups.get(groupKey);
      if (!state) return;

      this.evaluateAndEmitBestTriangle(state, Array.from(triangleIndices));
    });

    return true;
  }

  /**
   * Evaluate all affected triangles and emit only the best opportunity (highest profit)
   */
  private evaluateAndEmitBestTriangle(
    state: GroupState,
    triangleIndices: number[],
  ): void {
    let bestOpportunity: {
      profitAbs: number;
      opportunity: ArbOpportunity;
      emitKey: string;
    } | null = null;

    // Evaluate all triangles and find the best one
    for (const triangleIndex of triangleIndices) {
      const triangle = state.triangleStates[triangleIndex];
      if (!triangle) continue;

      const result = this.calculateTriangleProfit(state, triangle);
      if (!result) continue;

      // Only one of BUY or SELL can be profitable at a time
      // Compare with current best and update if better
      if (!bestOpportunity || result.profitAbs > bestOpportunity.profitAbs) {
        bestOpportunity = result;
      }
    }

    // No profitable opportunities
    if (!bestOpportunity) return;

    // Check cooldown and emit
    const now = Date.now();
    const lastEmitted = state.cooldowns.get(bestOpportunity.emitKey) || 0;
    if (now - lastEmitted < this.cooldownMs) return;

    state.cooldowns.set(bestOpportunity.emitKey, now);
    this.opportunity$.next(bestOpportunity.opportunity);
  }

  /**
   * Calculate triangle profit without emitting
   * Returns the profitable opportunity (BUY or SELL, only one can be profitable at a time)
   */
  private calculateTriangleProfit(
    state: GroupState,
    triangle: TriangleState,
  ): {
    profitAbs: number;
    profitBps: number;
    opportunity: ArbOpportunity;
    emitKey: string;
    mode: 'BUY' | 'SELL';
  } | null {
    const parentLower = state.parentStates[triangle.parentLowerIndex];
    const parentUpper = state.parentStates[triangle.parentUpperIndex];
    if (!parentLower || !parentUpper) return null;
    if (!parentLower.coverage) return null;

    // Triangle legs are updated independently via handleTriangleTopOfBook()
    // lowerYes: YES token of parent lower (index 0)
    // upperNo: NO token of parent upper (index 1)
    // ranges[].snapshot: NO tokens of range children (index 1)
    const askLowerYes = this.toFinite(triangle.lowerYes.bestAsk);
    const askUpperNo = this.toFinite(triangle.upperNo.bestAsk);
    const bidsLowerYes = this.toFinite(triangle.lowerYes.bestBid);
    const bidsUpperNo = this.toFinite(triangle.upperNo.bestBid);

    // Early exit if parent prices missing or zero
    if (
      askLowerYes === null ||
      askUpperNo === null ||
      bidsLowerYes === null ||
      bidsUpperNo === null ||
      askLowerYes <= 0 ||
      askUpperNo <= 0 ||
      bidsLowerYes <= 0 ||
      bidsUpperNo <= 0
    ) {
      return null;
    }

    let totalAskRanges = 0;
    let totalBidRanges = 0;
    const rangeChildren: Array<MarketSnapshot & { index: number }> = [];

    // Single pass through ranges - accumulate and build children array
    const rangesLength = triangle.ranges.length;
    for (let i = 0; i < rangesLength; i++) {
      const rangeRef = triangle.ranges[i];
      const child = state.childStates[rangeRef.index];
      const ask = this.toFinite(rangeRef.snapshot.bestAsk);
      const bid = this.toFinite(rangeRef.snapshot.bestBid);

      // Early exit on missing price or zero price
      if (ask === null || bid === null || ask <= 0 || bid <= 0) {
        return null;
      }

      totalAskRanges += ask;
      totalBidRanges += bid;

      rangeChildren.push({
        descriptor: child.descriptor,
        bestBid: bid,
        bestAsk: ask,
        bestBidSize: rangeRef.snapshot.bestBidSize,
        bestAskSize: rangeRef.snapshot.bestAskSize,
        assetId:
          rangeRef.snapshot.assetId ||
          child.descriptor.clobTokenIds?.[1] ||
          child.assetId,
        marketSlug: rangeRef.snapshot.marketSlug || child.marketSlug,
        timestampMs: rangeRef.snapshot.timestampMs,
        index: rangeRef.index,
      });
    }

    const totalAsk = askLowerYes + askUpperNo + totalAskRanges;
    const totalBid = bidsLowerYes + bidsUpperNo + totalBidRanges;
    const payout = rangesLength + 1; // constant payoff

    const timestamp =
      triangle.lowerYes.timestampMs ||
      triangle.upperNo.timestampMs ||
      triangle.ranges[0]?.snapshot.timestampMs ||
      Date.now();

    // Build key string without creating intermediate array
    let emitKeyBase = `${state.group.groupKey}:${triangle.parentLowerIndex}:${triangle.parentUpperIndex}:`;
    for (let i = 0; i < triangle.ranges.length; i++) {
      if (i > 0) emitKeyBase += '-';
      emitKeyBase += triangle.ranges[i].index;
    }
    emitKeyBase += ':POLYMARKET_TRIANGLE';

    const buildOpportunity = (
      mode: 'BUY' | 'SELL',
      profitAbs: number,
      profitBps: number,
      usedParentAsk: number | null,
      usedParentBid: number | null,
      usedUpperAsk: number | null,
      usedUpperBid: number | null,
    ): ArbOpportunity => {
      return {
        groupKey: state.group.groupKey,
        eventSlug: state.group.eventSlug,
        crypto: state.group.crypto,
        strategy:
          mode === 'BUY'
            ? 'POLYMARKET_TRIANGLE_BUY'
            : 'POLYMARKET_TRIANGLE_SELL',
        // Parent snapshot should use triangle YES token data, not parentLower state
        parent: {
          descriptor: parentLower.descriptor,
          bestBid: triangle.lowerYes.bestBid,
          bestAsk: triangle.lowerYes.bestAsk,
          bestBidSize: triangle.lowerYes.bestBidSize,
          bestAskSize: triangle.lowerYes.bestAskSize,
          assetId:
            triangle.lowerYes.assetId ||
            parentLower.descriptor.clobTokenIds?.[0],
          marketSlug: triangle.lowerYes.marketSlug || parentLower.marketSlug,
          timestampMs: triangle.lowerYes.timestampMs,
          coverage: parentLower.coverage,
        },
        parentUpper: {
          descriptor: parentUpper.descriptor,
          bestBid: triangle.upperNo.bestBid,
          bestAsk: triangle.upperNo.bestAsk,
          bestBidSize: triangle.upperNo.bestBidSize,
          bestAskSize: triangle.upperNo.bestAskSize,
          assetId:
            triangle.upperNo.assetId ||
            parentUpper.descriptor.clobTokenIds?.[1],
          marketSlug: triangle.upperNo.marketSlug || parentUpper.marketSlug,
          timestampMs: triangle.upperNo.timestampMs,
        },
        children: rangeChildren,
        childrenSumAsk: mode === 'BUY' ? totalAsk : Number.NaN,
        childrenSumBid: mode === 'SELL' ? totalBid : Number.NaN,
        parentBestBid: usedParentBid,
        parentBestAsk: usedParentAsk,
        parentUpperBestBid: usedUpperBid,
        parentUpperBestAsk: usedUpperAsk,
        profitAbs,
        profitBps,
        timestampMs: timestamp,
        isExecutable: true,
        polymarketTriangleContext: {
          parentLowerYesAsk: askLowerYes,
          parentLowerYesBid: bidsLowerYes,
          parentUpperNoAsk: askUpperNo,
          parentUpperNoBid: bidsUpperNo,
          rangeNoAsk: totalAskRanges,
          rangeNoBid: totalBidRanges,
          totalCost: mode === 'BUY' ? totalAsk : undefined,
          totalBid: mode === 'SELL' ? totalBid : undefined,
          payout,
          mode,
          rangesCount: triangle.ranges.length,
        },
        reason:
          mode === 'BUY'
            ? 'POLYMARKET_TRIANGLE_BUY_COST_LT_PAYOUT'
            : 'POLYMARKET_TRIANGLE_SELL_BID_GT_PAYOUT',
      };
    };

    // Calculate both sides
    // Buy side: pay asks, receive payout
    const profitBuyAbs = payout - totalAsk;
    const profitBuyBps = totalAsk > 0 ? (profitBuyAbs / totalAsk) * 10_000 : 0;

    // Sell side: collect bids, owe payout
    const profitSellAbs = totalBid - payout;
    const profitSellBps = payout > 0 ? (profitSellAbs / payout) * 10_000 : 0;

    // Only one side can be profitable at a time
    // Choose the side with positive profit that meets thresholds
    const meetsProfitBuy =
      profitBuyAbs > 0 &&
      profitBuyBps >= this.minProfitBps &&
      profitBuyAbs >= this.minProfitAbs;

    const meetsProfitSell =
      profitSellAbs > 0 &&
      profitSellBps >= this.minProfitBps &&
      profitSellAbs >= this.minProfitAbs;

    // Return the profitable side (should only be one)
    if (meetsProfitBuy) {
      return {
        profitAbs: profitBuyAbs,
        profitBps: profitBuyBps,
        opportunity: buildOpportunity(
          'BUY',
          profitBuyAbs,
          profitBuyBps,
          askLowerYes,
          bidsLowerYes,
          askUpperNo,
          bidsUpperNo,
        ),
        emitKey: `${emitKeyBase}:BUY`,
        mode: 'BUY',
      };
    }

    if (meetsProfitSell) {
      return {
        profitAbs: profitSellAbs,
        profitBps: profitSellBps,
        opportunity: buildOpportunity(
          'SELL',
          profitSellAbs,
          profitSellBps,
          askLowerYes,
          bidsLowerYes,
          askUpperNo,
          bidsUpperNo,
        ),
        emitKey: `${emitKeyBase}:SELL`,
        mode: 'SELL',
      };
    }

    return null;
  }

  private recalculatePrefixes(state: GroupState, fromIndex: number): void {
    const {
      childStates,
      askPrefix,
      bidPrefix,
      missingAskPrefix,
      missingBidPrefix,
    } = state;

    for (let i = fromIndex; i < childStates.length; i++) {
      const prevAsk = askPrefix[i];
      const prevBid = bidPrefix[i];
      const prevMissingAsk = missingAskPrefix[i];
      const prevMissingBid = missingBidPrefix[i];

      const ask = this.toFinite(childStates[i].bestAsk);
      const bid = this.toFinite(childStates[i].bestBid);

      askPrefix[i + 1] = prevAsk + (ask ?? 0);
      bidPrefix[i + 1] = prevBid + (bid ?? 0);
      missingAskPrefix[i + 1] = prevMissingAsk + (ask === null ? 1 : 0);
      missingBidPrefix[i + 1] = prevMissingBid + (bid === null ? 1 : 0);
    }
  }

  private scheduleScan(state: GroupState): void {
    if (state.scanTimer) return;

    const now = Date.now();
    const elapsed = now - state.lastScanAt;
    const delay = Math.max(0, this.throttleMs - elapsed);

    state.scanTimer = setTimeout(() => {
      state.scanTimer = undefined;
      this.scanGroup(state);
    }, delay);
  }

  private scanGroup(state: GroupState): void {
    state.lastScanAt = Date.now();

    // Scan range arbitrage opportunities only
    // Binary chill is handled separately in BinaryChillManager
    for (
      let parentIdx = 0;
      parentIdx < state.parentStates.length;
      parentIdx++
    ) {
      this.evaluateParentAllRanges(state, parentIdx);
    }
  }

  /**
   * Với mỗi parent (>i), thử tất cả các khoảng j từ i+step đến cuối
   * Ví dụ với parent >80k:
   * - Thử 80-82k + >82k (parentUpperIdx = 1)
   * - Thử 80-82k + 82-84k + >84k (parentUpperIdx = 2)
   * - ...
   * Tìm khoảng có profit tốt nhất
   */
  private evaluateParentAllRanges(
    state: GroupState,
    parentLowerIdx: number,
  ): void {
    const parentLower = state.parentStates[parentLowerIdx];
    if (!parentLower.coverage) return;

    const parentLowerWithCoverage = parentLower as ParentState & {
      coverage: RangeCoverage;
    };

    const parentBestBid = this.toFinite(parentLower.bestBid);
    const parentBestAsk = this.toFinite(parentLower.bestAsk);
    let bestCandidate: {
      profitAbs: number;
      emitKey: string;
      opportunity: ArbOpportunity;
    } | null = null;

    const startIndex = parentLower.coverage.startIndex;

    // Thử tất cả các parent upper từ parentLowerIdx+1 đến cuối
    for (
      let parentUpperIdx = parentLowerIdx + 1;
      parentUpperIdx < state.parentStates.length;
      parentUpperIdx++
    ) {
      const parentUpper = state.parentStates[parentUpperIdx];
      if (!parentUpper.coverage) continue;

      // endIndex là index cuối của khoảng range (trước parent upper)
      const endIndex = parentUpper.coverage.startIndex - 1;
      if (endIndex < startIndex) continue;

      // Tính Chiều A: Unbundling (Short Parent Lower, Long Children + Long Parent Upper)
      // Profit = Bid(>i) - [Sum(Ask(Range_k→k+step)) + Ask(>j)]
      const unbundling = this.evaluateUnbundling(
        state,
        parentLowerWithCoverage,
        parentUpper,
        startIndex,
        endIndex,
        parentBestBid,
        parentBestAsk,
      );

      // Tính Chiều B: Bundling (Long Parent Lower, Short Children + Short Parent Upper)
      // Profit = [Sum(Bid(Range_k→k+step)) + Bid(>j)] - Ask(>i)
      const bundling = this.evaluateBundling(
        state,
        parentLowerWithCoverage,
        parentUpper,
        startIndex,
        endIndex,
        parentBestBid,
        parentBestAsk,
      );

      // Keep only the best profit among unbundling/bundling for this parentLower
      const candidates = [unbundling, bundling];
      for (const c of candidates) {
        if (!c) continue;
        if (!bestCandidate || c.profitAbs > bestCandidate.profitAbs) {
          bestCandidate = c;
        }
      }
    }

    // Emit only the best candidate for this parentLower
    if (bestCandidate) {
      const now = Date.now();
      const lastEmitted = state.cooldowns.get(bestCandidate.emitKey) || 0;
      if (now - lastEmitted >= this.cooldownMs) {
        state.cooldowns.set(bestCandidate.emitKey, now);
        this.opportunity$.next(bestCandidate.opportunity);
      }
    }
  }

  /**
   * Chiều A: Unbundling - Short Parent Lower, Long Children + Long Parent Upper
   * Profit = Bid(>i) - [Sum(Ask(Range)) + Ask(>j)]
   */
  private evaluateUnbundling(
    state: GroupState,
    parentLower: ParentState & { coverage: RangeCoverage },
    parentUpper: ParentState,
    startIndex: number,
    endIndex: number,
    parentLowerBestBid: number | null,
    parentLowerBestAsk: number | null,
  ): {
    profitAbs: number;
    emitKey: string;
    opportunity: ArbOpportunity;
  } | null {
    if (parentLowerBestBid === null) return null;

    const parentUpperBestAsk = this.toFinite(parentUpper.bestAsk);
    if (parentUpperBestAsk === null) return null;

    const rangesSumAsk = this.sumRange(state, 'ask', startIndex, endIndex);
    if (!Number.isFinite(rangesSumAsk)) return null;

    const children = state.childStates.slice(startIndex, endIndex + 1);
    const totalCost = (rangesSumAsk as number) + parentUpperBestAsk;

    const profitAbs = parentLowerBestBid - totalCost;
    const profitBps = totalCost > 0 ? (profitAbs / totalCost) * 10_000 : 0;

    return this.buildRangeOpportunity(
      state,
      parentLower,
      parentUpper,
      children,
      {
        strategy: 'SELL_PARENT_BUY_CHILDREN',
        profitAbs,
        profitBps,
        childrenSumAsk: rangesSumAsk as number,
        childrenSumBid: Number.NaN,
        parentBestAsk: parentLowerBestAsk,
        parentBestBid: parentLowerBestBid,
        parentUpperBestAsk,
        parentUpperBestBid: this.toFinite(parentUpper.bestBid),
        timestampMs: parentLower.timestampMs || Date.now(),
      },
    );
  }

  /**
   * Chiều B: Bundling - Long Parent Lower, Short Children + Short Parent Upper
   * Profit = [Sum(Bid(Range)) + Bid(>j)] - Ask(>i)
   */
  private evaluateBundling(
    state: GroupState,
    parentLower: ParentState & { coverage: RangeCoverage },
    parentUpper: ParentState,
    startIndex: number,
    endIndex: number,
    parentLowerBestBid: number | null,
    parentLowerBestAsk: number | null,
  ): {
    profitAbs: number;
    emitKey: string;
    opportunity: ArbOpportunity;
  } | null {
    if (parentLowerBestAsk === null) return null;

    const parentUpperBestBid = this.toFinite(parentUpper.bestBid);
    if (parentUpperBestBid === null) return null;

    const rangesSumBid = this.sumRange(state, 'bid', startIndex, endIndex);
    if (!Number.isFinite(rangesSumBid)) return null;

    const children = state.childStates.slice(startIndex, endIndex + 1);
    const totalRevenue = (rangesSumBid as number) + parentUpperBestBid;

    const profitAbs = totalRevenue - parentLowerBestAsk;
    const profitBps =
      parentLowerBestAsk > 0 ? (profitAbs / parentLowerBestAsk) * 10_000 : 0;

    return this.buildRangeOpportunity(
      state,
      parentLower,
      parentUpper,
      children,
      {
        strategy: 'BUY_PARENT_SELL_CHILDREN',
        profitAbs,
        profitBps,
        childrenSumAsk: Number.NaN,
        childrenSumBid: rangesSumBid as number,
        parentBestAsk: parentLowerBestAsk,
        parentBestBid: parentLowerBestBid,
        parentUpperBestAsk: this.toFinite(parentUpper.bestAsk),
        parentUpperBestBid,
        timestampMs: parentLower.timestampMs || Date.now(),
      },
    );
  }

  private sumRange(
    state: GroupState,
    kind: 'ask' | 'bid',
    start: number,
    end: number,
  ): number | null {
    const prefix = kind === 'ask' ? state.askPrefix : state.bidPrefix;
    const missing =
      kind === 'ask' ? state.missingAskPrefix : state.missingBidPrefix;

    const missingCount = missing[end + 1] - missing[start];
    if (missingCount > 0) return null;
    return prefix[end + 1] - prefix[start];
  }

  private buildRangeOpportunity(
    state: GroupState,
    parent: ParentState & { coverage: RangeCoverage },
    parentUpper: ParentState | null,
    children: MarketSnapshot[],
    context: {
      strategy: ArbStrategy;
      profitAbs: number;
      profitBps: number;
      childrenSumAsk: number;
      childrenSumBid: number;
      parentBestBid: number | null;
      parentBestAsk: number | null;
      parentUpperBestBid?: number | null;
      parentUpperBestAsk?: number | null;
      timestampMs: number;
    },
  ): {
    profitAbs: number;
    emitKey: string;
    opportunity: ArbOpportunity;
  } | null {
    const { strategy, profitAbs, profitBps } = context;
    const key = parentUpper
      ? `${parent.descriptor.marketId || parent.descriptor.slug}:${parentUpper.descriptor.marketId || parentUpper.descriptor.slug}:${strategy}`
      : `${parent.descriptor.marketId || parent.descriptor.slug}:${strategy}`;

    // Block execution when any price is missing or zero
    if (this.hasInvalidPrices(parent, parentUpper, children)) {
      return null;
    }

    const isExecutable =
      profitAbs > 0 &&
      profitBps >= this.minProfitBps &&
      profitAbs >= this.minProfitAbs;

    if (!isExecutable) {
      return null;
    }

    const opportunity: ArbOpportunity = {
      groupKey: state.group.groupKey,
      eventSlug: state.group.eventSlug,
      crypto: state.group.crypto,
      strategy,
      parent: { ...parent, coverage: parent.coverage },
      parentUpper: parentUpper
        ? {
            descriptor: parentUpper.descriptor,
            bestBid: parentUpper.bestBid,
            bestAsk: parentUpper.bestAsk,
            bestBidSize: parentUpper.bestBidSize,
            bestAskSize: parentUpper.bestAskSize,
            assetId: parentUpper.assetId,
            marketSlug: parentUpper.marketSlug,
            timestampMs: parentUpper.timestampMs,
          }
        : undefined,
      children: children.map((child, idx) => ({
        ...child,
        index: parent.coverage.startIndex + idx,
      })),
      childrenSumAsk: context.childrenSumAsk,
      childrenSumBid: context.childrenSumBid,
      parentBestBid: context.parentBestBid ?? undefined,
      parentBestAsk: context.parentBestAsk ?? undefined,
      parentUpperBestBid: context.parentUpperBestBid ?? undefined,
      parentUpperBestAsk: context.parentUpperBestAsk ?? undefined,
      profitAbs,
      profitBps,
      timestampMs: context.timestampMs,
      isExecutable: true,
    };

    return { profitAbs, emitKey: key, opportunity };
  }

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

  /**
   * Detect any price that is missing or zero to avoid executing invalid opportunities.
   */
  private hasInvalidPrices(
    parent: ParentState,
    parentUpper: ParentState | null,
    children: MarketSnapshot[],
  ): boolean {
    const invalid = (v: number | null | undefined) =>
      v === null || v === undefined || v === 0;

    if (invalid(parent.bestBid) || invalid(parent.bestAsk)) return true;

    if (
      parentUpper &&
      (invalid(parentUpper.bestBid) || invalid(parentUpper.bestAsk))
    ) {
      return true;
    }

    for (const child of children) {
      if (invalid(child.bestBid) || invalid(child.bestAsk)) {
        return true;
      }
    }

    return false;
  }
}

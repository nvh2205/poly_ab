import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subscription, Subject, Observable } from 'rxjs';
import { MarketStructureService } from './market-structure.service';
import { MarketDataStreamService } from '../ingestion/market-data-stream.service';
import { TopOfBookUpdate } from './interfaces/top-of-book.interface';
import { MarketRangeDescriptor, RangeGroup } from './interfaces/range-group.interface';
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

interface GroupState {
  group: RangeGroup;
  childStates: MarketSnapshot[];
  parentStates: Array<MarketSnapshot & { coverage: RangeCoverage }>;
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
  private readonly opportunity$ = new Subject<ArbOpportunity>();
  private topOfBookSub?: Subscription;

  private readonly minProfitBps = this.numFromEnv('ARB_MIN_PROFIT_BPS', 5);
  private readonly minProfitAbs = this.numFromEnv('ARB_MIN_PROFIT_ABS', 0);
  private readonly throttleMs = this.numFromEnv('ARB_SCAN_THROTTLE_MS', 200);
  private readonly cooldownMs = this.numFromEnv('ARB_COOLDOWN_MS', 1000);

  constructor(
    private readonly marketStructureService: MarketStructureService,
    private readonly marketDataStreamService: MarketDataStreamService,
  ) {}

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
    this.opportunity$.complete();
  }

  onOpportunity(): Observable<ArbOpportunity> {
    return this.opportunity$.asObservable();
  }

  private async bootstrapGroups(): Promise<void> {
    try {
      const groups = await this.marketStructureService.rebuild();
      this.groups.clear();
      this.tokenIndex.clear();
      this.slugIndex.clear();
      this.marketIdIndex.clear();

      for (const group of groups) {
        const state = this.buildGroupState(group);
        this.groups.set(group.groupKey, state);
        this.indexGroup(state);
      }

      this.logger.log(`Arbitrage engine initialized for ${groups.length} groups`);
    } catch (error) {
      this.logger.error(`Failed to bootstrap arbitrage engine: ${error.message}`);
    }
  }

  private buildGroupState(group: RangeGroup): GroupState {
    const childStates = group.children.map<MarketSnapshot>((descriptor) => ({
      descriptor,
      bestAsk: undefined,
      bestBid: undefined,
      assetId: descriptor.clobTokenIds?.[0],
      marketSlug: descriptor.slug,
    }));

    const parentStates = group.parents
      .map((descriptor) => {
        const coverage = this.computeCoverage(group.children, descriptor);
        if (!coverage) return null;
        return {
          descriptor,
          coverage,
          bestAsk: undefined,
          bestBid: undefined,
          assetId: descriptor.clobTokenIds?.[0],
          marketSlug: descriptor.slug,
        } as MarketSnapshot & { coverage: RangeCoverage };
      })
      .filter((item) => item !== null) as Array<
      MarketSnapshot & { coverage: RangeCoverage }
    >;

    const length = childStates.length;
    const askPrefix = new Array<number>(length + 1).fill(0);
    const bidPrefix = new Array<number>(length + 1).fill(0);
    const missingAskPrefix = new Array<number>(length + 1).fill(0);
    const missingBidPrefix = new Array<number>(length + 1).fill(0);

    const state: GroupState = {
      group,
      childStates,
      parentStates,
      askPrefix,
      bidPrefix,
      missingAskPrefix,
      missingBidPrefix,
      cooldowns: new Map(),
      lastScanAt: 0,
    };

    this.recalculatePrefixes(state, 0);
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
  }

  private addLocator(
    groupKey: string,
    role: MarketRole,
    index: number,
    descriptor: MarketRangeDescriptor,
  ): void {
    const locator: MarketLocator = { groupKey, role, index };

    descriptor.clobTokenIds?.forEach((tokenId) => {
      if (tokenId) {
        this.tokenIndex.set(tokenId, locator);
      }
    });

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

      const overlaps =
        childUpper > parentLower && childLower < parentUpper;
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
    const locator =
      (update.assetId && this.tokenIndex.get(update.assetId)) ||
      (update.marketSlug && this.slugIndex.get(update.marketSlug)) ||
      (update.marketId && this.marketIdIndex.get(update.marketId.toString()));

    if (!locator) {
      return;
    }

    const state = this.groups.get(locator.groupKey);
    if (!state) return;

    if (locator.role === 'child') {
      this.updateChild(state, locator.index, update);
    } else {
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
    snapshot.assetId = update.assetId ?? snapshot.assetId;
    snapshot.marketSlug = update.marketSlug ?? snapshot.marketSlug;
    snapshot.timestampMs = update.timestampMs;
  }

  private recalculatePrefixes(state: GroupState, fromIndex: number): void {
    const { childStates, askPrefix, bidPrefix, missingAskPrefix, missingBidPrefix } =
      state;

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

    for (const parent of state.parentStates) {
      this.evaluateParent(state, parent);
    }
  }

  private evaluateParent(
    state: GroupState,
    parent: MarketSnapshot & { coverage: RangeCoverage },
  ): void {
    const { startIndex, endIndex } = parent.coverage;
    const children = state.childStates.slice(startIndex, endIndex + 1);
    const childrenSumAsk = this.sumRange(state, 'ask', startIndex, endIndex);
    const childrenSumBid = this.sumRange(state, 'bid', startIndex, endIndex);

    const parentBestBid = this.toFinite(parent.bestBid);
    const parentBestAsk = this.toFinite(parent.bestAsk);

    const now = Date.now();

    if (parentBestBid !== null && Number.isFinite(childrenSumAsk)) {
      const profitAbs = parentBestBid - (childrenSumAsk as number);
      const profitBps =
        childrenSumAsk && childrenSumAsk > 0
          ? (profitAbs / (childrenSumAsk as number)) * 10_000
          : 0;
      this.maybeEmitOpportunity(state, parent, children, {
        strategy: 'SELL_PARENT_BUY_CHILDREN',
        profitAbs,
        profitBps,
        childrenSumAsk: childrenSumAsk as number,
        childrenSumBid: childrenSumBid ?? Number.NaN,
        parentBestAsk,
        parentBestBid,
        timestampMs: parent.timestampMs || now,
      });
    }

    if (parentBestAsk !== null && Number.isFinite(childrenSumBid)) {
      const profitAbs = (childrenSumBid as number) - parentBestAsk;
      const profitBps =
        parentBestAsk && parentBestAsk > 0
          ? (profitAbs / parentBestAsk) * 10_000
          : 0;
      this.maybeEmitOpportunity(state, parent, children, {
        strategy: 'BUY_PARENT_SELL_CHILDREN',
        profitAbs,
        profitBps,
        childrenSumAsk: childrenSumAsk ?? Number.NaN,
        childrenSumBid: childrenSumBid as number,
        parentBestAsk,
        parentBestBid,
        timestampMs: parent.timestampMs || now,
      });
    }
  }

  private maybeEmitOpportunity(
    state: GroupState,
    parent: MarketSnapshot & { coverage: RangeCoverage },
    children: MarketSnapshot[],
    context: {
      strategy: ArbStrategy;
      profitAbs: number;
      profitBps: number;
      childrenSumAsk: number;
      childrenSumBid: number;
      parentBestBid: number | null;
      parentBestAsk: number | null;
      timestampMs: number;
    },
  ): void {
    const { strategy, profitAbs, profitBps } = context;
    const key = `${parent.descriptor.marketId || parent.descriptor.slug}:${strategy}`;

    const isExecutable =
      profitAbs > 0 &&
      profitBps >= this.minProfitBps &&
      profitAbs >= this.minProfitAbs;

    if (!isExecutable) {
      return;
    }

    const lastEmitted = state.cooldowns.get(key) || 0;
    const now = Date.now();
    if (now - lastEmitted < this.cooldownMs) {
      return;
    }

    state.cooldowns.set(key, now);

    const opportunity: ArbOpportunity = {
      groupKey: state.group.groupKey,
      eventSlug: state.group.eventSlug,
      crypto: state.group.crypto,
      strategy,
      parent: { ...parent, coverage: parent.coverage },
      children: children.map((child, idx) => ({
        ...child,
        index: parent.coverage.startIndex + idx,
      })),
      childrenSumAsk: context.childrenSumAsk,
      childrenSumBid: context.childrenSumBid,
      parentBestBid: context.parentBestBid ?? undefined,
      parentBestAsk: context.parentBestAsk ?? undefined,
      profitAbs,
      profitBps,
      timestampMs: context.timestampMs,
      isExecutable: true,
    };

    this.opportunity$.next(opportunity);
  }

  private sumRange(
    state: GroupState,
    kind: 'ask' | 'bid',
    start: number,
    end: number,
  ): number | null {
    const prefix = kind === 'ask' ? state.askPrefix : state.bidPrefix;
    const missing =
      kind === 'ask'
        ? state.missingAskPrefix
        : state.missingBidPrefix;

    const missingCount = missing[end + 1] - missing[start];
    if (missingCount > 0) return null;
    return prefix[end + 1] - prefix[start];
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
}


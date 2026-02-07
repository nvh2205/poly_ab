import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { TopOfBookUpdate } from './interfaces/top-of-book.interface';
import {
  BinaryChillSnapshot,
  BinaryChillStrategy,
  ArbOpportunity,
  RangeCoverage,
} from './interfaces/arbitrage.interface';
import { MarketRangeDescriptor } from './interfaces/range-group.interface';

interface BinaryChillPair {
  child: BinaryChillSnapshot;
  parent: BinaryChillSnapshot;
  childIndex: number;
  parentIndex: number;
  groupKey: string;
  eventSlug?: string;
  crypto?: string;
}

interface TokenLocator {
  pairId: string;
  role: 'child' | 'parent';
  tokenType: 'yes' | 'no';
}

/**
 * BinaryChillManager
 *
 * Quản lý riêng binary chill arbitrage pairs với tracking đầy đủ cả YES và NO tokens.
 * Tách biệt khỏi GroupState để tránh complexity và theo dõi chính xác giá NO token.
 */
@Injectable()
export class BinaryChillManager {
  private readonly logger = new Logger(BinaryChillManager.name);

  // Map pairId -> BinaryChillPair
  private readonly pairs = new Map<string, BinaryChillPair>();

  // Map tokenId -> TokenLocator để route updates
  private readonly tokenIndex = new Map<string, TokenLocator>();

  // Cooldowns per strategy
  private readonly cooldowns = new Map<string, number>();

  // Output stream
  private readonly opportunity$ = new Subject<ArbOpportunity>();

  // Configuration
  private readonly minProfitBps: number;
  private readonly minProfitAbs: number;
  private readonly cooldownMs: number;

  constructor(minProfitBps = 5, minProfitAbs = 0, cooldownMs = 1000) {
    this.minProfitBps = minProfitBps;
    this.minProfitAbs = minProfitAbs;
    this.cooldownMs = cooldownMs;
  }

  /**
   * Initialize binary chill pairs from market descriptors
   */
  initializePairs(
    groupKey: string,
    eventSlug: string | undefined,
    crypto: string | undefined,
    parents: Array<{ descriptor: MarketRangeDescriptor; index: number }>,
    // binaryChildren: Array<{ descriptor: MarketRangeDescriptor; index: number }>,
  ): void {
    // Build map of parent anchor -> parent info
    const parentByAnchor = new Map<
      number,
      { descriptor: MarketRangeDescriptor; index: number }
    >();

    parents.forEach((parent) => {
      const anchor = this.extractAnchor(parent.descriptor);
      if (anchor !== null) {
        parentByAnchor.set(anchor, parent);
      }
    });

    // Match each binary child with its parent
    // binaryChildren.forEach((child) => {
    //   const anchor = this.extractAnchor(child.descriptor);
    //   if (anchor === null) return;
    //
    //   const parent = parentByAnchor.get(anchor);
    //   if (!parent) return;
    //
    //   // Determine strategy based on child kind
    //   let strategy: BinaryChillStrategy;
    //   if (child.descriptor.kind === 'below') {
    //     // Case 1: Complement markets
    //     strategy = 'BUY_CHILD_YES_SELL_PARENT_NO'; // Default, will evaluate both directions
    //   } else if (child.descriptor.kind === 'above') {
    //     // Case 2: Same direction markets
    //     strategy = 'BUY_CHILD_YES_SELL_PARENT_YES'; // Default, will evaluate both directions
    //   } else {
    //     return; // Skip non-binary markets
    //   }
    //
    //   // Create pair
    //   const pairId = `${groupKey}:${child.descriptor.marketId}:${parent.descriptor.marketId}`;
    //
    //   const childSnapshot = this.createSnapshot(
    //     child.descriptor,
    //     parent.index,
    //     strategy,
    //   );
    //   const parentSnapshot = this.createSnapshot(
    //     parent.descriptor,
    //     parent.index,
    //     strategy,
    //   );
    //
    //   this.pairs.set(pairId, {
    //     child: childSnapshot,
    //     parent: parentSnapshot,
    //     childIndex: child.index,
    //     parentIndex: parent.index,
    //     groupKey,
    //     eventSlug,
    //     crypto,
    //   });
    //
    //   // Index tokens for routing
    //   this.indexTokens(pairId, child.descriptor, 'child');
    //   this.indexTokens(pairId, parent.descriptor, 'parent');
    // });

    this.logger.log(
      `Initialized ${this.pairs.size} binary chill pairs for group ${groupKey}`,
    );
  }

  /**
   * Handle top of book update for a token
   */
  handleTopOfBook(update: TopOfBookUpdate): void {
    const locator = this.tokenIndex.get(update.assetId || '');
    if (!locator) return;

    const pair = this.pairs.get(locator.pairId);
    if (!pair) return;

    // Update the appropriate snapshot
    const snapshot = locator.role === 'child' ? pair.child : pair.parent;

    if (locator.tokenType === 'yes') {
      snapshot.bestBidYes = this.toFinite(update.bestBid);
      snapshot.bestAskYes = this.toFinite(update.bestAsk);
      snapshot.bestBidSizeYes = update.bestBidSize ?? 0;
      snapshot.bestAskSizeYes = update.bestAskSize ?? 0;
      // Backward compatibility
      snapshot.bestBid = snapshot.bestBidYes;
      snapshot.bestAsk = snapshot.bestAskYes;
    } else {
      snapshot.bestBidNo = this.toFinite(update.bestBid);
      snapshot.bestAskNo = this.toFinite(update.bestAsk);
      snapshot.bestBidSizeNo = update.bestBidSize ?? 0;
      snapshot.bestAskSizeNo = update.bestAskSize ?? 0;
    }

    snapshot.timestampMs = update.timestampMs;

    // Evaluate arbitrage for this pair
    this.evaluatePair(pair);
  }

  /**
   * Get opportunities stream
   */
  onOpportunity(): Observable<ArbOpportunity> {
    return this.opportunity$.asObservable();
  }

  /**
   * Get all pairs (for debugging/monitoring)
   */
  getAllPairs(): BinaryChillPair[] {
    return Array.from(this.pairs.values());
  }

  /**
   * Clear all pairs (for cleanup)
   */
  clear(): void {
    this.pairs.clear();
    this.tokenIndex.clear();
    this.cooldowns.clear();
  }

  /**
   * Cleanup pairs for a specific group
   * Simplified: Clear all memory (same as clear() method)
   */
  cleanupGroup(groupKey: string): number {
    const removedCount = this.pairs.size;

    // Clear all memory (same as clear() method)
    this.pairs.clear();
    this.tokenIndex.clear();
    this.cooldowns.clear();

    if (removedCount > 0) {
      this.logger.log(
        `Cleaned up ${removedCount} binary chill pairs (cleared all)`,
      );
    }

    return removedCount;
  }

  // ==================== Private Methods ====================

  private createSnapshot(
    descriptor: MarketRangeDescriptor,
    parentIndex: number,
    strategy: BinaryChillStrategy,
  ): BinaryChillSnapshot {
    return {
      descriptor,
      yesTokenId: descriptor.clobTokenIds?.[0],
      noTokenId: descriptor.clobTokenIds?.[1],
      assetId: descriptor.clobTokenIds?.[0], // Backward compatibility
      marketSlug: descriptor.slug,
      parentIndex,
      strategy,
    };
  }

  private indexTokens(
    pairId: string,
    descriptor: MarketRangeDescriptor,
    role: 'child' | 'parent',
  ): void {
    // Index YES token (index 0)
    if (descriptor.clobTokenIds?.[0]) {
      this.tokenIndex.set(descriptor.clobTokenIds[0], {
        pairId,
        role,
        tokenType: 'yes',
      });
    }

    // Index NO token (index 1)
    if (descriptor.clobTokenIds?.[1]) {
      this.tokenIndex.set(descriptor.clobTokenIds[1], {
        pairId,
        role,
        tokenType: 'no',
      });
    }
  }

  private extractAnchor(descriptor: MarketRangeDescriptor): number | null {
    if (
      descriptor.kind === 'above' &&
      Number.isFinite(descriptor.bounds.lower)
    ) {
      return descriptor.bounds.lower as number;
    }
    if (
      descriptor.kind === 'below' &&
      Number.isFinite(descriptor.bounds.upper)
    ) {
      return descriptor.bounds.upper as number;
    }
    return null;
  }

  private evaluatePair(pair: BinaryChillPair): void {
    const { child, parent } = pair;

    // Determine case based on child kind
    if (child.descriptor.kind === 'below') {
      // Case 1: Complement markets
      this.evaluateComplement(pair);
    } else if (child.descriptor.kind === 'above') {
      // Case 2: Same direction markets
      this.evaluateSameDirection(pair);
    }
  }

  /**
   * Case 1: Complement Markets (Child <X vs Parent >X)
   * YES(child) = NO(parent) probabilistically
   */
  private evaluateComplement(pair: BinaryChillPair): void {
    const { child, parent } = pair;

    // Strategy A: Buy YES(child), Sell NO(parent)
    if (
      child.bestAskYes !== null &&
      child.bestAskYes !== undefined &&
      parent.bestBidNo !== null &&
      parent.bestBidNo !== undefined
    ) {
      const buyPrice = child.bestAskYes;
      const sellPrice = parent.bestBidNo;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = buyPrice > 0 ? (profitAbs / buyPrice) * 10_000 : 0;

      this.maybeEmitOpportunity(pair, {
        strategy: 'BUY_CHILD_YES_SELL_PARENT_NO',
        profitAbs,
        profitBps,
        buyPrice,
        sellPrice,
        childBestBidYes: child.bestBidYes,
        childBestAskYes: child.bestAskYes,
        parentBestBidNo: parent.bestBidNo,
        parentBestAskNo: parent.bestAskNo,
        timestampMs: child.timestampMs || parent.timestampMs || Date.now(),
      });
    }

    // Strategy B: Buy NO(parent), Sell YES(child)
    if (
      child.bestBidYes !== null &&
      child.bestBidYes !== undefined &&
      parent.bestAskNo !== null &&
      parent.bestAskNo !== undefined
    ) {
      const buyPrice = parent.bestAskNo;
      const sellPrice = child.bestBidYes;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = buyPrice > 0 ? (profitAbs / buyPrice) * 10_000 : 0;

      this.maybeEmitOpportunity(pair, {
        strategy: 'BUY_PARENT_NO_SELL_CHILD_YES',
        profitAbs,
        profitBps,
        buyPrice,
        sellPrice,
        childBestBidYes: child.bestBidYes,
        childBestAskYes: child.bestAskYes,
        parentBestBidNo: parent.bestBidNo,
        parentBestAskNo: parent.bestAskNo,
        timestampMs: child.timestampMs || parent.timestampMs || Date.now(),
      });
    }
  }

  /**
   * Case 2: Same Direction Markets (Child >X vs Parent >X)
   * YES(child) = YES(parent) - same outcome
   */
  private evaluateSameDirection(pair: BinaryChillPair): void {
    const { child, parent } = pair;

    // Strategy A: Buy YES(child), Sell YES(parent)
    if (
      child.bestAskYes !== null &&
      child.bestAskYes !== undefined &&
      parent.bestBidYes !== null &&
      parent.bestBidYes !== undefined
    ) {
      const buyPrice = child.bestAskYes;
      const sellPrice = parent.bestBidYes;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = buyPrice > 0 ? (profitAbs / buyPrice) * 10_000 : 0;

      this.maybeEmitOpportunity(pair, {
        strategy: 'BUY_CHILD_YES_SELL_PARENT_YES',
        profitAbs,
        profitBps,
        buyPrice,
        sellPrice,
        childBestBidYes: child.bestBidYes,
        childBestAskYes: child.bestAskYes,
        parentBestBidYes: parent.bestBidYes,
        parentBestAskYes: parent.bestAskYes,
        timestampMs: child.timestampMs || parent.timestampMs || Date.now(),
      });
    }

    // Strategy B: Buy NO(parent), Sell NO(child)
    if (
      child.bestBidNo !== null &&
      child.bestBidNo !== undefined &&
      parent.bestAskNo !== null &&
      parent.bestAskNo !== undefined
    ) {
      const buyPrice = parent.bestAskNo;
      const sellPrice = child.bestBidNo;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = buyPrice > 0 ? (profitAbs / buyPrice) * 10_000 : 0;

      this.maybeEmitOpportunity(pair, {
        strategy: 'BUY_PARENT_NO_SELL_CHILD_NO',
        profitAbs,
        profitBps,
        buyPrice,
        sellPrice,
        childBestBidNo: child.bestBidNo,
        childBestAskNo: child.bestAskNo,
        parentBestBidNo: parent.bestBidNo,
        parentBestAskNo: parent.bestAskNo,
        timestampMs: child.timestampMs || parent.timestampMs || Date.now(),
      });
    }
  }

  private maybeEmitOpportunity(
    pair: BinaryChillPair,
    context: {
      strategy: BinaryChillStrategy;
      profitAbs: number;
      profitBps: number;
      buyPrice: number;
      sellPrice: number;
      childBestBidYes?: number | null;
      childBestAskYes?: number | null;
      childBestBidNo?: number | null;
      childBestAskNo?: number | null;
      parentBestBidYes?: number | null;
      parentBestAskYes?: number | null;
      parentBestBidNo?: number | null;
      parentBestAskNo?: number | null;
      timestampMs: number;
    },
  ): void {
    const { strategy, profitAbs, profitBps } = context;

    // Check profitability
    const isExecutable =
      profitAbs > 0 &&
      profitBps >= this.minProfitBps &&
      profitAbs >= this.minProfitAbs;

    if (!isExecutable) {
      return;
    }

    // Check cooldown
    const key = `${pair.child.descriptor.marketId}:${pair.parent.descriptor.marketId}:${strategy}`;
    const lastEmitted = this.cooldowns.get(key) || 0;
    const now = Date.now();
    if (now - lastEmitted < this.cooldownMs) {
      return;
    }

    this.cooldowns.set(key, now);

    // Determine which token type is being bought
    const tokenType = this.getTokenType(strategy);

    // Emit opportunity
    const opportunity: ArbOpportunity = {
      groupKey: pair.groupKey,
      eventSlug: pair.eventSlug,
      crypto: pair.crypto,
      strategy,
      tokenType, // Add token type being arbitraged
      parent: {
        descriptor: pair.parent.descriptor,
        bestBid: pair.parent.bestBidYes,
        bestAsk: pair.parent.bestAskYes,
        bestBidSize: pair.parent.bestBidSizeYes ?? 0,
        bestAskSize: pair.parent.bestAskSizeYes ?? 0,
        assetId: pair.parent.yesTokenId,
        marketSlug: pair.parent.marketSlug,
        timestampMs: pair.parent.timestampMs,
        coverage: { startIndex: 0, endIndex: 0 }, // Not applicable for binary chill
      },
      children: [
        {
          descriptor: pair.child.descriptor,
          bestBid: pair.child.bestBidYes,
          bestAsk: pair.child.bestAskYes,
          bestBidSize: pair.child.bestBidSizeYes ?? 0,
          bestAskSize: pair.child.bestAskSizeYes ?? 0,
          assetId: pair.child.yesTokenId,
          marketSlug: pair.child.marketSlug,
          timestampMs: pair.child.timestampMs,
          index: pair.parentIndex,
        },
      ],
      childrenSumAsk: context.buyPrice,
      childrenSumBid: context.sellPrice,
      parentBestBid: context.parentBestBidYes,
      parentBestAsk: context.parentBestAskYes,
      profitAbs,
      profitBps,
      timestampMs: context.timestampMs,
      isExecutable: true,
      // Include full YES/NO context for accurate record keeping
      binaryChillContext: {
        childBestBidYes: context.childBestBidYes ?? undefined,
        childBestAskYes: context.childBestAskYes ?? undefined,
        childBestBidNo: context.childBestBidNo ?? undefined,
        childBestAskNo: context.childBestAskNo ?? undefined,
        childBestBidSizeYes: pair.child.bestBidSizeYes ?? 0,
        childBestAskSizeYes: pair.child.bestAskSizeYes ?? 0,
        childBestBidSizeNo: pair.child.bestBidSizeNo ?? 0,
        childBestAskSizeNo: pair.child.bestAskSizeNo ?? 0,
        parentBestBidYes: context.parentBestBidYes ?? undefined,
        parentBestAskYes: context.parentBestAskYes ?? undefined,
        parentBestBidNo: context.parentBestBidNo ?? undefined,
        parentBestAskNo: context.parentBestAskNo ?? undefined,
        parentBestBidSizeYes: pair.parent.bestBidSizeYes ?? 0,
        parentBestAskSizeYes: pair.parent.bestAskSizeYes ?? 0,
        parentBestBidSizeNo: pair.parent.bestBidSizeNo ?? 0,
        parentBestAskSizeNo: pair.parent.bestAskSizeNo ?? 0,
        childYesTokenId: pair.child.yesTokenId,
        childNoTokenId: pair.child.noTokenId,
        parentYesTokenId: pair.parent.yesTokenId,
        parentNoTokenId: pair.parent.noTokenId,
      },
    };

    this.opportunity$.next(opportunity);

    this.logger.debug(
      `Binary chill opportunity: ${strategy} (${tokenType.toUpperCase()}) | ` +
      `Profit: ${profitAbs.toFixed(4)} (${profitBps.toFixed(2)} bps) | ` +
      `Child: ${pair.child.descriptor.slug} | ` +
      `Parent: ${pair.parent.descriptor.slug}`,
    );
  }

  private toFinite(value: number | undefined): number | null {
    if (value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Determine which token type is being bought in the arbitrage
   * Returns 'yes' or 'no' based on the strategy
   */
  private getTokenType(strategy: BinaryChillStrategy): 'yes' | 'no' {
    switch (strategy) {
      case 'BUY_CHILD_YES_SELL_PARENT_NO':
        return 'yes'; // Buying YES token from child
      case 'BUY_PARENT_NO_SELL_CHILD_YES':
        return 'no'; // Buying NO token from parent
      case 'BUY_CHILD_YES_SELL_PARENT_YES':
        return 'yes'; // Buying YES token from child
      case 'BUY_PARENT_NO_SELL_CHILD_NO':
        return 'no'; // Buying NO token from parent
      default:
        return 'yes'; // Default fallback
    }
  }
}

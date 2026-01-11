import { MarketRangeDescriptor } from './range-group.interface';

export type ArbStrategy =
  | 'SELL_PARENT_BUY_CHILDREN'
  | 'BUY_PARENT_SELL_CHILDREN'
  // Case 1: Child <X vs Parent >X (complement)
  | 'BUY_CHILD_YES_SELL_PARENT_NO'
  | 'BUY_PARENT_NO_SELL_CHILD_YES'
  // Case 2: Child >X vs Parent >X (same direction)
  | 'BUY_CHILD_YES_SELL_PARENT_YES'
  | 'BUY_PARENT_NO_SELL_CHILD_NO'
  // Triangular polymarket combo: YES lower + NO upper + NO range
  | 'POLYMARKET_TRIANGLE'
  | 'POLYMARKET_TRIANGLE_BUY'
  | 'POLYMARKET_TRIANGLE_SELL';

export type BinaryChillStrategy =
  // Case 1: Child <X vs Parent >X (complement)
  | 'BUY_CHILD_YES_SELL_PARENT_NO'
  | 'BUY_PARENT_NO_SELL_CHILD_YES'
  // Case 2: Child >X vs Parent >X (same direction)
  | 'BUY_CHILD_YES_SELL_PARENT_YES'
  | 'BUY_PARENT_NO_SELL_CHILD_NO';

export interface RangeCoverage {
  startIndex: number;
  endIndex: number;
}

export interface MarketSnapshot {
  descriptor: MarketRangeDescriptor;
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number; // Size available at best bid
  bestAskSize?: number; // Size available at best ask
  assetId?: string;
  marketSlug?: string;
  timestampMs?: number;
}

export interface BinaryChillSnapshot {
  descriptor: MarketRangeDescriptor;
  // YES token (index 0)
  yesTokenId?: string;
  bestBidYes?: number;
  bestAskYes?: number;
  bestBidSizeYes?: number;
  bestAskSizeYes?: number;
  // NO token (index 1)
  noTokenId?: string;
  bestBidNo?: number;
  bestAskNo?: number;
  bestBidSizeNo?: number;
  bestAskSizeNo?: number;
  // Metadata
  assetId?: string; // Backward compatibility - points to YES token
  bestBid?: number; // Backward compatibility - YES bid
  bestAsk?: number; // Backward compatibility - YES ask
  marketSlug?: string;
  timestampMs?: number;
  parentIndex: number;
  strategy: BinaryChillStrategy;
}

export interface ArbOpportunity {
  groupKey: string;
  eventSlug?: string;
  crypto?: string;
  strategy: ArbStrategy;
  parent: MarketSnapshot & { coverage: RangeCoverage };
  parentUpper?: MarketSnapshot; // Parent cận trên (cho 2-chiều arbitrage)
  children: Array<MarketSnapshot & { index: number }>;
  childrenSumAsk: number;
  childrenSumBid: number;
  parentBestBid?: number;
  parentBestAsk?: number;
  parentUpperBestBid?: number; // Best bid của parent upper
  parentUpperBestAsk?: number; // Best ask của parent upper
  profitAbs: number;
  profitBps: number;
  timestampMs: number;
  isExecutable: boolean;
  reason?: string;
  // Token type being arbitraged (for binary markets)
  tokenType?: 'yes' | 'no';
  // Binary chill specific context (includes full YES/NO data)
  binaryChillContext?: {
    childBestBidYes?: number;
    childBestAskYes?: number;
    childBestBidNo?: number;
    childBestAskNo?: number;
    childBestBidSizeYes?: number;
    childBestAskSizeYes?: number;
    childBestBidSizeNo?: number;
    childBestAskSizeNo?: number;
    parentBestBidYes?: number;
    parentBestAskYes?: number;
    parentBestBidNo?: number;
    parentBestAskNo?: number;
    parentBestBidSizeYes?: number;
    parentBestAskSizeYes?: number;
    parentBestBidSizeNo?: number;
    parentBestAskSizeNo?: number;
    childYesTokenId?: string;
    childNoTokenId?: string;
    parentYesTokenId?: string;
    parentNoTokenId?: string;
  };
  // Polymarket triangle (YES lower + NO upper + NO range)
  polymarketTriangleContext?: {
    parentLowerYesAsk?: number;
    parentLowerYesBid?: number;
    parentUpperNoAsk?: number;
    parentUpperNoBid?: number;
    rangeNoAsk?: number;
    rangeNoBid?: number;
    totalCost?: number;
    totalBid?: number;
    payout?: number;
    mode?: 'BUY' | 'SELL';
    rangesCount?: number;
  };
}

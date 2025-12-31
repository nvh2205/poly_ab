import { MarketRangeDescriptor } from './range-group.interface';

export type ArbStrategy =
  | 'SELL_PARENT_BUY_CHILDREN'
  | 'BUY_PARENT_SELL_CHILDREN';

export interface RangeCoverage {
  startIndex: number;
  endIndex: number;
}

export interface MarketSnapshot {
  descriptor: MarketRangeDescriptor;
  bestBid?: number;
  bestAsk?: number;
  assetId?: string;
  marketSlug?: string;
  timestampMs?: number;
}

export interface ArbOpportunity {
  groupKey: string;
  eventSlug?: string;
  crypto?: string;
  strategy: ArbStrategy;
  parent: MarketSnapshot & { coverage: RangeCoverage };
  children: Array<MarketSnapshot & { index: number }>;
  childrenSumAsk: number;
  childrenSumBid: number;
  parentBestBid?: number;
  parentBestAsk?: number;
  profitAbs: number;
  profitBps: number;
  timestampMs: number;
  isExecutable: boolean;
  reason?: string;
}


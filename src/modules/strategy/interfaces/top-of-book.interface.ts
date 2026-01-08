export interface TopOfBookUpdate {
  assetId: string;
  marketHash: string;
  /**
   * Optional identifiers resolved from metadata/DB for grouping.
   */
  marketId?: string;
  marketSlug?: string;
  eventSlug?: string;
  bestBid: number;
  bestAsk: number;
  bestBidSize?: number; // Size available at best bid
  bestAskSize?: number; // Size available at best ask
  midPrice?: number;
  spread?: number;
  lastPrice?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
  /**
   * Unix timestamp in milliseconds.
   */
  timestampMs: number;
  /**
   * Raw message for downstream audit/debugging.
   */
  raw?: any;
}


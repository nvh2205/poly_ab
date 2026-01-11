export type RangeKind = 'range' | 'above' | 'below' | 'unknown';

export interface RangeBoundary {
  lower?: number;
  upper?: number;
}

export interface MarketRangeDescriptor {
  marketId: string;
  slug: string;
  question: string;
  clobTokenIds: string[];
  type?: string;
  eventSlug?: string;
  eventId?: string;
  bounds: RangeBoundary;
  kind: RangeKind;
  label?: string;
  parsedFrom?: 'question' | 'slug' | 'override';
  role: 'parent' | 'child' | 'unknown';
}

export interface RangeGroup {
  groupKey: string;
  eventSlug?: string;
  eventId?: string;
  crypto?: string;
  step?: number;
  children: MarketRangeDescriptor[];
  parents: MarketRangeDescriptor[];
  unmatched: MarketRangeDescriptor[];
  overridesApplied: string[];
}

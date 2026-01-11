import { RangeKind } from '../interfaces/range-group.interface';

export interface RangeOverrideRule {
  /**
   * Exact slug match.
   */
  matchSlug?: string;
  /**
   * Substring(s) that should appear in the slug.
   */
  slugContains?: string | string[];
  /**
   * Substring(s) that should appear in the question text.
   */
  questionContains?: string | string[];
  lower?: number;
  upper?: number;
  kind?: RangeKind;
  role?: 'parent' | 'child';
  label?: string;
}

export interface RangeGroupOverride {
  step?: number;
  crypto?: string;
  rules?: RangeOverrideRule[];
}

/**
 * Manual overrides for tricky markets. Keep it empty by default.
 * Example:
 * 'bitcoin-price-on-december-29': {
 *   crypto: 'btc',
 *   step: 2000,
 *   rules: [
 *     { slugContains: 'above', role: 'parent', lower: 90000, kind: 'above' },
 *     { slugContains: '88-90', role: 'child', lower: 88000, upper: 90000, kind: 'range' },
 *   ],
 * }
 */
export const RANGE_GROUP_OVERRIDES: Record<string, RangeGroupOverride> = {};

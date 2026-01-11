/**
 * Test for Binary Chill Arbitrage Logic
 *
 * This test verifies the logic for the two special cases of binary market arbitrage:
 * 1. Case 1: Child <X vs Parent >X (complement markets)
 * 2. Case 2: Child >X vs Parent >X (same direction markets)
 */

import { describe, it, expect } from '@jest/globals';

describe('Binary Chill Arbitrage Logic', () => {
  describe('Case 1: Complement Markets (Child <78k vs Parent >78k)', () => {
    // In this case: YES(<78k) = NO(>78k) probabilistically
    // Because: P(price < 78k) + P(price >= 78k) = 1

    it('should calculate correct profit for BUY_CHILD_YES_SELL_PARENT_NO', () => {
      // Example: Child <78k has Ask_YES = 0.3
      // Parent >78k has Ask_YES = 0.65
      // So: Bid_NO(parent) = 1 - 0.65 = 0.35

      const childAskYes = 0.3;
      const parentAskYes = 0.65;
      const parentBidNo = 1 - parentAskYes;

      const buyPrice = childAskYes;
      const sellPrice = parentBidNo;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = (profitAbs / buyPrice) * 10_000;

      expect(profitAbs).toBeCloseTo(0.05, 4);
      expect(profitBps).toBeCloseTo(166.67, 2);
      expect(profitAbs).toBeGreaterThan(0);
    });

    it('should calculate correct profit for BUY_PARENT_NO_SELL_CHILD_YES', () => {
      // Example: Child <78k has Bid_YES = 0.35
      // Parent >78k has Bid_YES = 0.7
      // So: Ask_NO(parent) = 1 - 0.7 = 0.3

      const childBidYes = 0.35;
      const parentBidYes = 0.7;
      const parentAskNo = 1 - parentBidYes;

      const buyPrice = parentAskNo;
      const sellPrice = childBidYes;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = (profitAbs / buyPrice) * 10_000;

      expect(profitAbs).toBeCloseTo(0.05, 4);
      expect(profitBps).toBeCloseTo(166.67, 2);
      expect(profitAbs).toBeGreaterThan(0);
    });

    it('should have no arbitrage when markets are fairly priced', () => {
      // Fair pricing: Ask_YES(child) + Ask_YES(parent) = 1
      const childAskYes = 0.35;
      const parentAskYes = 0.65; // 0.35 + 0.65 = 1.0
      const parentBidNo = 1 - parentAskYes;

      const buyPrice = childAskYes;
      const sellPrice = parentBidNo;
      const profitAbs = sellPrice - buyPrice;

      expect(profitAbs).toBeCloseTo(0, 4);
    });
  });

  describe('Case 2: Same Direction Markets (Child >96k vs Parent >96k)', () => {
    // In this case: YES(>96k child) = YES(>96k parent)
    // They represent the same outcome

    it('should calculate correct profit for BUY_CHILD_YES_SELL_PARENT_YES', () => {
      // Example: Child >96k has Ask_YES = 0.1
      // Parent >96k has Bid_YES = 0.12

      const childAskYes = 0.1;
      const parentBidYes = 0.12;

      const buyPrice = childAskYes;
      const sellPrice = parentBidYes;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = (profitAbs / buyPrice) * 10_000;

      expect(profitAbs).toBeCloseTo(0.02, 4);
      expect(profitBps).toBeCloseTo(200, 2);
      expect(profitAbs).toBeGreaterThan(0);
    });

    it('should calculate correct profit for BUY_PARENT_NO_SELL_CHILD_NO', () => {
      // Example: Child >96k has Ask_YES = 0.08
      // Parent >96k has Bid_YES = 0.1
      // So: Ask_NO(parent) = 1 - 0.1 = 0.9
      // And: Bid_NO(child) = 1 - 0.08 = 0.92

      const childAskYes = 0.08;
      const parentBidYes = 0.1;
      const parentAskNo = 1 - parentBidYes;
      const childBidNo = 1 - childAskYes;

      const buyPrice = parentAskNo;
      const sellPrice = childBidNo;
      const profitAbs = sellPrice - buyPrice;
      const profitBps = (profitAbs / buyPrice) * 10_000;

      expect(profitAbs).toBeCloseTo(0.02, 4);
      expect(profitBps).toBeCloseTo(22.22, 2);
      expect(profitAbs).toBeGreaterThan(0);
    });

    it('should have no arbitrage when markets are perfectly aligned', () => {
      // Perfect alignment: Ask(child) = Bid(parent)
      const childAskYes = 0.1;
      const parentBidYes = 0.1;

      const buyPrice = childAskYes;
      const sellPrice = parentBidYes;
      const profitAbs = sellPrice - buyPrice;

      expect(profitAbs).toBeCloseTo(0, 4);
    });
  });

  describe('Edge Cases', () => {
    it('should handle extreme prices correctly', () => {
      // Child very cheap (0.01), Parent very expensive (0.99)
      const childAskYes = 0.01;
      const parentAskYes = 0.99;
      const parentBidNo = 1 - parentAskYes;

      const profitAbs = parentBidNo - childAskYes;

      expect(profitAbs).toBeCloseTo(0, 4); // 0.01 - 0.01 = 0
    });

    it('should detect arbitrage when spread is wide', () => {
      // Wide spread opportunity
      const childAskYes = 0.25;
      const parentAskYes = 0.7; // Mispriced!
      const parentBidNo = 1 - parentAskYes;

      const profitAbs = parentBidNo - childAskYes;
      const profitBps = (profitAbs / childAskYes) * 10_000;

      expect(profitAbs).toBeCloseTo(0.05, 4);
      expect(profitBps).toBeCloseTo(200, 2);
    });
  });

  describe('Binary Market Price Relationship', () => {
    it('should verify that YES + NO prices sum to approximately 1', () => {
      // In theory: price_YES + price_NO = 1
      // In practice: there may be small spreads

      const priceYes = 0.65;
      const priceNo = 1 - priceYes;

      expect(priceYes + priceNo).toBeCloseTo(1.0, 10);
    });

    it('should verify bid/ask relationship', () => {
      // Bid_NO = 1 - Ask_YES
      // Ask_NO = 1 - Bid_YES

      const bidYes = 0.6;
      const askYes = 0.65;

      const askNo = 1 - bidYes; // 0.4
      const bidNo = 1 - askYes; // 0.35

      expect(askNo).toBeCloseTo(0.4, 4);
      expect(bidNo).toBeCloseTo(0.35, 4);
      expect(bidNo).toBeLessThan(askNo); // Bid always < Ask
    });
  });
});

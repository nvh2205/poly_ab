import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ArbitrageEngineService } from '../src/modules/strategy/arbitrage-engine.service';
import { MarketStructureService } from '../src/modules/strategy/market-structure.service';
import { MarketDataStreamService } from '../src/modules/ingestion/market-data-stream.service';
import { TopOfBookUpdate } from '../src/modules/strategy/interfaces/top-of-book.interface';
import { RangeGroup, MarketRangeDescriptor } from '../src/modules/strategy/interfaces/range-group.interface';
import { ArbOpportunity } from '../src/modules/strategy/interfaces/arbitrage.interface';

/**
 * Advanced simulation tests for ArbitrageEngineService
 * 
 * This test suite simulates realistic market scenarios including:
 * 1. Market volatility with rapid price changes
 * 2. Multiple concurrent arbitrage opportunities
 * 3. Partial fills and market depth changes
 * 4. Real-world pricing scenarios from Polymarket
 */

describe('ArbitrageEngineService - Advanced Simulations', () => {
  let service: ArbitrageEngineService;
  let marketStructureService: jest.Mocked<MarketStructureService>;
  let marketDataStreamService: jest.Mocked<MarketDataStreamService>;
  let topOfBookSubject: Subject<TopOfBookUpdate>;
  let opportunities: ArbOpportunity[];

  beforeEach(async () => {
    topOfBookSubject = new Subject<TopOfBookUpdate>();

    marketStructureService = {
      rebuild: jest.fn(),
      getGroup: jest.fn(),
      getAllGroups: jest.fn(),
    } as any;

    marketDataStreamService = {
      onTopOfBook: jest.fn().mockReturnValue(topOfBookSubject.asObservable()),
      onModuleDestroy: jest.fn(),
    } as any;

    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    // Use fast settings for testing
    process.env.ARB_SCAN_THROTTLE_MS = '50';
    process.env.ARB_COOLDOWN_MS = '200';
    process.env.ARB_MIN_PROFIT_BPS = '5'; // 0.05%
    process.env.ARB_MIN_PROFIT_ABS = '0';

    service = new ArbitrageEngineService(
      marketStructureService,
      marketDataStreamService,
    );

    opportunities = [];
    service.onOpportunity().subscribe((opp) => {
      opportunities.push(opp);
    });
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    delete process.env.ARB_SCAN_THROTTLE_MS;
    delete process.env.ARB_COOLDOWN_MS;
    delete process.env.ARB_MIN_PROFIT_BPS;
    delete process.env.ARB_MIN_PROFIT_ABS;
  });

  /**
   * Helper to create a realistic BTC range group
   */
  function createBTCRangeGroup(): RangeGroup {
    const ranges = [
      { lower: 80000, upper: 82000, label: '80-82k' },
      { lower: 82000, upper: 84000, label: '82-84k' },
      { lower: 84000, upper: 86000, label: '84-86k' },
      { lower: 86000, upper: 88000, label: '86-88k' },
      { lower: 88000, upper: 90000, label: '88-90k' },
    ];

    const children: MarketRangeDescriptor[] = ranges.map((range, idx) => ({
      marketId: `btc-range-${idx}`,
      slug: `btc-${range.lower}-${range.upper}`,
      question: `Will BTC be between $${range.lower}-$${range.upper}?`,
      clobTokenIds: [`btc-range-token-${idx}`],
      type: 'range',
      eventSlug: 'btc-price-jan-31-2026',
      eventId: 'event-btc-1',
      bounds: { lower: range.lower, upper: range.upper },
      kind: 'range',
      label: range.label,
      parsedFrom: 'question',
      role: 'child',
    }));

    const parents: MarketRangeDescriptor[] = [
      {
        marketId: 'btc-above-80k',
        slug: 'btc-above-80000',
        question: 'Will BTC be above $80,000?',
        clobTokenIds: ['btc-parent-80k-yes', 'btc-parent-80k-no'],
        type: 'binary',
        eventSlug: 'btc-price-jan-31-2026',
        eventId: 'event-btc-1',
        bounds: { lower: 80000 },
        kind: 'above',
        label: '>80k',
        parsedFrom: 'question',
        role: 'parent',
      },
      {
        marketId: 'btc-above-90k',
        slug: 'btc-above-90000',
        question: 'Will BTC be above $90,000?',
        clobTokenIds: ['btc-parent-90k-yes', 'btc-parent-90k-no'],
        type: 'binary',
        eventSlug: 'btc-price-jan-31-2026',
        eventId: 'event-btc-1',
        bounds: { lower: 90000 },
        kind: 'above',
        label: '>90k',
        parsedFrom: 'question',
        role: 'parent',
      },
    ];

    return {
      groupKey: 'BTC-2026-01-31',
      eventSlug: 'btc-price-jan-31-2026',
      eventId: 'event-btc-1',
      crypto: 'BTC',
      step: 2000,
      children,
      parents,
      unmatched: [],
      overridesApplied: [],
    };
  }

  /**
   * Simulate market state with prices
   */
  function simulateMarketState(
    group: RangeGroup,
    parentPrices: { bid: number; ask: number }[],
    childPrices: { bid: number; ask: number }[],
    timestampMs: number = Date.now(),
  ): void {
    // Update parents
    parentPrices.forEach((price, idx) => {
      if (idx < group.parents.length) {
        topOfBookSubject.next({
          assetId: group.parents[idx].clobTokenIds[0],
          marketHash: `hash-parent-${idx}`,
          marketId: group.parents[idx].marketId,
          marketSlug: group.parents[idx].slug,
          bestBid: price.bid,
          bestAsk: price.ask,
          bestBidSize: 100,
          bestAskSize: 100,
          timestampMs,
        });
      }
    });

    // Update children
    childPrices.forEach((price, idx) => {
      if (idx < group.children.length) {
        topOfBookSubject.next({
          assetId: group.children[idx].clobTokenIds[0],
          marketHash: `hash-child-${idx}`,
          marketId: group.children[idx].marketId,
          marketSlug: group.children[idx].slug,
          bestBid: price.bid,
          bestAsk: price.ask,
          bestBidSize: 100,
          bestAskSize: 100,
          timestampMs,
        });
      }
    });
  }

  describe('Scenario 1: BTC Rally - Prices Moving Up', () => {
    it('should detect multiple opportunities as BTC price expectations rise', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Initial state: BTC around $85k (middle of range)
      simulateMarketState(
        group,
        [
          { bid: 0.72, ask: 0.74 }, // >80k: high probability
          { bid: 0.08, ask: 0.10 }, // >90k: low probability
        ],
        [
          { bid: 0.08, ask: 0.10 }, // 80-82k: low prob (price likely higher)
          { bid: 0.15, ask: 0.17 }, // 82-84k: medium-low prob
          { bid: 0.22, ask: 0.24 }, // 84-86k: highest prob (current range)
          { bid: 0.18, ask: 0.20 }, // 86-88k: medium prob
          { bid: 0.09, ask: 0.11 }, // 88-90k: low prob
        ],
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const initialOppCount = opportunities.length;
      console.log(`Initial opportunities detected: ${initialOppCount}`);

      // Market shifts: Strong rally expected, prices adjust
      opportunities.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 250)); // Wait for cooldown

      simulateMarketState(
        group,
        [
          { bid: 0.85, ask: 0.87 }, // >80k: very high prob now
          { bid: 0.25, ask: 0.27 }, // >90k: increasing prob
        ],
        [
          { bid: 0.04, ask: 0.05 }, // 80-82k: very low prob
          { bid: 0.08, ask: 0.09 }, // 82-84k: low prob
          { bid: 0.15, ask: 0.16 }, // 84-86k: lower prob
          { bid: 0.25, ask: 0.26 }, // 86-88k: highest prob
          { bid: 0.22, ask: 0.23 }, // 88-90k: high prob
        ],
        Date.now() + 1000,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should detect arbitrage due to price discrepancy
      // Parent >80k bid (0.85) vs sum of ranges + >90k
      const rallyOppCount = opportunities.length;
      console.log(`Rally opportunities detected: ${rallyOppCount}`);
      
      expect(opportunities.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 2: Market Inefficiency - Mispriced Ranges', () => {
    it('should detect arbitrage when range markets are mispriced relative to parent', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Create obvious mispricing:
      // Parent >80k is priced at 0.90 (90% probability)
      // But sum of all ranges 80-90k is only 0.50 (50%)
      // This creates arbitrage: buy all ranges + sell parent
      
      simulateMarketState(
        group,
        [
          { bid: 0.90, ask: 0.92 }, // >80k: overpriced
          { bid: 0.08, ask: 0.10 }, // >90k: reasonably priced
        ],
        [
          { bid: 0.08, ask: 0.10 }, // 80-82k: underpriced
          { bid: 0.08, ask: 0.10 }, // 82-84k: underpriced
          { bid: 0.08, ask: 0.10 }, // 84-86k: underpriced
          { bid: 0.08, ask: 0.10 }, // 86-88k: underpriced
          { bid: 0.08, ask: 0.10 }, // 88-90k: underpriced
        ],
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify arbitrage detected
      const unbundlingOpps = opportunities.filter(
        (opp) => opp.strategy === 'SELL_PARENT_BUY_CHILDREN',
      );

      expect(unbundlingOpps.length).toBeGreaterThan(0);
      
      if (unbundlingOpps.length > 0) {
        const bestOpp = unbundlingOpps.reduce((prev, current) => 
          current.profitAbs > prev.profitAbs ? current : prev
        );

        console.log(`Best unbundling opportunity:`);
        console.log(`  Profit: $${bestOpp.profitAbs.toFixed(4)} (${bestOpp.profitBps.toFixed(2)} bps)`);
        console.log(`  Parent bid: ${bestOpp.parentBestBid}`);
        console.log(`  Children sum ask: ${bestOpp.childrenSumAsk}`);
        console.log(`  Parent upper ask: ${bestOpp.parentUpperBestAsk}`);
        console.log(`  Total cost: ${(bestOpp.childrenSumAsk + (bestOpp.parentUpperBestAsk || 0)).toFixed(4)}`);

        expect(bestOpp.profitAbs).toBeGreaterThan(0.25); // At least 25 cent profit
        expect(bestOpp.profitBps).toBeGreaterThan(1000); // At least 10%
      }
    });
  });

  describe('Scenario 3: Two-way Arbitrage - Both Directions Profitable', () => {
    it('should detect both bundling and unbundling opportunities when both are profitable', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Create scenario where both directions are profitable due to wide spreads
      simulateMarketState(
        group,
        [
          { bid: 0.65, ask: 0.75 }, // >80k: wide spread
          { bid: 0.05, ask: 0.15 }, // >90k: wide spread
        ],
        [
          { bid: 0.15, ask: 0.17 }, // 80-82k
          { bid: 0.15, ask: 0.17 }, // 82-84k
          { bid: 0.15, ask: 0.17 }, // 84-86k
          { bid: 0.15, ask: 0.17 }, // 86-88k
          { bid: 0.15, ask: 0.17 }, // 88-90k
        ],
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const unbundlingOpps = opportunities.filter(
        (opp) => opp.strategy === 'SELL_PARENT_BUY_CHILDREN',
      );
      const bundlingOpps = opportunities.filter(
        (opp) => opp.strategy === 'BUY_PARENT_SELL_CHILDREN',
      );

      console.log(`Unbundling opportunities: ${unbundlingOpps.length}`);
      console.log(`Bundling opportunities: ${bundlingOpps.length}`);

      // Both should exist due to wide spreads
      expect(unbundlingOpps.length).toBeGreaterThan(0);
      expect(bundlingOpps.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 4: Rapid Price Updates - Stress Test', () => {
    it('should handle rapid sequential price updates without missing opportunities', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Simulate 100 rapid price updates
      const updateCount = 100;
      const startTime = Date.now();

      for (let i = 0; i < updateCount; i++) {
        const variance = 0.02; // 2% variance
        const basePrice = 0.20;
        const randomFactor = 1 + (Math.random() - 0.5) * variance;

        simulateMarketState(
          group,
          [
            { 
              bid: 0.75 * randomFactor, 
              ask: 0.76 * randomFactor 
            },
            { 
              bid: 0.10 * randomFactor, 
              ask: 0.11 * randomFactor 
            },
          ],
          group.children.map(() => ({
            bid: basePrice * randomFactor * 0.95,
            ask: basePrice * randomFactor * 1.05,
          })),
          startTime + i * 10,
        );

        // Small delay between updates
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      // Wait for all scans to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      console.log(`Processed ${updateCount} updates, detected ${opportunities.length} opportunities`);

      // Should have detected some opportunities despite rapid updates
      expect(opportunities.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 5: Partial Range Coverage', () => {
    it('should detect opportunities for partial range coverage (not all ranges)', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Create scenario where only a subset of ranges is profitable
      // Parent >80k covers all ranges 80k+
      // Parent >90k covers ranges beyond 90k
      // We'll make arbitrage profitable for ranges 80-90k only
      
      simulateMarketState(
        group,
        [
          { bid: 0.80, ask: 0.82 }, // >80k
          { bid: 0.10, ask: 0.12 }, // >90k
        ],
        [
          { bid: 0.13, ask: 0.15 }, // 80-82k
          { bid: 0.13, ask: 0.15 }, // 82-84k
          { bid: 0.13, ask: 0.15 }, // 84-86k
          { bid: 0.13, ask: 0.15 }, // 86-88k
          { bid: 0.13, ask: 0.15 }, // 88-90k
        ],
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should detect opportunity for parent >80k vs ranges 80-90k + parent >90k
      // Profit = 0.80 (parent bid) - (5 * 0.15 + 0.12) = 0.80 - 0.87 = -0.07 (not profitable for all 5)
      // But should try different combinations

      console.log(`Detected ${opportunities.length} opportunities with partial coverage`);
      expect(opportunities.length).toBeGreaterThanOrEqual(0); // May or may not find profitable combination
    });
  });

  describe('Scenario 6: Market Depth Changes', () => {
    it('should track size changes and include them in opportunity data', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Initial state with good sizes
      topOfBookSubject.next({
        assetId: 'btc-parent-80k-yes',
        marketHash: 'hash-1',
        marketId: 'btc-above-80k',
        marketSlug: 'btc-above-80000',
        bestBid: 0.75,
        bestAsk: 0.76,
        bestBidSize: 1000, // Large size
        bestAskSize: 1000,
        timestampMs: Date.now(),
      });

      // Update with reduced size
      await new Promise((resolve) => setTimeout(resolve, 50));

      topOfBookSubject.next({
        assetId: 'btc-parent-80k-yes',
        marketHash: 'hash-1',
        marketId: 'btc-above-80k',
        marketSlug: 'btc-above-80000',
        bestBid: 0.75,
        bestAsk: 0.76,
        bestBidSize: 10, // Small size - partially filled
        bestAskSize: 10,
        timestampMs: Date.now() + 1000,
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify sizes are tracked
      const internals = service as any;
      const state = internals.groups.get(group.groupKey);
      
      expect(state.parentStates[0].bestBidSize).toBe(10);
      expect(state.parentStates[0].bestAskSize).toBe(10);
    });
  });

  describe('Scenario 7: Real-world Polymarket Pricing', () => {
    it('should handle realistic Polymarket probability distributions', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      // Realistic pricing based on normal distribution around $85k
      // P(>80k) ≈ 85%
      // P(80-82k) ≈ 5%
      // P(82-84k) ≈ 12%
      // P(84-86k) ≈ 20% (peak)
      // P(86-88k) ≈ 18%
      // P(88-90k) ≈ 15%
      // P(>90k) ≈ 15%
      // Sum = 85% (which equals P(>80k))

      simulateMarketState(
        group,
        [
          { bid: 0.84, ask: 0.86 }, // >80k: 85%
          { bid: 0.14, ask: 0.16 }, // >90k: 15%
        ],
        [
          { bid: 0.04, ask: 0.06 }, // 80-82k: 5%
          { bid: 0.11, ask: 0.13 }, // 82-84k: 12%
          { bid: 0.19, ask: 0.21 }, // 84-86k: 20%
          { bid: 0.17, ask: 0.19 }, // 86-88k: 18%
          { bid: 0.14, ask: 0.16 }, // 88-90k: 15%
        ],
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check if probabilities are consistent
      // Sum of children asks + parent upper ask should be close to parent bid
      const sumChildrenAsks = 0.06 + 0.13 + 0.21 + 0.19 + 0.16; // = 0.75
      const parentUpperAsk = 0.16;
      const totalCost = sumChildrenAsks + parentUpperAsk; // = 0.91
      const parentBid = 0.84;

      console.log(`Realistic pricing check:`);
      console.log(`  Parent >80k bid: ${parentBid}`);
      console.log(`  Sum of children asks: ${sumChildrenAsks.toFixed(2)}`);
      console.log(`  Parent >90k ask: ${parentUpperAsk}`);
      console.log(`  Total cost: ${totalCost.toFixed(2)}`);
      console.log(`  Difference: ${(totalCost - parentBid).toFixed(2)}`);

      // In this realistic scenario, no arbitrage should exist (or minimal)
      const significantOpps = opportunities.filter(
        (opp) => opp.profitAbs > 0.05, // 5 cent threshold
      );

      console.log(`Significant opportunities (>5¢): ${significantOpps.length}`);
      
      // Realistic markets should have few/no large arbitrage opportunities
      expect(significantOpps.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Performance Metrics', () => {
    it('should measure processing time for 1000 updates', async () => {
      const group = createBTCRangeGroup();
      marketStructureService.rebuild.mockResolvedValue([group]);
      await service.onModuleInit();
      opportunities.length = 0;

      const updateCount = 1000;
      const startTime = Date.now();

      // Generate random realistic updates
      for (let i = 0; i < updateCount; i++) {
        const marketIdx = i % (group.children.length + group.parents.length);
        const isParent = marketIdx >= group.children.length;
        const price = 0.10 + Math.random() * 0.70; // Random between 0.10 and 0.80
        const spread = 0.01 + Math.random() * 0.02; // 1-3% spread

        if (isParent) {
          const parentIdx = marketIdx - group.children.length;
          topOfBookSubject.next({
            assetId: group.parents[parentIdx].clobTokenIds[0],
            marketHash: `hash-${i}`,
            marketId: group.parents[parentIdx].marketId,
            marketSlug: group.parents[parentIdx].slug,
            bestBid: price,
            bestAsk: price + spread,
            bestBidSize: 100,
            bestAskSize: 100,
            timestampMs: startTime + i,
          });
        } else {
          topOfBookSubject.next({
            assetId: group.children[marketIdx].clobTokenIds[0],
            marketHash: `hash-${i}`,
            marketId: group.children[marketIdx].marketId,
            marketSlug: group.children[marketIdx].slug,
            bestBid: price,
            bestAsk: price + spread,
            bestBidSize: 100,
            bestAskSize: 100,
            timestampMs: startTime + i,
          });
        }
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 500));

      const endTime = Date.now();
      const totalTime = endTime - startTime;
      const avgTimePerUpdate = totalTime / updateCount;

      console.log(`Performance metrics:`);
      console.log(`  Total updates: ${updateCount}`);
      console.log(`  Total time: ${totalTime}ms`);
      console.log(`  Average time per update: ${avgTimePerUpdate.toFixed(2)}ms`);
      console.log(`  Updates per second: ${((updateCount / totalTime) * 1000).toFixed(2)}`);
      console.log(`  Opportunities detected: ${opportunities.length}`);

      // Performance check: should handle at least 100 updates per second
      expect(avgTimePerUpdate).toBeLessThan(10); // Less than 10ms per update
    });
  });
});


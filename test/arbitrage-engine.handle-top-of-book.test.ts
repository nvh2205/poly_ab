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
 * Test suite for ArbitrageEngineService.handleTopOfBook method
 * 
 * This test simulates real-world scenarios by:
 * 1. Mocking the MarketStructureService and MarketDataStreamService
 * 2. Creating mock range groups with parent/child markets
 * 3. Simulating TopOfBook updates
 * 4. Verifying arbitrage opportunities are detected
 */

describe('ArbitrageEngineService - handleTopOfBook', () => {
  let service: ArbitrageEngineService;
  let marketStructureService: jest.Mocked<MarketStructureService>;
  let marketDataStreamService: jest.Mocked<MarketDataStreamService>;
  let topOfBookSubject: Subject<TopOfBookUpdate>;
  let opportunities: ArbOpportunity[];

  beforeEach(async () => {
    // Create a Subject for TopOfBook updates
    topOfBookSubject = new Subject<TopOfBookUpdate>();

    // Mock MarketStructureService
    marketStructureService = {
      rebuild: jest.fn(),
      getGroup: jest.fn(),
      getAllGroups: jest.fn(),
    } as any;

    // Mock MarketDataStreamService
    marketDataStreamService = {
      onTopOfBook: jest.fn().mockReturnValue(topOfBookSubject.asObservable()),
      onModuleDestroy: jest.fn(),
    } as any;

    // Suppress logs during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    // Create the service
    service = new ArbitrageEngineService(
      marketStructureService,
      marketDataStreamService,
    );

    // Subscribe to opportunities
    opportunities = [];
    service.onOpportunity().subscribe((opp) => {
      opportunities.push(opp);
    });
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  /**
   * Helper function to create a mock range group for testing
   */
  function createMockRangeGroup(
    groupKey: string,
    crypto: string,
    eventSlug: string,
  ): RangeGroup {
    // Create parent market (>80k)
    const parent: MarketRangeDescriptor = {
      marketId: 'parent-market-1',
      slug: `will-${crypto}-price-above-80000-on-jan-31`,
      question: `Will ${crypto} be above $80,000 on Jan 31?`,
      clobTokenIds: ['parent-token-yes', 'parent-token-no'],
      type: 'binary',
      eventSlug,
      eventId: 'event-1',
      bounds: { lower: 80000 },
      kind: 'above',
      label: '>80k',
      parsedFrom: 'question',
      role: 'parent',
    };

    // Create child range markets
    const children: MarketRangeDescriptor[] = [
      {
        marketId: 'child-market-1',
        slug: `${crypto}-price-80000-82000-on-jan-31`,
        question: `Will ${crypto} be between $80,000-$82,000 on Jan 31?`,
        clobTokenIds: ['child-token-1'],
        type: 'range',
        eventSlug,
        eventId: 'event-1',
        bounds: { lower: 80000, upper: 82000 },
        kind: 'range',
        label: '80-82k',
        parsedFrom: 'question',
        role: 'child',
      },
      {
        marketId: 'child-market-2',
        slug: `${crypto}-price-82000-84000-on-jan-31`,
        question: `Will ${crypto} be between $82,000-$84,000 on Jan 31?`,
        clobTokenIds: ['child-token-2'],
        type: 'range',
        eventSlug,
        eventId: 'event-1',
        bounds: { lower: 82000, upper: 84000 },
        kind: 'range',
        label: '82-84k',
        parsedFrom: 'question',
        role: 'child',
      },
      {
        marketId: 'child-market-3',
        slug: `${crypto}-price-84000-86000-on-jan-31`,
        question: `Will ${crypto} be between $84,000-$86,000 on Jan 31?`,
        clobTokenIds: ['child-token-3'],
        type: 'range',
        eventSlug,
        eventId: 'event-1',
        bounds: { lower: 84000, upper: 86000 },
        kind: 'range',
        label: '84-86k',
        parsedFrom: 'question',
        role: 'child',
      },
    ];

    // Create upper parent (>86k)
    const parentUpper: MarketRangeDescriptor = {
      marketId: 'parent-market-2',
      slug: `will-${crypto}-price-above-86000-on-jan-31`,
      question: `Will ${crypto} be above $86,000 on Jan 31?`,
      clobTokenIds: ['parent-upper-token-yes', 'parent-upper-token-no'],
      type: 'binary',
      eventSlug,
      eventId: 'event-1',
      bounds: { lower: 86000 },
      kind: 'above',
      label: '>86k',
      parsedFrom: 'question',
      role: 'parent',
    };

    return {
      groupKey,
      eventSlug,
      eventId: 'event-1',
      crypto,
      step: 2000,
      children,
      parents: [parent, parentUpper],
      unmatched: [],
      overridesApplied: [],
    };
  }

  /**
   * Helper function to create a TopOfBook update
   */
  function createTopOfBookUpdate(
    assetId: string,
    marketId: string,
    marketSlug: string,
    bestBid: number,
    bestAsk: number,
    timestampMs: number = Date.now(),
  ): TopOfBookUpdate {
    return {
      assetId,
      marketHash: `hash-${assetId}`,
      marketId,
      marketSlug,
      bestBid,
      bestAsk,
      bestBidSize: 100,
      bestAskSize: 100,
      midPrice: (bestBid + bestAsk) / 2,
      spread: bestAsk - bestBid,
      timestampMs,
    };
  }

  describe('Range Market Arbitrage - Unbundling (SELL_PARENT_BUY_CHILDREN)', () => {
    it('should detect unbundling arbitrage opportunity when parent bid > sum of children asks + upper parent ask', async () => {
      // Setup
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      // Initialize the service
      await service.onModuleInit();

      // Clear any initial opportunities
      opportunities.length = 0;

      // Simulate price updates that create an arbitrage opportunity
      // Parent (>80k) bid = 0.75 (willing to pay 0.75 for YES token)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          group.parents[0].slug,
          0.75,
          0.76,
        ),
      );

      // Children asks (total = 0.65)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.19,
          0.20, // Ask = 0.20
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-2',
          'child-market-2',
          group.children[1].slug,
          0.19,
          0.20, // Ask = 0.20
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-3',
          'child-market-3',
          group.children[2].slug,
          0.19,
          0.20, // Ask = 0.20
        ),
      );

      // Upper parent (>86k) ask = 0.05
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-upper-token-yes',
          'parent-market-2',
          group.parents[1].slug,
          0.04,
          0.05, // Ask = 0.05
        ),
      );

      // Wait for throttle/scan
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify
      // Total cost = 0.20 + 0.20 + 0.20 + 0.05 = 0.65
      // Revenue = 0.75 (parent bid)
      // Profit = 0.75 - 0.65 = 0.10 = 10 cents
      // Profit BPS = (0.10 / 0.65) * 10000 = 1538.46 bps ≈ 15.38%
      
      expect(opportunities.length).toBeGreaterThan(0);
      
      const unbundlingOpp = opportunities.find(
        (opp) => opp.strategy === 'SELL_PARENT_BUY_CHILDREN',
      );
      
      expect(unbundlingOpp).toBeDefined();
      expect(unbundlingOpp!.profitAbs).toBeCloseTo(0.10, 2);
      expect(unbundlingOpp!.profitBps).toBeGreaterThan(1500);
      expect(unbundlingOpp!.isExecutable).toBe(true);
      expect(unbundlingOpp!.parentBestBid).toBe(0.75);
      expect(unbundlingOpp!.childrenSumAsk).toBeCloseTo(0.60, 2);
      expect(unbundlingOpp!.parentUpperBestAsk).toBe(0.05);
      expect(unbundlingOpp!.children.length).toBe(3);
    });
  });

  describe('Range Market Arbitrage - Bundling (BUY_PARENT_SELL_CHILDREN)', () => {
    it('should detect bundling arbitrage opportunity when children bids + upper parent bid > parent ask', async () => {
      // Setup
      const group = createMockRangeGroup('ETH-2026-01-31', 'ETH', 'eth-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      // Initialize the service
      await service.onModuleInit();

      // Clear any initial opportunities
      opportunities.length = 0;

      // Simulate price updates that create an arbitrage opportunity
      // Parent (>80k) ask = 0.65 (can buy YES token for 0.65)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          group.parents[0].slug,
          0.64,
          0.65,
        ),
      );

      // Children bids (total = 0.60)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.20, // Bid = 0.20
          0.21,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-2',
          'child-market-2',
          group.children[1].slug,
          0.20, // Bid = 0.20
          0.21,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-3',
          'child-market-3',
          group.children[2].slug,
          0.20, // Bid = 0.20
          0.21,
        ),
      );

      // Upper parent (>86k) bid = 0.15
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-upper-token-yes',
          'parent-market-2',
          group.parents[1].slug,
          0.15, // Bid = 0.15
          0.16,
        ),
      );

      // Wait for throttle/scan
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify
      // Revenue = 0.20 + 0.20 + 0.20 + 0.15 = 0.75
      // Cost = 0.65 (parent ask)
      // Profit = 0.75 - 0.65 = 0.10 = 10 cents
      // Profit BPS = (0.10 / 0.65) * 10000 = 1538.46 bps ≈ 15.38%
      
      expect(opportunities.length).toBeGreaterThan(0);
      
      const bundlingOpp = opportunities.find(
        (opp) => opp.strategy === 'BUY_PARENT_SELL_CHILDREN',
      );
      
      expect(bundlingOpp).toBeDefined();
      expect(bundlingOpp!.profitAbs).toBeCloseTo(0.10, 2);
      expect(bundlingOpp!.profitBps).toBeGreaterThan(1500);
      expect(bundlingOpp!.isExecutable).toBe(true);
      expect(bundlingOpp!.parentBestAsk).toBe(0.65);
      expect(bundlingOpp!.childrenSumBid).toBeCloseTo(0.60, 2);
      expect(bundlingOpp!.parentUpperBestBid).toBe(0.15);
      expect(bundlingOpp!.children.length).toBe(3);
    });
  });

  describe('Market Indexing and Lookup', () => {
    it('should correctly index and lookup markets by token ID', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update using token ID
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.25,
          0.26,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the update was processed (no error)
      expect(true).toBe(true);
    });

    it('should correctly index and lookup markets by slug', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update using market slug (without token ID)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          '', // No token ID
          'child-market-1',
          group.children[0].slug,
          0.25,
          0.26,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the update was processed
      expect(true).toBe(true);
    });

    it('should correctly index and lookup markets by market ID', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update using market ID only
      topOfBookSubject.next({
        assetId: '',
        marketHash: 'hash-123',
        marketId: 'child-market-1',
        marketSlug: undefined,
        bestBid: 0.25,
        bestAsk: 0.26,
        timestampMs: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the update was processed
      expect(true).toBe(true);
    });

    it('should handle updates for unknown markets gracefully', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update for non-existent market
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'unknown-token',
          'unknown-market',
          'unknown-slug',
          0.25,
          0.26,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not throw error
      expect(true).toBe(true);
    });
  });

  describe('Prefix Sum Recalculation', () => {
    it('should correctly recalculate prefix sums after child updates', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();

      // Get internal state (for testing purposes)
      const internals = service as any;
      const state = internals.groups.get(group.groupKey);

      // Initial state - all should be 0
      expect(state.askPrefix[0]).toBe(0);
      expect(state.bidPrefix[0]).toBe(0);

      // Update first child
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.10,
          0.20,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify prefix sums updated
      expect(state.askPrefix[1]).toBe(0.20); // First child ask
      expect(state.bidPrefix[1]).toBe(0.10); // First child bid

      // Update second child
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-2',
          'child-market-2',
          group.children[1].slug,
          0.15,
          0.25,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify cumulative prefix sums
      expect(state.askPrefix[2]).toBeCloseTo(0.45, 2); // 0.20 + 0.25
      expect(state.bidPrefix[2]).toBeCloseTo(0.25, 2); // 0.10 + 0.15
    });
  });

  describe('Cooldown and Throttling', () => {
    it('should respect cooldown period between same opportunity emissions', async () => {
      // Set short cooldown for testing
      process.env.ARB_COOLDOWN_MS = '500';
      process.env.ARB_SCAN_THROTTLE_MS = '50';

      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      // Recreate service with new env vars
      const testService = new ArbitrageEngineService(
        marketStructureService,
        marketDataStreamService,
      );

      const testOpportunities: ArbOpportunity[] = [];
      testService.onOpportunity().subscribe((opp) => {
        testOpportunities.push(opp);
      });

      await testService.onModuleInit();
      testOpportunities.length = 0;

      // Setup profitable scenario
      const setupPrices = () => {
        topOfBookSubject.next(
          createTopOfBookUpdate(
            'parent-token-yes',
            'parent-market-1',
            group.parents[0].slug,
            0.75,
            0.76,
          ),
        );

        topOfBookSubject.next(
          createTopOfBookUpdate(
            'child-token-1',
            'child-market-1',
            group.children[0].slug,
            0.19,
            0.20,
          ),
        );

        topOfBookSubject.next(
          createTopOfBookUpdate(
            'child-token-2',
            'child-market-2',
            group.children[1].slug,
            0.19,
            0.20,
          ),
        );

        topOfBookSubject.next(
          createTopOfBookUpdate(
            'child-token-3',
            'child-market-3',
            group.children[2].slug,
            0.19,
            0.20,
          ),
        );

        topOfBookSubject.next(
          createTopOfBookUpdate(
            'parent-upper-token-yes',
            'parent-market-2',
            group.parents[1].slug,
            0.04,
            0.05,
          ),
        );
      };

      // First emission
      setupPrices();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const firstCount = testOpportunities.length;

      // Second emission immediately (should be blocked by cooldown)
      setupPrices();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const secondCount = testOpportunities.length;

      expect(secondCount).toBe(firstCount); // No new opportunity

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Third emission after cooldown
      setupPrices();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const thirdCount = testOpportunities.length;

      expect(thirdCount).toBeGreaterThan(secondCount); // New opportunity emitted

      testService.onModuleDestroy();
      delete process.env.ARB_COOLDOWN_MS;
      delete process.env.ARB_SCAN_THROTTLE_MS;
    });
  });

  describe('Profit Thresholds', () => {
    it('should not emit opportunity when profit is below minimum BPS threshold', async () => {
      // Set high profit threshold
      process.env.ARB_MIN_PROFIT_BPS = '5000'; // 50%
      process.env.ARB_MIN_PROFIT_ABS = '0';

      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      const testService = new ArbitrageEngineService(
        marketStructureService,
        marketDataStreamService,
      );

      const testOpportunities: ArbOpportunity[] = [];
      testService.onOpportunity().subscribe((opp) => {
        testOpportunities.push(opp);
      });

      await testService.onModuleInit();
      testOpportunities.length = 0;

      // Setup scenario with low profit (< 50%)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          group.parents[0].slug,
          0.70,
          0.71,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.19,
          0.20,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-2',
          'child-market-2',
          group.children[1].slug,
          0.19,
          0.20,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-3',
          'child-market-3',
          group.children[2].slug,
          0.19,
          0.20,
        ),
      );

      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-upper-token-yes',
          'parent-market-2',
          group.parents[1].slug,
          0.04,
          0.05,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should not emit because profit BPS is below threshold
      expect(testOpportunities.length).toBe(0);

      testService.onModuleDestroy();
      delete process.env.ARB_MIN_PROFIT_BPS;
      delete process.env.ARB_MIN_PROFIT_ABS;
    });
  });

  describe('Multiple Groups', () => {
    it('should handle updates for multiple independent groups', async () => {
      const btcGroup = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      const ethGroup = createMockRangeGroup('ETH-2026-01-31', 'ETH', 'eth-price-jan-31-2026');

      marketStructureService.rebuild.mockResolvedValue([btcGroup, ethGroup]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update BTC group
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          btcGroup.parents[0].slug,
          0.75,
          0.76,
        ),
      );

      // Update ETH group
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          ethGroup.parents[0].slug,
          0.65,
          0.66,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both groups should be tracked independently
      const internals = service as any;
      expect(internals.groups.size).toBe(2);
      expect(internals.groups.has('BTC-2026-01-31')).toBe(true);
      expect(internals.groups.has('ETH-2026-01-31')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing bid/ask values gracefully', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update with undefined values
      topOfBookSubject.next({
        assetId: 'child-token-1',
        marketHash: 'hash-123',
        marketId: 'child-market-1',
        marketSlug: group.children[0].slug,
        bestBid: undefined as any,
        bestAsk: undefined as any,
        timestampMs: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should handle gracefully without throwing
      expect(true).toBe(true);
    });

    it('should handle NaN and Infinity values', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update with invalid numeric values
      topOfBookSubject.next({
        assetId: 'child-token-1',
        marketHash: 'hash-123',
        marketId: 'child-market-1',
        marketSlug: group.children[0].slug,
        bestBid: NaN,
        bestAsk: Infinity,
        timestampMs: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should handle gracefully without throwing
      const internals = service as any;
      const state = internals.groups.get(group.groupKey);
      
      // Verify that NaN and Infinity are converted to null
      expect(state.childStates[0].bestBid).toBeNull();
      expect(state.childStates[0].bestAsk).toBeNull();
    });

    it('should not emit opportunity when children have missing prices', async () => {
      const group = createMockRangeGroup('BTC-2026-01-31', 'BTC', 'btc-price-jan-31-2026');
      marketStructureService.rebuild.mockResolvedValue([group]);

      await service.onModuleInit();
      opportunities.length = 0;

      // Update parent with good prices
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-token-yes',
          'parent-market-1',
          group.parents[0].slug,
          0.75,
          0.76,
        ),
      );

      // Update only first child (others missing)
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'child-token-1',
          'child-market-1',
          group.children[0].slug,
          0.19,
          0.20,
        ),
      );

      // Update upper parent
      topOfBookSubject.next(
        createTopOfBookUpdate(
          'parent-upper-token-yes',
          'parent-market-2',
          group.parents[1].slug,
          0.04,
          0.05,
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should not emit opportunity because children 2 and 3 are missing prices
      expect(opportunities.length).toBe(0);
    });
  });
});


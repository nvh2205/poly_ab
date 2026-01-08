import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ArbitrageEngineService } from '../src/modules/strategy/arbitrage-engine.service';
import { MarketStructureService } from '../src/modules/strategy/market-structure.service';
import { MarketDataStreamService } from '../src/modules/ingestion/market-data-stream.service';
import { TopOfBookUpdate } from '../src/modules/strategy/interfaces/top-of-book.interface';
import { RangeGroup } from '../src/modules/strategy/interfaces/range-group.interface';
import { ArbOpportunity } from '../src/modules/strategy/interfaces/arbitrage.interface';

/**
 * Example test demonstrating how to test handleTopOfBook
 * 
 * Use this as a template for writing your own tests
 */

describe('Example Test - Template', () => {
  let service: ArbitrageEngineService;
  let marketStructureService: jest.Mocked<MarketStructureService>;
  let marketDataStreamService: jest.Mocked<MarketDataStreamService>;
  let topOfBookSubject: Subject<TopOfBookUpdate>;
  let opportunities: ArbOpportunity[];

  // Setup before each test
  beforeEach(async () => {
    // Create Subject for simulating TopOfBook updates
    topOfBookSubject = new Subject<TopOfBookUpdate>();

    // Mock MarketStructureService
    marketStructureService = {
      rebuild: jest.fn(),
    } as any;

    // Mock MarketDataStreamService
    marketDataStreamService = {
      onTopOfBook: jest.fn().mockReturnValue(topOfBookSubject.asObservable()),
      onModuleDestroy: jest.fn(),
    } as any;

    // Suppress logs during tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    // Create the service under test
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

  // Cleanup after each test
  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
  });

  /**
   * Example 1: Simple test showing basic flow
   */
  it('example 1 - should process TopOfBook update', async () => {
    // ARRANGE: Setup mock data
    const mockGroup: RangeGroup = {
      groupKey: 'BTC-TEST',
      eventSlug: 'btc-test',
      crypto: 'BTC',
      parents: [
        {
          marketId: 'parent-1',
          slug: 'btc-above-80k',
          question: 'Will BTC be above $80k?',
          clobTokenIds: ['token-yes', 'token-no'],
          bounds: { lower: 80000 },
          kind: 'above',
          role: 'parent',
        },
      ],
      children: [
        {
          marketId: 'child-1',
          slug: 'btc-80-82k',
          question: 'Will BTC be between $80k-$82k?',
          clobTokenIds: ['token-range-1'],
          bounds: { lower: 80000, upper: 82000 },
          kind: 'range',
          role: 'child',
        },
      ],
      unmatched: [],
      overridesApplied: [],
    };

    marketStructureService.rebuild.mockResolvedValue([mockGroup]);

    // Initialize service
    await service.onModuleInit();

    // ACT: Send TopOfBook update
    const update: TopOfBookUpdate = {
      assetId: 'token-yes',
      marketHash: 'hash-123',
      marketId: 'parent-1',
      marketSlug: 'btc-above-80k',
      bestBid: 0.75,
      bestAsk: 0.76,
      timestampMs: Date.now(),
    };

    topOfBookSubject.next(update);

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // ASSERT: Verify update was processed
    const internals = service as any;
    const state = internals.groups.get('BTC-TEST');
    
    expect(state).toBeDefined();
    expect(state.parentStates[0].bestBid).toBe(0.75);
    expect(state.parentStates[0].bestAsk).toBe(0.76);
  });

  /**
   * Example 2: Testing arbitrage opportunity detection
   */
  it('example 2 - should detect arbitrage opportunity', async () => {
    // ARRANGE: Setup profitable scenario
    const mockGroup: RangeGroup = {
      groupKey: 'BTC-TEST',
      eventSlug: 'btc-test',
      crypto: 'BTC',
      parents: [
        {
          marketId: 'parent-1',
          slug: 'btc-above-80k',
          question: 'Will BTC be above $80k?',
          clobTokenIds: ['parent-yes', 'parent-no'],
          bounds: { lower: 80000 },
          kind: 'above',
          role: 'parent',
        },
        {
          marketId: 'parent-2',
          slug: 'btc-above-82k',
          question: 'Will BTC be above $82k?',
          clobTokenIds: ['parent-upper-yes', 'parent-upper-no'],
          bounds: { lower: 82000 },
          kind: 'above',
          role: 'parent',
        },
      ],
      children: [
        {
          marketId: 'child-1',
          slug: 'btc-80-82k',
          question: 'Will BTC be between $80k-$82k?',
          clobTokenIds: ['child-token-1'],
          bounds: { lower: 80000, upper: 82000 },
          kind: 'range',
          role: 'child',
        },
      ],
      unmatched: [],
      overridesApplied: [],
    };

    marketStructureService.rebuild.mockResolvedValue([mockGroup]);
    await service.onModuleInit();
    opportunities.length = 0; // Clear any initial opportunities

    // ACT: Send profitable prices
    // Parent bid: 0.80
    topOfBookSubject.next({
      assetId: 'parent-yes',
      marketHash: 'hash-1',
      marketId: 'parent-1',
      bestBid: 0.80,
      bestAsk: 0.81,
      timestampMs: Date.now(),
    });

    // Child ask: 0.30
    topOfBookSubject.next({
      assetId: 'child-token-1',
      marketHash: 'hash-2',
      marketId: 'child-1',
      bestBid: 0.29,
      bestAsk: 0.30,
      timestampMs: Date.now(),
    });

    // Parent upper ask: 0.40
    topOfBookSubject.next({
      assetId: 'parent-upper-yes',
      marketHash: 'hash-3',
      marketId: 'parent-2',
      bestBid: 0.39,
      bestAsk: 0.40,
      timestampMs: Date.now(),
    });

    // Wait for scan
    await new Promise((resolve) => setTimeout(resolve, 300));

    // ASSERT: Verify opportunity
    // Profit = 0.80 (parent bid) - (0.30 + 0.40) = 0.10
    expect(opportunities.length).toBeGreaterThan(0);
    
    const opp = opportunities.find(o => o.strategy === 'SELL_PARENT_BUY_CHILDREN');
    expect(opp).toBeDefined();
    expect(opp!.profitAbs).toBeCloseTo(0.10, 2);
  });

  /**
   * Example 3: Testing with multiple updates
   */
  it('example 3 - should handle multiple sequential updates', async () => {
    // ARRANGE
    const mockGroup: RangeGroup = {
      groupKey: 'BTC-TEST',
      eventSlug: 'btc-test',
      crypto: 'BTC',
      parents: [
        {
          marketId: 'parent-1',
          slug: 'btc-above-80k',
          question: 'Will BTC be above $80k?',
          clobTokenIds: ['parent-yes', 'parent-no'],
          bounds: { lower: 80000 },
          kind: 'above',
          role: 'parent',
        },
      ],
      children: [
        {
          marketId: 'child-1',
          slug: 'btc-80-82k',
          question: 'Will BTC be between $80k-$82k?',
          clobTokenIds: ['child-token-1'],
          bounds: { lower: 80000, upper: 82000 },
          kind: 'range',
          role: 'child',
        },
      ],
      unmatched: [],
      overridesApplied: [],
    };

    marketStructureService.rebuild.mockResolvedValue([mockGroup]);
    await service.onModuleInit();

    // ACT: Send multiple updates
    for (let i = 0; i < 10; i++) {
      const price = 0.70 + i * 0.01; // Gradually increasing price
      
      topOfBookSubject.next({
        assetId: 'parent-yes',
        marketHash: 'hash-1',
        marketId: 'parent-1',
        bestBid: price,
        bestAsk: price + 0.01,
        timestampMs: Date.now() + i * 100,
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    // ASSERT: All updates processed
    const internals = service as any;
    const state = internals.groups.get('BTC-TEST');
    expect(state.parentStates[0].bestBid).toBeCloseTo(0.79, 2); // Last price
  });

  /**
   * Example 4: Testing edge case - missing data
   */
  it('example 4 - should handle missing bid/ask gracefully', async () => {
    // ARRANGE
    const mockGroup: RangeGroup = {
      groupKey: 'BTC-TEST',
      eventSlug: 'btc-test',
      crypto: 'BTC',
      parents: [{
        marketId: 'parent-1',
        slug: 'test',
        question: 'Test?',
        clobTokenIds: ['token-1'],
        bounds: { lower: 80000 },
        kind: 'above',
        role: 'parent',
      }],
      children: [],
      unmatched: [],
      overridesApplied: [],
    };

    marketStructureService.rebuild.mockResolvedValue([mockGroup]);
    await service.onModuleInit();

    // ACT: Send update with undefined values
    topOfBookSubject.next({
      assetId: 'token-1',
      marketHash: 'hash-1',
      marketId: 'parent-1',
      bestBid: undefined as any,
      bestAsk: undefined as any,
      timestampMs: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // ASSERT: Should not throw error
    const internals = service as any;
    const state = internals.groups.get('BTC-TEST');
    expect(state.parentStates[0].bestBid).toBeNull();
    expect(state.parentStates[0].bestAsk).toBeNull();
  });

  /**
   * Example 5: Testing custom environment variables
   */
  it('example 5 - should respect custom profit thresholds', async () => {
    // ARRANGE: Set high profit threshold
    process.env.ARB_MIN_PROFIT_BPS = '10000'; // 100%
    
    // Create new service with new env vars
    const testService = new ArbitrageEngineService(
      marketStructureService,
      marketDataStreamService,
    );

    const testOpportunities: ArbOpportunity[] = [];
    testService.onOpportunity().subscribe((opp) => {
      testOpportunities.push(opp);
    });

    const mockGroup: RangeGroup = {
      groupKey: 'BTC-TEST',
      eventSlug: 'btc-test',
      crypto: 'BTC',
      parents: [{
        marketId: 'p1',
        slug: 's1',
        question: 'q1',
        clobTokenIds: ['t1'],
        bounds: { lower: 80000 },
        kind: 'above',
        role: 'parent',
      }],
      children: [],
      unmatched: [],
      overridesApplied: [],
    };

    marketStructureService.rebuild.mockResolvedValue([mockGroup]);
    await testService.onModuleInit();

    // ACT: Send low-profit scenario
    topOfBookSubject.next({
      assetId: 't1',
      marketHash: 'h1',
      marketId: 'p1',
      bestBid: 0.51,
      bestAsk: 0.50,
      timestampMs: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    // ASSERT: Should not emit (profit too low)
    expect(testOpportunities.length).toBe(0);

    // Cleanup
    testService.onModuleDestroy();
    delete process.env.ARB_MIN_PROFIT_BPS;
  });
});


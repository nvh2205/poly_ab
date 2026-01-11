import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subscription } from 'rxjs';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbRealTrade } from '../../database/entities/arb-real-trade.entity';
import { ArbitrageEngineService } from './arbitrage-engine.service';
import { ArbOpportunity } from './interfaces/arbitrage.interface';
import {
  PolymarketOnchainService,
  BatchOrderParams,
} from '../../common/services/polymarket-onchain.service';
import { loadPolymarketConfig } from '../../common/services/polymarket-onchain.config';

interface RealTradeResult {
  signalId: string;
  success: boolean;
  orderIds?: string[];
  error?: string;
  totalCost: number;
  expectedPnl: number;
  timestampMs: number;
}

/**
 * Real Execution Service
 * Executes real trades on Polymarket when arbitrage opportunities meet PnL threshold
 * 
 * Key Features:
 * - PnL threshold check: only execute if PnL >= 2% of total_cost
 * - Batch order execution for speed optimization
 * - Comprehensive error handling and logging
 */
@Injectable()
export class RealExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealExecutionService.name);
  private opportunitySub?: Subscription;

  // Configuration
  private readonly enabled = this.boolFromEnv('REAL_TRADING_ENABLED', false);
  private readonly minPnlThresholdPercent = this.numFromEnv(
    'REAL_TRADING_MIN_PNL_PERCENT',
    2.0,
  ); // Default 2%
  private readonly defaultSize = this.numFromEnv('REAL_TRADE_SIZE', 10); // Default 10 USDC
  private readonly maxBatchSize = 15; // Polymarket limit

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbRealTrade)
    private readonly arbRealTradeRepository: Repository<ArbRealTrade>,
    private readonly arbitrageEngineService: ArbitrageEngineService,
    private readonly polymarketOnchainService: PolymarketOnchainService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'Real trading is DISABLED. Set REAL_TRADING_ENABLED=true to enable.',
      );
      return;
    }

    this.logger.log('Real Execution Service initializing...');
    this.logger.log(
      `PnL threshold: ${this.minPnlThresholdPercent}% of total_cost`,
    );
    this.logger.log(`Default trade size: ${this.defaultSize} USDC`);

    this.opportunitySub = this.arbitrageEngineService
      .onOpportunity()
      .subscribe((opportunity) => this.handleOpportunity(opportunity));

    this.logger.log('Real Execution Service initialized and ACTIVE');
  }

  onModuleDestroy(): void {
    if (this.opportunitySub) {
      this.opportunitySub.unsubscribe();
    }
  }

  /**
   * Handle arbitrage opportunity - check threshold and execute if profitable enough
   */
  private async handleOpportunity(opportunity: ArbOpportunity): Promise<void> {
    try {
      // Calculate total cost and PnL percentage
      const totalCost = this.calculateTotalCost(opportunity);
      const pnlPercent = (opportunity.profitAbs / totalCost) * 100;

      // Check PnL threshold
      if (pnlPercent < this.minPnlThresholdPercent) {
        this.logger.debug(
          `Signal below threshold: ${pnlPercent.toFixed(2)}% < ${this.minPnlThresholdPercent}% (profit: ${opportunity.profitAbs.toFixed(4)}, cost: ${totalCost.toFixed(4)})`,
        );
        return;
      }

      this.logger.log(
        `🎯 Signal meets threshold! PnL: ${pnlPercent.toFixed(2)}% (${opportunity.profitAbs.toFixed(4)} USDC) - Strategy: ${opportunity.strategy}`,
      );

      // Save signal first
      const signal = await this.saveSignal(opportunity);

      // Execute real trade
      const tradeResult = await this.executeRealTrade(opportunity, signal.id);

      // Save trade result to database
      await this.saveRealTrade(tradeResult);

      if (tradeResult.success) {
        this.logger.log(
          `✅ Real trade executed successfully! Orders: ${tradeResult.orderIds?.join(', ')}`,
        );
      } else {
        this.logger.error(
          `❌ Real trade failed: ${tradeResult.error}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle opportunity: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Calculate total cost for the arbitrage opportunity
   */
  private calculateTotalCost(opportunity: ArbOpportunity): number {
    const strategy = opportunity.strategy;

    // For range arbitrage strategies
    if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
      // Cost = sum of children asks + parent upper ask
      const childrenCost = opportunity.childrenSumAsk || 0;
      const parentUpperCost = opportunity.parentUpperBestAsk || 0;
      return childrenCost + parentUpperCost;
    }

    if (strategy === 'BUY_PARENT_SELL_CHILDREN') {
      // Cost = parent lower ask
      return opportunity.parentBestAsk || 0;
    }

    // For polymarket triangle strategies
    if (
      strategy === 'POLYMARKET_TRIANGLE_BUY' ||
      strategy === 'POLYMARKET_TRIANGLE'
    ) {
      return opportunity.polymarketTriangleContext?.totalCost || 0;
    }

    if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
      // For sell, cost is the payout we need to cover
      const payout = opportunity.polymarketTriangleContext?.payout || 0;
      return payout;
    }

    // For binary chill strategies
    if (
      strategy === 'BUY_CHILD_YES_SELL_PARENT_NO' ||
      strategy === 'BUY_CHILD_YES_SELL_PARENT_YES'
    ) {
      // Cost = child YES ask
      return opportunity.childrenSumAsk || 0;
    }

    if (
      strategy === 'BUY_PARENT_NO_SELL_CHILD_YES' ||
      strategy === 'BUY_PARENT_NO_SELL_CHILD_NO'
    ) {
      // Cost = parent NO ask
      const ctx = opportunity.binaryChillContext;
      return ctx?.parentBestAskNo || 0;
    }

    return 0;
  }

  /**
   * Execute real trade using batch orders for speed optimization
   */
  private async executeRealTrade(
    opportunity: ArbOpportunity,
    signalId: string,
  ): Promise<RealTradeResult> {
    const startTime = Date.now();

    try {
      // Load Polymarket config
      const config = loadPolymarketConfig();

      // Build batch orders based on strategy
      const batchOrders = this.buildBatchOrders(opportunity);

      if (batchOrders.length === 0) {
        return {
          signalId,
          success: false,
          error: 'No valid orders to execute',
          totalCost: this.calculateTotalCost(opportunity),
          expectedPnl: opportunity.profitAbs,
          timestampMs: Date.now(),
        };
      }

      // Execute batch orders
      this.logger.log(
        `Executing ${batchOrders.length} orders in batch for ${opportunity.strategy}`,
      );

      const result = await this.polymarketOnchainService.placeBatchOrders(
        config,
        batchOrders,
      );

      const latencyMs = Date.now() - startTime;

      if (!result.success || !result.results) {
        return {
          signalId,
          success: false,
          error: result.error || 'Batch order failed',
          totalCost: this.calculateTotalCost(opportunity),
          expectedPnl: opportunity.profitAbs,
          timestampMs: Date.now(),
        };
      }

      // Extract successful order IDs
      const orderIds = result.results
        .filter((r) => r.success && r.orderID)
        .map((r) => r.orderID!);

      const failedCount = result.results.filter((r) => !r.success).length;

      if (failedCount > 0) {
        this.logger.warn(
          `${failedCount} orders failed in batch. Successful: ${orderIds.length}`,
        );
      }

      this.logger.log(
        `Batch execution completed in ${latencyMs}ms. Orders placed: ${orderIds.length}`,
      );

      return {
        signalId,
        success: orderIds.length > 0,
        orderIds,
        totalCost: this.calculateTotalCost(opportunity),
        expectedPnl: opportunity.profitAbs,
        timestampMs: Date.now(),
      };
    } catch (error) {
      this.logger.error(
        `Error executing real trade: ${error.message}`,
        error.stack,
      );
      return {
        signalId,
        success: false,
        error: error.message,
        totalCost: this.calculateTotalCost(opportunity),
        expectedPnl: opportunity.profitAbs,
        timestampMs: Date.now(),
      };
    }
  }

  /**
   * Build batch orders from arbitrage opportunity
   * Optimized for speed: all orders in single batch (up to 15 orders)
   */
  private buildBatchOrders(opportunity: ArbOpportunity): BatchOrderParams[] {
    const orders: BatchOrderParams[] = [];
    const size = this.defaultSize;

    const strategy = opportunity.strategy;

    // Range arbitrage: SELL_PARENT_BUY_CHILDREN
    if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
      // Sell parent at bid
      if (opportunity.parent.assetId && opportunity.parent.bestBid) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Buy children at ask
      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            size,
            side: 'BUY',
            feeRateBps: 0,
            orderType: 'GTC',
          });
        }
      }

      // Buy parent upper at ask
      if (
        opportunity.parentUpper?.assetId &&
        opportunity.parentUpper.bestAsk
      ) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Range arbitrage: BUY_PARENT_SELL_CHILDREN
    else if (strategy === 'BUY_PARENT_SELL_CHILDREN') {
      // Buy parent at ask
      if (opportunity.parent.assetId && opportunity.parent.bestAsk) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell children at bid
      for (const child of opportunity.children) {
        if (child.assetId && child.bestBid) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestBid,
            size,
            side: 'SELL',
            feeRateBps: 0,
            orderType: 'GTC',
          });
        }
      }

      // Sell parent upper at bid
      if (
        opportunity.parentUpper?.assetId &&
        opportunity.parentUpper.bestBid
      ) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Polymarket Triangle: BUY mode
    else if (
      strategy === 'POLYMARKET_TRIANGLE_BUY' ||
      strategy === 'POLYMARKET_TRIANGLE'
    ) {
      // Buy parent lower YES at ask
      if (opportunity.parent.assetId && opportunity.parent.bestAsk) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Buy parent upper NO at ask
      if (
        opportunity.parentUpper?.assetId &&
        opportunity.parentUpper.bestAsk
      ) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Buy range children NO at ask
      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            size,
            side: 'BUY',
            feeRateBps: 0,
            orderType: 'GTC',
          });
        }
      }
    }

    // Polymarket Triangle: SELL mode
    else if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
      // Sell parent lower YES at bid
      if (opportunity.parent.assetId && opportunity.parent.bestBid) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell parent upper NO at bid
      if (
        opportunity.parentUpper?.assetId &&
        opportunity.parentUpper.bestBid
      ) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell range children NO at bid
      for (const child of opportunity.children) {
        if (child.assetId && child.bestBid) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestBid,
            size,
            side: 'SELL',
            feeRateBps: 0,
            orderType: 'GTC',
          });
        }
      }
    }

    // Binary Chill: BUY_CHILD_YES_SELL_PARENT_NO
    else if (strategy === 'BUY_CHILD_YES_SELL_PARENT_NO') {
      const child = opportunity.children[0];
      const ctx = opportunity.binaryChillContext;

      // Buy child YES at ask
      if (child?.assetId && child.bestAsk) {
        orders.push({
          tokenID: child.assetId,
          price: child.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell parent NO at bid
      if (ctx?.parentNoTokenId && ctx.parentBestBidNo) {
        orders.push({
          tokenID: ctx.parentNoTokenId,
          price: ctx.parentBestBidNo,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Binary Chill: BUY_PARENT_NO_SELL_CHILD_YES
    else if (strategy === 'BUY_PARENT_NO_SELL_CHILD_YES') {
      const child = opportunity.children[0];
      const ctx = opportunity.binaryChillContext;

      // Buy parent NO at ask
      if (ctx?.parentNoTokenId && ctx.parentBestAskNo) {
        orders.push({
          tokenID: ctx.parentNoTokenId,
          price: ctx.parentBestAskNo,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell child YES at bid
      if (child?.assetId && child.bestBid) {
        orders.push({
          tokenID: child.assetId,
          price: child.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Binary Chill: BUY_CHILD_YES_SELL_PARENT_YES
    else if (strategy === 'BUY_CHILD_YES_SELL_PARENT_YES') {
      const child = opportunity.children[0];

      // Buy child YES at ask
      if (child?.assetId && child.bestAsk) {
        orders.push({
          tokenID: child.assetId,
          price: child.bestAsk,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell parent YES at bid
      if (opportunity.parent.assetId && opportunity.parent.bestBid) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestBid,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Binary Chill: BUY_PARENT_NO_SELL_CHILD_NO
    else if (strategy === 'BUY_PARENT_NO_SELL_CHILD_NO') {
      const ctx = opportunity.binaryChillContext;

      // Buy parent NO at ask
      if (ctx?.parentNoTokenId && ctx.parentBestAskNo) {
        orders.push({
          tokenID: ctx.parentNoTokenId,
          price: ctx.parentBestAskNo,
          size,
          side: 'BUY',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }

      // Sell child NO at bid
      if (ctx?.childNoTokenId && ctx.childBestBidNo) {
        orders.push({
          tokenID: ctx.childNoTokenId,
          price: ctx.childBestBidNo,
          size,
          side: 'SELL',
          feeRateBps: 0,
          orderType: 'GTC',
        });
      }
    }

    // Validate batch size (Polymarket limit is 15)
    if (orders.length > this.maxBatchSize) {
      this.logger.warn(
        `Batch size ${orders.length} exceeds limit ${this.maxBatchSize}. Truncating.`,
      );
      return orders.slice(0, this.maxBatchSize);
    }

    return orders;
  }

  /**
   * Save signal to database (same as paper execution)
   */
  private async saveSignal(opportunity: ArbOpportunity): Promise<ArbSignal> {
    const snapshot: any = {
      parent: {
        assetId: opportunity.parent.assetId,
        marketSlug: opportunity.parent.marketSlug,
        bestBid: opportunity.parent.bestBid,
        bestAsk: opportunity.parent.bestAsk,
        bestBidSize: opportunity.parent.bestBidSize,
        bestAskSize: opportunity.parent.bestAskSize,
        coverage: opportunity.parent.coverage,
      },
      children: opportunity.children.map((child) => ({
        index: child.index,
        assetId: child.assetId,
        marketSlug: child.marketSlug,
        bestBid: child.bestBid,
        bestAsk: child.bestAsk,
        bestBidSize: child.bestBidSize,
        bestAskSize: child.bestAskSize,
        bounds: child.descriptor.bounds,
      })),
    };

    if (opportunity.parentUpper) {
      snapshot.parentUpper = {
        assetId: opportunity.parentUpper.assetId,
        marketSlug: opportunity.parentUpper.marketSlug,
        bestBid:
          opportunity.parentUpperBestBid ?? opportunity.parentUpper.bestBid,
        bestAsk:
          opportunity.parentUpperBestAsk ?? opportunity.parentUpper.bestAsk,
        bestBidSize: opportunity.parentUpper.bestBidSize,
        bestAskSize: opportunity.parentUpper.bestAskSize,
        bounds: opportunity.parentUpper.descriptor?.bounds,
      };
    }

    if (opportunity.binaryChillContext) {
      snapshot.binaryChillDetails = opportunity.binaryChillContext;
    }

    if (opportunity.polymarketTriangleContext) {
      snapshot.polymarketTriangle = opportunity.polymarketTriangleContext;
    }

    const signal = this.arbSignalRepository.create({
      groupKey: opportunity.groupKey,
      eventSlug: opportunity.eventSlug,
      crypto: opportunity.crypto,
      strategy: opportunity.strategy,
      parentMarketId:
        opportunity.parent.descriptor.marketId ||
        opportunity.parent.marketSlug ||
        '',
      parentAssetId: opportunity.parent.assetId || '',
      tokenType: opportunity.tokenType || 'yes',
      rangeI: opportunity.parent.coverage.startIndex,
      rangeJ: opportunity.parent.coverage.endIndex,
      parentBestBid: this.toFiniteOrNull(opportunity.parentBestBid),
      parentBestAsk: this.toFiniteOrNull(opportunity.parentBestAsk),
      parentBestBidSize: this.toFiniteOrNull(opportunity.parent.bestBidSize),
      parentBestAskSize: this.toFiniteOrNull(opportunity.parent.bestAskSize),
      parentUpperBestBid: this.toFiniteOrNull(opportunity.parentUpperBestBid),
      parentUpperBestAsk: this.toFiniteOrNull(opportunity.parentUpperBestAsk),
      parentUpperBestBidSize: this.toFiniteOrNull(
        opportunity.parentUpper?.bestBidSize,
      ),
      parentUpperBestAskSize: this.toFiniteOrNull(
        opportunity.parentUpper?.bestAskSize,
      ),
      childrenSumAsk: this.toFiniteOrNull(opportunity.childrenSumAsk),
      childrenSumBid: this.toFiniteOrNull(opportunity.childrenSumBid),
      profitAbs: this.toFiniteOrNull(opportunity.profitAbs) ?? 0,
      profitBps: this.toFiniteOrNull(opportunity.profitBps) ?? 0,
      isExecutable: opportunity.isExecutable,
      reason: opportunity.reason,
      snapshot,
      timestampMs: opportunity.timestampMs,
    });

    return await this.arbSignalRepository.save(signal);
  }

  /**
   * Save real trade result to database
   */
  private async saveRealTrade(
    result: RealTradeResult,
  ): Promise<ArbRealTrade> {
    const realTrade = this.arbRealTradeRepository.create({
      signalId: result.signalId,
      success: result.success,
      orderIds: result.orderIds,
      error: result.error,
      totalCost: this.toFiniteOrNull(result.totalCost) ?? 0,
      expectedPnl: this.toFiniteOrNull(result.expectedPnl) ?? 0,
      timestampMs: result.timestampMs,
    });

    return await this.arbRealTradeRepository.save(realTrade);
  }

  private toFiniteOrNull(value: number | undefined | null): number | null {
    if (value === undefined || value === null) return null;
    return Number.isFinite(value) ? value : null;
  }

  private numFromEnv(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    const num = Number(raw);
    return Number.isFinite(num) ? num : defaultValue;
  }

  private boolFromEnv(key: string, defaultValue: boolean): boolean {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    return raw.toLowerCase() === 'true' || raw === '1';
  }
}

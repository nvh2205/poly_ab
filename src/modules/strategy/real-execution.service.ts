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
  BatchOrderResult,
  PolymarketConfig,
} from '../../common/services/polymarket-onchain.service';
import { loadPolymarketConfig } from '../../common/services/polymarket-onchain.config';
import { TelegramService } from '../../common/services/telegram.service';

interface RealTradeResult {
  signalId: string;
  success: boolean;
  orderIds?: string[];
  error?: string;
  totalCost: number;
  expectedPnl: number;
  timestampMs: number;
}

interface OrderCandidate {
  tokenID: string;
  price: number;
  side: 'BUY' | 'SELL';
  orderbookSize?: number;
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
  private cachedUsdcBalance?: number;
  private mintedAssetCacheByGroup?: Map<string, Map<string, number>>;

  // === HFT Cache State (RAM) ===
  private localUsdcBalance: number = 0;
  private config!: PolymarketConfig;
  private balanceRefreshInterval?: ReturnType<typeof setInterval>;
  private mintedRefreshInterval?: ReturnType<typeof setInterval>;
  private readonly BALANCE_REFRESH_MS = 5000; // 5 seconds
  private readonly MINTED_REFRESH_MS = 10000; // 10 seconds (minted changes less frequently)

  // === Order Submission Lock ===
  private isSubmittingOrder: boolean = false;

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
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'Real trading is DISABLED. Set REAL_TRADING_ENABLED=true to enable.',
      );
      return;
    }

    this.logger.log('Real Execution Service initializing (HFT Mode)...');
    this.logger.log(
      `PnL threshold: ${this.minPnlThresholdPercent}% of total_cost`,
    );
    this.logger.log(`Default trade size: ${this.defaultSize} USDC`);

    // === HFT: Load config ONCE at startup ===
    this.config = loadPolymarketConfig();
    this.logger.log('Polymarket config loaded and cached in RAM');

    // === HFT: Initialize mintedAssetCacheByGroup ===
    this.mintedAssetCacheByGroup = new Map();

    // === HFT: Initial balance fetch ===
    this.refreshBalancesBackground();

    // === HFT: Initial minted assets fetch (BASE POOL) ===
    this.refreshMintedAssetsBackground();

    // === HFT: Setup background balance refresh (every 5s) ===
    this.balanceRefreshInterval = setInterval(() => {
      this.refreshBalancesBackground();
    }, this.BALANCE_REFRESH_MS);
    this.logger.log(
      `Background balance refresh scheduled every ${this.BALANCE_REFRESH_MS}ms`,
    );

    // === HFT: Setup background minted assets refresh (every 10s) ===
    this.mintedRefreshInterval = setInterval(() => {
      this.refreshMintedAssetsBackground();
    }, this.MINTED_REFRESH_MS);
    this.logger.log(
      `Background minted assets refresh scheduled every ${this.MINTED_REFRESH_MS}ms`,
    );

    // Subscribe to opportunities
    // this.opportunitySub = this.arbitrageEngineService
    //   .onOpportunity()
    //   .subscribe((opportunity) => this.handleOpportunity(opportunity));

    this.logger.log('Real Execution Service initialized and ACTIVE (HFT Mode)');
  }

  onModuleDestroy(): void {
    if (this.opportunitySub) {
      this.opportunitySub.unsubscribe();
    }
    if (this.balanceRefreshInterval) {
      clearInterval(this.balanceRefreshInterval);
    }
    if (this.mintedRefreshInterval) {
      clearInterval(this.mintedRefreshInterval);
    }
  }

  /**
   * Background balance refresh - runs async, updates localUsdcBalance
   * This is called periodically to sync cached balance with actual RPC/Redis state
   */
  private refreshBalancesBackground(): void {
    const targetAddress = this.config.proxyAddress || undefined;
    this.polymarketOnchainService
      .getBalances(this.config, undefined, targetAddress)
      .then((balances) => {
        this.localUsdcBalance = parseFloat(balances.usdc) || 0;
        this.cachedUsdcBalance = this.localUsdcBalance;
        this.logger.debug(
          `Background balance refresh: ${this.localUsdcBalance.toFixed(2)} USDC`,
        );
      })
      .catch((error) => {
        this.logger.warn(
          `Background balance refresh failed: ${error.message}`,
        );
      });
  }

  /**
   * Background minted assets refresh - loads BASE POOL from Redis for all groups
   * This enables SELL legs to work correctly by knowing available pre-minted inventory
   */
  private refreshMintedAssetsBackground(): void {
    const groupKeys = this.arbitrageEngineService.getGroupKeys();
    if (groupKeys.length === 0) {
      this.logger.debug('No group keys available yet, skipping minted assets refresh');
      return;
    }

    // Load minted assets for each group in parallel (fire & forget)
    for (const groupKey of groupKeys) {
      this.polymarketOnchainService
        .getMintedAssetBalances(this.config, groupKey)
        .then((balances) => {
          const cache = new Map(
            Object.entries(balances).map(([tokenId, amount]) => [
              tokenId,
              Number(amount) || 0,
            ]),
          );
          
          if (!this.mintedAssetCacheByGroup) {
            this.mintedAssetCacheByGroup = new Map();
          }
          this.mintedAssetCacheByGroup.set(groupKey, cache);
          
          const totalTokens = cache.size;
          const totalAmount = Array.from(cache.values()).reduce((a, b) => a + b, 0);
          if (totalTokens > 0) {
            this.logger.debug(
              `Minted cache refreshed for ${groupKey}: ${totalTokens} tokens, ${totalAmount.toFixed(2)} total units`,
            );
          }
        })
        .catch((error) => {
          this.logger.warn(
            `Minted assets refresh failed for ${groupKey}: ${error.message}`,
          );
        });
    }
  }

  /**
   * HFT Hot Path: Handle arbitrage opportunity with ZERO awaits
   * - Uses cached localUsdcBalance (no RPC/Redis calls)
   * - Optimistic balance deduction before order placement
   * - Fire & Forget order execution
   * - Ensures only one signal is processed at a time (sequential execution)
   */
  private handleOpportunity(opportunity: ArbOpportunity): void {
    try {
      // === CHECK: Skip if already submitting an order ===
      if (this.isSubmittingOrder) {
        this.logger.debug(
          `Skipping signal: Order submission already in progress`,
        );
        return;
      }

      // === FAST PATH: All synchronous calculations ===
      const totalCost = this.calculateTotalCost(opportunity);
      const pnlPercent = (opportunity.profitAbs / totalCost) * 100;

      // Check PnL threshold (synchronous)
      if (pnlPercent < this.minPnlThresholdPercent) {
        this.logger.debug(
          `Signal below threshold: ${pnlPercent.toFixed(2)}% < ${this.minPnlThresholdPercent}% (profit: ${opportunity.profitAbs.toFixed(4)}, cost: ${totalCost.toFixed(4)})`,
        );
        return;
      }

      // === Calculate order size using cached balance (NO awaits) ===
      const candidates = this.buildOrderCandidates(opportunity);
      if (candidates.length === 0) {
        this.logger.warn('No valid order candidates built');
        return;
      }

      const size = this.calculateFillSizeSync(candidates, opportunity.groupKey);
      if (!Number.isFinite(size) || size <= 0) {
        this.logger.warn(`Insufficient balance or invalid size: ${size}`);
        return;
      }

      // === Check if localUsdcBalance is sufficient ===
      const requiredCost = this.estimateRequiredCost(candidates, size);
      if (this.localUsdcBalance < requiredCost) {
        this.logger.warn(
          `Insufficient local balance: ${this.localUsdcBalance.toFixed(2)} < ${requiredCost.toFixed(2)} required`,
        );
        return;
      }

      // === OPTIMISTIC UPDATE: Deduct balance BEFORE sending order ===
      const reservedAmount = requiredCost;
      this.localUsdcBalance -= reservedAmount;
      
      // === LOCK: Mark as submitting order ===
      this.isSubmittingOrder = true;
      
      this.logger.log(
        `🎯 HFT Signal! PnL: ${pnlPercent.toFixed(2)}% | Size: ${size.toFixed(2)} | Reserved: ${reservedAmount.toFixed(2)} | Remaining: ${this.localUsdcBalance.toFixed(2)}`,
      );

      // Build batch orders
      const orders = candidates.map((candidate) => ({
        tokenID: candidate.tokenID,
        price: candidate.price,
        size,
        side: candidate.side,
        feeRateBps: 0,
        orderType: 'GTC' as const,
      }));

      // Truncate if exceeds max batch size
      const batchOrders = orders.length > this.maxBatchSize
        ? orders.slice(0, this.maxBatchSize)
        : orders;

      const tradeStartTime = Date.now();

      // === FIRE & FORGET: Place orders WITHOUT awaiting ===
      this.polymarketOnchainService
        .placeBatchOrders(this.config, batchOrders)
        .then((result) => {
          const latencyMs = Date.now() - tradeStartTime;

          if (result.success && result.results) {
            const orderIds = result.results
              .filter((r) => r.success && r.orderID)
              .map((r) => r.orderID!);
            const failedCount = result.results.filter((r) => !r.success).length;

            this.logger.log(
              `✅ HFT Trade SUCCESS in ${latencyMs}ms! Orders: ${orderIds.length}, Failed: ${failedCount}`,
            );

            // Send Telegram notification (fire & forget)
            this.telegramService.notifyOrderFilled({
              success: true,
              strategy: opportunity.strategy,
              ordersPlaced: orderIds.length,
              ordersFailed: failedCount,
              size,
              pnlPercent,
              totalCost,
              expectedPnl: opportunity.profitAbs,
              latencyMs,
              balance: this.localUsdcBalance,
              reserved: reservedAmount,
            }).catch((error) => {
              this.logger.warn(`Telegram notification failed: ${error.message}`);
            });

            // Adjust minted cache for sell orders (async)
            this.adjustMintedCacheAfterSell(
              batchOrders,
              result.results,
              this.config,
              opportunity.groupKey,
            );
          } else {
            // === ROLLBACK: Add back reserved amount on failure ===
            this.localUsdcBalance += reservedAmount;
            this.logger.error(
              `❌ HFT Trade FAILED in ${latencyMs}ms: ${result.error || 'Unknown error'} | Rolled back: ${reservedAmount.toFixed(2)}`,
            );

            // Send Telegram notification (fire & forget)
            this.telegramService.notifyOrderFilled({
              success: false,
              strategy: opportunity.strategy,
              error: result.error || 'Unknown error',
              latencyMs,
              balance: this.localUsdcBalance,
              reserved: reservedAmount,
            }).catch((error) => {
              this.logger.warn(`Telegram notification failed: ${error.message}`);
            });
          }

          // === UNLOCK: Release order submission lock ===
          this.isSubmittingOrder = false;
        })
        .catch((error) => {
          const latencyMs = Date.now() - tradeStartTime;
          // === ROLLBACK: Add back reserved amount on error ===
          this.localUsdcBalance += reservedAmount;
          this.logger.error(
            `❌ HFT Trade ERROR in ${latencyMs}ms: ${error.message} | Rolled back: ${reservedAmount.toFixed(2)}`,
          );

          // Send Telegram notification (fire & forget)
          this.telegramService.notifyOrderFilled({
            success: false,
            strategy: opportunity.strategy,
            error: error.message,
            latencyMs,
            balance: this.localUsdcBalance,
            reserved: reservedAmount,
          }).catch((err) => {
            this.logger.warn(`Telegram notification failed: ${err.message}`);
          });

          // === UNLOCK: Release order submission lock ===
          this.isSubmittingOrder = false;
        });

      // === ASYNC DB SAVE (non-blocking) ===
      const tradeResult: RealTradeResult = {
        signalId: 'pending',
        success: true, // Optimistic - will be updated if we add result tracking
        totalCost,
        expectedPnl: opportunity.profitAbs,
        timestampMs: Date.now(),
      };

      this.saveSignalAndTradeAsync(opportunity, tradeResult).catch((error) => {
        this.logger.error(
          `Failed to save signal/trade to DB: ${error.message}`,
        );
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to handle opportunity: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Synchronous fill size calculation using cached balances (HFT optimized)
   * NO awaits - uses localUsdcBalance and mintedAssetCacheByGroup
   */
  private calculateFillSizeSync(
    candidates: OrderCandidate[],
    groupKey: string,
  ): number {
    const buyLegs = candidates.filter((c) => c.side === 'BUY');
    const sellLegs = candidates.filter((c) => c.side === 'SELL');
    const sizeCandidates: number[] = [];

    // Use cached localUsdcBalance for buy legs
    if (buyLegs.length > 0) {
      const allocPerBuy = this.localUsdcBalance / buyLegs.length;

      for (const leg of buyLegs) {
        if (!leg.price || leg.price <= 0) continue;
        const sizeFromCash = allocPerBuy > 0 ? allocPerBuy / leg.price : 0;
        const bookCap = leg.orderbookSize && leg.orderbookSize > 0
          ? leg.orderbookSize
          : Number.POSITIVE_INFINITY;
        sizeCandidates.push(Math.min(sizeFromCash, bookCap));
      }
    }

    // Use cached minted assets for sell legs
    if (sellLegs.length > 0) {
      const mintedCache = this.mintedAssetCacheByGroup?.get(groupKey);
      for (const leg of sellLegs) {
        const mintedAvailable = mintedCache?.get(leg.tokenID) ?? 0;
        const bookCap = leg.orderbookSize && leg.orderbookSize > 0
          ? leg.orderbookSize
          : Number.POSITIVE_INFINITY;
        sizeCandidates.push(Math.min(mintedAvailable, bookCap));
      }
    }

    const finiteCandidates = sizeCandidates.filter(
      (v) => Number.isFinite(v) && v >= 0,
    );

    let minSize = finiteCandidates.length > 0
      ? Math.min(...finiteCandidates)
      : this.defaultSize;

    if (!Number.isFinite(minSize)) {
      minSize = 0;
    }

    if (this.defaultSize && Number.isFinite(minSize)) {
      minSize = Math.min(minSize, this.defaultSize);
    }

    return minSize > 0 ? minSize : 0;
  }

  /**
   * Estimate required USDC cost for buy orders (synchronous)
   */
  private estimateRequiredCost(
    candidates: OrderCandidate[],
    size: number,
  ): number {
    let totalCost = 0;
    for (const candidate of candidates) {
      if (candidate.side === 'BUY') {
        totalCost += candidate.price * size;
      }
    }
    return totalCost;
  }

  /**
   * Calculate total cost for the arbitrage opportunity
   */
  /**
   * Calculate total cost for the arbitrage opportunity
   * Updated to include Minting Cost (Collateral) for Sell/Short orders
   */
  private calculateTotalCost(opportunity: ArbOpportunity): number {
    const strategy = opportunity.strategy;
    // 1. Range Strategy: SELL_PARENT_BUY_CHILDREN
    // Logic: Short Parent (Cost: 1 - Bid) + Long Children (Cost: Ask) + Long Upper (Cost: Ask)
    if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
      const childrenBuyCost = opportunity.childrenSumAsk || 0;
      const parentUpperBuyCost = opportunity.parentUpperBestAsk || 0;

      // Sell Parent Cost = 1 - Bid
      const parentBid = opportunity.parent.bestBid || 0;
      const parentSellCost = 1 - parentBid;

      return childrenBuyCost + parentUpperBuyCost + parentSellCost;
    }

    // 2. Range Strategy: BUY_PARENT_SELL_CHILDREN
    // Logic: Long Parent (Cost: Ask) + Short Children (Cost: 1 - Bid) + Short Upper (Cost: 1 - Bid)
    if (strategy === 'BUY_PARENT_SELL_CHILDREN') {
      const parentBuyCost = opportunity.parentBestAsk || 0;

      // Sell Children Cost
      let childrenSellCost = 0;
      for (const child of opportunity.children) {
        const bid = child.bestBid || 0;
        childrenSellCost += 1 - bid;
      }

      // Sell Parent Upper Cost
      const parentUpperBid = opportunity.parentUpper?.bestBid || 0;
      const parentUpperSellCost = 1 - parentUpperBid;

      return parentBuyCost + childrenSellCost + parentUpperSellCost;
    }

    // 3. Polymarket Triangle: BUY
    // Logic: Buy all legs -> Cost is simply Sum of Asks
    if (
      strategy === 'POLYMARKET_TRIANGLE_BUY' ||
      strategy === 'POLYMARKET_TRIANGLE'
    ) {
      return opportunity.polymarketTriangleContext?.totalCost || 0;
    }

    // 4. Polymarket Triangle: SELL
    // Logic: Must mint all legs first (cost = payout), then sell them (revenue = totalBid)
    // Cost = payout (collateral to mint)
    // Revenue = totalBid (already reflected in profitAbs)
    if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
      const ctx = opportunity.polymarketTriangleContext;
      const payout = ctx?.payout || 0; // Total Collateral needed to mint all legs

      // Cost is the payout (amount needed to mint)
      // The revenue (totalBid) is already calculated in profitAbs
      return payout;
    }

    // 5. Binary Chill Strategies (Đã fix trước đó)
    // Logic: Cost = Buy Ask + (1 - Sell Bid)

    // if (strategy === 'BUY_CHILD_YES_SELL_PARENT_NO') {
    //   const buyCost = opportunity.childrenSumAsk || 0;
    //   const ctx = opportunity.binaryChillContext;
    //   const sellProceeds = ctx?.parentBestBidNo || 0;
    //   return buyCost + (1 - sellProceeds);
    // }

    // if (strategy === 'BUY_CHILD_YES_SELL_PARENT_YES') {
    //   const buyCost = opportunity.childrenSumAsk || 0;
    //   const sellProceeds = opportunity.parent.bestBid || 0;
    //   return buyCost + (1 - sellProceeds);
    // }

    // if (strategy === 'BUY_PARENT_NO_SELL_CHILD_YES') {
    //   const ctx = opportunity.binaryChillContext;
    //   const buyCost = ctx?.parentBestAskNo || 0;
    //   const child = opportunity.children[0];
    //   const sellProceeds = child?.bestBid || 0;
    //   return buyCost + (1 - sellProceeds);
    // }

    // if (strategy === 'BUY_PARENT_NO_SELL_CHILD_NO') {
    //   const ctx = opportunity.binaryChillContext;
    //   const buyCost = ctx?.parentBestAskNo || 0;
    //   const sellProceeds = ctx?.childBestBidNo || 0;
    //   return buyCost + (1 - sellProceeds);
    // }

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
      const batchOrders = await this.buildBatchOrders(opportunity, config);

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
      // Refresh cached balances after submitting orders
      await this.refreshCashBalance(config);
      await this.adjustMintedCacheAfterSell(
        batchOrders,
        result.results,
        config,
        opportunity.groupKey,
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
  private async buildBatchOrders(
    opportunity: ArbOpportunity,
    config: PolymarketConfig,
  ): Promise<BatchOrderParams[]> {
    const candidates = this.buildOrderCandidates(opportunity);

    if (candidates.length === 0) {
      return [];
    }

    const size = await this.calculateFillSize(
      candidates,
      config,
      opportunity.groupKey,
    );

    if (!Number.isFinite(size) || size <= 0) {
      this.logger.warn(
        `Calculated executable size is invalid (${size}). Skip placing orders.`,
      );
      return [];
    }

    const orders: BatchOrderParams[] = candidates.map((candidate) => ({
      tokenID: candidate.tokenID,
      price: candidate.price,
      size,
      side: candidate.side,
      feeRateBps: 0,
      orderType: 'GTC',
    }));

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
   * Build order candidates with price/side/book size data
   */
  private buildOrderCandidates(opportunity: ArbOpportunity): OrderCandidate[] {
    const orders: OrderCandidate[] = [];
    const strategy = opportunity.strategy;

    if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
      if (opportunity.parent.assetId && opportunity.parent.bestBid) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestBid,
          side: 'SELL',
          orderbookSize: opportunity.parent.bestBidSize,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            side: 'BUY',
            orderbookSize: child.bestAskSize,
          });
        }
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestAsk) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parentUpper.bestAskSize,
        });
      }
    } else if (strategy === 'BUY_PARENT_SELL_CHILDREN') {
      if (opportunity.parent.assetId && opportunity.parent.bestAsk) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parent.bestAskSize,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestBid) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestBid,
            side: 'SELL',
            orderbookSize: child.bestBidSize,
          });
        }
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestBid) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestBid,
          side: 'SELL',
          orderbookSize: opportunity.parentUpper.bestBidSize,
        });
      }
    } else if (
      strategy === 'POLYMARKET_TRIANGLE_BUY' ||
      strategy === 'POLYMARKET_TRIANGLE'
    ) {
      if (opportunity.parent.assetId && opportunity.parent.bestAsk) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parent.bestAskSize,
        });
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestAsk) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parentUpper.bestAskSize,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            side: 'BUY',
            orderbookSize: child.bestAskSize,
          });
        }
      }
    } else if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
      if (opportunity.parent.assetId && opportunity.parent.bestBid) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestBid,
          side: 'SELL',
          orderbookSize: opportunity.parent.bestBidSize,
        });
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestBid) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestBid,
          side: 'SELL',
          orderbookSize: opportunity.parentUpper.bestBidSize,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestBid) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestBid,
            side: 'SELL',
            orderbookSize: child.bestBidSize,
          });
        }
      }
    }

    return orders.filter((o) => Number.isFinite(o.price) && o.price > 0);
  }

  /**
   * Compute executable size from cash + minted assets with default-size cap
   */
  private async calculateFillSize(
    candidates: OrderCandidate[],
    config: PolymarketConfig,
    groupKey: string,
  ): Promise<number> {
    const buyLegs = candidates.filter((c) => c.side === 'BUY');
    const sellLegs = candidates.filter((c) => c.side === 'SELL');
    const sizeCandidates: number[] = [];

    if (buyLegs.length > 0) {
      const cash = await this.getCachedCashBalance(config);
      const allocPerBuy = buyLegs.length > 0 ? cash / buyLegs.length : 0;

      for (const leg of buyLegs) {
        if (!leg.price || leg.price <= 0) continue;
        const sizeFromCash =
          allocPerBuy > 0 && leg.price > 0 ? allocPerBuy / leg.price : 0;
        const bookCap =
          leg.orderbookSize && leg.orderbookSize > 0
            ? leg.orderbookSize
            : Number.POSITIVE_INFINITY;
        sizeCandidates.push(Math.min(sizeFromCash, bookCap));
      }
    }

    if (sellLegs.length > 0) {
      const mintedCache = await this.getMintedAssetCache(config, groupKey);
      for (const leg of sellLegs) {
        const mintedAvailable = mintedCache.get(leg.tokenID) ?? 0;
        const bookCap =
          leg.orderbookSize && leg.orderbookSize > 0
            ? leg.orderbookSize
            : Number.POSITIVE_INFINITY;
        sizeCandidates.push(Math.min(mintedAvailable, bookCap));
      }
    }

    const finiteCandidates = sizeCandidates.filter(
      (v) => Number.isFinite(v) && v >= 0,
    );

    let minSize =
      finiteCandidates.length > 0
        ? Math.min(...finiteCandidates)
        : this.defaultSize;

    if (!Number.isFinite(minSize)) {
      minSize = 0;
    }

    if (this.defaultSize && Number.isFinite(minSize)) {
      minSize = Math.min(minSize, this.defaultSize);
    }

    return minSize > 0 ? minSize : 0;
  }

  /**
   * Cached USDC balance helper (on-chain fetch only when needed)
   */
  private async getCachedCashBalance(
    config: PolymarketConfig,
  ): Promise<number> {
    if (this.cachedUsdcBalance === undefined) {
      return this.refreshCashBalance(config);
    }
    return this.cachedUsdcBalance;
  }

  private async refreshCashBalance(config: PolymarketConfig): Promise<number> {
    try {
      const targetAddress = config.proxyAddress || undefined;
      const balances = await this.polymarketOnchainService.getBalances(
        config,
        undefined,
        targetAddress,
      );
      this.cachedUsdcBalance = parseFloat(balances.usdc) || 0;
    } catch (error: any) {
      this.logger.warn(`Failed to refresh USDC balance: ${error.message}`);
      this.cachedUsdcBalance = this.cachedUsdcBalance ?? 0;
    }
    return this.cachedUsdcBalance;
  }

  /**
   * Load minted assets from Redis once, then serve from memory
   */
  private async getMintedAssetCache(
    config: PolymarketConfig,
    groupKey: string,
  ): Promise<Map<string, number>> {
    if (this.mintedAssetCacheByGroup?.has(groupKey)) {
      return this.mintedAssetCacheByGroup.get(groupKey)!;
    }

    try {
      const minted = await this.polymarketOnchainService.getMintedAssetBalances(
        config,
        groupKey,
      );
      const cache = new Map(
        Object.entries(minted).map(([tokenId, amount]) => [
          tokenId,
          Number(amount) || 0,
        ]),
      );
      if (!this.mintedAssetCacheByGroup) {
        this.mintedAssetCacheByGroup = new Map();
      }
      this.mintedAssetCacheByGroup.set(groupKey, cache);
      return cache;
    } catch (error: any) {
      this.logger.warn(`Failed to load minted asset cache: ${error.message}`);
      if (!this.mintedAssetCacheByGroup) {
        this.mintedAssetCacheByGroup = new Map();
      }
      const emptyCache = new Map<string, number>();
      this.mintedAssetCacheByGroup.set(groupKey, emptyCache);
      return emptyCache;
    }
  }

  /**
   * Reduce minted cache after submitting sell orders (best-effort)
   */
  private adjustMintedCacheAfterSell(
    orders: BatchOrderParams[],
    results?: BatchOrderResult[],
    config?: PolymarketConfig,
    groupKey?: string,
  ): Promise<void> {
    if (!this.mintedAssetCacheByGroup || orders.length === 0 || !results) {
      return Promise.resolve();
    }

    const successfulIndexes = new Set<number>();

    results.forEach((res, idx) => {
      if (res?.success) successfulIndexes.add(idx);
    });

    const redisDeltas: Record<string, number> = {};

    successfulIndexes.forEach((idx) => {
      const order = orders[idx];
      if (!order || order.side !== 'SELL') return;
      if (groupKey && this.mintedAssetCacheByGroup.has(groupKey)) {
        const cache = this.mintedAssetCacheByGroup.get(groupKey)!;
        const current = cache.get(order.tokenID) || 0;
        cache.set(order.tokenID, Math.max(current - order.size, 0));
      }
      redisDeltas[order.tokenID] =
        (redisDeltas[order.tokenID] || 0) - order.size;
    });

    if (config && groupKey && Object.keys(redisDeltas).length > 0) {
      return this.polymarketOnchainService.updateMintedBalances(
        config,
        groupKey,
        redisDeltas,
      );
    }

    return Promise.resolve();
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
   * Save signal and trade result to database asynchronously (non-blocking)
   * This runs AFTER trade execution to optimize speed
   */
  private async saveSignalAndTradeAsync(
    opportunity: ArbOpportunity,
    tradeResult: RealTradeResult,
  ): Promise<void> {
    try {
      // Save signal first
      const signal = await this.saveSignal(opportunity);

      // Update trade result with real signal ID
      tradeResult.signalId = signal.id;

      // Save trade result
      await this.saveRealTrade(tradeResult);

      this.logger.debug(
        `Saved signal ${signal.id} and trade result to database`,
      );
    } catch (error) {
      this.logger.error(
        `Error in saveSignalAndTradeAsync: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Save real trade result to database
   */
  private async saveRealTrade(result: RealTradeResult): Promise<ArbRealTrade> {
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

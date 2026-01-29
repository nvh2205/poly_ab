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
import { MintQueueService } from './services/mint-queue.service';
import { ManagePositionQueueService } from './services/manage-position-queue.service';

interface RealTradeResult {
  signalId: string;
  success: boolean;
  orderIds?: string[];
  error?: string;
  errorMessages?: Array<{
    tokenID: string;
    marketSlug?: string;
    side: 'BUY' | 'SELL';
    price: number;
    errorMsg: string;
  }>;
  totalCost: number;
  expectedPnl: number;
  timestampMs: number;
}

interface OrderCandidate {
  tokenID: string;
  price: number;
  side: 'BUY' | 'SELL';
  orderbookSize?: number;
  /** Whether this is a negRisk market (for native signing) */
  negRisk?: boolean;
}

// ============================================
// Constants
// ============================================

/** HFT Configuration Constants */
const BALANCE_REFRESH_MS = 5000; // 5 seconds
const MINTED_REFRESH_MS = 10000; // 10 seconds (minted changes less frequently)
const OPPORTUNITY_TIMEOUT_MS = 5000; // 5 seconds between opportunities

/** Polymarket Constraints */
const MAX_BATCH_SIZE = 15; // Polymarket batch order limit
const MAX_PRICE = 0.99; // Maximum price for probability markets (must be < 1.0)
const MIN_PRICE = 0.01; // Minimum price for probability markets (must be > 0.0)
const MIN_ORDER_VALUE = 1.0; // Polymarket minimum order value in test mode (USDC)

/**
 * Slippage/Spread Constants (based on Polymarket tick size mechanism)
 * Reference: https://docs.polymarket.com
 * - Normal tick size: 0.01 (1 cent) when price is between 0.04 and 0.96
 * - Extreme tick size: 0.001 (0.1 cent) when price > 0.96 or price < 0.04
 */
const SLIPPAGE_EXTREME_THRESHOLD_HIGH = 0.96; // Price above this uses smaller tick
const SLIPPAGE_EXTREME_THRESHOLD_LOW = 0.04; // Price below this uses smaller tick
const NORMAL_SPREAD = 0.01; // 1 cent spread for normal prices
const EXTREME_SPREAD = 0.001; // 0.1 cent spread for extreme prices (near 0 or 1)

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

  // === Order Submission Lock ===
  private isSubmittingOrder: boolean = false;

  // === Opportunity Timeout ===
  private lastOpportunityExecutedAt: number = 0;

  // === Configuration (from environment variables) ===
  private readonly enabled = this.boolFromEnv('REAL_TRADING_ENABLED', false);
  private runtimeEnabled: boolean = this.boolFromEnv('REAL_TRADING_ENABLED', false);
  private slippageEnabled: boolean = this.boolFromEnv('SLIPPAGE_ENABLED', false); // Slippage enabled by default
  private readonly minPnlThresholdPercent = this.numFromEnv('REAL_TRADING_MIN_PNL_PERCENT', 1);
  private readonly defaultSize = this.numFromEnv('REAL_TRADE_SIZE', 10);
  private readonly enforceMinOrderValue = this.boolFromEnv('ENFORCE_MIN_ORDER_VALUE', true);

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbRealTrade)
    private readonly arbRealTradeRepository: Repository<ArbRealTrade>,
    private readonly arbitrageEngineService: ArbitrageEngineService,
    private readonly polymarketOnchainService: PolymarketOnchainService,
    private readonly telegramService: TelegramService,
    private readonly mintQueueService: MintQueueService,
    private readonly managePositionQueueService: ManagePositionQueueService,
  ) { }

  async onModuleInit(): Promise<void> {


    // if (!this.enabled) {
    //   this.logger.warn(
    //     'Real trading is DISABLED. Set REAL_TRADING_ENABLED=true to enable.',
    //   );
    //   return;
    // }

    this.logger.log('Real Execution Service initializing (HFT Mode)...');
    this.logger.log(
      `PnL threshold: ${this.minPnlThresholdPercent}% of total_cost`,
    );
    this.logger.log(`Default trade size: ${this.defaultSize} USDC`);
    this.logger.log(`Opportunity timeout: ${OPPORTUNITY_TIMEOUT_MS}ms between opportunities`);
    this.logger.log(`Min order value enforcement: ${this.enforceMinOrderValue ? 'ENABLED' : 'DISABLED'} (${MIN_ORDER_VALUE} USDC)`);
    this.logger.log(`Slippage: ${this.slippageEnabled ? 'ENABLED' : 'DISABLED'} (Normal: ${NORMAL_SPREAD}, Extreme: ${EXTREME_SPREAD})`);

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
    }, BALANCE_REFRESH_MS);
    this.logger.log(
      `Background balance refresh scheduled every ${BALANCE_REFRESH_MS}ms`,
    );

    // === HFT: Setup background minted assets refresh (every 10s) ===
    this.mintedRefreshInterval = setInterval(() => {
      this.refreshMintedAssetsBackground();
    }, MINTED_REFRESH_MS);
    this.logger.log(
      `Background minted assets refresh scheduled every ${MINTED_REFRESH_MS}ms`,
    );

    // Subscribe to opportunities
    this.opportunitySub = this.arbitrageEngineService
      .onOpportunity()
      .subscribe((opportunity) => this.handleOpportunity(opportunity));

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
    const groupKeys = this.generateGroupKeys();
    if (groupKeys.length === 0) {
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
        })
        .catch((error) => {
          this.logger.warn(
            `Minted assets refresh failed for ${groupKey}: ${error.message}`,
          );
        });
    }
  }

  /**
   * Generate group keys for ETH and BTC with 17:00 UTC expiration
   * If current time is before 17:00 UTC today, uses today's date
   * If current time is after 17:00 UTC today, uses tomorrow's date
   * Format: {symbol}-{ISO8601 expiration time}
   * Example: "eth-2026-01-20T17:00:00.000Z"
   */
  private generateGroupKeys(): string[] {
    const now = new Date();
    const currentHourUTC = now.getUTCHours();

    // If current time is >= 17:00 UTC, use next day
    let expirationDate: Date;
    if (currentHourUTC >= 17) {
      // Move to next day at 17:00 UTC
      expirationDate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        17, 0, 0, 0
      ));
    } else {
      // Use today at 17:00 UTC
      expirationDate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        17, 0, 0, 0
      ));
    }

    const expirationISO = expirationDate.toISOString();
    const symbols = ['eth', 'btc'];

    return symbols.map(symbol => `${symbol}-${expirationISO}`);
  }

  /**
   * HFT Hot Path: Handle arbitrage opportunity with ZERO awaits
   * - Uses cached localUsdcBalance (no RPC/Redis calls)
   * - Optimistic balance deduction before order placement
   * - Fire & Forget order execution
   * - Ensures only one signal is processed at a time (sequential execution)
   * - 5 second timeout between opportunities
   */
  private handleOpportunity(opportunity: ArbOpportunity): void {
    try {
      // === VALIDATION: Check if opportunity should be skipped ===
      const validation = this.shouldSkipOpportunity(opportunity);
      if (validation.shouldSkip) {
        return;
      }

      const { candidates, size, requiredCost, totalCost } = validation;

      // === OPTIMISTIC UPDATE: Deduct balance BEFORE sending order ===
      const reservedAmount = requiredCost;
      this.localUsdcBalance -= reservedAmount;

      // === UPDATE: Mark opportunity execution timestamp ===
      this.lastOpportunityExecutedAt = Date.now();

      // === LOCK: Mark as submitting order ===
      this.isSubmittingOrder = true;

      // Prepare batch orders
      const batchOrders = this.prepareBatchOrdersSync(candidates, size);

      const tradeStartTime = Date.now();

      // === FIRE & FORGET: Place orders WITHOUT awaiting ===
      this.polymarketOnchainService
        .placeBatchOrdersNative(this.config, batchOrders)
        .then((result) => {
          const latencyMs = Date.now() - tradeStartTime;

          if (result.success && result.results) {
            const orderIds = result.results
              .filter((r) => r.success && r.orderID)
              .map((r) => r.orderID!);
            const failedCount = result.results.filter((r) => !r.success).length;

            // Build token to market slug mapping
            const tokenToMarketSlug = this.buildTokenToMarketSlugMap(opportunity);

            // Collect successful orders details
            const successfulOrders = result.results
              .map((r, idx) => ({ result: r, order: batchOrders[idx] }))
              .filter(({ result }) => result.success)
              .map(({ result, order }) => ({
                tokenID: order.tokenID,
                marketSlug: tokenToMarketSlug.get(order.tokenID),
                side: order.side,
                price: order.price,
              }));

            // Collect failed orders details
            const failedOrders = result.results
              .map((r, idx) => ({ result: r, order: batchOrders[idx] }))
              .filter(({ result }) => !result.success)
              .map(({ result, order }) => ({
                tokenID: order.tokenID,
                marketSlug: tokenToMarketSlug.get(order.tokenID),
                side: order.side,
                price: order.price,
                errorMsg: result.errorMsg || result.status || 'Unknown error',
              }));

            // Console log failed orders for debugging
            if (failedOrders.length > 0) {
              this.logger.warn(`❌ ${failedOrders.length} order(s) failed:`);
              failedOrders.forEach((order, idx) => {
                this.logger.warn(
                  `  [${idx + 1}] ${order.side} ${order.marketSlug || order.tokenID.substring(0, 10)} @ ${order.price.toFixed(4)} - Error: ${order.errorMsg}`
                );
              });
            }

            // Calculate actual total cost based on size (already multiplied by price in candidates)
            const actualTotalCost = this.calculateActualCost(batchOrders, size);

            // Calculate actual PnL in USDC (size * profit per unit)
            const actualPnlUsdc = size * opportunity.profitAbs;

            // Recalculate PnL percentage based on actual cost
            const actualPnlPercent = actualTotalCost > 0 ? (actualPnlUsdc / actualTotalCost) * 100 : 0;

            // Send Telegram notification (fire & forget)
            this.telegramService.notifyOrderFilled({
              success: true,
              strategy: opportunity.strategy,
              ordersPlaced: orderIds.length,
              ordersFailed: failedCount,
              successfulOrders,
              failedOrders,
              size,
              pnlPercent: actualPnlPercent,
              totalCost: actualTotalCost,
              expectedPnl: actualPnlUsdc,
              latencyMs,
              balance: this.localUsdcBalance,
              reserved: reservedAmount,
            }).catch(() => {
              // Silent fail for telegram notifications
            });

            // Save trade result to database and queue for order status checking
            const tradeResult: RealTradeResult = {
              signalId: 'pending',
              success: orderIds.length > 0,
              orderIds: orderIds.length > 0 ? orderIds : undefined,
              errorMessages: failedOrders.length > 0 ? failedOrders : undefined,
              totalCost: actualTotalCost,
              expectedPnl: actualPnlUsdc,
              timestampMs: Date.now(),
            };

            this.saveTradeResultAsync(opportunity, tradeResult)
              .then((savedTrade) => {
                // Queue order status check for manage-position (fire & forget)
                if (orderIds.length > 0) {
                  const originalOrders = result.results!
                    .map((r, idx) => ({ result: r, order: batchOrders[idx] }))
                    .filter(({ result: r }) => r.success && r.orderID)
                    .map(({ result: r, order }) => ({
                      orderId: r.orderID!,
                      tokenID: order.tokenID,
                      side: order.side,
                      price: order.price,
                      size: order.size,
                      negRisk: order.negRisk,
                    }));

                  this.managePositionQueueService.addToQueue(
                    savedTrade.id,
                    orderIds,
                    originalOrders,
                  ).catch((err) => {
                    this.logger.warn(`Failed to queue order status check: ${err.message}`);
                  });
                }
              })
              .catch((error) => {
                this.logger.error(
                  `Failed to save trade result to DB: ${error.message}`,
                );
              });

            // Adjust minted cache for sell orders (async)
            this.adjustMintedCacheAfterSell(
              batchOrders,
              result.results,
              this.config,
              opportunity.groupKey,
            );

            // Queue SELL orders for minting replenishment (fire & forget)
            this.queueMintForSellSignals(
              batchOrders,
              result.results,
            );
          } else {
            // === ROLLBACK: Add back reserved amount on failure ===
            this.localUsdcBalance += reservedAmount;

            // Console log batch failure
            const errorMsg = result.error || 'Unknown error';
            this.logger.error(
              `❌ BATCH ORDER FAILED - Strategy: ${opportunity.strategy}, Error: ${errorMsg}`
            );
            this.logger.error(
              `   Orders attempted: ${batchOrders.length}, Size: ${size}, Reserved: ${reservedAmount.toFixed(2)} USDC`
            );

            // Send Telegram notification (fire & forget)
            this.telegramService.notifyOrderFilled({
              success: false,
              strategy: opportunity.strategy,
              error: errorMsg,
              latencyMs,
              balance: this.localUsdcBalance,
              reserved: reservedAmount,
            }).catch(() => {
              // Silent fail for telegram notifications
            });

            // Save trade result to database (async)
            const tradeResult: RealTradeResult = {
              signalId: 'pending',
              success: false,
              error: errorMsg,
              totalCost,
              expectedPnl: opportunity.profitAbs,
              timestampMs: Date.now(),
            };

            this.saveTradeResultAsync(opportunity, tradeResult).catch((error) => {
              this.logger.error(
                `Failed to save trade result to DB: ${error.message}`,
              );
            });
          }

          // === UNLOCK: Release order submission lock ===
          this.isSubmittingOrder = false;
        })
        .catch((error) => {
          const latencyMs = Date.now() - tradeStartTime;
          // === ROLLBACK: Add back reserved amount on error ===
          this.localUsdcBalance += reservedAmount;

          // Console log exception
          this.logger.error(
            `❌ EXCEPTION during order placement - Strategy: ${opportunity.strategy}`,
            error.stack
          );
          this.logger.error(
            `   Orders attempted: ${batchOrders.length}, Size: ${size}, Reserved: ${reservedAmount.toFixed(2)} USDC`
          );

          // Send Telegram notification (fire & forget)
          this.telegramService.notifyOrderFilled({
            success: false,
            strategy: opportunity.strategy,
            error: error.message,
            latencyMs,
            balance: this.localUsdcBalance,
            reserved: reservedAmount,
          }).catch(() => {
            // Silent fail for telegram notifications
          });

          // Save trade result to database (async)
          const tradeResult: RealTradeResult = {
            signalId: 'pending',
            success: false,
            error: error.message,
            totalCost,
            expectedPnl: opportunity.profitAbs,
            timestampMs: Date.now(),
          };

          this.saveTradeResultAsync(opportunity, tradeResult).catch((dbError) => {
            this.logger.error(
              `Failed to save trade result to DB: ${dbError.message}`,
            );
          });

          // === UNLOCK: Release order submission lock ===
          this.isSubmittingOrder = false;
        });
    } catch (error: any) {
      this.logger.error(
        `Failed to handle opportunity: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Validate opportunity and return skip decision with calculated values
   * Returns shouldSkip=true if opportunity should be rejected
   */
  private shouldSkipOpportunity(opportunity: ArbOpportunity): {
    shouldSkip: boolean;
    candidates?: OrderCandidate[];
    size?: number;
    requiredCost?: number;
    totalCost?: number;
  } {
    // === CHECK: Skip if trading is disabled ===
    if (!this.runtimeEnabled) {
      return { shouldSkip: true };
    }

    // === CHECK: Skip if already submitting an order ===
    if (this.isSubmittingOrder) {
      return { shouldSkip: true };
    }

    // === CHECK: Skip if within 5 second timeout from last opportunity ===
    const now = Date.now();
    const timeSinceLastOpportunity = now - this.lastOpportunityExecutedAt;
    if (this.lastOpportunityExecutedAt > 0 && timeSinceLastOpportunity < OPPORTUNITY_TIMEOUT_MS) {
      const remainingMs = OPPORTUNITY_TIMEOUT_MS - timeSinceLastOpportunity;
      this.logger.debug(
        `Skipping opportunity: timeout (${remainingMs}ms remaining until next opportunity)`
      );
      return { shouldSkip: true };
    }

    // === FAST PATH: All synchronous calculations ===
    const totalCost = this.calculateTotalCost(opportunity);
    const pnlPercent = (opportunity.profitAbs / totalCost) * 100;

    // Check PnL threshold (synchronous)
    if (pnlPercent < this.minPnlThresholdPercent) {
      this.logger.debug(`pnlPercent: ${pnlPercent} < ${this.minPnlThresholdPercent}%`);
      return { shouldSkip: true };
    }

    // === Calculate order size using cached balance (NO awaits) ===
    const candidates = this.buildOrderCandidates(opportunity);
    if (candidates.length === 0) {
      return { shouldSkip: true };
    }

    const size = this.calculateFillSizeSync(candidates, opportunity.groupKey);

    // Validate size: must be finite, positive, and >= 5 (Polymarket minimum)
    if (!Number.isFinite(size) || size < 5) {
      if (size > 0 && size < 5) {
        this.logger.debug(
          `Order size ${size} is below Polymarket minimum (5). Skip opportunity.`,
        );
      }
      return { shouldSkip: true };
    }

    // === Check if localUsdcBalance is sufficient ===
    const requiredCost = this.estimateRequiredCost(candidates, size);
    if (this.localUsdcBalance < requiredCost) {
      return { shouldSkip: true };
    }

    // All checks passed - return calculated values
    return {
      shouldSkip: false,
      candidates,
      size,
      requiredCost,
      totalCost,
    };
  }


  /**
   * Get the appropriate spread/tick size based on price
   * Following Polymarket tick size mechanism:
   * - Normal: 0.01 (1 cent) when price is between 0.04 and 0.96
   * - Extreme: 0.001 (0.1 cent) when price >= 0.96 or price <= 0.04
   */
  private getSpreadForPrice(price: number): number {
    if (price >= SLIPPAGE_EXTREME_THRESHOLD_HIGH || price <= SLIPPAGE_EXTREME_THRESHOLD_LOW) {
      return EXTREME_SPREAD;
    }
    return NORMAL_SPREAD;
  }

  /**
   * Apply slippage to order price based on side
   * - BUY: Add spread (pay higher price to ensure fill)
   * - SELL: Subtract spread (accept lower price to ensure fill)
   * 
   * Important: Slippage should NEVER make the price worse for filling:
   * - BUY: adjusted price should be >= original price (willing to pay more, not less)
   * - SELL: adjusted price should be <= original price (accepting less, not demanding more)
   * 
   * Key rules:
   * - BUY: Final price = max(original_price, min(original_price + spread, MAX_PRICE))
   *   This ensures we never bid BELOW the best ask (which would prevent fill)
   * - SELL: Final price = min(original_price, max(original_price - spread, MIN_PRICE))
   *   This ensures we never ask ABOVE the best bid (which would prevent fill)
   */
  private applySlippage(price: number, side: 'BUY' | 'SELL'): number {
    if (!this.slippageEnabled) {
      return price;
    }

    const spread = this.getSpreadForPrice(price);

    if (side === 'BUY') {
      // BUY: Add spread to best ask (willing to pay more to ensure fill)
      // Cap at MAX_PRICE, but NEVER go below original price
      const withSlippage = Math.min(price + spread, MAX_PRICE);
      // Ensure we always pay at least the original ask price
      return Math.max(price, withSlippage);
    } else {
      // SELL: Subtract spread from best bid (accept lower price to ensure fill)
      // Floor at MIN_PRICE, but NEVER go above original price
      const withSlippage = Math.max(price - spread, MIN_PRICE);
      // Ensure we never ask more than the original bid price
      return Math.min(price, withSlippage);
    }
  }

  /**
   * Prepare batch orders from candidates with price adjustments
   * Synchronous - no awaits
   * Applies slippage and minimum order value adjustments
   */
  private prepareBatchOrdersSync(
    candidates: OrderCandidate[],
    size: number,
  ): BatchOrderParams[] {
    // Build batch orders with slippage applied
    const orders = candidates.map((candidate) => {
      // Apply slippage to price if enabled
      const slippageAdjustedPrice = this.applySlippage(candidate.price, candidate.side);

      return {
        tokenID: candidate.tokenID,
        price: slippageAdjustedPrice,
        size,
        side: candidate.side,
        feeRateBps: 0,
        orderType: 'GTC' as const,
        negRisk: candidate.negRisk,
      };
    });

    // Adjust prices to meet minimum order value ($1) for test mode
    const adjustedOrders = this.enforceMinOrderValue
      ? orders.map((order) => {
        const orderValue = order.size * order.price;

        if (orderValue < MIN_ORDER_VALUE && order.side === 'BUY') {
          const adjustedPrice = MIN_ORDER_VALUE / order.size;
          // Cap at MAX_PRICE for probability markets (can't be >= 1.0)
          const finalPrice = Math.min(adjustedPrice, MAX_PRICE);

          return {
            ...order,
            price: finalPrice,
          };
        }

        return order;
      })
      : orders;

    return adjustedOrders;
  }

  /**
   * Synchronous fill size calculation using cached balances (HFT optimized)
   * NO awaits - uses localUsdcBalance and mintedAssetCacheByGroup
   * Returns 0 immediately if any size candidate is 0 (insufficient liquidity)
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
        const legSize = Math.min(sizeFromCash, bookCap);

        // Early return if any leg has 0 size
        if (legSize <= 0) {
          return 0;
        }

        sizeCandidates.push(legSize);
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
        const legSize = Math.min(mintedAvailable, bookCap);

        // Early return if any leg has 0 size
        if (legSize <= 0) {
          return 0;
        }

        sizeCandidates.push(legSize);
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
   * Calculate actual total cost for batch orders including both BUY and SELL legs
   * For BUY: cost = price * size
   * For SELL: cost = (1 - price) * size (minting cost)
   */
  private calculateActualCost(
    orders: BatchOrderParams[],
    size: number,
  ): number {
    let totalCost = 0;
    for (const order of orders) {
      if (order.side === 'BUY') {
        totalCost += order.price * size;
      } else {
        // SELL requires minting: cost is (1 - price) per token
        totalCost += (1 - order.price) * size;
      }
    }
    return totalCost;
  }

  /**
   * Build mapping from tokenID to marketSlug for all tokens in opportunity
   */
  private buildTokenToMarketSlugMap(
    opportunity: ArbOpportunity,
  ): Map<string, string> {
    const map = new Map<string, string>();

    // Add parent token
    if (opportunity.parent.assetId && opportunity.parent.marketSlug) {
      map.set(opportunity.parent.assetId, opportunity.parent.marketSlug);
    }

    // Add parent upper token
    if (opportunity.parentUpper?.assetId && opportunity.parentUpper.marketSlug) {
      map.set(opportunity.parentUpper.assetId, opportunity.parentUpper.marketSlug);
    }

    // Add children tokens
    for (const child of opportunity.children) {
      if (child.assetId && child.marketSlug) {
        map.set(child.assetId, child.marketSlug);
      }
    }

    return map;
  }

  /**
   * Queue SELL signals for minting replenishment
   * Simply sends assetId (tokenID) to queue for each successful SELL order
   * Processor will query database by assetId to get market details
   */
  private queueMintForSellSignals(
    orders: BatchOrderParams[],
    results: BatchOrderResult[] | undefined,
  ): void {
    if (!results || orders.length === 0) {
      return;
    }

    const queuedAssets = new Set<string>();

    results.forEach((res, idx) => {
      const order = orders[idx];

      // Only process successful SELL orders
      if (!res?.success || order?.side !== 'SELL') {
        return;
      }

      // Skip duplicates
      if (queuedAssets.has(order.tokenID)) {
        return;
      }
      queuedAssets.add(order.tokenID);

      // Queue for minting (fire & forget) - send assetId directly
      this.mintQueueService.addToQueue(order.tokenID, this.defaultSize).catch(() => { });
    });
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
    // TEMPORARILY DISABLED: POLYMARKET_TRIANGLE_SELL strategy
    // Logic: Must mint all legs first (cost = payout), then sell them (revenue = totalBid)
    // Cost = payout (collateral to mint)
    // Revenue = totalBid (already reflected in profitAbs)
    // if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
    //   const ctx = opportunity.polymarketTriangleContext;
    //   const payout = ctx?.payout || 0; // Total Collateral needed to mint all legs

    //   // Cost is the payout (amount needed to mint)
    //   // The revenue (totalBid) is already calculated in profitAbs
    //   return payout;
    // }

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

    // Polymarket minimum order size is 5
    if (size < 5) {
      this.logger.warn(
        `Order size ${size} is below Polymarket minimum (5). Skip placing orders.`,
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
    if (orders.length > MAX_BATCH_SIZE) {
      this.logger.warn(
        `Batch size ${orders.length} exceeds limit ${MAX_BATCH_SIZE}. Truncating.`,
      );
      return orders.slice(0, MAX_BATCH_SIZE);
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
          negRisk: opportunity.parent.descriptor.negRisk,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            side: 'BUY',
            orderbookSize: child.bestAskSize,
            negRisk: child.descriptor.negRisk,
          });
        }
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestAsk) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parentUpper.bestAskSize,
          negRisk: opportunity.parentUpper.descriptor.negRisk,
        });
      }
    } else if (strategy === 'BUY_PARENT_SELL_CHILDREN') {
      if (opportunity.parent.assetId && opportunity.parent.bestAsk) {
        orders.push({
          tokenID: opportunity.parent.assetId,
          price: opportunity.parent.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parent.bestAskSize,
          negRisk: opportunity.parent.descriptor.negRisk,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestBid) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestBid,
            side: 'SELL',
            orderbookSize: child.bestBidSize,
            negRisk: child.descriptor.negRisk,
          });
        }
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestBid) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestBid,
          side: 'SELL',
          orderbookSize: opportunity.parentUpper.bestBidSize,
          negRisk: opportunity.parentUpper.descriptor.negRisk,
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
          negRisk: opportunity.parent.descriptor.negRisk,
        });
      }

      if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestAsk) {
        orders.push({
          tokenID: opportunity.parentUpper.assetId,
          price: opportunity.parentUpper.bestAsk,
          side: 'BUY',
          orderbookSize: opportunity.parentUpper.bestAskSize,
          negRisk: opportunity.parentUpper.descriptor.negRisk,
        });
      }

      for (const child of opportunity.children) {
        if (child.assetId && child.bestAsk) {
          orders.push({
            tokenID: child.assetId,
            price: child.bestAsk,
            side: 'BUY',
            orderbookSize: child.bestAskSize,
            negRisk: child.descriptor.negRisk,
          });
        }
      }
    }
    // TEMPORARILY DISABLED: POLYMARKET_TRIANGLE_SELL strategy
    // else if (strategy === 'POLYMARKET_TRIANGLE_SELL') {
    //   if (opportunity.parent.assetId && opportunity.parent.bestBid) {
    //     orders.push({
    //       tokenID: opportunity.parent.assetId,
    //       price: opportunity.parent.bestBid,
    //       side: 'SELL',
    //       orderbookSize: opportunity.parent.bestBidSize,
    //     });
    //   }

    //   if (opportunity.parentUpper?.assetId && opportunity.parentUpper.bestBid) {
    //     orders.push({
    //       tokenID: opportunity.parentUpper.assetId,
    //       price: opportunity.parentUpper.bestBid,
    //       side: 'SELL',
    //       orderbookSize: opportunity.parentUpper.bestBidSize,
    //     });
    //   }

    //   for (const child of opportunity.children) {
    //     if (child.assetId && child.bestBid) {
    //       orders.push({
    //         tokenID: child.assetId,
    //         price: child.bestBid,
    //         side: 'SELL',
    //         orderbookSize: child.bestBidSize,
    //       });
    //     }
    //   }
    // }

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
   * Save signal to database asynchronously (non-blocking)
   */
  private async saveSignalAsync(opportunity: ArbOpportunity): Promise<string> {
    try {
      const signal = await this.saveSignal(opportunity);
      return signal.id;
    } catch (error) {
      this.logger.error(
        `Error in saveSignalAsync: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Save trade result to database asynchronously (non-blocking)
   * Returns the saved trade entity with ID
   */
  private async saveTradeResultAsync(
    opportunity: ArbOpportunity,
    tradeResult: RealTradeResult,
  ): Promise<ArbRealTrade> {
    try {
      // Get or create signal
      const signal = await this.saveSignal(opportunity);

      // Update trade result with real signal ID
      tradeResult.signalId = signal.id;

      // Save trade result
      const savedTrade = await this.saveRealTrade(tradeResult);
      return savedTrade;
    } catch (error) {
      this.logger.error(
        `Error in saveTradeResultAsync: ${error.message}`,
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
      errorMessages: result.errorMessages,
      totalCost: this.toFiniteOrNull(result.totalCost) ?? 0,
      expectedPnl: this.toFiniteOrNull(result.expectedPnl) ?? 0,
      timestampMs: result.timestampMs,
    });

    return await this.arbRealTradeRepository.save(realTrade);
  }

  /**
   * Enable real trading at runtime (also enables slippage)
   */
  enableTrading(): { success: boolean; message: string; enabled: boolean; slippageEnabled: boolean } {
    this.runtimeEnabled = true;
    // this.slippageEnabled = true;
    this.logger.log('Real trading ENABLED via API (slippage: ON)');
    return {
      success: true,
      message: 'Real trading has been enabled with slippage',
      enabled: true,
      slippageEnabled: true,
    };
  }

  /**
   * Disable real trading at runtime (also disables slippage)
   */
  disableTrading(): { success: boolean; message: string; enabled: boolean; slippageEnabled: boolean } {
    this.runtimeEnabled = false;
    this.slippageEnabled = false;
    this.logger.log('Real trading DISABLED via API (slippage: OFF)');
    return {
      success: true,
      message: 'Real trading has been disabled with slippage',
      enabled: false,
      slippageEnabled: false,
    };
  }

  /**
   * Enable slippage independently
   */
  enableSlippage(): { success: boolean; message: string; slippageEnabled: boolean } {
    this.slippageEnabled = true;
    this.logger.log('Slippage ENABLED via API');
    return {
      success: true,
      message: 'Slippage has been enabled',
      slippageEnabled: true,
    };
  }

  /**
   * Disable slippage independently
   */
  disableSlippage(): { success: boolean; message: string; slippageEnabled: boolean } {
    this.slippageEnabled = false;
    this.logger.log('Slippage DISABLED via API');
    return {
      success: true,
      message: 'Slippage has been disabled',
      slippageEnabled: false,
    };
  }

  /**
   * Get current trading status and configuration
   */
  getTradingStatus(): {
    enabled: boolean;
    runtimeEnabled: boolean;
    slippageEnabled: boolean;
    config: {
      minPnlThresholdPercent: number;
      defaultSize: number;
      maxBatchSize: number;
      opportunityTimeoutMs: number;
      balanceRefreshMs: number;
      mintedRefreshMs: number;
      slippage: {
        normalSpread: number;
        extremeSpread: number;
        extremeThresholdHigh: number;
        extremeThresholdLow: number;
      };
    };
    state: {
      isSubmittingOrder: boolean;
      localUsdcBalance: number;
      cachedUsdcBalance?: number;
      lastOpportunityExecutedAt: number;
      timeSinceLastOpportunity: number;
    };
  } {
    const now = Date.now();
    return {
      enabled: this.enabled,
      runtimeEnabled: this.runtimeEnabled,
      slippageEnabled: this.slippageEnabled,
      config: {
        minPnlThresholdPercent: this.minPnlThresholdPercent,
        defaultSize: this.defaultSize,
        maxBatchSize: MAX_BATCH_SIZE,
        opportunityTimeoutMs: OPPORTUNITY_TIMEOUT_MS,
        balanceRefreshMs: BALANCE_REFRESH_MS,
        mintedRefreshMs: MINTED_REFRESH_MS,
        slippage: {
          normalSpread: NORMAL_SPREAD,
          extremeSpread: EXTREME_SPREAD,
          extremeThresholdHigh: SLIPPAGE_EXTREME_THRESHOLD_HIGH,
          extremeThresholdLow: SLIPPAGE_EXTREME_THRESHOLD_LOW,
        },
      },
      state: {
        isSubmittingOrder: this.isSubmittingOrder,
        localUsdcBalance: this.localUsdcBalance,
        cachedUsdcBalance: this.cachedUsdcBalance,
        lastOpportunityExecutedAt: this.lastOpportunityExecutedAt,
        timeSinceLastOpportunity: this.lastOpportunityExecutedAt > 0
          ? now - this.lastOpportunityExecutedAt
          : 0,
      },
    };
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

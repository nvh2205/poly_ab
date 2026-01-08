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
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';
import { ArbitrageEngineService } from './arbitrage-engine.service';
import { ArbOpportunity } from './interfaces/arbitrage.interface';

interface PaperFill {
  assetId: string;
  marketSlug?: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  index?: number;
}

interface PaperTradeResult {
  signalId: string;
  filledSize: number;
  entry: {
    strategy: string;
    parentAssetId: string;
    childrenAssetIds: string[];
    timestampMs: number;
  };
  fills: PaperFill[];
  pnlAbs: number;
  pnlBps: number;
  latencyMs: number;
  timestampMs: number;
}

@Injectable()
export class PaperExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperExecutionService.name);
  private opportunitySub?: Subscription;

  private readonly defaultSize = this.numFromEnv('PAPER_TRADE_SIZE', 100);
  private readonly simulatedLatencyMs = this.numFromEnv(
    'PAPER_TRADE_LATENCY_MS',
    50,
  );

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbPaperTrade)
    private readonly arbPaperTradeRepository: Repository<ArbPaperTrade>,
    private readonly arbitrageEngineService: ArbitrageEngineService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.opportunitySub = this.arbitrageEngineService
      .onOpportunity()
      .subscribe((opportunity) => this.handleOpportunity(opportunity));

    this.logger.log('PaperExecutionService initialized');
  }

  onModuleDestroy(): void {
    if (this.opportunitySub) {
      this.opportunitySub.unsubscribe();
    }
  }

  private async handleOpportunity(
    opportunity: ArbOpportunity,
  ): Promise<void> {
    try {

      // Log full opportunity details for debugging
      this.logger.debug(
        `Opportunity received: ${JSON.stringify({
          strategy: opportunity.strategy,
          groupKey: opportunity.groupKey,
          profitAbs: opportunity.profitAbs,
          profitBps: opportunity.profitBps,
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
          })),
          timestampMs: opportunity.timestampMs,
        }, null, 2)}`,
      );

      // 1. Save signal to database
      const signal = await this.saveSignal(opportunity);

      // 2. Simulate paper trade execution
      const tradeResult = await this.simulateTrade(opportunity, signal.id);

      // 3. Save paper trade result
      await this.savePaperTrade(tradeResult);

      this.logger.log(
        `Paper trade executed: ${opportunity.strategy} on ${opportunity.groupKey}, ` +
          `profit: ${tradeResult.pnlAbs.toFixed(4)} (${tradeResult.pnlBps.toFixed(2)} bps)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle opportunity: ${error.message}`,
        error.stack,
      );
    }
  }

  private async saveSignal(
    opportunity: ArbOpportunity,
  ): Promise<ArbSignal> {
    // Debug log opportunity sizes before save
    this.logger.debug(
      `Saving signal with sizes - Parent: bid=${opportunity.parent.bestBidSize}, ask=${opportunity.parent.bestAskSize}, ` +
      `Children: ${opportunity.children.map(c => `bid=${c.bestBidSize},ask=${c.bestAskSize}`).join('; ')}`
    );

    // Build comprehensive snapshot with YES/NO data for binary chill
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

    // Add comprehensive YES/NO token details for binary chill strategies
    if (opportunity.binaryChillContext) {
      const child = opportunity.children[0];
      const parent = opportunity.parent;
      const ctx = opportunity.binaryChillContext;

      snapshot.binaryChillDetails = {
        strategy: opportunity.strategy,
        child: {
          marketId: child.descriptor.marketId,
          slug: child.descriptor.slug,
          kind: child.descriptor.kind,
          bounds: child.descriptor.bounds,
          // Token IDs
          yesTokenId: ctx.childYesTokenId,
          noTokenId: ctx.childNoTokenId,
          // YES token prices
          bestBidYes: ctx.childBestBidYes,
          bestAskYes: ctx.childBestAskYes,
          // NO token prices (real data from orderbook!)
          bestBidNo: ctx.childBestBidNo,
          bestAskNo: ctx.childBestAskNo,
        },
        parent: {
          marketId: parent.descriptor.marketId,
          slug: parent.descriptor.slug,
          kind: parent.descriptor.kind,
          bounds: parent.descriptor.bounds,
          // Token IDs
          yesTokenId: ctx.parentYesTokenId,
          noTokenId: ctx.parentNoTokenId,
          // YES token prices
          bestBidYes: ctx.parentBestBidYes,
          bestAskYes: ctx.parentBestAskYes,
          // NO token prices (real data from orderbook!)
          bestBidNo: ctx.parentBestBidNo,
          bestAskNo: ctx.parentBestAskNo,
        },
        pricing: {
          buyPrice: opportunity.childrenSumAsk,
          sellPrice: opportunity.childrenSumBid,
          profitAbs: opportunity.profitAbs,
          profitBps: opportunity.profitBps,
        },
        // Add validation: check if price_YES + price_NO ≈ 1
        validation: {
          childPriceSum:
            ctx.childBestAskYes && ctx.childBestBidNo
              ? ctx.childBestAskYes + ctx.childBestBidNo
              : null,
          parentPriceSum:
            ctx.parentBestAskYes && ctx.parentBestBidNo
              ? ctx.parentBestAskYes + ctx.parentBestBidNo
              : null,
        },
      };
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
      tokenType: opportunity.tokenType || 'yes', // Default to 'yes' for backward compatibility
      rangeI: opportunity.parent.coverage.startIndex,
      rangeJ: opportunity.parent.coverage.endIndex,
      parentBestBid: this.toFiniteOrNull(opportunity.parentBestBid),
      parentBestAsk: this.toFiniteOrNull(opportunity.parentBestAsk),
      parentBestBidSize: this.toFiniteOrNull(opportunity.parent.bestBidSize),
      parentBestAskSize: this.toFiniteOrNull(opportunity.parent.bestAskSize),
      parentUpperBestBid: this.toFiniteOrNull(opportunity.parentUpperBestBid),
      parentUpperBestAsk: this.toFiniteOrNull(opportunity.parentUpperBestAsk),
      parentUpperBestBidSize: this.toFiniteOrNull(opportunity.parentUpper?.bestBidSize),
      parentUpperBestAskSize: this.toFiniteOrNull(opportunity.parentUpper?.bestAskSize),
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

  private async simulateTrade(
    opportunity: ArbOpportunity,
    signalId: string,
  ): Promise<PaperTradeResult> {
    const startTime = Date.now();

    // Simulate latency
    await this.sleep(this.simulatedLatencyMs);

    const fills: PaperFill[] = [];

    // Build fills based on strategy
    if (opportunity.strategy === 'SELL_PARENT_BUY_CHILDREN') {
      // Unbundling: Short parent lower, Long children + Long parent upper
      // Sell parent lower at bid
      if (opportunity.parent.bestBid && opportunity.parent.bestBid > 0) {
        fills.push({
          assetId: opportunity.parent.assetId || '',
          marketSlug: opportunity.parent.marketSlug,
          side: 'sell',
          price: opportunity.parent.bestBid,
          size: opportunity.parent.bestBidSize || this.defaultSize,
        });
      }

      // Buy children at ask
      opportunity.children.forEach((child) => {
        if (child.bestAsk && child.bestAsk > 0) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'buy',
            price: child.bestAsk,
            size: child.bestAskSize || this.defaultSize,
            index: child.index,
          });
        }
      });

      // Buy parent upper at ask (if exists)
      if (opportunity.parentUpper?.bestAsk && opportunity.parentUpper.bestAsk > 0) {
        fills.push({
          assetId: opportunity.parentUpper.assetId || '',
          marketSlug: opportunity.parentUpper.marketSlug,
          side: 'buy',
          price: opportunity.parentUpper.bestAsk,
          size: opportunity.parentUpper.bestAskSize || this.defaultSize,
        });
      }
    } else if (opportunity.strategy === 'BUY_PARENT_SELL_CHILDREN') {
      // Bundling: Long parent lower, Short children + Short parent upper
      // Buy parent lower at ask
      if (opportunity.parent.bestAsk && opportunity.parent.bestAsk > 0) {
        fills.push({
          assetId: opportunity.parent.assetId || '',
          marketSlug: opportunity.parent.marketSlug,
          side: 'buy',
          price: opportunity.parent.bestAsk,
          size: opportunity.parent.bestAskSize || this.defaultSize,
        });
      }

      // Sell children at bid
      opportunity.children.forEach((child) => {
        if (child.bestBid && child.bestBid > 0) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'sell',
            price: child.bestBid,
            size: child.bestBidSize || this.defaultSize,
            index: child.index,
          });
        }
      });

      // Sell parent upper at bid (if exists)
      if (opportunity.parentUpper?.bestBid && opportunity.parentUpper.bestBid > 0) {
        fills.push({
          assetId: opportunity.parentUpper.assetId || '',
          marketSlug: opportunity.parentUpper.marketSlug,
          side: 'sell',
          price: opportunity.parentUpper.bestBid,
          size: opportunity.parentUpper.bestBidSize || this.defaultSize,
        });
      }
    } else if (
      opportunity.strategy === 'POLYMARKET_TRIANGLE' ||
      opportunity.strategy === 'POLYMARKET_TRIANGLE_BUY' ||
      opportunity.strategy === 'POLYMARKET_TRIANGLE_SELL'
    ) {
      const mode =
        opportunity.strategy === 'POLYMARKET_TRIANGLE_SELL'
          ? 'SELL'
          : opportunity.strategy === 'POLYMARKET_TRIANGLE_BUY'
            ? 'BUY'
            : opportunity.polymarketTriangleContext?.mode || 'BUY';
      const payoutPerUnit =
        opportunity.polymarketTriangleContext?.payout ??
        (opportunity.children.length + 1);

      if (mode === 'BUY') {
        // Buy all legs at ask, receive synthetic payout
        if (opportunity.parent.bestAsk && opportunity.parent.bestAsk > 0 && opportunity.parent.bestAskSize) {
          fills.push({
            assetId: opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'buy',
            price: opportunity.parent.bestAsk,
            size: opportunity.parent.bestAskSize,
          });
        }

        if (opportunity.parentUpper?.bestAsk && opportunity.parentUpper.bestAsk > 0 && opportunity.parentUpper.bestAskSize) {
          fills.push({
            assetId: opportunity.parentUpper.assetId || '',
            marketSlug: opportunity.parentUpper.marketSlug,
            side: 'buy',
            price: opportunity.parentUpper.bestAsk,
            size: opportunity.parentUpper.bestAskSize,
          });
        }

        opportunity.children.forEach((child) => {
          if (child.bestAsk && child.bestAsk > 0 && child.bestAskSize) {
            fills.push({
              assetId: child.assetId || '',
              marketSlug: child.marketSlug,
              side: 'buy',
              price: child.bestAsk,
              size: child.bestAskSize,
              index: child.index,
            });
          }
        });

        // Synthetic payout leg (receive 1 per outcome unit)
        if (fills.length > 0) {
          // placeholder; real payout handled separately
        }
      } else {
        // SELL mode: short all legs at bid, pay synthetic payout
        if (opportunity.parent.bestBid && opportunity.parent.bestBid > 0 && opportunity.parent.bestBidSize) {
          fills.push({
            assetId: opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'sell',
            price: opportunity.parent.bestBid,
            size: opportunity.parent.bestBidSize,
          });
        }

        if (opportunity.parentUpper?.bestBid && opportunity.parentUpper.bestBid > 0 && opportunity.parentUpper.bestBidSize) {
          fills.push({
            assetId: opportunity.parentUpper.assetId || '',
            marketSlug: opportunity.parentUpper.marketSlug,
            side: 'sell',
            price: opportunity.parentUpper.bestBid,
            size: opportunity.parentUpper.bestBidSize,
          });
        }

        opportunity.children.forEach((child) => {
          if (child.bestBid && child.bestBid > 0 && child.bestBidSize) {
            fills.push({
              assetId: child.assetId || '',
              marketSlug: child.marketSlug,
              side: 'sell',
              price: child.bestBid,
              size: child.bestBidSize,
              index: child.index,
            });
          }
        });
      }
    } else if (
      opportunity.strategy === 'BUY_CHILD_YES_SELL_PARENT_NO' ||
      opportunity.strategy === 'BUY_PARENT_NO_SELL_CHILD_YES' ||
      opportunity.strategy === 'BUY_CHILD_YES_SELL_PARENT_YES' ||
      opportunity.strategy === 'BUY_PARENT_NO_SELL_CHILD_NO'
    ) {
      // Binary chill strategies - xử lý dựa trên chiều cụ thể
      const child = opportunity.children[0]; // Binary chill chỉ có 1 child

      const ctx = opportunity.binaryChillContext;

      if (opportunity.strategy === 'BUY_CHILD_YES_SELL_PARENT_NO') {
        // Case 1A: Buy YES(child), Sell NO(parent)
        // Buy child YES at ask
        if (child?.bestAsk && child.bestAsk > 0) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'buy',
            price: child.bestAsk,
            size: ctx?.childBestAskSizeYes || child.bestAskSize || this.defaultSize,
            index: child.index,
          });
        }

        // Sell parent NO at bid (use real NO token data if available)
        if (ctx?.parentBestBidNo !== undefined && ctx.parentBestBidNo > 0) {
          fills.push({
            assetId: ctx.parentNoTokenId || opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'sell',
            price: ctx.parentBestBidNo,
            size: ctx?.parentBestBidSizeNo || this.defaultSize,
          });
        }
      } else if (opportunity.strategy === 'BUY_PARENT_NO_SELL_CHILD_YES') {
        // Case 1B: Buy NO(parent), Sell YES(child)
        // Buy parent NO at ask (use real NO token data if available)
        if (ctx?.parentBestAskNo !== undefined && ctx.parentBestAskNo > 0) {
          fills.push({
            assetId: ctx.parentNoTokenId || opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'buy',
            price: ctx.parentBestAskNo,
            size: ctx?.parentBestAskSizeNo || this.defaultSize,
          });
        }

        // Sell child YES at bid
        if (child?.bestBid && child.bestBid > 0) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'sell',
            price: child.bestBid,
            size: ctx?.childBestBidSizeYes || child.bestBidSize || this.defaultSize,
            index: child.index,
          });
        }
      } else if (opportunity.strategy === 'BUY_CHILD_YES_SELL_PARENT_YES') {
        // Case 2A: Buy YES(child), Sell YES(parent)
        // Buy child YES at ask
        if (child?.bestAsk && child.bestAsk > 0) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'buy',
            price: child.bestAsk,
            size: ctx?.childBestAskSizeYes || child.bestAskSize || this.defaultSize,
            index: child.index,
          });
        }

        // Sell parent YES at bid
        if (opportunity.parent.bestBid && opportunity.parent.bestBid > 0) {
          fills.push({
            assetId: opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'sell',
            price: opportunity.parent.bestBid,
            size: ctx?.parentBestBidSizeYes || opportunity.parent.bestBidSize || this.defaultSize,
          });
        }
      } else if (opportunity.strategy === 'BUY_PARENT_NO_SELL_CHILD_NO') {
        // Case 2B: Buy NO(parent), Sell NO(child)
        // Buy parent NO at ask (use real NO token data if available)
        if (ctx?.parentBestAskNo !== undefined && ctx.parentBestAskNo > 0) {
          fills.push({
            assetId: ctx.parentNoTokenId || opportunity.parent.assetId || '',
            marketSlug: opportunity.parent.marketSlug,
            side: 'buy',
            price: ctx.parentBestAskNo,
            size: ctx?.parentBestAskSizeNo || this.defaultSize,
          });
        }

        // Sell child NO at bid (use real NO token data if available)
        if (ctx?.childBestBidNo !== undefined && ctx.childBestBidNo > 0) {
          fills.push({
            assetId: ctx.childNoTokenId || child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'sell',
            price: ctx.childBestBidNo,
            size: ctx?.childBestBidSizeNo || this.defaultSize,
            index: child.index,
          });
        }
      }
    }

    // Tính filled size = min size của tất cả fills
    // Trong arbitrage, nếu một leg không fill đủ, toàn bộ position phải giảm
    const filledSize = fills.length > 0
      ? Math.min(...fills.map(f => f.size))
      : 0;

    // Adjust tất cả fills về filledSize
    fills.forEach(fill => {
      fill.size = filledSize;
    });

    // Với polymarket triangle, thêm leg settlement giả định payout
    if (
      (opportunity.strategy === 'POLYMARKET_TRIANGLE' ||
        opportunity.strategy === 'POLYMARKET_TRIANGLE_BUY' ||
        opportunity.strategy === 'POLYMARKET_TRIANGLE_SELL') &&
      filledSize > 0
    ) {
      const payoutPerUnit =
        opportunity.polymarketTriangleContext?.payout ??
        (opportunity.children.length + 1);
      const mode =
        opportunity.strategy === 'POLYMARKET_TRIANGLE_SELL'
          ? 'SELL'
          : opportunity.strategy === 'POLYMARKET_TRIANGLE_BUY'
            ? 'BUY'
            : opportunity.polymarketTriangleContext?.mode || 'BUY';
      fills.push({
        assetId: 'synthetic-payout',
        marketSlug: opportunity.eventSlug,
        side: mode === 'BUY' ? 'sell' : 'buy',
        price: payoutPerUnit,
        size: filledSize,
      });
    }

    // Calculate PnL với filled size thực tế
    const { pnlAbs, pnlBps } = this.calculatePnL(
      fills,
      opportunity.strategy,
      filledSize,
    );

    const latencyMs = Date.now() - startTime;

    return {
      signalId,
      filledSize,
      entry: {
        strategy: opportunity.strategy,
        parentAssetId: opportunity.parent.assetId || '',
        childrenAssetIds: opportunity.children
          .map((c) => c.assetId)
          .filter((id): id is string => !!id),
        timestampMs: opportunity.timestampMs,
      },
      fills,
      pnlAbs,
      pnlBps,
      latencyMs,
      timestampMs: Date.now(),
    };
  }

  private calculatePnL(
    fills: PaperFill[],
    strategy: string,
    size: number,
  ): { pnlAbs: number; pnlBps: number } {
    // Tính cash flow dựa trên buy/sell
    // Sell = nhận tiền (+), Buy = trả tiền (-)
    let cashFlow = 0;

    fills.forEach((fill) => {
      const amount = fill.price * fill.size;
      
      if (fill.side === 'sell') {
        cashFlow += amount; // Nhận tiền khi bán
      } else if (fill.side === 'buy') {
        cashFlow -= amount; // Trả tiền khi mua
      }
    });

    // Tính total invested (tổng số tiền đầu tư vào - chỉ tính buy side)
    const totalInvested = fills
      .filter(f => f.side === 'buy')
      .reduce((sum, f) => sum + (f.price * f.size), 0);

    const pnlAbs = cashFlow;
    const pnlBps = totalInvested > 0 ? (pnlAbs / totalInvested) * 10_000 : 0;

    return { pnlAbs, pnlBps };
  }

  private async savePaperTrade(
    result: PaperTradeResult,
  ): Promise<ArbPaperTrade> {
    const paperTrade = this.arbPaperTradeRepository.create({
      signalId: result.signalId,
      filledSize: result.filledSize,
      entry: result.entry,
      fills: result.fills,
      pnlAbs: result.pnlAbs,
      pnlBps: result.pnlBps,
      latencyMs: result.latencyMs,
      timestampMs: result.timestampMs,
    });

    return await this.arbPaperTradeRepository.save(paperTrade);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private numFromEnv(key: string, defaultValue: number): number {
    const raw = process.env[key];
    if (!raw) return defaultValue;
    const num = Number(raw);
    return Number.isFinite(num) ? num : defaultValue;
  }

  /**
   * Convert value to finite number or null
   * Handles NaN, Infinity, undefined gracefully for database storage
   */
  private toFiniteOrNull(value: number | undefined | null): number | null {
    if (value === undefined || value === null) return null;
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Get recent paper trades for analysis
   */
  async getRecentTrades(limit = 100): Promise<ArbPaperTrade[]> {
    return await this.arbPaperTradeRepository.find({
      order: { createdAt: 'DESC' },
      take: limit,
      relations: ['signal'],
    });
  }

  /**
   * Get paper trades by group key
   */
  async getTradesByGroup(
    groupKey: string,
    limit = 100,
  ): Promise<ArbPaperTrade[]> {
    return await this.arbPaperTradeRepository
      .createQueryBuilder('trade')
      .leftJoinAndSelect('trade.signal', 'signal')
      .where('signal.group_key = :groupKey', { groupKey })
      .orderBy('trade.created_at', 'DESC')
      .take(limit)
      .getMany();
  }

  /**
   * Get statistics for paper trading
   */
  async getStats(): Promise<{
    totalTrades: number;
    totalPnlAbs: number;
    avgPnlBps: number;
    winRate: number;
    avgLatencyMs: number;
  }> {
    const trades = await this.arbPaperTradeRepository.find();

    if (trades.length === 0) {
      return {
        totalTrades: 0,
        totalPnlAbs: 0,
        avgPnlBps: 0,
        winRate: 0,
        avgLatencyMs: 0,
      };
    }

    const totalPnlAbs = trades.reduce(
      (sum, t) => sum + Number(t.pnlAbs || 0),
      0,
    );
    const avgPnlBps =
      trades.reduce((sum, t) => sum + Number(t.pnlBps || 0), 0) /
      trades.length;
    const winningTrades = trades.filter((t) => Number(t.pnlAbs || 0) > 0);
    const winRate = winningTrades.length / trades.length;
    const avgLatencyMs =
      trades.reduce((sum, t) => sum + Number(t.latencyMs || 0), 0) /
      trades.length;

    return {
      totalTrades: trades.length,
      totalPnlAbs,
      avgPnlBps,
      winRate,
      avgLatencyMs,
    };
  }
}


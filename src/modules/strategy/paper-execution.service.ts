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
    const snapshot = {
      parent: {
        assetId: opportunity.parent.assetId,
        marketSlug: opportunity.parent.marketSlug,
        bestBid: opportunity.parent.bestBid,
        bestAsk: opportunity.parent.bestAsk,
        coverage: opportunity.parent.coverage,
      },
      children: opportunity.children.map((child) => ({
        index: child.index,
        assetId: child.assetId,
        marketSlug: child.marketSlug,
        bestBid: child.bestBid,
        bestAsk: child.bestAsk,
        bounds: child.descriptor.bounds,
      })),
    };

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
      rangeI: opportunity.parent.coverage.startIndex,
      rangeJ: opportunity.parent.coverage.endIndex,
      parentBestBid: opportunity.parentBestBid,
      parentBestAsk: opportunity.parentBestAsk,
      childrenSumAsk: opportunity.childrenSumAsk,
      childrenSumBid: opportunity.childrenSumBid,
      profitAbs: opportunity.profitAbs,
      profitBps: opportunity.profitBps,
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
    const size = this.defaultSize;

    // Build fills based on strategy
    if (opportunity.strategy === 'SELL_PARENT_BUY_CHILDREN') {
      // Sell parent at bid
      if (opportunity.parent.bestBid) {
        fills.push({
          assetId: opportunity.parent.assetId || '',
          marketSlug: opportunity.parent.marketSlug,
          side: 'sell',
          price: opportunity.parent.bestBid,
          size,
        });
      }

      // Buy children at ask
      opportunity.children.forEach((child) => {
        if (child.bestAsk) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'buy',
            price: child.bestAsk,
            size,
            index: child.index,
          });
        }
      });
    } else {
      // BUY_PARENT_SELL_CHILDREN
      // Buy parent at ask
      if (opportunity.parent.bestAsk) {
        fills.push({
          assetId: opportunity.parent.assetId || '',
          marketSlug: opportunity.parent.marketSlug,
          side: 'buy',
          price: opportunity.parent.bestAsk,
          size,
        });
      }

      // Sell children at bid
      opportunity.children.forEach((child) => {
        if (child.bestBid) {
          fills.push({
            assetId: child.assetId || '',
            marketSlug: child.marketSlug,
            side: 'sell',
            price: child.bestBid,
            size,
            index: child.index,
          });
        }
      });
    }

    // Calculate PnL
    const { pnlAbs, pnlBps } = this.calculatePnL(
      fills,
      opportunity.strategy,
      size,
    );

    const latencyMs = Date.now() - startTime;

    return {
      signalId,
      filledSize: size,
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
    let parentCost = 0;
    let childrenCost = 0;

    fills.forEach((fill) => {
      const cost = fill.price * fill.size;
      if (fill.index === undefined) {
        // Parent fill
        if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
          parentCost = cost; // We receive this
        } else {
          parentCost = -cost; // We pay this
        }
      } else {
        // Child fill
        if (strategy === 'SELL_PARENT_BUY_CHILDREN') {
          childrenCost -= cost; // We pay this
        } else {
          childrenCost += cost; // We receive this
        }
      }
    });

    const pnlAbs = parentCost + childrenCost;
    const totalInvested = Math.abs(
      strategy === 'SELL_PARENT_BUY_CHILDREN' ? childrenCost : parentCost,
    );
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


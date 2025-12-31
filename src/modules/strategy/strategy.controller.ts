import {
  Controller,
  Get,
  Post,
  Query,
  Logger,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArbSignal } from '../../database/entities/arb-signal.entity';
import { ArbPaperTrade } from '../../database/entities/arb-paper-trade.entity';
import { PaperExecutionService } from './paper-execution.service';
import { MarketStructureService } from './market-structure.service';
import { RetentionCleanupService } from './retention-cleanup.service';

@Controller('strategy')
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(
    @InjectRepository(ArbSignal)
    private readonly arbSignalRepository: Repository<ArbSignal>,
    @InjectRepository(ArbPaperTrade)
    private readonly arbPaperTradeRepository: Repository<ArbPaperTrade>,
    private readonly paperExecutionService: PaperExecutionService,
    private readonly marketStructureService: MarketStructureService,
    private readonly retentionCleanupService: RetentionCleanupService,
  ) {}

  /**
   * GET /strategy/stats
   * Returns overall statistics for paper trading
   */
  @Get('stats')
  async getStats() {
    try {
      const paperStats = await this.paperExecutionService.getStats();
      
      // Get signal stats
      const totalSignals = await this.arbSignalRepository.count();
      const executableSignals = await this.arbSignalRepository.count({
        where: { isExecutable: true },
      });

      // Get recent activity
      const recentSignals = await this.arbSignalRepository.find({
        order: { createdAt: 'DESC' },
        take: 10,
        select: ['id', 'groupKey', 'strategy', 'profitBps', 'createdAt'],
      });

      return {
        signals: {
          total: totalSignals,
          executable: executableSignals,
          recent: recentSignals,
        },
        paperTrades: paperStats,
      };
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/groups
   * Returns list of active range groups
   */
  @Get('groups')
  async getGroups() {
    try {
      const groups = await this.marketStructureService.getAllGroups();
      
      // Enrich with signal counts
      const enrichedGroups = await Promise.all(
        groups.map(async (group) => {
          const signalCount = await this.arbSignalRepository.count({
            where: { groupKey: group.groupKey },
          });
          
          return {
            groupKey: group.groupKey,
            eventSlug: group.eventSlug,
            crypto: group.crypto,
            childrenCount: group.children.length,
            parentsCount: group.parents.length,
            signalCount,
          };
        }),
      );

      return {
        total: enrichedGroups.length,
        groups: enrichedGroups,
      };
    } catch (error) {
      this.logger.error(`Failed to get groups: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/signals?limit=100&groupKey=xxx
   * Returns arbitrage signals with optional filtering
   */
  @Get('signals')
  async getSignals(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('groupKey') groupKey?: string,
  ) {
    try {
      const queryBuilder = this.arbSignalRepository
        .createQueryBuilder('signal')
        .orderBy('signal.created_at', 'DESC')
        .take(Math.min(limit, 1000)); // Cap at 1000

      if (groupKey) {
        queryBuilder.where('signal.group_key = :groupKey', { groupKey });
      }

      const signals = await queryBuilder.getMany();

      // Get summary stats
      const totalCount = await (groupKey
        ? this.arbSignalRepository.count({ where: { groupKey } })
        : this.arbSignalRepository.count());

      return {
        total: totalCount,
        limit,
        groupKey: groupKey || 'all',
        signals,
      };
    } catch (error) {
      this.logger.error(`Failed to get signals: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * GET /strategy/paper-trades?limit=100&groupKey=xxx
   * Returns paper trade results with optional filtering
   */
  @Get('paper-trades')
  async getPaperTrades(
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query('groupKey') groupKey?: string,
  ) {
    try {
      if (groupKey) {
        const trades = await this.paperExecutionService.getTradesByGroup(
          groupKey,
          Math.min(limit, 1000),
        );
        
        return {
          total: trades.length,
          limit,
          groupKey,
          trades,
        };
      } else {
        const trades = await this.paperExecutionService.getRecentTrades(
          Math.min(limit, 1000),
        );
        
        return {
          total: trades.length,
          limit,
          groupKey: 'all',
          trades,
        };
      }
    } catch (error) {
      this.logger.error(
        `Failed to get paper trades: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/signals/:groupKey/summary
   * Returns summary statistics for a specific group
   */
  @Get('signals/:groupKey/summary')
  async getGroupSummary(@Query('groupKey') groupKey: string) {
    try {
      const signals = await this.arbSignalRepository.find({
        where: { groupKey },
        order: { createdAt: 'DESC' },
      });

      if (signals.length === 0) {
        return {
          groupKey,
          signalCount: 0,
          avgProfitBps: 0,
          maxProfitBps: 0,
          strategies: {},
        };
      }

      const avgProfitBps =
        signals.reduce((sum, s) => sum + Number(s.profitBps || 0), 0) /
        signals.length;
      const maxProfitBps = Math.max(
        ...signals.map((s) => Number(s.profitBps || 0)),
      );

      // Group by strategy
      const strategies = signals.reduce((acc, signal) => {
        const strategy = signal.strategy;
        if (!acc[strategy]) {
          acc[strategy] = { count: 0, totalProfitBps: 0 };
        }
        acc[strategy].count++;
        acc[strategy].totalProfitBps += Number(signal.profitBps || 0);
        return acc;
      }, {} as Record<string, { count: number; totalProfitBps: number }>);

      return {
        groupKey,
        signalCount: signals.length,
        avgProfitBps,
        maxProfitBps,
        strategies: Object.entries(strategies).map(([name, stats]) => ({
          name,
          count: stats.count,
          avgProfitBps: stats.totalProfitBps / stats.count,
        })),
      };
    } catch (error) {
      this.logger.error(
        `Failed to get group summary: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * GET /strategy/retention/stats
   * Returns current retention policy and database statistics
   */
  @Get('retention/stats')
  async getRetentionStats() {
    try {
      return await this.retentionCleanupService.getRetentionStats();
    } catch (error) {
      this.logger.error(
        `Failed to get retention stats: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * POST /strategy/retention/cleanup
   * Manually trigger retention cleanup
   */
  @Post('retention/cleanup')
  async triggerCleanup() {
    try {
      this.logger.log('Manual cleanup triggered via API');
      return await this.retentionCleanupService.triggerManualCleanup();
    } catch (error) {
      this.logger.error(
        `Failed to trigger cleanup: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

